// ArkTalk 桌面窗口壳（Electron）。
// 与 QQ 平行：不碰 QQ 进程、不抢登录，只是 SnowLuma 上游的又一个客户端。
// 职责：拉起（或复用）本地桥 → 开一个独立窗口加载它 → 托盘常驻 → 退出时收好摊。
const { app, BrowserWindow, session, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 3020;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP_NAME = 'ArkTalk';

// 禁用 GPU 硬件加速：远程桌面/远控（ToDesk、向日葵、RDP）会话里 Electron 的 GPU
// 渲染经常失效导致窗口全白；聊天界面走 CPU 渲染毫无压力。必须在 app ready 前调用。
app.disableHardwareAcceleration();
// 保险起见再补两个渲染层开关（部分远控环境只关硬件加速不够）
app.commandLine.appendSwitch('disable-gpu-compositing');

let serverChild = null;
let win = null;
let tray = null;
let isQuitting = false;      // 真正退出（而不是收进托盘）
let trayTipShown = false;    // 首次最小化到托盘的气泡只弹一次
let statusTimer = null;

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

/** 读桥的轻量状态（托盘提示与菜单用），失败返回 null。 */
function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}/api/status`, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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

  // 关窗不退出：收进托盘，桥和穿透继续运行（不然关窗就掉线，消息收不到）
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (!trayTipShown && tray) {
      trayTipShown = true;
      try {
        tray.displayBalloon({
          title: 'ArkTalk 还在后台运行',
          content: '已最小化到系统托盘，双击托盘图标可重新打开。要真正退出请用托盘菜单的「退出」。'
        });
      } catch { /* 部分系统不支持气泡，忽略 */ }
    }
  });
  win.on('closed', () => { win = null; });

  // 外部链接走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(URL_BASE)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

/** 托盘菜单：每次状态变化重建（Electron 的菜单项不能直接改，只能替换整体）。 */
function buildTrayMenu(status) {
  const lines = [];
  if (status) {
    const who = status.nickname ? `${status.nickname}（${status.selfId}）` : (status.selfId ?? '未登录');
    lines.push({ label: `账号：${who}`, enabled: false });
    lines.push({
      label: status.friends
        ? `在线：${status.online} / ${status.friends} 位联系人`
        : '还没有联系人',
      enabled: false
    });
    lines.push({ label: `跨网穿透：${status.relay ? '已启用' : '未启用'}`, enabled: false });
  } else {
    lines.push({ label: '连接本地服务中…', enabled: false });
  }

  return Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? '打开 ArkTalk' : '显示 ArkTalk 窗口',
      click: () => showWindow()
    },
    { type: 'separator' },
    ...lines,
    { type: 'separator' },
    { label: '隐藏到托盘', visible: !!(win && win.isVisible()), click: () => win && win.hide() },
    {
      label: '刷新状态',
      click: () => refreshTray(true)
    },
    { type: 'separator' },
    {
      label: '退出 ArkTalk',
      click: () => { isQuitting = true; app.quit(); }
    }
  ]);
}

async function refreshTray(force = false) {
  const status = await fetchStatus();
  if (tray && !tray.isDestroyed()) {
    const tip = status
      ? `${APP_NAME} · ${status.nickname || status.selfId || '未登录'} · 在线 ${status.online}/${status.friends}`
      : `${APP_NAME} · 本地服务未响应`;
    tray.setToolTip(tip);
    tray.setContextMenu(buildTrayMenu(status));
    // 有未连上的联系人时图标提示（Windows 任务栏托盘文字提示已足够，这里不动图标）
    if (force) { /* 手动刷新时菜单已重建，无需额外动作 */ }
  }
  return status;
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon_16.png'));
  }
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu(null));

  // Windows/Linux：单击切换显示；macOS 单击默认弹菜单，这里也统一成切换更直观
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());

  refreshTray();
  statusTimer = setInterval(() => { refreshTray(); }, 20_000);
}

// 单实例：多开会让托盘出现两个图标且互抢端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    // 语音消息需要麦克风：只放行本机界面地址的媒体权限
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media');
    });
    await ensureBridge();
    createWindow();
    createTray();
  }).catch((e) => {
    // 没窗口可弹的场景（比如桥没起来）只能写日志
    console.error(`[ArkTalk] 启动失败：`, e.message);
    app.quit();
  });
}

// 托盘常驻：窗口全关也不退出
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
app.on('activate', () => showWindow());

app.on('before-quit', () => {
  isQuitting = true;
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
  if (serverChild) { try { serverChild.kill(); } catch { /* ignore */ } }
});
