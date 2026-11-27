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
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PeerLink } from './p2p.js';
import { OpenP2PManager } from './openp2p.js';
import { chatKeyOf, previewOf } from './message-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Bridge {
  /**
   * @param {object} opts
   * @param {import('./store.js').LocalStore} opts.store
   * @param {{host:string,port:string|number}} opts.listen 界面服务监听（只给本机界面）
   * @param {{host:string,port:number}} opts.p2p P2P 内核监听（0.0.0.0 才能接受外部设备）
   * @param {import('./onebot-client.js').OneBotClient|null} [opts.ob] 可选 SnowLuma 注入通道
   * @param {function} [opts.log]
   */
  constructor({ store, listen, p2p, ob = null, log = () => {} }) {
    this.store = store;
    this.listen = listen;
    this.p2pCfg = p2p;
    this.ob = ob;
    this.log = log;
    this.uiToken = crypto.randomBytes(16).toString('hex');
    this.uiSockets = new Set();
    this.unread = new Map(); // chatKey -> count
    this.local = { profile: null, friends: [], groups: [] };
    this._loadLocal();
    if (!this.local.profile) {
      // 账号认设备：首次运行自动生成本机账号 ID，无需注册
      this.local.profile = { accountId: Math.floor(100000000 + Math.random() * 900000000), nickname: '', avatar: '' };
      this._saveLocal();
    }
    this.link = new PeerLink({ selfId: this.local.profile.accountId, listen: p2p, log });
    // 跨网穿透（OpenP2P，可选）：联系人里每个账号建一条 127.0.0.1:131xx → 对方 3021 的隧道
    this.openp2p = new OpenP2PManager({
      exePath: path.join(__dirname, '..', 'bin', 'openp2p.exe'),
      workDir: path.join(this.store.dataDir, 'openp2p'),
      log
    });
    // 文件传输：outFiles = 我发出去的（对方来拉）；downloads = 我正在收的
    this.filesDir = path.join(this.store.dataDir, 'files');
    this.downloadsDir = path.join(this.store.dataDir, 'downloads');
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
      res.writeHead(200, { 'content-type': mime });
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
        this._sendUi(ws, { type: 'history', chatKey: msg.chatKey, messages: this.store.read(msg.chatKey, msg.limit ?? 50), source: 'local' });
        return;
      }
      case 'read': {
        this.unread.set(msg.chatKey, 0);
        this._broadcast({ type: 'unread', unread: Object.fromEntries(this.unread) });
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
      case 'download-file': return this._downloadFile(p);
      case 'peers': return { peers: this.link.onlineMap() };
      case 'set-openp2p-token': return this._setOpenP2pToken(p);
      case 'relay-status': return {
        tokenSet: !!this.local.settings?.openp2pToken,
        ...this.openp2p.info()
      };
      default: throw new Error(`未知操作：${name}`);
    }
  }

  _setProfile({ nickname, avatar } = {}) {
    if (nickname !== undefined) this.local.profile.nickname = String(nickname).trim().slice(0, 30);
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
      queued: !!queued
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
    if (this.downloads.has(fid)) return { started: true, exists: true };
    const total = Math.max(0, Number(size) || 0);
    const safe = String(name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
    const dest = this._uniqueDownloadPath(safe);
    const job = {
      peerId, fileId: fid, name: safe, size: total, chunkSize: 512 * 1024,
      dest,
      ws: fs.createWriteStream(dest),
      seq: 0, nextWrite: 0, buf: new Map(),
      got: 0, inFlight: new Set(), done: false, eofSeen: false, lastProgress: Date.now()
    };
    this.downloads.set(fid, job);
    this._reqMoreChunks(job);
    job.watchdog = setInterval(() => {
      if (Date.now() - job.lastProgress > 90000) this._abortDownload(fid, '传输超时');
    }, 15000);
    this.log(`开始下载 ${safe}（来自 ${peerId}）`);
    return { started: true };
  }

  /** 并发窗口：同时挂 6 个块请求在管道里（多路并行，管道满载）。 */
  _reqMoreChunks(job) {
    if (job.done || job.eofSeen) return;
    const WINDOW = 6;
    while (job.inFlight.size < WINDOW) {
      const offset = job.seq * job.chunkSize;
      if (job.size && offset >= job.size) return;
      const seq = job.seq++;
      job.inFlight.add(seq);
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
      this._broadcast({ type: 'file-done', fileId: job.fileId, name: job.name, path: job.dest, size: job.size });
      this.log(`文件已保存：${job.dest}`);
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
        const info = this.outFiles.get(fid);
        if (!info) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件不存在' }); return; }
        const seq = Number(f.seq) | 0;
        if (seq < 0) return;
        const chunkSize = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, Number(f.chunkSize) || 512 * 1024));
        const file = path.resolve(this.filesDir, fid);
        // 路径归属校验：fileId 必须真的落在 filesDir 里，防止对端用 .. 穿越读任意文件
        if (!file.startsWith(path.resolve(this.filesDir) + path.sep)) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件不存在' }); return; }
        const buf = Buffer.alloc(chunkSize);
        fs.open(file, 'r', (err, fd) => {
          if (err) { this.link.sendFrame(from, { type: 'file-abort', fileId: fid, reason: '文件读取失败' }); return; }
          fs.read(fd, buf, 0, chunkSize, seq * chunkSize, (err2, n) => {
            fs.close(fd, () => {});
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
