// 本机消息存储：所有聊天记录落在本机 data/ 目录，上游（SnowLuma）断线也能看。
//
// 设计：
//   · 每个会话一个 JSONL 文件（data/messages/<chatKey>.jsonl），追加写，崩溃安全
//   · chatKey 约定：私聊 p<uin>，群聊 g<群号> —— 与界面层共享
//   · 会话索引（最后一条/时间）从各文件尾部扫描得出，不单独维护索引文件
//   · 只追加不删除；撤回是 UI 层按 message_id 打标记，不动文件
import fs from 'node:fs';
import path from 'node:path';

export class LocalStore {
  /**
   * @param {string} dataDir 持久化目录
   * @param {function} [log]
   */
  constructor(dataDir, log = () => {}) {
    this.dataDir = dataDir;
    this.msgDir = path.join(dataDir, 'messages');
    fs.mkdirSync(this.msgDir, { recursive: true });
    this.log = log;
    this._fdCache = new Map(); // chatKey -> fd（追加句柄）
    this._ids = new Map();     // chatKey -> Set<message_id>（去重：自发消息先落账，上游回推不重复）
  }

  _file(chatKey) {
    if (!/^[pg][0-9]+$/.test(chatKey)) throw new Error(`非法 chatKey：${chatKey}`);
    return path.join(this.msgDir, `${chatKey}.jsonl`);
  }

  /**
   * 追加一条消息记录。record 至少含 message_id / time。
   * 同一 chatKey 内 message_id 重复的记录直接跳过（返回 false），保证"本机先落账 + 上游回推"不产生双份。
   * @returns {boolean} 是否真的写入
   */
  append(chatKey, record) {
    const file = this._file(chatKey);
    let ids = this._ids.get(chatKey);
    if (!ids) {
      ids = new Set();
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const j = JSON.parse(line); if (j?.message_id != null) ids.add(String(j.message_id)); } catch { /* 坏行忽略 */ }
        }
      } catch { /* 新文件 */ }
      this._ids.set(chatKey, ids);
    }
    if (record?.message_id != null) {
      const k = String(record.message_id);
      if (ids.has(k)) return false;
      ids.add(k);
    }
    const line = JSON.stringify(record) + '\n';
    let fd = this._fdCache.get(chatKey);
    if (fd === undefined) {
      fd = fs.openSync(file, 'a');
      this._fdCache.set(chatKey, fd);
    }
    fs.writeSync(fd, line);
    return true;
  }

  _closeFd(chatKey) {
    const fd = this._fdCache.get(chatKey);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } this._fdCache.delete(chatKey); }
  }

  close() {
    for (const key of [...this._fdCache.keys()]) this._closeFd(key);
  }

  /**
   * 读取某会话最近 limit 条（按时间正序返回）。
   * @param {string} chatKey
   * @param {number} limit
   */
  read(chatKey, limit = 50) {
    const file = this._file(chatKey);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const lines = text.split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const s = lines[i].trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { this.log(`${chatKey} 第 ${i + 1} 行损坏，跳过`, 'warn'); }
    }
    return out.reverse();
  }

  /** 扫描全部会话，返回 [{chatKey, count, lastTime, lastRecord}]，按最后时间倒序。 */
  listChats() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.msgDir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const chatKey = e.name.slice(0, -'.jsonl'.length);
      let text = '';
      try { text = fs.readFileSync(path.join(this.msgDir, e.name), 'utf8'); } catch { continue; }
      const lines = text.split('\n').filter((s) => s.trim());
      if (lines.length === 0) continue;
      let last = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { last = JSON.parse(lines[i]); break; } catch { /* 尾行坏了继续往前找 */ }
      }
      out.push({ chatKey, count: lines.length, lastTime: last?.time ?? 0, lastRecord: last });
    }
    return out.sort((a, b) => b.lastTime - a.lastTime);
  }

  /** 按 message_id 找某会话里的记录（撤回等场景用）。 */
  findById(chatKey, messageId) {
    return this.read(chatKey, 1e9).find((m) => String(m.message_id) === String(messageId)) ?? null;
  }

  /**
   * 本机物理删除消息（仅删除本机记录，不影响对方设备）。
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {string} [opts.messageId] 只删这一条（优先）
   * @param {boolean} [opts.sent]     删本机发出的（self_sent=true）
   * @param {boolean} [opts.received] 删收到的（self_sent=false）
   * @returns {{deleted:number}} 实际删除条数
   */
  deleteMessages(chatKey, opts = {}) {
    const file = this._file(chatKey);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { deleted: 0 }; }
    const { messageId, sent, received } = opts;
    const byId = messageId != null && String(messageId) !== '';
    const kept = [];
    let deleted = 0;
    for (const s of text.split('\n')) {
      if (!s.trim()) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { kept.push(s); continue; } // 坏行保留不误删
      let hit = false;
      if (byId) {
        hit = String(rec?.message_id) === String(messageId);
      } else if (sent || received) {
        const mine = rec?.self_sent === true;
        hit = (mine && !!sent) || (!mine && !!received);
      }
      if (hit) { deleted++; continue; }
      kept.push(s);
    }
    if (!deleted) return { deleted: 0 };
    // 先关闭追加句柄：Windows 上有打开的 fd 时 rename 覆盖会 EPERM
    this._closeFd(chatKey);
    // 重写文件（写临时文件再原子替换，避免中途崩溃损坏）
    const tmp = file + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
    // 同步去重集合：删除的消息 id 要从 _ids 移除，否则重新收到同 id 消息会被当成重复吞掉
    const ids = new Set();
    for (const s of kept) {
      try { const j = JSON.parse(s); if (j?.message_id != null) ids.add(String(j.message_id)); } catch { /* 忽略坏行 */ }
    }
    this._ids.set(chatKey, ids);
    this.log(`${chatKey} 本机删除 ${deleted} 条消息`, 'info');
    return { deleted };
  }
}
