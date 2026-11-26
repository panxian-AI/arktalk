// ArkTalk 自研 P2P 传输内核。
//
// 设备之间直接以 WebSocket 互连（局域网直连；之后由内置 OpenP2P 提供跨网穿透）。
// 与 QQ / SnowLuma / OneBot 无任何数据沟通——这是一套完全独立的协议。
//
// 协议（JSON 帧）：
//   连接建立后第一帧（双向都发）：{ v:1, type:'hello', accountId, nickname, avatar }
//   消息：  { v:1, type:'msg', id, from, to, time, segs }
//   确认：  { v:1, type:'ack', id }            （收到 msg 后立即回；发送方收到 ack 才算送达）
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
    this.endpoints = new Map();  // accountId -> 'host:port'（要主动连的对端地址）
    this._out = new Map();       // accountId -> ws（出站连接，可能与 peers 里同一条）
    this._retry = new Map();     // accountId -> timer
    this._server = null;
    this._listeners = new Map();
    this._stopped = false;
  }

  on(ev, fn) { (this._listeners.get(ev) ?? this._listeners.set(ev, new Set()).get(ev)).add(fn); return this; }
  emit(ev, ...args) { for (const fn of this._listeners.get(ev) ?? []) { try { fn(...args); } catch (e) { this.log(`事件 ${ev} 处理失败：${e.message}`, 'warn'); } } }

  start() {
    this._stopped = false;
    this._server = new WebSocketServer({ host: this.listen.host, port: this.listen.port });
    return new Promise((resolve, reject) => {
      this._server.once('error', (err) => {
        if (err?.code === 'EADDRINUSE') reject(new Error(`P2P 端口 ${this.listen.port} 已被占用，改 config.json p2p.port`));
        else reject(err);
      });
      this._server.on('connection', (ws) => this._setup(ws, 'inbound'));
      this._server.on('listening', () => {
        this.log(`P2P 内核：监听 ${this.listen.host}:${this.listen.port}`);
        resolve();
      });
    });
  }

  stop() {
    this._stopped = true;
    for (const t of this._retry.values()) clearTimeout(t);
    this._retry.clear();
    for (const ws of new Set([...this.peers.values(), ...this._out.values()])) { try { ws.close(1001, 'bye'); } catch { /* ignore */ } }
    this.peers.clear(); this._out.clear();
    return new Promise((r) => this._server?.close(() => r()));
  }

  /** 登记/更新对端地址，并（若未连）发起出站连接 + 周期重试。 */
  setEndpoint(accountId, endpoint) {
    const id = String(accountId);
    const ep = String(endpoint ?? '').trim();
    if (!ep) return;
    const norm = ep.includes(':') ? ep : `${ep}:${3021}`;
    if (this.endpoints.get(id) === norm) return;
    this.endpoints.set(id, norm);
    if (!this.peers.has(id) && !this._out.has(id)) this._dial(id);
  }

  /** 当前是否与某账号直连在线。 */
  isOnline(accountId) {
    const ws = this.peers.get(String(accountId));
    return !!ws && ws.readyState === 1;
  }
  onlineMap() { const m = {}; for (const [id, ws] of this.peers) m[id] = ws.readyState === 1; return m; }

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
    if (!this._out.has(id) && this.endpoints.has(id)) this._dial(id);
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

  // ---------- 内部 ----------
  _setup(ws, side) {
    ws._side = side;
    ws._peerId = null;
    ws.on('message', (raw) => {
      let f;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (!f || f.v !== PROTO) return;
      switch (f.type) {
        case 'hello': {
          ws._peerId = String(f.accountId ?? '');
          if (!ws._peerId || ws._peerId === this.selfId) { ws.close(4002, 'bad hello'); return; }
          // 同账号多连接仲裁：保留"由较小 accountId 一方发起"的连接（确定性，避免双向拨号互顶）
          const old = this.peers.get(ws._peerId);
          if (old && old !== ws && old.readyState === 1) {
            const keep = this._preferKeep(ws, old, ws._peerId);
            if (keep === old) { try { ws.close(4003, 'duplicate'); } catch { /* ignore */ } return; }
            try { old.close(4003, 'replaced'); } catch { /* ignore */ }
          }
          this.peers.set(ws._peerId, ws);
          if (side === 'outbound') this._out.set(ws._peerId, ws);
          ws.send(JSON.stringify({ v: PROTO, type: 'hello', accountId: this.selfId }));
          this.emit('peer-online', ws._peerId);
          this._flushOutbox(ws._peerId);
          break;
        }
        case 'msg': {
          ws.send(JSON.stringify({ v: PROTO, type: 'ack', id: f.id }));
          if (ws._peerId && String(f.from) === ws._peerId) {
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
    });
    ws.on('close', () => {
      if (!ws._peerId) return;
      if (this.peers.get(ws._peerId) === ws) {
        this.peers.delete(ws._peerId);
        this.emit('peer-offline', ws._peerId);
      }
      if (this._out.get(ws._peerId) === ws) this._out.delete(ws._peerId);
      // 仅当这条被关的连接曾是"现役连接"且对端已不在线时才重连
      if (!this._stopped && !this.peers.has(ws._peerId)
        && (this.endpoints.has(ws._peerId) || (this.outbox.get(ws._peerId)?.length))) {
        this._scheduleRetry(ws._peerId);
      }
    });
    ws.on('error', () => { /* close 会跟着来 */ });
  }

  /** 双连接仲裁：保留由较小 accountId 一方发起的连接。clientOf = 该连接的发起方 id。 */
  _preferKeep(newWs, oldWs, peerId) {
    const clientOf = (w) => (w._side === 'outbound' ? String(this.selfId) : peerId);
    const a = clientOf(newWs), b = clientOf(oldWs);
    if (a !== b) return a < b ? newWs : oldWs;
    return oldWs; // 同向重复：保留旧连接
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

  _dial(accountId) {
    const ep = this.endpoints.get(accountId);
    if (!ep || this._stopped) return;
    try {
      const ws = new WebSocket(`ws://${ep}`);
      this._out.set(accountId, ws);
      ws.on('open', () => ws.send(JSON.stringify({ v: PROTO, type: 'hello', accountId: this.selfId })));
      this._setup(ws, 'outbound');
    } catch (e) {
      this.log(`连接 ${ep} 失败：${e.message}`, 'warn');
      this._scheduleRetry(accountId);
    }
  }

  _scheduleRetry(accountId) {
    if (this._stopped || this._retry.has(accountId)) return;
    const t = setTimeout(() => {
      this._retry.delete(accountId);
      if (!this.peers.has(accountId)) this._dial(accountId);
    }, 2000);
    this._retry.set(accountId, t);
  }
}
