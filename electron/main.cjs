// ArkTalk 桌面窗口壳（Electron）。
// 与 QQ 平行：不碰 QQ 进程、不抢登录，只是 SnowLuma 上游的又一个客户端。
// 职责：拉起（或复用）本地桥 → 开一个独立窗口加载它 → 托盘常驻 → 退出时收好摊。
const { app, BrowserWindow, session, Tray, Menu, nativeImage, shell, ipcMain, webUtils } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3020;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const APP_NAME = 'ArkTalk';

// 兜底：主进程里任何一个未捕获异常（典型的是一条异常消息帧把 ws 回调打穿）
// 默认会直接结束进程 = 界面"闪退"。这里落盘 + 继续运行，聊天窗口不会因此消失。
function logCrash(kind, err) {
  try {
    const fs = require('node:fs');
    const dir = path.join(__dirname, '..', 'diag');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'),
      `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${kind}\n${err?.stack || err}\n\n`);
  } catch { /* 记录失败也不能再抛 */ }
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); console.error('[crash]', err); });
process.on('unhandledRejection', (err) => { logCrash('unhandledRejection', err); console.error('[reject]', err); });

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

let bridgeStarting = false;

async function ensureBridge() {
  if (await bridgeUp()) return; // 已有实例在跑（比如你开着 npm start），直接复用，不抢端口
  if (bridgeStarting) return;
  bridgeStarting = true;
  try {
    // 打包成 exe 后系统里不一定有 node：用 Electron 自带的 Node 运行时跑桥
    // （ELECTRON_RUN_AS_NODE=1 会让 electron.exe 以纯 Node 模式执行，不打开窗口）
    const packaged = app.isPackaged;
    serverChild = spawn(packaged ? process.execPath : 'node', ['src/main.js'], {
      cwd: app.getAppPath(),
      stdio: 'inherit',
      windowsHide: true,
      env: packaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    });
    // 桥自己挂掉（未捕获异常 / 端口被抢 / 上游崩）时自动拉起：
    // 否则窗口会一直白屏，只能手动重启整个应用。
    serverChild.on('exit', (code, signal) => {
      serverChild = null;
      if (isQuitting) return;
      logCrash('bridge-exit', new Error(`本地桥退出 code=${code} signal=${signal}`));
      setTimeout(() => { ensureBridge().catch(() => {}); }, 2000);
    });
    serverChild.on('error', (err) => logCrash('bridge-spawn', err));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await bridgeUp()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('本地桥 15 秒内没起来：检查 config.json（端口占用/上游配置），日志见上面输出');
  } finally {
    bridgeStarting = false;
  }
}

// ---------- 原生文件拖出：把图片/文件从聊天窗口拖到桌面/资源管理器 ----------
// 页面在 dragstart 里同步发这个 IPC，主进程用 Electron 的 startDrag 把真实文件交给系统。
ipcMain.on('ark:drag-out', (event, payload = {}) => {
  try {
    let file = '';
    let suggested = '';
    if (payload.filePath && fs.existsSync(payload.filePath)) {
      file = payload.filePath;
      suggested = path.basename(file);
    } else if (payload.dataUrl) {
      const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(String(payload.dataUrl));
      if (!m) throw new Error('无法识别的图片数据');
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[m[1].toLowerCase()] || 'png';
      const base = String(payload.name ?? '图片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || `IMG_${Date.now()}`;
      const dir = path.join(os.tmpdir(), 'arktalk-drag');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      suggested = path.basename(file);
    }
    if (!file || !fs.existsSync(file)) throw new Error('文件不存在或尚未保存到本地');
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.ico'));
    const opts = { file, ...(icon && !icon.isEmpty() ? { icon } : {}) };
    // Electron 32+ 用 webUtils.startDrag；旧版回退 webContents.startDrag
    if (webUtils?.startDrag) webUtils.startDrag(opts);
    else if (win?.webContents?.startDrag) win.webContents.startDrag(opts);
    else throw new Error('当前 Electron 版本不支持原生拖出');
    event.returnValue = { ok: true, file, name: suggested };
  } catch (e) {
    event.returnValue = { ok: false, error: String(e?.message || e) };
  }
});

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  win.loadURL(URL_BASE);

  // 渲染进程崩溃 / 卡死 / 白屏自愈：Electron 的渲染进程（Chromium）偶尔会因为显存、
  // 显卡驱动、远程桌面切换而挂掉——表现是窗口变白，但进程还在。这里自动重载。
  win.webContents.on('render-process-gone', (_e, details) => {
    logCrash('renderer-gone', new Error(JSON.stringify(details)));
    if (!isQuitting) setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 800);
  });
  win.on('unresponsive', () => {
    logCrash('renderer-unresponsive', new Error('界面无响应'));
    if (!isQuitting && win) win.reload();
  });
  let failLoads = 0;
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isQuitting || !isMainFrame) return;
    failLoads += 1;
    if (failLoads > 30) return; // 最多重试 30 次（约 45 秒），避免死循环
    setTimeout(async () => {
      if (isQuitting || !win || win.isDestroyed()) return;
      try { await ensureBridge(); } catch { /* 起不来就等下一次 */ }
      if (win && !win.isDestroyed()) win.loadURL(URL_BASE);
    }, 1500);
  });
  win.webContents.on('did-finish-load', () => { failLoads = 0; });

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
    {
      label: '重启 ArkTalk',
      toolTip: '完全退出并重新启动（界面卡死/收不到消息时用）',
      click: () => restartApp()
    },
    { type: 'separator' },
    {
      label: '退出 ArkTalk',
      click: () => { isQuitting = true; app.quit(); }
    }
  ]);
}

/** 从托盘完整重启：先标记退出（避免关窗被拦截成 hide），再由 Electron 重新拉起自己。 */
function restartApp() {
  try { logCrash('tray-restart', new Error('托盘手动重启')); } catch { /* ignore */ }
  isQuitting = true;
  app.relaunch({ args: process.argv.slice(1) });
  app.exit(0);
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
  statusTimer = setInterval(async () => {
    await refreshTray();
    // 守护：桥断了（进程被杀、端口异常）自动拉起，界面若还在旧页面就重载一次
    if (isQuitting) return;
    if (!(await bridgeUp())) {
      logCrash('bridge-watchdog', new Error('本地桥无响应，尝试重启'));
      try {
        await ensureBridge();
        if (win && !win.isDestroyed()) win.loadURL(URL_BASE);
      } catch (e) { logCrash('bridge-watchdog-fail', e); }
    }
  }, 20_000);
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
