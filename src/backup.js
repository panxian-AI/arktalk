/**
 * ArkTalk 备份格式（聊天记录 + 配置的可导入导出）
 * ================================================
 * 设计目标：现在导出的包，未来任何版本都能导入（前向兼容）。
 *
 * 文件本体是一个标准 ZIP（两端通用，PC 纯 JS 实现，安卓用 java.util.zip），
 * 包内固定结构：
 *
 *   manifest.json          格式标识 + schema 版本 + 导出时间/来源端 + 清单
 *   data/contacts.json     归一化配置（profile/friends/groups/settings）
 *   data/read-marks.json   已读回执 { chatKey: 秒级时间戳 }
 *   data/recalled.json     撤回标记 { chatKey: [message_id,...] }
 *   data/downloads-done.json 下载登记 { fileId: {where,path,size,time} }
 *   messages/<chatKey>.jsonl  每会话一个，每行一条消息（与本地存储同构）
 *   files/registry.json    发出文件登记 { fileId: {name,size} }
 *   files/<fileId>         发出的文件本体
 *
 * 前向兼容约定：
 * 1. manifest.format 必须是 'arktalk-backup'，否则拒绝导入（防止误选普通 zip）。
 * 2. manifest.schema 是整数版本号。导入端支持 <= 自己 SCHEMA 的版本；
 *    遇到更高的 schema 只警告、仍尽力导入已知的旧字段（未知字段一律忽略）。
 * 3. 所有 JSON 解析用宽容默认值（缺字段=空），未知键不影响导入。
 * 4. 消息逐条写入走 store.append，按 message_id 去重 → 重复导入幂等。
 * 5. 配置按目标端键位归一化（PC 用 settings{}，安卓顶层 openp2pToken(s)）。
 *
 * ZIP 实现用 store/deflate，CRC32 用 node:zlib.crc32（Node 20.15+/22+）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BACKUP_FORMAT = 'arktalk-backup';
export const SCHEMA = 1;

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/** 构造 zip 条目列表。entries: [{name, data:Buffer}] */
function crc32(buf) { return zlib.crc32(buf) >>> 0; }

/** 生成 ZIP（deflate 压缩）。纯 JS，无外部依赖。 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(raw.length), u16(name.length), u16(0), name, comp
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(centralBuf.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 解析 ZIP，返回 Map<name, Buffer>。支持 store(0) 与 deflate(8)。 */
export function parseZip(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 定位本地头，取数据区
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let raw;
    if (method === 0) raw = comp;
    else if (method === 8) raw = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的 zip 压缩方式：${method}`);
    if (raw.length !== rawSize || crc32(raw) !== crc) throw new Error(`zip 条目校验失败：${name}`);
    out.set(name, raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 安全取 JSON：解析失败/缺文件返回默认值 */
export function jsonFrom(map, name, fallback) {
  try {
    const b = map.get(name);
    if (!b) return fallback;
    const v = JSON.parse(b.toString('utf8'));
    return v ?? fallback;
  } catch { return fallback; }
}

/** 构造 manifest */
export function makeManifest({ source, appVersion, counts }) {
  return {
    format: BACKUP_FORMAT,
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    source,                       // 'pc' | 'android'
    appVersion: appVersion ?? '',
    counts,                       // { messages, chats, friends, groups, files, bytes }
    _note: 'ArkTalk 备份包。未知字段请忽略；schema 更高时尽力导入已知字段。'
  };
}

/** 校验 manifest：返回 {ok, warn?, manifest} */
export function checkManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('备份包缺少 manifest.json');
  if (manifest.format !== BACKUP_FORMAT) throw new Error('不是 ArkTalk 备份包（格式标识不匹配）');
  const schema = Number(manifest.schema);
  if (!Number.isFinite(schema) || schema < 1) throw new Error('备份包 schema 版本号无效');
  const warn = schema > SCHEMA ? `备份来自更新版本（schema ${schema} > ${SCHEMA}），将尽力导入已知数据` : null;
  return { ok: true, warn, manifest };
}
