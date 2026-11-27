// 本地桥 + P2P 内核的粘合层。
//
// 这是一个完全独立的聊天软件——本体不碰 QQ、不碰任何腾讯服务。
// 传输双通道：
//   · p2p（默认）：设备间 WS 直连（PeerLink）
//   · snowluma（可选）：SnowLuma 注入后经 OneBot v11 收发（ob 非空时启用）
//
//   界面（public/） --UI 帧--> 本地桥 --PeerLink / OneBot--> 对方设备
//
// 职责：
//   · 静态资源 + /api/config
//   · 本机账号（认设备）/ 联系人（手动添加 + 连接地址）/ 本地群（逐成员直发）
//   · 所有消息落本机（LocalStore），离线消息由 PeerLink 发件箱补发
//   · 收到未知账号的消息一律忽略（联系人必须手动添加）
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildZip, parseZip, jsonFrom, makeManifest, checkManifest, BACKUP_FORMAT, SCHEMA } from './backup.js';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PeerLink } from './p2p.js';
import { OpenP2PManager } from './openp2p.js';
import { chatKeyOf, previewOf } from './message-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 选一个用户真能找到的下载目录：优先「下载/ArkTalk」，不可写就退回数据目录。
 * 之前直接用 data/downloads，文件收完了界面上也不给路径，等于"下不了"。
 */
function pickDownloadsDir(dataDir, configured = '') {
  const home = os.homedir();
  const candidates = [
    configured, // 用户在设置里指定的接收目录，优先级最高
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads', 'ArkTalk') : null,
    path.join(home, 'Downloads', 'ArkTalk'),
    path.join(dataDir, 'downloads')
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* 试下一个 */ }
  }
  return path.join(dataDir, 'downloads');
}

export class Bridge {
  /**
   * @param {object} opts
   * @param {import('./store.js').LocalStore} opts.store
   * @param {{host:string,port:string|number}} opts.listen 界面服务监听（只给本机界面）
   * @param {{host:string,port:number}} opts.p2p P2P 内核监听（0.0.0.0 才能接受外部设备）
   * @param {import('./onebot-client.js').OneBotClient|null} [opts.ob] 可选 SnowLuma 注入通道
   * @param {string} [opts.downloadsDir] 用户在设置里指定的接收文件目录（空 = 自动选）
   * @param {function} [opts.log]
   */
  constructor({ store, listen, p2p, ob = null, downloadsDir = '', log = () => {} }) {
    this.store = store;
    this.listen = listen;
    this.p2pCfg = p2p;
    this.ob = ob;
    this.log = log;
    this.uiToken = crypto.randomBytes(16).toString('hex');
    this.uiSockets = new Set();
    this.unread = new Map(); // chatKey -> count
    // 已读回执：readMarks = 对方读到哪一刻（chatKey -> ts，落盘）；_readSent / _readPending = 我发给对方的
    this.readMarks = new Map();
    this._readSent = new Map();
    this._readPending = new Map();
    // 撤回：本机打标记（chatKey -> Set<message_id>），不动消息文件
    this.recalled = new Map();
    // 下载登记：fileId -> {where, path, size, time}（落盘），用来回答"这个文件下没下过"
    this.downloadsDone = new Map();
    this.local = { profile: null, friends: [], groups: [] };
    this._loadLocal();
    if (!this.local.profile) {
      // 账号认设备：首次运行自动生成本机账号 ID，无需注册
      this.local.profile = { accountId: Math.floor(100000000 + Math.random() * 900000000), nickname: '', avatar: '' };
      this._saveLocal();
    }
    this.readMarks = this._loadReadMarks();
    this.recalled = this._loadRecalled();
    this.downloadsDone = this._loadDownloadsDone();
    this.link = new PeerLink({ selfId: this.local.profile.accountId, listen: p2p, log });
    // 跨网穿透（OpenP2P，可选）：联系人里每个账号建一条 127.0.0.1:131xx → 对方 3021 的隧道
    this.openp2p = new OpenP2PManager({
      exePath: path.join(__dirname, '..', 'bin', 'openp2p.exe'),
      workDir: path.join(this.store.dataDir, 'openp2p'),
      log
    });
    // 文件传输：outFiles = 我发出去的（对方来拉）；downloads = 我正在收的
    this.filesDir = path.join(this.store.dataDir, 'files');
    // 收到的文件默认放到用户自己的"下载/ArkTalk"里；用户也可在设置里指定任意目录
    this.downloadsDir = pickDownloadsDir(this.store.dataDir, downloadsDir);
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    this.outFiles = this._loadOutRegistry(); // fileId -> {name, size}
    this.downloads = new Map();              // fileId -> 下载任务
    this._server = null;
    this._wss = null;
  }

  start() {
    this._server = http.createServer((req, res) => this._onHttp(req, res));
    this._wss = new WebSocketServer({ server: this._server, path: '/ws' });
    this._wss.on('connection', (ws, req) => this._onUi(ws, req));

    // 启动即恢复联系人里的连接地址并拨号（不用等发第一条消息才发现连不上）
    for (const f of this.local.friends) {
      if (f.endpoint) this.link.setEndpoint(f.user_id, f.endpoint);
    }
    // 穿透隧道（填了 OpenP2P 令牌才有）：为每个联系人加 127.0.0.1 隧道地址
    this._refreshRelay();
    // 心跳自检：每 20 秒把「哪些账号当前能直连」广播给界面（列表绿/灰点实时刷新）
    this._peersTimer = setInterval(() => {
      this._broadcast({ type: 'peers', peers: this.link.onlineMap() });
    }, 20000);
    this._watchRelay(); // 穿透进程守护（崩溃/被杀自动拉起）

    // P2P 事件 → 落本机 + 广播界面
    this.link.on('message', (m) => this._onPeerMessage(m));
    this.link.on('profile', (p) => this._onPeerProfile(p));
    // 对方已读回执：记录"对方读到哪一刻"，界面把这条时间之前的自发消息标成已读
    this.link.on('read', ({ from, ts }) => this._onPeerRead(from, ts));
    // 对方刚上线：把之前没发出去的已读回执补发一次（离线时发的丢了）
    this.link.on('peer-online', (id) => this._flushReadPending(`p${id}`));
    // 对方换网后连进来 → 自动把它的最新 IP 记进联系人（网络环境变化免手填）
    this.link.on('endpoint-learned', ({ accountId, endpoint }) => {
      const f = this.local.friends.find((x) => Number(x.user_id) === Number(accountId));
      if (!f) return;
      const cur = String(f.endpoint ?? '').split(/[\s,;，；]+/).filter(Boolean);
      if (cur.includes(endpoint)) return;
      f.endpoint = [endpoint, ...cur].join(',');
      this._saveLocal();
      this._broadcastHello();
      this.log(`自动更新 ${accountId} 的地址 → ${endpoint}`, 'info');
    });
    this.link.on('fileframe', ({ from, frame }) => this._onFileFrame(from, frame));
    this.link.on('peer-online', (id) => {
      this.link.pushProfile(id, this.local.profile); // 对方上线即互报资料
      this._broadcast({ type: 'peers', peers: this.link.onlineMap() });
    });
    this.link.on('peer-offline', () => this._broadcast({ type: 'peers', peers: this.link.onlineMap() }));

    // 可选 SnowLuma 注入通道：事件按同一套"只认联系人"的规则处理
    if (this.ob) {
      this.ob.on('online', () => this._broadcastHello());
      this.ob.on('offline', () => this._broadcast({ type: 'peers', peers: this.link.onlineMap() }));
      this.ob.on('event', (ev) => this._onObEvent(ev));
    }

    return Promise.all([
      new Promise((resolve, reject) => {
        this._server.once('error', (err) => {
          if (err?.code === 'EADDRINUSE') reject(new Error(`端口 ${this.listen.port} 已被占用。改 config.json listen.port 或关掉占用进程。`));
          else reject(err);
        });
        this._server.listen(this.listen.port, this.listen.host, () => {
          this.log(`界面服务：http://${this.listen.host}:${this.listen.port}`);
          resolve();
        });
      }),
      this.link.start()
    ]).then(() => {});
  }

  stop() {
    clearInterval(this._peersTimer);
    clearInterval(this._relayTimer);
    this.openp2p.stop();
    for (const ws of this.uiSockets) { try { ws.close(1001, 'server stop'); } catch { /* ignore */ } }
    this._wss?.close();
    this._server?.close();
    return this.link.stop();
  }

  // ---------- HTTP ----------
  /** 本机所有局域网 IPv4（排除回环；VirtualBox/虚拟网卡等也列出，由对方按连通性轮换）。 */
  lanAddrs() {
    const out = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal && a.address) out.push(a.address);
      }
    }
    return out;
  }

  _onHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        uiToken: this.uiToken,
        selfId: this.local.profile.accountId,
        p2pPort: this.p2pCfg.port,
        lanAddrs: this.lanAddrs(),   // 本机所有局域网 IPv4（供“复制连接信息”用）
        op2pTokenSet: !!this.local.settings?.openp2pToken // 跨网穿透是否已启用
      }));
      return;
    }
    // 托盘/外部工具用的轻量状态（不含令牌，只读）
    if (url.pathname === '/api/status') {
      const online = this.link.onlineMap();
      const friends = this.local.friends ?? [];
      // 严格语义：只有 peers 里明确 readyState === 1 才算在线（不在表里 = 没连上）
      const onCount = friends.filter((f) => online[String(f.user_id)] === true).length;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        selfId: this.local.profile?.accountId ?? null,
        nickname: this.local.profile?.nickname ?? '',
        friends: friends.length,
        online: onCount,
        peers: online,
        relay: !!this.local.settings?.openp2pToken
      }));
      return;
    }
    if (url.pathname === '/api/links') {
      // 排查"一端在线另一端离线"用：每条连接的沉默时长（silentMs > 20000 说明可能半开）
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.link.linkStats()));
      return;
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      if (url.searchParams.get('token') !== this.uiToken) { res.writeHead(403); res.end(); return; }
      this._onUpload(req, res, url).catch(() => { try { res.writeHead(500); res.end('upload failed'); } catch { /* ignore */ } });
      return;
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^([/\\])+/, '');
    const file = path.join(__dirname, '..', 'public', p);
    if (!file.startsWith(path.join(__dirname, '..', 'public'))) { res.writeHead(403); res.end(); return; }
    try {
      const body = fs.readFileSync(file);
      const ext = path.extname(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream';
      // no-store：界面资源绝不走缓存——否则升级后 WebView/浏览器还拿旧 app.js，"新功能不生效"
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }

  // ---------- UI WS ----------
  _onUi(ws, req) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== this.uiToken) { ws.close(4001, 'bad token'); return; }
    this.uiSockets.add(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      this._onUiFrame(ws, msg).catch((e) => this.log(`UI 帧处理失败：${e.message}`, 'warn'));
    });
    ws.on('close', () => this.uiSockets.delete(ws));
    this._sendUi(ws, this._helloPayload());
  }

  _sendUi(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  _broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.uiSockets) if (ws.readyState === 1) ws.send(s);
  }

  async _onUiFrame(ws, msg) {
    switch (msg.type) {
      case 'history': { // 本机记录（唯一来源，离线信息留在本机）
        this._sendUi(ws, {
          type: 'history',
          chatKey: msg.chatKey,
          messages: this.store.read(msg.chatKey, msg.limit ?? 50).map((r) => this._annotate(msg.chatKey, r)),
          source: 'local'
        });
        return;
      }
      case 'read': {
        this.unread.set(msg.chatKey, 0);
        this._broadcast({ type: 'unread', unread: Object.fromEntries(this.unread) });
        this._sendReadReceipt(msg.chatKey); // 已读回执：让对方那条消息变"已读"
        return;
      }
      case 'rpc': {
        try {
          const data = await this._rpc(msg.name, msg.params ?? {});
          this._sendUi(ws, { type: 'action-result', reqId: msg.reqId, ok: true, data });
        } catch (e) {
          this._sendUi(ws, { type: 'action-result', reqId: msg.reqId, ok: false, error: e.message });
        }
        return;
      }
      case 'self-msg': { // 界面主动落账（兜底路径，桥的发送路径通常自己已落）
        try { this.store.append(msg.chatKey, msg.record ?? {}); } catch (e) { this.log(`自发消息落盘失败：${e.message}`, 'warn'); }
        this._broadcast({ type: 'self-msg', chatKey: msg.chatKey, record: msg.record });
        return;
      }
      default:
        return;
    }
  }

  // ---------- 软件功能 ----------
  async _rpc(name, p) {
    switch (name) {
      case 'set-profile': return this._setProfile(p);
      case 'add-friend': return this._addFriend(p);
      case 'remove-friend': return this._removeFriend(p);
      case 'create-group': return this._createGroup(p);
      case 'remove-group': return this._removeGroup(p);
      case 'send-private': return await this._sendPrivate(p);
      case 'send-to-group': return await this._sendToGroup(p);
      case 'send-file': return await this._sendFile(p);
      case 'recall-message': return this._recallMessage(p);
      case 'save-image': return this._saveImage(p);
      case 'download-file': return this._downloadFile(p);
      case 'open-location': return this._openLocation(p);
      case 'peers': return { peers: this.link.onlineMap() };
      case 'set-openp2p-token': return this._setOpenP2pToken(p);
      case 'list-tokens': return this._listTokens();
      case 'add-token': return this._addToken(p);
      case 'switch-token': return this._switchToken(p);
      case 'remove-token': return this._removeToken(p);
      case 'relay-status': return {
        tokenSet: !!this.local.settings?.openp2pToken,
        ...this.openp2p.info()
      };
      case 'diag-pack': return this._diagPack();
      case 'storage-info': return this._storageInfo();
      case 'set-storage': return this._setStorage(p);
      case 'backup-info': return this._backupInfo();
      case 'backup-export': return this._exportBackup(p);
      case 'backup-import': return this._importBackup(p);
      default: throw new Error(`未知操作：${name}`);
    }
  }

  /** 当前实际生效的存储路径 + config.json 里的原始配置（界面显示 / 迁移用）。 */
  _storageInfo() {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 配置损坏时只报实际路径 */ }
    return {
      dataDir: this.store.dataDir,
      filesDir: this.filesDir,
      downloadsDir: this.downloadsDir,
      configDataDir: cfg.storage?.dataDir ?? '',
      configDownloadsDir: cfg.storage?.downloadsDir ?? ''
    };
  }

  // ---------- 数据备份：导出 / 导入（聊天记录 + 配置，跨版本兼容） ----------
  /** 备份格式信息（前端展示用） */
  _backupInfo() {
    const chats = this.store.listChats();
    return {
      format: BACKUP_FORMAT,
      schema: SCHEMA,
      chats: chats.length,
      messages: chats.reduce((n, c) => n + (c.count || 0), 0),
      friends: (this.local.friends || []).length,
      groups: (this.local.groups || []).length,
      outFiles: this.outFiles?.size ?? 0,
      dataDir: this.store.dataDir,
      downloadsDir: this.downloadsDir
    };
  }

  /**
   * 导出全部数据为标准 zip 备份包。
   * 落盘到接收文件目录（用户可见），同时返回 base64（供前端直接下载/另存）。
   * 返回 { file, where, size, base64, counts, schema }
   */
  _exportBackup() {
    const entries = [];
    // 1) 归一化配置（PC 的 settings 就是中立结构，直接用）
    const contacts = {
      profile: this.local.profile ?? null,
      friends: Array.isArray(this.local.friends) ? this.local.friends : [],
      groups: Array.isArray(this.local.groups) ? this.local.groups : [],
      settings: this.local.settings ?? {}
    };
    // 2) 已读 / 撤回 / 下载登记
    const readMarks = Object.fromEntries(this.readMarks);
    const recalled = {};
    for (const [k, s] of this.recalled) if (s?.size) recalled[k] = [...s];
    const downloadsDone = Object.fromEntries(this.downloadsDone);
    // 3) 消息：每个会话一个 jsonl（原样拷贝，避免解析丢失字段）
    const msgDir = path.join(this.store.dataDir, 'messages');
    let msgCount = 0, chatCount = 0;
    if (fs.existsSync(msgDir)) {
      for (const f of fs.readdirSync(msgDir)) {
        if (!/^[pg]\d+\.jsonl$/.test(f)) continue;
        const buf = fs.readFileSync(path.join(msgDir, f));
        entries.push({ name: `messages/${f}`, data: buf });
        chatCount++;
        msgCount += buf.toString('utf8').split('\n').filter((l) => l.trim()).length;
      }
    }
    // 4) 发出文件：登记 + 文件本体
    const reg = Object.fromEntries(this.outFiles ?? new Map());
    let fileBytes = 0;
    for (const fid of Object.keys(reg)) {
      const fp = path.join(this.filesDir, fid);
      if (fs.existsSync(fp)) {
        const buf = fs.readFileSync(fp);
        entries.push({ name: `files/${fid}`, data: buf });
        fileBytes += buf.length;
      }
    }
    const appVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch { return ''; } })();
    const manifest = makeManifest({
      source: 'pc', appVersion,
      counts: { messages: msgCount, chats: chatCount, friends: contacts.friends.length, groups: contacts.groups.length, files: Object.keys(reg).length, bytes: fileBytes }
    });
    // manifest + 配置类文件放前面，便于未来版本快速读取
    const head = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) },
      { name: 'data/contacts.json', data: Buffer.from(JSON.stringify(contacts, null, 1)) },
      { name: 'data/read-marks.json', data: Buffer.from(JSON.stringify(readMarks, null, 1)) },
      { name: 'data/recalled.json', data: Buffer.from(JSON.stringify(recalled, null, 1)) },
      { name: 'data/downloads-done.json', data: Buffer.from(JSON.stringify(downloadsDone, null, 1)) },
      { name: 'files/registry.json', data: Buffer.from(JSON.stringify(reg, null, 1)) }
    ];
    const zip = buildZip([...head, ...entries]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `arktalk-backup-${stamp}.zip`;
    let file = '', where = '';
    try {
      file = path.join(this.downloadsDir, name);
      fs.writeFileSync(file, zip);
      where = `下载/ArkTalk/${name}`;
    } catch (e) {
      this.log(`备份落盘失败（仍返回 base64）：${e.message}`, 'warn');
      file = '';
    }
    return {
      file, where, size: zip.length,
      base64: zip.toString('base64'),
      counts: manifest.counts, schema: SCHEMA, format: BACKUP_FORMAT
    };
  }

  /**
   * 导入备份包。base64 为标准 zip 内容（与 _exportBackup 对应）。
   * 策略=合并（幂等）：消息按 message_id 去重追加；联系人/群按 id 合并；
   * 已读取较新时间戳；撤回合并；下载登记合并；配置仅在本地为空时采用 profile。
   * 返回 { ok, warn, imported:{...}, skipped }
   */
  _importBackup({ base64, policy = 'merge' } = {}) {
    if (!base64) throw new Error('备份内容为空');
    let buf;
    try { buf = Buffer.from(String(base64), 'base64'); } catch { throw new Error('备份内容解码失败'); }
    if (buf.length < 22) throw new Error('备份文件过小');
    let map;
    try { map = parseZip(buf); } catch (e) { throw new Error(`备份包解析失败：${e.message}`); }
    const { warn } = checkManifest(jsonFrom(map, 'manifest.json', null));
    const imported = { messages: 0, chats: 0, friends: 0, groups: 0, files: 0 };
    let skipped = 0;

    // --- 消息：逐会话 append（store 内部按 message_id 去重 → 幂等）---
    const msgDir = path.join(this.store.dataDir, 'messages');
    fs.mkdirSync(msgDir, { recursive: true });
    for (const [name, raw] of map) {
      const m = /^messages\/([pg]\d+\.jsonl)$/.exec(name);
      if (!m) continue;
      const chatKey = m[1].replace(/\.jsonl$/, '');
      let added = 0;
      for (const line of raw.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          if (!rec?.message_id) { skipped++; continue; }
          if (this.store.append(chatKey, rec)) added++; else skipped++;
        } catch { skipped++; }
      }
      if (added) { imported.chats++; imported.messages += added; }
    }

    // --- 配置 ---
    const contacts = jsonFrom(map, 'data/contacts.json', {});
    if (contacts && typeof contacts === 'object') {
      // profile：默认仅当本地没有时才采用（避免覆盖当前设备身份）；
      // 显式 replaceProfile=true 时用备份身份替换（换设备/迁移场景）。
      if (contacts.profile?.accountId && (policy === 'replace-profile' || !this.local.profile?.accountId)) {
        const oldId = this.local.profile?.accountId;
        this.local.profile = contacts.profile;
        if (oldId && String(oldId) !== String(contacts.profile.accountId)) {
          // 身份变了：需要让 P2P 内核用新 ID 重连
          try { this.link.selfId = contacts.profile.accountId; } catch { /* 忽略 */ }
        }
      }
      const mergeById = (dst, src, key) => {
        const have = new Set((dst || []).map((x) => String(x?.[key])));
        for (const item of (Array.isArray(src) ? src : [])) {
          if (!item || typeof item !== 'object') continue;
          const id = String(item[key] ?? '');
          if (!id || have.has(id)) { skipped++; continue; }
          have.add(id); dst.push(item);
          if (key === 'user_id') imported.friends++; else imported.groups++;
        }
      };
      if (!Array.isArray(this.local.friends)) this.local.friends = [];
      if (!Array.isArray(this.local.groups)) this.local.groups = [];
      mergeById(this.local.friends, contacts.friends, 'user_id');
      mergeById(this.local.groups, contacts.groups, 'group_id');
      // settings：令牌合并去重
      const s = contacts.settings ?? {};
      if (!this.local.settings) this.local.settings = {};
      const toks = Array.isArray(s.openp2pTokens) ? s.openp2pTokens : [];
      const myToks = Array.isArray(this.local.settings.openp2pTokens) ? this.local.settings.openp2pTokens : [];
      const seen = new Set(myToks.map((t) => t?.token));
      for (const t of toks) if (t?.token && !seen.has(t.token)) { seen.add(t.token); myToks.push(t); }
      this.local.settings.openp2pTokens = myToks;
      if (!this.local.settings.openp2pToken && s.openp2pToken) this.local.settings.openp2pToken = s.openp2pToken;
      this._saveLocal();
    }

    // --- 已读：取较新 ---
    const marks = jsonFrom(map, 'data/read-marks.json', {});
    if (marks && typeof marks === 'object') {
      for (const [k, v] of Object.entries(marks)) {
        const ts = Number(v);
        if (Number.isFinite(ts) && ts > (this.readMarks.get(k) ?? 0)) this.readMarks.set(k, ts);
      }
      this._saveReadMarks();
    }

    // --- 撤回：并集 ---
    const rec = jsonFrom(map, 'data/recalled.json', {});
    if (rec && typeof rec === 'object') {
      for (const [k, arr] of Object.entries(rec)) {
        if (!Array.isArray(arr)) continue;
        if (!this.recalled.has(k)) this.recalled.set(k, new Set());
        const set = this.recalled.get(k);
        for (const id of arr) if (id) set.add(String(id));
      }
      this._saveRecalled();
    }

    // --- 下载登记：并集（本地优先，不覆盖已有的完整路径）---
    const dl = jsonFrom(map, 'data/downloads-done.json', {});
    if (dl && typeof dl === 'object') {
      for (const [k, v] of Object.entries(dl)) {
        if (v && typeof v === 'object' && !this.downloadsDone.has(k)) this.downloadsDone.set(k, v);
      }
      this._saveDownloadsDone();
    }

    // --- 文件本体：补缺失的 ---
    const reg = jsonFrom(map, 'files/registry.json', {});
    if (reg && typeof reg === 'object') {
      fs.mkdirSync(this.filesDir, { recursive: true });
      for (const fid of Object.keys(reg)) {
        const data = map.get(`files/${fid}`);
        if (!data) continue;
        const fp = path.join(this.filesDir, fid);
        if (!fs.existsSync(fp)) { fs.writeFileSync(fp, data); imported.files++; }
      }
      // 合并登记
      for (const [fid, meta] of Object.entries(reg)) if (!this.outFiles.has(fid)) this.outFiles.set(fid, meta);
      this._saveOutRegistry();
    }

    this.log(`备份导入完成：${imported.messages} 条消息 / ${imported.friends} 联系人 / ${imported.files} 文件${warn ? '（' + warn + '）' : ''}`, 'info');
    return { ok: true, warn, imported, skipped, schema: jsonFrom(map, 'manifest.json', {}).schema ?? null };
  }

  /**
   * 开发模式（npm start）下的存储位置修改回退。
   * 打包版走 Electron 主进程 IPC：先停桥再迁移，避免边写边拷。这里只做配置落盘 + 复制，
   * 调用方收到 needRestart 后提示用户手动重启。
   */
  _setStorage({ dataDir, downloadsDir, migrate = true } = {}) {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    const root = path.resolve(__dirname, '..');
    const resolve = (p, fallback) => {
      if (!p || typeof p !== 'string' || !p.trim()) return fallback;
      const s = p.trim();
      return path.isAbsolute(s) ? path.normalize(s) : path.resolve(root, s);
    };
    const oldData = resolve(cfg.storage?.dataDir, path.join(root, 'data'));
    const newData = dataDir == null ? oldData : resolve(dataDir, path.join(root, 'data'));
    if (migrate && path.resolve(newData) !== path.resolve(oldData)) {
      fs.mkdirSync(newData, { recursive: true });
      fs.cpSync(oldData, newData, { recursive: true, force: false, errorOnExist: false });
    }
    cfg.storage = {
      ...(cfg.storage ?? {}),
      dataDir: dataDir == null ? (cfg.storage?.dataDir ?? '') : String(dataDir),
      downloadsDir: downloadsDir == null ? (cfg.storage?.downloadsDir ?? '') : String(downloadsDir)
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    return { ok: true, needRestart: true, dataDir: newData };
  }

  /** 诊断包：PC 端排查用（不含令牌明文、不含聊天内容）。 */
  _diagPack() {
    const lan = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) lan.push(`${name}:${a.address}`);
      }
    }
    const pack = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      app: 'ArkTalk Desktop',
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      accountId: this.local.profile?.accountId,
      nickname: this.local.profile?.nickname || '',
      p2pPort: this.p2pCfg?.port ?? null,
      lanAddrs: lan,
      peers: this.link.onlineMap(),
      links: typeof this.link.linkStats === 'function' ? this.link.linkStats() : null,
      friends: (this.local.friends || []).map((f) => ({
        id: f.user_id, nickname: f.nickname || '', endpoint: f.endpoint || ''
      })),
      relay: { tokenSet: !!this.local.settings?.openp2pToken, ...this.openp2p.info() },
      files: {
        downloadsDir: this.downloadsDir,
        knownOut: this.outFiles.size,
        active: [...this.downloads.values()].map((j) => ({
          fileId: j.fileId, name: j.name, size: j.size, got: j.got,
          seqIssued: j.seq, nextWrite: j.nextWrite, inFlight: [...j.inFlight],
          eof: j.eofSeen, idleMs: Date.now() - j.lastProgress
        }))
      }
    };
    // 同时落成文件，方便直接发出去
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'diag');
      fs.mkdirSync(dir, { recursive: true });
      const name = `arktalk-diag-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(pack, null, 1), 'utf8');
      pack.file = file;
    } catch (e) {
      pack.file = `写入失败：${e.message}`;
    }
    return pack;
  }

  _setProfile({ nickname, avatar } = {}) {    if (nickname !== undefined) this.local.profile.nickname = String(nickname).trim().slice(0, 30);
    if (avatar !== undefined) this.local.profile.avatar = String(avatar).slice(0, 400 * 1024);
    this._saveLocal();
    this._broadcastHello();
    // 把新资料推给所有在线联系人
    for (const id of Object.keys(this.link.onlineMap())) {
      this.link.pushProfile(id, this.local.profile);
    }
    return { profile: { ...this.local.profile } };
  }

  /** 手动添加联系人：对方账号 + 连接地址（host:端口，如 192.168.1.5:3021）。 */
  _addFriend({ userId, remark, endpoint } = {}) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('请输入有效的账号（数字）');
    let f = this.local.friends.find((x) => Number(x.user_id) === uid);
    if (!f) {
      f = { user_id: uid, nickname: '', remark: String(remark ?? '').trim(), endpoint: '' };
      this.local.friends.push(f);
    } else if (remark !== undefined) {
      f.remark = String(remark ?? '').trim();
    }
    if (endpoint !== undefined && String(endpoint).trim()) {
      f.endpoint = String(endpoint).trim();
      this.link.setEndpoint(uid, f.endpoint);
    }
    this._saveLocal();
    this._broadcastHello();
    this._refreshRelay(); // 联系人变化 → 重建 OpenP2P 隧道（新增账号也走跨网）
    return { added: true, user_id: uid };
  }

  _removeFriend({ userId } = {}) {
    const uid = Number(userId);
    const before = this.local.friends.length;
    this.local.friends = this.local.friends.filter((x) => Number(x.user_id) !== uid);
    // 从本地群里也移除该成员
    for (const g of this.local.groups) {
      g.members = (g.members ?? []).filter((m) => Number(m.user_id) !== uid);
    }
    this._saveLocal();
    this._broadcastHello();
    this._refreshRelay();
    return { removed: before !== this.local.friends.length };
  }

  /** 删除本地群（仅本机移除；聊天记录保留）。 */
  _removeGroup({ groupId } = {}) {
    const gid = Number(groupId);
    const before = this.local.groups.length;
    this.local.groups = this.local.groups.filter((g) => Number(g.group_id) !== gid);
    this._saveLocal();
    this._broadcastHello();
    return { removed: before !== this.local.groups.length };
  }

  /** 手动建群：本地群，发消息逐成员经 P2P 直发。 */
  _createGroup({ name, memberIds = [] } = {}) {
    const gname = String(name ?? '').trim();
    if (!gname) throw new Error('群名称不能为空');
    const members = [...new Set((memberIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!members.length) throw new Error('至少选择一名成员');
    const group = { group_id: Date.now(), group_name: gname, members: members.map((user_id) => ({ user_id })), local: true };
    this.local.groups.push(group);
    this._saveLocal();
    this._broadcastHello();
    return { group_id: group.group_id, group_name: gname, memberCount: members.length };
  }

  /** 经 P2P 发 segs 给某联系人，落本机账并广播界面。返回 {queued, messageId}。 */
  _sendToPeerPersist(uid, segs) {
    const contact = this.local.friends.find((f) => Number(f.user_id) === uid);
    if (!contact) throw new Error('对方不在联系人列表，请先手动添加');
    if (contact.endpoint) this.link.setEndpoint(uid, contact.endpoint);
    const { queued, envelope } = this.link.send(uid, segs);
    const record = {
      message_id: envelope.id,
      time: envelope.time,
      sender: { user_id: this.local.profile.accountId, nickname: this.local.profile.nickname || '我' },
      user_id: this.local.profile.accountId,
      message: segs,
      raw_message: '',
      self_sent: true,
      queued: !!queued,
      read: false            // 发出去先算未读，收到对方回执后变已读
    };
    try { this.store.append(`p${uid}`, record); } catch (e) { this.log(`落盘失败：${e.message}`, 'warn'); }
    this._broadcast({ type: 'self-msg', chatKey: `p${uid}`, record });
    return { queued, messageId: envelope.id };
  }

  /** 私聊发送：经 P2P 内核直发对方设备；本机立即落账（自己发的马上可见）。 */
  async _sendPrivate({ userId, segs } = {}) {
    const uid = Number(userId);
    const list = Array.isArray(segs) ? segs : [];
    if (!list.length) throw new Error('空消息');
    return this._sendToPeerPersist(uid, list);
  }

  /** 发文件：只发卡片（元数据），文件本体留在本机等对方来拉。 */
  async _sendFile({ userId, fileId, name, size } = {}) {
    const uid = Number(userId);
    const fid = String(fileId ?? '').trim();
    const info = this.outFiles.get(fid);
    if (!info) throw new Error('文件不存在或已过期，请重新选择');
    return this._sendToPeerPersist(uid, [{ type: 'file', data: { file_id: fid, name: info.name, size: info.size } }]);
  }

  /** 下载文件：向对方要。窗口并发请求（多路并行），对方点保存才开始，全程可断点。 */
  _downloadFile({ userId, fileId, name, size } = {}) {
    const peerId = String(userId ?? '');
    const fid = String(fileId ?? '').trim();
    if (!peerId || !fid) throw new Error('参数缺失');
    if (!this.local.friends.some((f) => String(f.user_id) === peerId)) throw new Error('只能向联系人下载文件');
    // 下过的直接回答"已经保存到哪"，不再重新拉一遍
    const done = this.downloadsDone.get(fid);
    if (done && done.path && fs.existsSync(done.path)) return { started: true, exists: true, already: true, where: done.where, path: done.path };
    if (this.downloads.has(fid)) return { started: true, exists: true };
    const total = Math.max(0, Number(size) || 0);
    const safe = String(name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
    const dest = this._uniqueDownloadPath(safe);
    const job = {
      peerId, fileId: fid, name: safe, size: total, chunkSize: 1024 * 1024,
      dest,
      ws: fs.createWriteStream(dest),
      seq: 0, nextWrite: 0, buf: new Map(),
      got: 0, inFlight: new Set(), done: false, eofSeen: false, lastProgress: Date.now(),
      reqAt: new Map(),   // seq -> 请求时刻（块超时重传用）
      tries: new Map()    // seq -> 重试次数
    };
    this.downloads.set(fid, job);
    this._reqMoreChunks(job);
    // 5 秒一巡检：卡住的块单独重发，整单 90 秒没有任何进展才判定超时
    job.watchdog = setInterval(() => this._pumpDownload(job), 5000);
    this.log(`开始下载 ${safe}（来自 ${peerId}）`);
    return { started: true };
  }

  /** 巡检在途块：超过 12 秒没回来的重发，重试 6 次仍失败就中止（弱网/隧道抖动自愈）。 */
  _pumpDownload(job) {
    if (job.done) return;
    const now = Date.now();
    if (now - job.lastProgress > 90000) { this._abortDownload(job.fileId, '传输超时（90 秒无进展）'); return; }
    for (const seq of [...job.inFlight]) {
      const at = job.reqAt.get(seq) ?? 0;
      if (now - at < 12000) continue;
      const n = (job.tries.get(seq) ?? 0) + 1;
      if (n > 6) { this._abortDownload(job.fileId, `第 ${seq} 块重试 6 次仍失败`); return; }
      job.tries.set(seq, n);
      job.reqAt.set(seq, now);
      const ok = this.link.sendFrame(job.peerId, { type: 'file-req', fileId: job.fileId, seq, chunkSize: job.chunkSize });
      if (!ok) { this._abortDownload(job.fileId, '对方设备离线，无法继续传输'); return; }
    }
  }

  /** 并发窗口：同时挂 6 个块请求在管道里（多路并行，管道满载）。 */
  _reqMoreChunks(job) {
    if (job.done || job.eofSeen) return;
    const WINDOW = 10;
    while (job.inFlight.size < WINDOW) {
      const offset = job.seq * job.chunkSize;
      if (job.size && offset >= job.size) return;
      const seq = job.seq++;
      job.inFlight.add(seq);
      job.reqAt.set(seq, Date.now());
      const ok = this.link.sendFrame(job.peerId, { type: 'file-req', fileId: job.fileId, seq, chunkSize: job.chunkSize });
      if (!ok) {
        job.inFlight.delete(seq);
        this._abortDownload(job.fileId, '对方设备离线，无法传输');
        return;
      }
    }
  }

  _onFileChunk(from, f) {
    const job = this.downloads.get(String(f.fileId));
    if (!job || String(from) !== job.peerId || job.done) return;
    const seq = Number(f.seq);
    if (!job.inFlight.has(seq)) return;
    job.inFlight.delete(seq);
    job.reqAt.delete(seq);
    job.tries.delete(seq);
    if (f.eof) job.eofSeen = true;
    const buf = Buffer.from(String(f.data ?? ''), 'base64');
    job.buf.set(seq, buf);
    job.lastProgress = Date.now();
    this._writeSeq(job);
    this._reqMoreChunks(job);
    this._broadcast({ type: 'file-progress', fileId: job.fileId, received: job.got, size: job.size });
    if (job.size ? job.got >= job.size : (job.eofSeen && job.inFlight.size === 0 && job.buf.size === 0)) {
      this._finishDownload(job);
    }
  }

  /** 乱序块按序落盘。 */
  _writeSeq(job) {
    while (job.buf.has(job.nextWrite)) {
      const b = job.buf.get(job.nextWrite);
      job.buf.delete(job.nextWrite);
      job.ws.write(b);
      job.got += b.length;
      job.nextWrite++;
    }
  }

  _finishDownload(job) {
    if (job.done) return;
    job.done = true;
    clearInterval(job.watchdog);
    job.ws.end(() => {
      this.downloads.delete(job.fileId);
      try { this.link.sendFrame(job.peerId, { type: 'file-done', fileId: job.fileId }); } catch { /* ignore */ }
      // where：给用户看的短路径（"下载/ArkTalk/xxx"），path：完整路径（供"打开"用）
      const where = `${path.basename(this.downloadsDir)}/${job.name}`;
      // 登记到"已下载"名册：下次进会话卡片直接显示"已保存"，不用重新拉
      this.downloadsDone.set(job.fileId, { where, path: job.dest, size: job.size, time: Math.floor(Date.now() / 1000) });
      this._saveDownloadsDone();
      this._broadcast({ type: 'file-done', fileId: job.fileId, name: job.name, path: job.dest, where, size: job.size });
      this.log(`文件已保存：${job.dest}`);
      // 顺带在本机弹一条系统提示，避免"以为没下下来"
      try {
        if (this._onFileSaved) this._onFileSaved(job.dest, job.name);
      } catch { /* ignore */ }
    });
  }

  _abortDownload(fid, reason) {
    const job = this.downloads.get(fid);
    if (!job) return;
    job.done = true;
    clearInterval(job.watchdog);
    try { job.ws.end(); } catch { /* ignore */ }
    fs.rm(job.dest, { force: true }, () => {});
    this.downloads.delete(fid);
    this._broadcast({ type: 'file-error', fileId: fid, error: reason });
    this.log(`下载中止：${reason}`, 'warn');
  }

  /** 我发出去的文件：对方来要哪块就读哪块。 */
  _onFileFrame(from, f) {
    switch (f.type) {
      case 'file-req': {
        const fid = String(f.fileId ?? '');
        // 只服务自己的联系人（fid 是 UUID 不可猜，但仍不该对陌生人开放读盘）
        if (!this.local.friends.some((fr) => String(fr.user_id) === String(from))) return;
        const info = this.outFiles.get(fid);
        if (!info) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件不存在' }); return; }
        const seq = Number(f.seq) | 0;
        if (seq < 0) return;
        const chunkSize = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, Number(f.chunkSize) || 512 * 1024));
        const file = path.resolve(this.filesDir, fid);
        // 路径归属校验：fileId 必须真的落在 filesDir 里，防止对端用 .. 穿越读任意文件
        if (!file.startsWith(path.resolve(this.filesDir) + path.sep)) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件不存在' }); return; }
        // 并发闸门：读盘请求打满时直接丢弃（接收端 12 秒后会自动重传该块，不会丢数据）
        if ((this._serveActive ?? 0) > 32) return;
        this._serveActive = (this._serveActive ?? 0) + 1;
        const buf = Buffer.alloc(chunkSize);
        const done = () => { this._serveActive = Math.max(0, (this._serveActive ?? 1) - 1); };
        fs.open(file, 'r', (err, fd) => {
          if (err) { done(); this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件读取失败' }); return; }
          fs.read(fd, buf, 0, chunkSize, seq * chunkSize, (err2, n) => {
            fs.close(fd, () => {});
            done();
            if (err2 || n == null) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件读取失败' }); return; }
            this.link.sendFrame(from, { type: 'file-chunk', fileId: fid, seq, data: buf.subarray(0, n).toString('base64'), eof: n < chunkSize });
          });
        });
        break;
      }
      case 'file-chunk':
        this._onFileChunk(from, f);
        break;
      case 'file-done': // 我发的文件，对方收完了
        this._broadcast({ type: 'file-ack', fileId: String(f.fileId ?? '') });
        break;
      case 'file-abort':
        if (this.downloads.has(String(f.fileId))) this._abortDownload(String(f.fileId), `对方中止：${f.reason ?? ''}`);
        this._broadcast({ type: 'file-error', fileId: String(f.fileId ?? ''), error: String(f.reason ?? '对方中止') });
        break;
      default: break;
    }
  }

  // ---------- 文件登记 ----------
  _outRegistryPath() { return path.join(this.filesDir, 'registry.json'); }
  _loadOutRegistry() {
    try {
      const j = JSON.parse(fs.readFileSync(this._outRegistryPath(), 'utf8'));
      return new Map(Object.entries(j ?? {}));
    } catch { return new Map(); }
  }
  _saveOutRegistry() {
    try { fs.writeFileSync(this._outRegistryPath(), JSON.stringify(Object.fromEntries(this.outFiles), null, 1)); }
    catch (e) { this.log(`文件登记保存失败：${e.message}`, 'warn'); }
  }
  _uniqueDownloadPath(name) {
    let dest = path.join(this.downloadsDir, name);
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let i = 1;
    while (fs.existsSync(dest)) dest = path.join(this.downloadsDir, `${base}(${i++})${ext}`);
    return dest;
  }

  /** HTTP 上传：文件直写本机 data/files/，不占 WebSocket 通道。 */
  _onUpload(req, res, url) {
    return new Promise((resolve) => {
      const name = decodeURIComponent(url.searchParams.get('name') ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
      const fid = crypto.randomUUID();
      const out = fs.createWriteStream(path.join(this.filesDir, fid));
      let size = 0;
      let settled = false;
      const done = (code, body) => {
        if (settled) return;
        settled = true;
        try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(body); } catch { /* ignore */ }
        resolve();
      };
      req.on('data', (c) => { size += c.length; });
      req.on('error', () => { out.destroy(); done(500, '{"error":"upload broken"}'); });
      out.on('error', () => done(500, '{"error":"write failed"}'));
      req.pipe(out);
      out.on('finish', () => {
        this.outFiles.set(fid, { name, size });
        this._saveOutRegistry();
        done(200, JSON.stringify({ fileId: fid, name, size }));
      });
    });
  }

  /** 本地群群发：对每个成员经 P2P 直发，落本机群会话。 */
  async _sendToGroup({ groupId, message } = {}) {
    const gid = Number(groupId);
    const group = this.local.groups.find((g) => Number(g.group_id) === gid);
    if (!group) throw new Error('本地群不存在');
    const segs = Array.isArray(message) ? message : [];
    if (!segs.length) throw new Error('空消息');
    const results = [];
    for (const m of group.members ?? []) {
      try {
        const r = this.link.send(m.user_id, segs);
        results.push({ user_id: m.user_id, ok: true, queued: r.queued });
      } catch (e) {
        results.push({ user_id: m.user_id, ok: false, error: e.message });
      }
    }
    const record = {
      message_id: `local_${gid}_${Date.now()}`,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: this.local.profile.accountId, nickname: this.local.profile.nickname || '我' },
      user_id: this.local.profile.accountId,
      group_id: gid,
      message: segs,
      raw_message: '',
      self_sent: true
    };
    try { this.store.append(`g${gid}`, record); } catch (e) { this.log(`群消息落盘失败：${e.message}`, 'warn'); }
    this._broadcast({ type: 'self-msg', chatKey: `g${gid}`, record });
    return { results, failed: results.filter((r) => !r.ok).length };
  }

  // ---------- 跨网穿透（OpenP2P，可选） ----------
  /** 令牌变化或联系人变化后重建隧道：每个联系人一条 127.0.0.1:131xx → 对方 3021。 */
  _refreshRelay() {
    const token = this.local.settings?.openp2pToken;
    if (!token) { this.openp2p.stop(); return; }
    const ids = this.local.friends.map((f) => String(f.user_id));
    const relayMap = this.openp2p.start(token, this.local.profile.accountId, ids);
    for (const [id, addr] of Object.entries(relayMap)) this.link.setEndpoint(id, addr);
  }

  /** 穿透进程守护：异常退出（被安全软件杀、网络切换崩溃）后 30 秒内自动重启。 */
  _watchRelay() {
    this._relayTimer = setInterval(() => {
      if (!this.local.settings?.openp2pToken) return;
      if (!this.openp2p.proc) this._refreshRelay();
    }, 30000);
  }

  _setOpenP2pToken({ token } = {}) {
    const t = String(token ?? '').trim();
    if (!this.local.settings) this.local.settings = {};
    this.local.settings.openp2pToken = t;
    this._saveLocal();
    this._refreshRelay();
    this.log(t ? '跨网穿透已启用' : '跨网穿透已停用', 'info');
    return { enabled: !!t };
  }

  // ---------- 多令牌管理（保存多个 OpenP2P 令牌，随时切换当前使用的那个）----------
  _tokens() {
    if (!this.local.settings) this.local.settings = {};
    if (!Array.isArray(this.local.settings.openp2pTokens)) this.local.settings.openp2pTokens = [];
    return this.local.settings.openp2pTokens;
  }
  _maskToken(t) {
    const s = String(t ?? '');
    return s.length <= 8 ? '••••' : s.slice(0, 3) + '••••' + s.slice(-3);
  }
  _listTokens() {
    const list = this._tokens();
    const active = this.local.settings?.openp2pToken ?? '';
    return {
      activeId: list.find((x) => x.token === active)?.id ?? '',
      tokens: list.map((x) => ({ id: x.id, name: x.name || '未命名', masked: this._maskToken(x.token), active: x.token === active }))
    };
  }
  _addToken({ name, token } = {}) {
    const t = String(token ?? '').trim();
    if (!t) throw new Error('令牌不能为空');
    const list = this._tokens();
    if (list.some((x) => x.token === t)) throw new Error('这个令牌已经保存过了');
    const item = { id: `tk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: String(name ?? '').trim() || `令牌 ${list.length + 1}`, token: t };
    list.push(item);
    // 第一个令牌自动启用
    if (!this.local.settings.openp2pToken) this.local.settings.openp2pToken = t;
    this._saveLocal();
    if (this.local.settings.openp2pToken === t) this._refreshRelay();
    return this._listTokens();
  }
  _switchToken({ id } = {}) {
    const list = this._tokens();
    const item = list.find((x) => x.id === id);
    if (!item) throw new Error('找不到这个令牌');
    this.local.settings.openp2pToken = item.token;
    this._saveLocal();
    this._refreshRelay();
    this.log(`已切换到令牌：${item.name}`, 'info');
    return this._listTokens();
  }
  _removeToken({ id } = {}) {
    const list = this._tokens();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('找不到这个令牌');
    const wasActive = list[idx].token === this.local.settings.openp2pToken;
    list.splice(idx, 1);
    if (wasActive) {
      this.local.settings.openp2pToken = list.length ? list[0].token : '';
    }
    this._saveLocal();
    this._refreshRelay();
    return this._listTokens();
  }

  // ---------- 本机数据（账号/联系人/群，全部留在本机） ----------
  _localPath() { return path.join(this.store.dataDir, 'contacts.json'); }
  _loadLocal() {
    try {
      const j = JSON.parse(fs.readFileSync(this._localPath(), 'utf8'));
      this.local = {
        profile: j.profile ?? null,
        friends: Array.isArray(j.localFriends) ? j.localFriends : [],
        groups: Array.isArray(j.localGroups) ? j.localGroups : [],
        settings: j.settings ?? {}
      };
    } catch { this.local = { profile: null, friends: [], groups: [], settings: {} }; }
  }
  _saveLocal() {
    try {
      fs.writeFileSync(this._localPath(), JSON.stringify({
        profile: this.local.profile,
        localFriends: this.local.friends,
        localGroups: this.local.groups,
        settings: this.local.settings ?? {}
      }, null, 1));
    } catch (e) { this.log(`本机数据保存失败：${e.message}`, 'warn'); }
  }

  // ---------- 已读 / 未读 ----------
  _readMarksPath() { return path.join(this.store.dataDir, 'read-marks.json'); }

  _loadReadMarks() {
    try {
      const j = JSON.parse(fs.readFileSync(this._readMarksPath(), 'utf8'));
      const m = new Map();
      for (const [k, v] of Object.entries(j ?? {})) if (Number(v) > 0) m.set(k, Number(v));
      return m;
    } catch { return new Map(); }
  }

  _saveReadMarks() {
    try {
      fs.writeFileSync(this._readMarksPath(), JSON.stringify(Object.fromEntries(this.readMarks), null, 1));
    } catch (e) { this.log(`已读标记保存失败：${e.message}`, 'warn'); }
  }

  /** 给某条记录补上 read 字段：自发消息且时间不晚于"对方读到的时刻"才算已读。群聊不做回执。 */
  _withRead(chatKey, record) {
    if (!record?.self_sent || !/^p\d+$/.test(String(chatKey))) return record;
    const upTo = this.readMarks.get(chatKey) ?? 0;
    const read = Number(record.time ?? 0) <= upTo;
    return record.read === read ? record : { ...record, read };
  }

  /** 打开会话时调用：告诉对方「我看到这里了」。离线则挂起，对方上线补发。 */
  _sendReadReceipt(chatKey) {
    const m = /^p(\d+)$/.exec(String(chatKey));
    if (!m) return;                                   // 群聊暂不做回执（多成员语义不同）
    const uid = m[1];
    if (!this.local.friends.some((f) => String(f.user_id) === uid)) return;
    const ts = Math.floor(Date.now() / 1000);
    if ((this._readSent.get(chatKey) ?? 0) >= ts) return; // 同一秒内重复触发不必重发
    if (this.link.sendRead(uid, ts)) {
      this._readSent.set(chatKey, ts);
      this._readPending.delete(chatKey);
    } else {
      this._readPending.set(chatKey, ts);             // 对方不在线：等 peer-online 补发
    }
  }

  _flushReadPending(chatKey) {
    const ts = this._readPending.get(chatKey);
    if (!ts) return;
    const m = /^p(\d+)$/.exec(chatKey);
    if (m && this.link.sendRead(m[1], ts)) { this._readPending.delete(chatKey); this._readSent.set(chatKey, ts); }
  }

  /** 对方读了：更新标记并通知界面（界面只改自己发的消息，不动聊天内容）。 */
  _onPeerRead(from, ts) {
    const key = `p${from}`;
    const cur = this.readMarks.get(key) ?? 0;
    if (!ts || ts <= cur) return;
    this.readMarks.set(key, ts);
    this._saveReadMarks();
    this._broadcast({ type: 'read', chatKey: key, upTo: ts });
  }

  // ---------- 撤回（目前只支持"还没发出去"的消息） ----------
  _recalledPath() { return path.join(this.store.dataDir, 'recalled.json'); }

  _loadRecalled() {
    const m = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(this._recalledPath(), 'utf8'));
      for (const [k, arr] of Object.entries(j ?? {})) m.set(k, new Set((Array.isArray(arr) ? arr : []).map(String)));
    } catch { /* 没有就空着 */ }
    return m;
  }

  _saveRecalled() {
    try {
      const j = {};
      for (const [k, s] of this.recalled) if (s.size) j[k] = [...s];
      fs.writeFileSync(this._recalledPath(), JSON.stringify(j, null, 1));
    } catch (e) { this.log(`撤回标记保存失败：${e.message}`, 'warn'); }
  }

  // ---------- 下载登记（回答"下没下过"，重启后仍然记得） ----------
  _downloadsDonePath() { return path.join(this.store.dataDir, 'downloads-done.json'); }

  _loadDownloadsDone() {
    const m = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(this._downloadsDonePath(), 'utf8'));
      for (const [k, v] of Object.entries(j ?? {})) if (v && typeof v === 'object') m.set(String(k), v);
    } catch { /* 没有就空着 */ }
    return m;
  }

  _saveDownloadsDone() {
    try {
      fs.writeFileSync(this._downloadsDonePath(), JSON.stringify(Object.fromEntries(this.downloadsDone), null, 1));
    } catch (e) { this.log(`下载登记保存失败：${e.message}`, 'warn'); }
  }

  /** 撤回一条还没发出去的消息：从发件箱删掉 + 本机标记"已撤回"。已发出的不支持。 */
  _recallMessage({ chatKey, messageId } = {}) {
    const key = String(chatKey ?? '');
    if (!/^[pg]\d+$/.test(key)) throw new Error('非法会话');
    const mid = String(messageId ?? '');
    const rec = this.store.findById(key, mid);
    if (!rec) throw new Error('消息不存在');
    if (!rec.self_sent) throw new Error('只能撤回自己发的消息');
    if (this.recalled.get(key)?.has(mid)) return { ok: true, cancelled: true };
    const uid = key.slice(1);
    // 唯一准许条件：还在发件箱里（一次都没发出去）。已发出待确认的也不行——对方可能已经收到。
    if (!this.link.isQueued(uid, mid)) throw new Error('消息已发出，暂不支持撤回');
    this.link.cancelQueued(uid, mid);
    let set = this.recalled.get(key);
    if (!set) this.recalled.set(key, set = new Set());
    set.add(mid);
    this._saveRecalled();
    this._broadcast({ type: 'recalled', chatKey: key, messageId: mid });
    return { ok: true, cancelled: true };
  }

  /** 保存聊天图片（灯箱里的"保存图片"）：dataURL 解码落盘到下载目录。 */
  _saveImage({ dataUrl, name } = {}) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl ?? ''));
    if (!m) throw new Error('不是有效的图片数据');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : (m[1].split('+')[0] || 'png');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('图片数据为空');
    // 图片统一按精确时间命名：IMG_20261127-201447.png（秒级时间戳，重名由 _uniqueDownloadPath 兜底）
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    const withExt = `IMG_${stamp}.${ext}`;
    const dest = this._uniqueDownloadPath(withExt);
    fs.writeFileSync(dest, buf);
    const where = `${path.basename(this.downloadsDir)}/${path.basename(dest)}`;
    return { where, path: dest, size: buf.length };
  }

  /** 打开文件所在位置：资源管理器定位并选中该文件（Windows）。 */
  _openLocation({ path } = {}) {
    const p = String(path ?? '').trim().replace(/"/g, '');
    if (!p || !fs.existsSync(p)) throw new Error('文件不存在或尚未保存');
    spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }

  /** 历史消息统一标注：撤回标记 + 已读状态 + 是否仍未送达 + 文件卡片的"下没下过"。 */
  _annotate(chatKey, record) {
    if (!record) return record;
    let r = this._withRead(chatKey, record);
    if (this.recalled.get(chatKey)?.has(String(r.message_id))) r = { ...r, recalled: true };
    if (/^p\d+$/.test(chatKey) && r.self_sent && !r.recalled) {
      const stillPending = this.link.isPending(chatKey.slice(1), String(r.message_id));
      r = { ...r, queued: stillPending };
    }
    // 文件卡片补上"已保存"信息（卡片本体不含状态，下载登记里有就带上）
    if (Array.isArray(r.message)) {
      let changed = false;
      const segs = r.message.map((seg) => {
        if (seg?.type !== 'file' || !seg.data?.file_id) return seg;
        const done = this.downloadsDone.get(String(seg.data.file_id));
        if (!done || seg.data.downloaded) return seg;
        changed = true;
        return { ...seg, data: { ...seg.data, downloaded: true, where: done.where, dpath: done.path } };
      });
      if (changed) r = { ...r, message: segs };
    }
    return r;
  }

  _helloPayload() {
    return {
      type: 'hello',
      self: { ...this.local.profile },
      friends: this.local.friends,
      groups: this.local.groups,
      chats: this._chatSummaries(),
      peers: this.link.onlineMap()
    };
  }
  _broadcastHello() { this._broadcast(this._helloPayload()); }

  // ---------- P2P 事件 ----------
  /** 收到对方设备的消息：只有手动添加过的联系人才收（完全独立，不认陌生人）。 */
  _onPeerMessage(m) {
    const key = `p${m.from}`;
    const contact = this.local.friends.find((f) => String(f.user_id) === m.from);
    if (!contact) { this.log(`忽略来自未知账号 ${m.from} 的消息`); return; }
    const record = {
      message_id: m.id,
      time: m.time,
      sender: { user_id: Number(m.from), nickname: contact.remark || contact.nickname || `账号 ${m.from}` },
      user_id: Number(m.from),
      message: m.segs,
      raw_message: ''
    };
    try { this.store.append(key, record); } catch (e) { this.log(`落盘失败：${e.message}`, 'warn'); }
    this.unread.set(key, (this.unread.get(key) ?? 0) + 1);
    this._broadcast({ type: 'event', chatKey: key, record, unread: Object.fromEntries(this.unread), chats: this._chatSummaries() });
  }

  /** 对方资料自报：更新联系人昵称/头像（备注优先，不被覆盖）。 */
  _onPeerProfile({ accountId, nickname, avatar }) {
    const f = this.local.friends.find((x) => String(x.user_id) === String(accountId));
    if (!f) return;
    let changed = false;
    if (nickname && !f.nickname) { f.nickname = nickname; changed = true; }
    if (avatar && avatar !== f.avatar) { f.avatar = avatar; changed = true; }
    if (changed) { this._saveLocal(); this._broadcastHello(); }
  }

  /** SnowLuma 注入通道（可选）推来的消息：只收不发，只认联系人。发送一律走 P2P。 */
  _onObEvent(ev) {
    if (ev?.post_type !== 'message') return; // message_sent / 群消息 / 其它事件一律忽略
    if (ev.message_type !== 'private') return;
    this._onPeerMessage({
      from: String(ev.user_id ?? ''),
      to: String(this.local.profile.accountId),
      time: ev.time ?? Math.floor(Date.now() / 1000),
      segs: Array.isArray(ev.message) ? ev.message : [],
      id: `ob_${ev.message_id ?? Date.now()}`
    });
  }

  /** 本机会话摘要（供界面左侧列表）——只认本机联系人/本地群，与 QQ 数据完全隔离。 */
  _chatSummaries() {
    const valid = new Set([
      ...this.local.friends.map((f) => `p${f.user_id}`),
      ...this.local.groups.map((g) => `g${g.group_id}`)
    ]);
    return this.store.listChats()
      .filter((c) => valid.has(c.chatKey))
      .map((c) => ({
        chatKey: c.chatKey,
        lastTime: c.lastTime,
        lastPreview: previewOf(c.lastRecord),
        unread: this.unread.get(c.chatKey) ?? 0
      }));
  }
}
