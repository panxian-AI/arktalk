// ArkTalk 桌面窗口壳（Electron）。
// 与 QQ 平行：不碰 QQ 进程、不抢登录，只是 SnowLuma 上游的又一个客户端。
// 职责：拉起（或复用）本地桥 → 开一个独立窗口加载它 → 退出时收好摊。
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 3020;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP_NAME = 'ArkTalk';

let serverChild = null;
let win = null;

function bridgeUp() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}/api/config`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureBridge() {
  if (await bridgeUp()) return; // 已有实例在跑（比如你开着 npm start），直接复用，不抢端口
  serverChild = spawn('node', ['src/main.js'], {
    cwd: app.getAppPath(),
    stdio: 'inherit',
    windowsHide: true
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await bridgeUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('本地桥 15 秒内没起来：检查 config.json（端口占用/上游配置），日志见上面输出');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: '#f2f4f7',
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(URL_BASE);
  // 关窗 = 退出整个应用（连本地桥一起收摊）
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  // 语音消息需要麦克风：只放行本机界面地址的媒体权限
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  await ensureBridge();
  createWindow();
}).catch((e) => {
  // 没窗口可弹的场景（比如桥没起来）只能写日志
  console.error(`[ArkTalk] 启动失败：`, e.message);
  app.quit();
});

app.on('before-quit', () => {
  if (serverChild) { try { serverChild.kill(); } catch { /* ignore */ } }
});
app.on('window-all-closed', () => app.quit());
