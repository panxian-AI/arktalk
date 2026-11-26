// 入口：读配置 → 起本机账号/P2P 内核 → 起本地桥 →（可选）连接 SnowLuma 注入通道 →（可选）拉起 OpenP2P。
//
// 完全独立的聊天软件：本体不碰 QQ、不碰任何腾讯服务。
// 传输是双通道：
//   · p2p（默认）：设备间 WS 直连（跨网由内置 OpenP2P 映射）
//   · snowluma（可选）：SnowLuma 注入本进程/本机后经 OneBot v11 收发——注入即可用
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Bridge } from './bridge.js';
import { LocalStore } from './store.js';
import { OneBotClient } from './onebot-client.js';
import { discoverUpstream } from './discover.js';

function readConfig() {
  const text = fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
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
  const dataDir = new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const store = new LocalStore(dataDir, log);
  const ob = await maybeConnectSnowluma(cfg, log);
  const bridge = new Bridge({
    store,
    listen: cfg.listen,
    p2p: { host: cfg.p2p?.host ?? '0.0.0.0', port: Number(cfg.p2p?.port ?? 3021) },
    ob,
    log
  });

  await bridge.start();
  ob?.start();
  maybeStartOpenp2p(cfg, log);

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
