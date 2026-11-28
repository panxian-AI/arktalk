// 入口：读配置 → 起本机账号/P2P 内核 → 起本地桥 →（可选）连接 SnowLuma 注入通道 →（可选）拉起 OpenP2P。
//
// 完全独立的聊天软件：本体不碰 QQ、不碰任何腾讯服务。
// 传输是双通道：
//   · p2p（默认）：设备间 WS 直连（跨网由内置 OpenP2P 映射）
//   · snowluma（可选）：SnowLuma 注入本进程/本机后经 OneBot v11 收发——注入即可用
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Bridge } from './bridge.js';
import { LocalStore } from './store.js';
import { OneBotClient } from './onebot-client.js';
import { discoverUpstream } from './discover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

function readConfig() {
  const text = fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

/**
 * storage 里的路径：空 = 用默认；相对路径按应用根目录解析；绝对路径原样使用。
 * 解压即用的发行版里 appRoot 就是 ArkTalk-win64 目录。
 */
function resolveStoragePath(p, fallback) {
  if (!p || typeof p !== 'string' || !p.trim()) return fallback;
  const s = p.trim();
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(appRoot, s);
}

/**
 * 数据目录必须与程序版本解耦：旧实现默认用 <解压目录>/data，
 * 每升一个版本解压到新文件夹 = 全新 data = 当作新设备随机生成账号 →
 * 账号一变 OpenP2P 节点名 arktalk-<账号> 就变，手机通讯录存的旧号对不上，跨网永远不通。
 * 现在默认固定到用户主目录下的 ArkTalk/data（换版本不随程序目录变），
 * 并在首次使用时把旧的程序内 data 一次性迁移过去（保留原目录，不删），
 * 这样当前账号/联系人/令牌/聊天记录/好友申请全部延续，不再换号。
 */
function resolveDataDir(cfg) {
  const bundled = path.join(appRoot, 'data');
  const configured = cfg.storage?.dataDir;
  // 用户在设置里显式选过目录：尊重它（原样走老逻辑）。
  if (configured && String(configured).trim()) {
    return resolveStoragePath(configured, bundled);
  }
  // 未配置 → 固定的用户目录，与解压目录/版本无关。
  const stable = path.join(os.homedir(), 'ArkTalk', 'data');
  try {
    fs.mkdirSync(stable, { recursive: true });
    // 首次迁移：目标还没有 contacts.json，而旧的程序内 data 有 → 复制过去。
    const hasStable = fs.existsSync(path.join(stable, 'contacts.json'));
    if (!hasStable && fs.existsSync(path.join(bundled, 'contacts.json'))) {
      fs.cpSync(bundled, stable, { recursive: true, force: false, errorOnExist: false });
      console.log(`[数据迁移] 已从 ${bundled} 复制到 ${stable}（账号/联系人/令牌保留，原目录未删）`);
    }
  } catch (e) {
    console.error(`[数据迁移] 失败，回退到程序内 data：${e?.message || e}`);
    return bundled;
  }
  return stable;
}

/** SnowLuma 注入通道（可选）：自发现 token 后连接上游 OneBot。 */
async function maybeConnectSnowluma(cfg, log) {
  const sl = cfg.snowluma ?? {};
  if (!sl.enabled) return null;
  const discovery = await discoverUpstream({
    homeDir: sl.homeDir,
    wsUrl: sl.wsUrl,
    accessToken: sl.accessToken,
    log
  });
  if (!discovery.ok) { log(`SnowLuma 通道不可用：${discovery.error}`, 'warn'); return null; }
  const ob = new OneBotClient({ url: discovery.wsUrl, token: discovery.accessToken, log });
  return ob;
}

/** 可选：拉起 OpenP2P 内核（跨网穿透；局域网内不需要）。 */
function maybeStartOpenp2p(cfg, log) {
  const op = cfg.openp2p ?? {};
  if (!op.enabled || !op.exePath) return;
  if (!fs.existsSync(op.exePath)) { log(`OpenP2P 内核不存在：${op.exePath}`, 'warn'); return; }
  const args = op.token ? ['-token', String(op.token)] : [];
  const child = spawn(op.exePath, args, { stdio: 'ignore', detached: false });
  child.on('error', (e) => log(`OpenP2P 启动失败：${e.message}`, 'warn'));
  log(`OpenP2P 内核已拉起（pid=${child.pid}），映射目标端口 = P2P 端口 ${cfg.p2p.port}`);
}

async function main() {
  const log = (msg, level = 'info') =>
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${level}] ${msg}`);

  const cfg = readConfig();
  const dataDir = resolveDataDir(cfg);
  const downloadsDir = resolveStoragePath(cfg.storage?.downloadsDir, '');
  const store = new LocalStore(dataDir, log);
  const ob = await maybeConnectSnowluma(cfg, log);
  const bridge = new Bridge({
    store,
    downloadsDir,
    listen: cfg.listen,
    p2p: { host: cfg.p2p?.host ?? '0.0.0.0', port: Number(cfg.p2p?.port ?? 3021) },
    ob,
    log
  });

  await bridge.start();
  ob?.start();
  maybeStartOpenp2p(cfg, log);
  log(`数据目录：${dataDir}`);
  log(`接收文件目录：${bridge.downloadsDir}`);

  const shutdown = async () => {
    log('正在退出…');
    ob?.stop();
    await bridge.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
