// OneBot v11 正向 WS 客户端：上游永远是 SnowLuma（本机 hook 真 QQ），本模块不改上游任何东西。
//
// 职责边界（与方案文档一致）：
//   · 只做「客户端」：收事件（post_type=message/notice/...）、发动作（send_private_msg / ...）
//   · 断线指数退避重连（1s → 2s → 4s … 上限 60s），重连后不需要任何重新配对
//   · 动作回执用 echo 配对，单条动作超时只影响自己
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export class OneBotClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url      OneBot v11 正向 WS 地址（如 ws://127.0.0.1:3001）
   * @param {string} opts.token    access_token（可为空）
   * @param {function} [opts.log]  日志函数（msg, level）
   */
  constructor({ url, token = '', log = () => {} } = {}) {
    super();
    if (!url) throw new Error('OneBotClient: url 不能为空');
    this.url = url;
    this.token = String(token || '');
    this.log = log;
    this.ws = null;
    this.online = false;
    this._echoSeq = 0;
    this._pending = new Map();     // echo -> { resolve, reject, timer }
    this._backoff = BACKOFF_BASE_MS;
    this._reconnectTimer = null;
    this._closedByUs = false;
    this._pingTimer = null;
  }

  /** 建立连接并保持。重复调用是幂等的。 */
  start() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this._closedByUs = false;
    this._connect();
  }

  /** 停止：不再重连，动作全部以失败结算。 */
  stop() {
    this._closedByUs = true;
    this._clearReconnect();
    this._stopPing();
    if (this.ws) { try { this.ws.close(1000, 'client stop'); } catch { /* ignore */ } }
    this._failAllPending('客户端已停止');
  }

  _connect() {
    const headers = this.token ? { authorization: `Bearer ${this.token}` } : undefined;
    let ws;
    try {
      ws = new WebSocket(this.url, { headers });
    } catch (err) {
      this.log(`连接创建失败：${err?.message ?? err}`, 'error');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.online = true;
      this._backoff = BACKOFF_BASE_MS;
      this._startPing();
      this.log(`OneBot 已连接：${this.url}`);
      this.emit('online');
    });

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; } // 非 JSON 帧忽略
      if (data.echo !== undefined) {
        const p = this._pending.get(data.echo);
        if (!p) return;
        this._pending.delete(data.echo);
        clearTimeout(p.timer);
        if (data.status === 'ok' && Number(data.retcode) === 0) p.resolve(data.data);
        else p.reject(new Error(`动作失败 retcode=${data.retcode}${data.wording ? ` ${data.wording}` : ''}`));
        return;
      }
      // 没有回执字段 → 事件帧。全部原样上抛，业务层自己筛。
      if (data.post_type) this.emit('event', data);
    });

    ws.on('error', (err) => {
      this.log(`WS 错误：${err?.message ?? err}`, 'warn');
    });

    ws.on('close', () => {
      const wasOnline = this.online;
      this.online = false;
      this._stopPing();
      this._failAllPending('与上游断开');
      this.emit('offline');
      if (wasOnline) this.log('OneBot 连接断开');
      if (!this._closedByUs) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._closedByUs || this._reconnectTimer) return;
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this.log(`将在 ${Math.round(delay / 1000)}s 后重连上游`, 'warn');
  }

  _clearReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  _startPing() {
    this._stopPing();
    // 上游长时间没数据也要主动探测，半开连接是最坑人的那种
    this._pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch { /* ignore */ }
      }
    }, 20_000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _failAllPending(reason) {
    for (const [echo, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this._pending.clear();
  }

  /**
   * 调用一个 OneBot 动作。
   * @param {string} action  如 get_login_info / send_private_msg
   * @param {object} params
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} data 段
   */
  call(action, params = {}, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('上游未连接'));
    }
    const echo = `sc_${Date.now().toString(36)}_${(this._echoSeq++).toString(36)}`;
    const payload = JSON.stringify({ action, params, echo });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`动作超时：${action}`));
      }, timeoutMs);
      this._pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(echo);
        reject(err);
      }
    });
  }
}
