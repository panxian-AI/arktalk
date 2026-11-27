// ArkTalk 自研 P2P 传输内核。
//
// 设备之间直接以 WebSocket 互连（局域网直连；之后由内置 OpenP2P 提供跨网穿透）。
// 与 QQ / SnowLuma / OneBot 无任何数据沟通——这是一套完全独立的协议。
//
// 协议（JSON 帧）：
//   连接建立后第一帧（双向都发）：{ v:1, type:'hello', accountId, nickname, avatar }
//   消息：  { v:1, type:'msg', id, from, to, time, segs }
//   确认：  { v:1, type:'ack', id }            （收到 msg 后立即回；发送方收到 ack 才算送达）
//   已读：  { v:1, type:'read', ts }           （我读完了截至 ts 的来自你的消息——已读回执）
//   资料：  { v:1, type:'profile', accountId, nickname, avatar }   （资料变更时推送）
//   文件：  { v:1, type:'file-req', fileId, seq, chunkSize }        （接收方要第 seq 块）
//           { v:1, type:'file-chunk', fileId, seq, data }           （发送方回 base64 块）
//           { v:1, type:'file-done', fileId } / { type:'file-abort', fileId, reason }
//           接收方点"保存"才开始拉取，窗口并发请求（多路并行），发送方只需存好文件待取
//
// 可靠性：发出后未收到 ack 的消息进入离线发件箱，对端可达后自动补发。
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PROTO = 1;

// ---------- 连接策略参数（借鉴 ICE / libp2p DCUtR 的做法） ----------
// 旧实现：每 5s 轮换拨一个地址，5 个候选里只有 1 条隧道是通的，
// 于是「失败 → 报离线 → 灰 → 下一轮拨到隧道 → 绿」反复循环，就是肉眼看到的绿灰交替。
// 新实现：同时拨最多 3 个候选（错开 180ms），谁先完成 hello 谁赢，其余立刻关掉；
// 掉线不立刻报离线，给 2.5s 竞速窗口自己接回来。
const MAX_RACE = 3;        // 同轮并行候选数
const RACE_STAGGER = 180;  // 候选之间错开（ms），避免同一瞬间三个 SYN
const HANDSHAKE_MS = 4500; // 单个候选的握手超时
const OFFLINE_GRACE = 2500;// 掉线滞后（ms）：这段时间内接回来就不报离线
const DEDUPE_MAX = 600;    // 消息去重窗口（条）

// ---------- 半开连接（zombie）识别 ----------
// 手机切网/隧道静默断开时，TCP 层收不到 FIN：本端 ws 的 readyState 会永远是 1。
// 旧实现只 ws.ping() 不检查 pong，于是电脑端把"已经死掉的连接"当成在线，
// 而手机重新拨进来时又被"较小 accountId 发起者优先"的仲裁规则踢掉（4003 duplicate）——
// 表现就是「手机看不到电脑在线，电脑却一直显示手机在线」，且永远自愈不了。
const PING_EVERY = 12000;  // 每 12s 探一次（ws 层 ping，对方 ws 栈自动回 pong）
const DEAD_MS = 40000;     // 超过 40s 没收到任何帧/ pong → 判定半开，直接 terminate 触发重连
const STALE_MS = 20000;    // 仲裁用：超过 20s 没动静的旧连接不再享有"优先保留"特权

export class PeerLink {
  /**
   * @param {object} opts
   * @param {number|string} opts.selfId 本机设备账号
   * @param {{host:string,port:number}} opts.listen 监听地址（host 用 0.0.0.0 才能接受外部设备）
   * @param {function} [opts.log]
   * 事件（on/off/emit）：
   *   'peer-online'  (accountId)
   *   'peer-offline' (accountId)
   *   'message'      ({ from, to, time, segs, id })
   *   'profile'      ({ accountId, nickname, avatar })
   */
  constructor({ selfId, listen, log = () => {} }) {
    this.selfId = String(selfId);
    this.listen = listen;
    this.log = log;
    this.peers = new Map();      // accountId -> ws（当前在线的直连）
    this.outbox = new Map();     // accountId -> [envelope]（未 ack 的排队消息）
    this.endpoints = new Map();  // accountId -> ['host:port', ...]（要主动连的对端地址，可多个轮换）
    this._epIdx = new Map();     // 保留兼容（旧轮换下标，已不参与决策）
    this._out = new Map();       // accountId -> ws（出站连接，可能与 peers 里同一条）
    this._retry = new Map();     // accountId -> timer
    // 地址健康度：accountId -> Map(ep -> { ok, fail, rtt, cool, lastOk })
    // 成功的地址置顶，失败的指数退避冷却——不再"每次轮换都先撞一遍死地址"
    this._score = new Map();
    this._race = new Map();      // accountId -> 本轮竞速对象
    this._offTimer = new Map();  // accountId -> 掉线滞后 timer
    this._fail = new Map();      // accountId -> 连续失败轮数（重试退避用）
    this._seen = new Map();      // accountId -> Set(msgId)（重发导致的重复消息过滤）
    this._server = null;
    this._listeners = new Map();
    this._stopped = false;
    this._sweep = null;          // 周期补拨定时器
    this._ping = null;           // 保活探测定时器
  }

  on(ev, fn) { (this._listeners.get(ev) ?? this._listeners.set(ev, new Set()).get(ev)).add(fn); return this; }
  emit(ev, ...args) { for (const fn of this._listeners.get(ev) ?? []) { try { fn(...args); } catch (e) { this.log(`事件 ${ev} 处理失败：${e.message}`, 'warn'); } } }

  start() {
    this._stopped = false;
    this._server = new WebSocketServer({ host: this.listen.host, port: this.listen.port });
    // 周期自愈：每 10s 扫一遍已知地址，没连上的自动补拨——对方后上线也能自动恢复在线
    this._sweep = setInterval(() => {
      if (this._stopped) return;
      for (const id of this.endpoints.keys()) {
        if (!this.peers.has(id) && !this._out.has(id)) this._dial(id);
      }
    }, 10000);
    // 保活探测：每 12s ping 一遍所有连接，并按"最后一次收到帧/pong 的时间"清理半开连接。
    // 注意：只 ping 不检查 pong 等于没探测——半开连接会一直 readyState===1，把对端永久锁成"在线"。
    this._ping = setInterval(() => {
      const now = Date.now();
      for (const ws of new Set([...this.peers.values(), ...this._out.values()])) {
        if (ws.readyState !== 1) continue;
        const last = ws._lastRx ?? ws._openAt ?? now;
        if (now - last > DEAD_MS) {
          this.log(`连接 ${ws._peerId ?? '(未握手)'} 已 ${Math.round((now - last) / 1000)}s 无响应，判定半开并强制关闭`, 'warn');
          try { ws.terminate(); } catch { /* close 会跟着来 */ }
          continue;
        }
        try { ws.ping(); } catch { /* close 会跟着来 */ }
      }
    }, PING_EVERY);
    return new Promise((resolve, reject) => {
      this._server.once('error', (err) => {
        if (err?.code === 'EADDRINUSE') reject(new Error(`P2P 端口 ${this.listen.port} 已被占用，改 config.json p2p.port`));
        else reject(err);
      });
      this._server.on('connection', (ws, req) => this._setup(ws, 'inbound', req));
      this._server.on('listening', () => {
        this.log(`P2P 内核：监听 ${this.listen.host}:${this.listen.port}`);
        resolve();
      });
    });
  }

  stop() {
    this._stopped = true;
    clearInterval(this._sweep); clearInterval(this._ping);
    for (const t of this._retry.values()) clearTimeout(t);
    this._retry.clear();
    for (const ws of new Set([...this.peers.values(), ...this._out.values()])) { try { ws.close(1001, 'bye'); } catch { /* ignore */ } }
    this.peers.clear(); this._out.clear();
    return new Promise((r) => this._server?.close(() => r()));
  }

  /**
   * 登记/更新对端地址，并（若未连）发起出站连接 + 周期重试。
   * endpoint 支持多个地址（逗号/空格分隔），拨号失败自动轮换下一个——
   * 适配网络环境变化（换 WiFi、DHCP 换 IP，对方多网卡等）。
   * @returns {boolean} 是否新增了地址
   */
  setEndpoint(accountId, endpoint) {
    const id = String(accountId);
    const list = String(endpoint ?? '')
      .split(/[\s,;，；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^\d{1,3}(\.\d{1,3}){3}:?\d*$|^\[[0-9a-f:]+\](:\d+)?$/.test(s) || s.includes(':')
        ? (s.includes(':') ? s : `${s}:3021`)
        : `${s}:3021`));
    if (!list.length) return false;
    const cur = this.endpoints.get(id) ?? [];
    let added = false;
    for (const a of list) {
      if (!cur.includes(a)) { cur.push(a); added = true; }
    }
    if (!added) return false;
    this.endpoints.set(id, cur);
    if (!this.peers.has(id) && !this._out.has(id)) this._dial(id);
    return true;
  }

  /** 当前是否与某账号直连在线（宽限期内仍算在线，避免圆点闪灰）。 */
  isOnline(accountId) {
    const id = String(accountId);
    const ws = this.peers.get(id);
    if (ws && ws.readyState === 1) return true;
    return this._offTimer.has(id);
  }
  onlineMap() {
    const m = {};
    for (const [id, ws] of this.peers) m[id] = ws.readyState === 1;
    for (const id of this._offTimer.keys()) if (!(id in m)) m[id] = true;
    return m;
  }

  /** 诊断：每个账号的候选地址、健康度与在线状态（排查"绿灰交替"用）。 */
  linkStats() {
    const ids = new Set([...this.endpoints.keys(), ...this.peers.keys(), ...this._score.keys()]);
    const out = {};
    const now = Date.now();
    for (const id of ids) {
      const m = this._score.get(id);
      out[id] = {
        online: this.isOnline(id),
        race: this._race.has(id),
        endpoints: this.endpoints.get(id) ?? [],
        // 现役连接最后一次"有动静"距今多久（>20s 说明可能半开；>40s 会被强制清理）
        silentMs: this.peers.has(id) ? Math.max(0, now - (this.peers.get(id)._lastRx ?? now)) : null,
        cands: m ? [...m.entries()].map(([ep, v]) => ({
          ep, ok: v.ok, fail: v.fail, rtt: v.rtt, cool: Math.max(0, v.cool - now),
        })) : [],
      };
    }
    return out;
  }

  /** 发送一条消息。在线即发；离线入发件箱，可达后补发。返回 { queued }。 */
  send(accountId, segs, time = Math.floor(Date.now() / 1000)) {
    const id = String(accountId);
    const envelope = { v: PROTO, type: 'msg', id: crypto.randomUUID(), from: this.selfId, to: id, time, segs };
    const ws = this.peers.get(id);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(envelope));
      this._awaitAck(ws, envelope);
      return { queued: false, envelope };
    }
    const q = this.outbox.get(id) ?? this.outbox.set(id, []).get(id);
    q.push(envelope);
    if (!this.peers.has(id) && !this._out.has(id) && this.endpoints.has(id)) this._dial(id);
    return { queued: true, envelope };
  }

  /** 主动向对端推送自己的最新资料。 */
  pushProfile(accountId, profile) {
    const ws = this.peers.get(String(accountId));
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ v: PROTO, type: 'profile', accountId: this.selfId, nickname: profile.nickname ?? '', avatar: profile.avatar ?? '' }));
    }
  }

  /**
   * 直发一帧（不排队、不落发件箱）。文件分块传输等在线才能做的事用这个。
   * @returns {boolean} 是否真的发出去了（对端不在线返回 false）
   */
  sendFrame(accountId, frame) {
    const ws = this.peers.get(String(accountId));
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ v: PROTO, ...frame }));
    return true;
  }

  /** 已读回执：告诉对方「我读完了截至 ts 的、来自你的消息」。离线时静默丢弃（下次打开会重发）。 */
  sendRead(accountId, ts = Math.floor(Date.now() / 1000)) {
    const ws = this.peers.get(String(accountId));
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify({ v: PROTO, type: 'read', ts })); return true; } catch { return false; }
  }

  /** 消息是否还在发件箱里（从未发出去过）——"未发出撤回"的唯一准许条件。 */
  isQueued(accountId, messageId) {
    return this.outbox.get(String(accountId))?.some((e) => e.id === messageId) ?? false;
  }

  /** 消息是否还没送达（在发件箱或已发出待 ack 队列里）。 */
  isPending(accountId, messageId) {
    const id = String(accountId);
    if (this.isQueued(id, messageId)) return true;
    return this.peers.get(id)?._pendingAck?.some((e) => e.id === messageId) ?? false;
  }

  /** 撤回"还没发出去"的消息：从发件箱与待确认队列里删掉。返回是否真的删了。 */
  cancelQueued(accountId, messageId) {
    const id = String(accountId);
    let removed = false;
    const q = this.outbox.get(id);
    if (q) {
      const i = q.findIndex((e) => e.id === messageId);
      if (i >= 0) { q.splice(i, 1); removed = true; }
    }
    const ws = this.peers.get(id);
    if (ws?._pendingAck?.length) {
      const i = ws._pendingAck.findIndex((e) => e.id === messageId);
      if (i >= 0) { ws._pendingAck.splice(i, 1); removed = true; }
    }
    return removed;
  }

  // ---------- 内部 ----------
  /** 每条连接只发一次 hello（旧实现会与对端互相回环，形成无限握手风暴）。 */
  _hello(ws) {
    if (ws._helloSent) return;
    ws._helloSent = true;
    try { ws.send(JSON.stringify({ v: PROTO, type: 'hello', accountId: this.selfId })); } catch { /* ignore */ }
  }

  _setup(ws, side, req) {
    ws._side = side;
    ws._peerId = null;
    ws._openAt = Date.now();
    ws._lastRx = Date.now();   // 最后一次"收到任何东西"的时间（帧或 pong），半开连接判定用
    // 入站连接记录来源 IP：对方换网后自动更新地址（带事件通知上层落盘）
    if (req?.socket?.remoteAddress) {
      ws._remoteIp = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
    }
    ws.on('pong', () => { ws._lastRx = Date.now(); });
    ws.on('message', (raw) => {
      ws._lastRx = Date.now();
      let f;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (!f || f.v !== PROTO) return;
      // 一帧处理出错不能冒泡成 uncaughtException（那会直接杀进程 = 界面闪退），
      // 也不能让这条连接的后续帧全部失效。
      try { this._onFrame(ws, f); }
      catch (e) { this.log(`处理来帧失败（已隔离）：${e?.message || e}`, 'warn'); }
    });
    this._bindLifecycle(ws);
  }

  _onFrame(ws, f) {
    switch (f.type) {
        case 'hello': {
          const peerId = String(f.accountId ?? '');
          if (!peerId || peerId === this.selfId) { ws.close(4002, 'bad hello'); return; }
          // 关键：hello 是"握手"不是"心跳"。旧实现收到 hello 就回一条 hello，
          // 两端会互相无限回环（实测每秒数万条），把隧道带宽全部吃光——这正是"消息收不到、绿灰交替"的隐形元凶。
          // 同一条连接上重复 hello 一律忽略，且 hello 每条连接只发一次。
          if (ws._peerId === peerId) break;
          ws._peerId = peerId;
          // 多路竞速：谁先完成 hello 谁就是冠军，其余候选立刻关闭（先定胜负，再做连接仲裁）
          if (ws._race && !ws._race.done) this._winRace(ws._race, ws, ws._peerId);
          // 自动学习：对方连进来时记住它的 最新 IP（换网不用重新填地址）
          if (ws._side === 'inbound' && ws._remoteIp) {
            const learned = this._learnEndpoint(ws._peerId, ws._remoteIp);
            if (learned) this.emit('endpoint-learned', { accountId: ws._peerId, endpoint: learned });
          }
          // 同账号多连接仲裁：保留"由较小 accountId 一方发起"的连接（确定性，避免双向拨号互顶）
          // 但有例外：旧连接若已长时间没有任何动静（半开/对端早就不认这条了），
          // 必须让位给这条刚刚 hello 成功、已被证明活着的新连接——否则永远自愈不了。
          const old = this.peers.get(ws._peerId);
          if (old && old !== ws && old.readyState === 1) {
            const stale = this._isStale(old);
            const keep = stale ? ws : this._preferKeep(ws, old, ws._peerId);
            if (keep === old) { try { ws.close(4003, 'duplicate'); } catch { /* ignore */ } return; }
            if (stale) this.log(`旧连接 ${ws._peerId} 已失效（${Math.round((Date.now() - (old._lastRx ?? 0)) / 1000)}s 无响应），改用新连接`, 'warn');
            try { old.terminate(); } catch { /* ignore */ }
          }
          this.peers.set(ws._peerId, ws);
          if (ws._side === 'outbound') this._out.set(ws._peerId, ws);
          this._hello(ws);
          const pendingOff = this._offTimer.get(ws._peerId);
          if (pendingOff) { clearTimeout(pendingOff); this._offTimer.delete(ws._peerId); }
          this.emit('peer-online', ws._peerId);
          this._flushOutbox(ws._peerId);
          break;
        }
        case 'msg': {
          ws.send(JSON.stringify({ v: PROTO, type: 'ack', id: f.id }));
          if (ws._peerId && String(f.from) === ws._peerId) {
            // 重发（断线补发 / ack 丢失）会带来同 id 重复帧：去重窗口内只投递一次
            if (f.id && this._dupSeen(ws._peerId, String(f.id))) break;
            this.emit('message', { from: String(f.from), to: String(f.to), time: f.time ?? Math.floor(Date.now() / 1000), segs: Array.isArray(f.segs) ? f.segs : [], id: f.id });
          }
          break;
        }
        case 'ack': {
          const q = this.outbox.get(ws._peerId);
          if (q) {
            const i = q.findIndex((e) => e.id === f.id);
            if (i >= 0) q.splice(i, 1);
          }
          if (ws._pendingAck) {
            const i = ws._pendingAck.findIndex((e) => e.id === f.id);
            if (i >= 0) ws._pendingAck.splice(i, 1);
          }
          break;
        }
        case 'read': {
          // 已读回执：只认"本连接已握手的那一方"发的，防止伪造
          if (ws._peerId) this.emit('read', { from: ws._peerId, ts: Number(f.ts) || 0 });
          break;
        }
        case 'profile': {
          if (ws._peerId && String(f.accountId) === ws._peerId) {
            this.emit('profile', { accountId: ws._peerId, nickname: f.nickname ?? '', avatar: f.avatar ?? '' });
          }
          break;
        }
        default: {
          // 文件传输帧（file-req / file-chunk / file-done / file-abort）：原样交给上层
          if (String(f.type ?? '').startsWith('file-') && ws._peerId) {
            this.emit('fileframe', { from: ws._peerId, frame: f });
          }
          break;
        }
      }
  }

  _bindLifecycle(ws) {
    ws.on('close', () => {
      // 未完成 hello 的出站候选：失败计数与重试由 _dialOne 的 close 负责，这里不重复处理
      if (!ws._peerId) return;
      if (this.peers.get(ws._peerId) === ws) {
        this.peers.delete(ws._peerId);
        this._offlineLater(ws._peerId); // 掉线滞后：宽限期内接回来就不报离线
      }
      if (this._out.get(ws._peerId) === ws) this._out.delete(ws._peerId);
      // 立即安排重连，不等宽限期结束——宽限期只是"别急着改 UI"
      if (!this._stopped && !this.peers.has(ws._peerId)
        && (this.endpoints.has(ws._peerId) || (this.outbox.get(ws._peerId)?.length))) {
        this._scheduleRetry(ws._peerId);
      }
    });
    ws.on('error', () => { /* close 会跟着来 */ });
  }

  /** 学习到的对端地址（入站来源 IP + 对端 P2P 端口）。已存在则不重复。回环地址（OpenP2P 隧道来源）不学。 */
  _learnEndpoint(peerId, ip) {
    if (/^127\.|^::1$/.test(ip)) return null;
    const cur = this.endpoints.get(peerId) ?? [];
    const knownPort = cur.map((a) => a.split(':').pop()).find((p) => /^\d+$/.test(p));
    const cand = `${ip}:${knownPort ?? 3021}`;
    if (cur.includes(cand)) return null;
    cur.unshift(cand); // 最新地址排最前，优先拨
    this.endpoints.set(peerId, cur);
    return cand;
  }

  /** 双连接仲裁：保留由较小 accountId 一方发起的连接。clientOf = 该连接的发起方 id。 */
  _preferKeep(newWs, oldWs, peerId) {
    const clientOf = (w) => (w._side === 'outbound' ? String(this.selfId) : peerId);
    const a = clientOf(newWs), b = clientOf(oldWs);
    if (a !== b) return a < b ? newWs : oldWs;
    return oldWs; // 同向重复：保留旧连接
  }

  /** 这条连接是否已经"哑"了（长时间没收到任何帧或 pong）——半开连接的判定。 */
  _isStale(ws) {
    const last = ws._lastRx ?? ws._openAt ?? 0;
    return last > 0 && Date.now() - last > STALE_MS;
  }

  _awaitAck(ws, envelope) {
    (ws._pendingAck ??= []).push(envelope);
    // 发件箱兜底：10 秒没 ack 也排队（防半开连接）
    setTimeout(() => {
      const q = this.outbox.get(envelope.to) ?? this.outbox.set(envelope.to, []).get(envelope.to);
      if (q.some((e) => e.id === envelope.id)) return;
      const pend = ws._pendingAck ?? [];
      const i = pend.findIndex((e) => e.id === envelope.id);
      if (i >= 0) {
        pend.splice(i, 1);
        if (ws.readyState === 1) return; // 其实已经 ack 过只是乱序；保守起见仍可能丢——概率低，可接受
        q.push(envelope);
        this._scheduleRetry(envelope.to);
      }
    }, 10000);
  }

  _flushOutbox(accountId) {
    const ws = this.peers.get(accountId);
    const q = this.outbox.get(accountId);
    if (!ws || ws.readyState !== 1 || !q?.length) return;
    for (const e of [...q]) ws.send(JSON.stringify(e));
    // 等 ack 逐条清；这里把队首移交 pendingAck
    (ws._pendingAck ??= []).push(...q);
    this.outbox.set(accountId, []);
  }

  // ---------- 地址健康度（借鉴 ICE 的 candidate pair / libp2p 的地址排序） ----------
  _candOf(id, ep) {
    let m = this._score.get(id);
    if (!m) this._score.set(id, m = new Map());
    let s = m.get(ep);
    if (!s) m.set(ep, s = { ok: 0, fail: 0, rtt: 9999, cool: 0, lastOk: 0 });
    return s;
  }

  _scoreFail(id, ep) {
    const s = this._candOf(id, ep);
    s.fail += 1;
    // 指数退避：5s → 10s → 20s → 40s → 80s（封顶 2 分钟），别再每轮都去撞同一个死地址
    s.cool = Date.now() + Math.min(120000, 5000 * 2 ** Math.min(5, s.fail - 1));
  }

  _scoreOk(id, ep, rtt) {
    const s = this._candOf(id, ep);
    s.ok += 1; s.fail = 0; s.cool = 0; s.rtt = Math.max(1, rtt | 0); s.lastOk = Date.now();
  }

  /** 候选排序：未冷却 → 成功率高的 → 延迟低的；冷却中的按最早解冻时间排在后面。 */
  _rank(id, list) {
    const now = Date.now();
    const scored = list.map((ep) => ({ ep, s: this._candOf(id, ep) }));
    scored.sort((a, b) => {
      const ca = a.s.cool > now ? 1 : 0, cb = b.s.cool > now ? 1 : 0;
      if (ca !== cb) return ca - cb;
      if (ca === 1) return a.s.cool - b.s.cool;
      const ra = a.s.ok / Math.max(1, a.s.ok + a.s.fail);
      const rb = b.s.ok / Math.max(1, b.s.ok + b.s.fail);
      if (rb !== ra) return rb - ra;
      return (a.s.rtt || 9999) - (b.s.rtt || 9999);
    });
    return scored.map((x) => x.ep);
  }

  /**
   * 一轮拨号 = 一次"多路竞速"：同轮拨最多 3 个候选，谁先 hello 谁赢，其余立刻关。
   * 这样"能通的隧道地址"不会再被"拨不通的局域网地址"挡住 5 秒。
   */
  _dial(accountId) {
    const id = String(accountId);
    if (this._stopped) return;
    if (this._race.has(id)) return;                    // 本轮已在竞速
    const cur = this.peers.get(id);
    if (cur && cur.readyState === 1) return;           // 已有可用连接：保持粘性，不打扰
    const list = this.endpoints.get(id) ?? [];
    if (!list.length) return;
    const picks = this._rank(id, list).slice(0, MAX_RACE);
    const race = { id, done: false, pending: 0, socks: [], timers: [] };
    this._race.set(id, race);
    this.log(`拨号 ${id}：并行尝试 ${picks.join(' / ')}`, 'info');
    picks.forEach((ep, i) => {
      const t = setTimeout(() => {
        if (!race.done) this._dialOne(race, ep);
      }, i * RACE_STAGGER);
      race.timers.push(t);
    });
    // 整轮兜底：所有候选都没在时限内完成 hello → 收摊，按失败计
    race.deadline = setTimeout(() => {
      if (race.done) return;
      for (const ep of picks) this._scoreFail(id, ep);
      this._endRace(race);
    }, HANDSHAKE_MS + RACE_STAGGER * picks.length + 1200);
  }

  _dialOne(race, ep) {
    const id = race.id;
    let ws;
    try {
      ws = new WebSocket(`ws://${ep}`, { handshakeTimeout: HANDSHAKE_MS });
    } catch (e) {
      this._scoreFail(id, ep);
      return;
    }
    ws._dialEp = ep;
    ws._race = race;
    ws._dialT0 = Date.now();
    race.pending += 1;
    race.socks.push(ws);
    ws.on('open', () => { this._hello(ws); });
    ws.on('error', (e) => { if (!ws._peerId) this.log(`连接 ${ep} 失败：${e.message}`, 'warn'); });
    ws.on('close', () => {
      if (ws._peerId) return; // 已建连：交给 _setup 的 close 处理
      if (race.done) return;  // 竞速已结束（这条是落败候选）
      this._scoreFail(id, ep);
      race.pending -= 1;
      if (race.pending <= 0) this._endRace(race);
    });
    this._setup(ws, 'outbound');
  }

  /** 冠军产生：记录成功地址、关掉其余候选。 */
  _winRace(race, ws, peerId) {
    race.done = true;
    clearTimeout(race.deadline);
    for (const t of race.timers) clearTimeout(t);
    this._race.delete(race.id);
    this._scoreOk(peerId, ws._dialEp, Date.now() - (ws._dialT0 ?? Date.now()));
    this._fail.delete(race.id);
    for (const w of race.socks) {
      if (w === ws) continue;
      try { w.close(4004, 'race-loser'); } catch { /* ignore */ }
    }
  }

  /** 一轮全灭：收摊 + 退避重试。 */
  _endRace(race) {
    if (this._race.get(race.id) === race) this._race.delete(race.id);
    clearTimeout(race.deadline);
    for (const t of race.timers) clearTimeout(t);
    for (const w of race.socks) { try { w.close(4004, 'race-lost'); } catch { /* ignore */ } }
    if (!this.peers.has(race.id)) this._scheduleRetry(race.id);
  }

  /** 掉线滞后：宽限期内重连成功则不报离线（消除圆点闪灰）。 */
  _offlineLater(id) {
    if (this._offTimer.has(id)) return;
    const t = setTimeout(() => {
      this._offTimer.delete(id);
      if (!this.peers.has(id)) this.emit('peer-offline', id);
    }, OFFLINE_GRACE);
    this._offTimer.set(id, t);
  }

  /** 消息去重：断线补发 / ack 丢失会导致同 id 重复投递，窗口内只放行一次。 */
  _dupSeen(id, msgId) {
    let s = this._seen.get(id);
    if (!s) this._seen.set(id, s = new Set());
    if (s.has(msgId)) return true;
    s.add(msgId);
    if (s.size > DEDUPE_MAX) s.delete(s.values().next().value);
    return false;
  }

  _scheduleRetry(accountId) {
    if (this._stopped || this._retry.has(accountId)) return;
    const n = Math.min(4, this._fail.get(accountId) ?? 0);
    this._fail.set(accountId, n + 1);
    const wait = [1500, 3000, 6000, 12000, 20000][n];
    const t = setTimeout(() => {
      this._retry.delete(accountId);
      if (!this.peers.has(accountId)) this._dial(accountId);
    }, wait);
    this._retry.set(accountId, t);
  }
}
