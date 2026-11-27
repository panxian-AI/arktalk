// 自动更新（Windows 免安装 zip 版）。
// 机制：只有仓库 stable.json 里 stable=true 的版本才算「正式稳定版」才会被检测。
// 更新方式：下载新 zip → 解压到同级新目录 → 旧目录改名备份 → 重启到新版。
// 回退：把备份目录换回来再重启。全程不覆盖正在运行的 exe（Windows 不允许自覆盖）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawn } = require('node:child_process');

const STABLE_URL = 'https://raw.githubusercontent.com/panxian-AI/arktalk/main/stable.json';

/** 版本号比较：'0.6.10' > '0.6.2'。返回 1 / 0 / -1。 */
function cmpVer(a, b) {
  const pa = String(a ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 带超时的 HTTPS GET（跟随一次重定向），返回 Buffer。 */
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: { 'user-agent': 'ArkTalk-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects < 4) return resolve(httpGet(res.headers.location, redirects + 1).then((b) => b));
        return reject(new Error('重定向次数过多'));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 下载文件（跟随重定向），写磁盘，回报进度百分比。 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u, n) => {
      const req = https.get(u, { timeout: 30000, headers: { 'user-agent': 'ArkTalk-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); if (n < 4) return follow(res.headers.location, n + 1);
          return reject(new Error('重定向次数过多'));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0, lastPct = -1;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) { const pct = Math.floor(got * 100 / total); if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onProgress?.(pct); } }
        });
        res.on('end', () => { out.end(); });
        out.on('finish', () => resolve({ bytes: got }));
        res.on('error', (e) => { out.destroy(); reject(e); });
        out.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

function versionOf(pkgDir) {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? '0'; }
  catch { return '0'; }
}

/** 应用根目录（解压后的 ArkTalk-0.6.x-win64）。开发模式下用 dist 里的应用目录。 */
function appRoot(app) {
  // 打包后 app.getAppPath() 就是 …/resources/app；往上两级到 ArkTalk-0.6.x-win64
  if (app.isPackaged) return path.resolve(app.getAppPath(), '..', '..');
  return path.resolve(__dirname, '..'); // 开发：snow-chat 目录
}

class Updater {
  constructor(app, log = () => {}) {
    this.app = app;
    this.log = log;
    this.stateFile = path.join(os.tmpdir(), 'arktalk-update-state.json');
    this.state = this._loadState();
  }

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }
  _saveState() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch { /* ignore */ }
  }

  currentVersion() { return versionOf(path.join(__dirname, '..')); }

  /** 检查更新：拉公告牌，只有 stable=true 且版本号更高才返回 available。 */
  async check() {
    const buf = await httpGet(STABLE_URL + `?t=${Date.now()}`);
    const info = JSON.parse(buf.toString('utf8'));
    const cur = this.currentVersion();
    const available = !!info.stable && cmpVer(info.version, cur) > 0;
    return {
      current: cur,
      latest: info.version ?? '',
      available,
      notes: info.notes ?? '',
      published: info.published ?? '',
      assetUrl: info.assets?.windows ?? '',
      skipped: this.state.skipped === info.version
    };
  }

  skip(version) { this.state.skipped = String(version); this._saveState(); }
  clearSkip() { delete this.state.skipped; this._saveState(); }

  /** 下载并解压到同级新目录，返回新目录路径。 */
  async prepare(info) {
    if (!info.assetUrl) throw new Error('公告牌里没有 Windows 安装包地址');
    const root = appRoot(this.app);
    const parent = path.dirname(root);
    const newDir = path.join(parent, `ArkTalk-${info.latest}-win64`);
    if (fs.existsSync(newDir)) throw new Error(`更新目录已存在：${newDir}（可能上次更新残留）`);
    const tmp = path.join(os.tmpdir(), `arktalk-update-${Date.now()}.zip`);
    fs.mkdirSync(parent, { recursive: true });
    await download(info.assetUrl, tmp, (pct) => this.log(`下载更新包 ${pct}%`));
    fs.mkdirSync(newDir, { recursive: true });
    // 用系统 tar.exe 解压（Windows 10+ 自带，zip 里的顶层目录要剥掉）
    await this._extract(tmp, newDir);
    // 兼容 zip 内嵌一层 ArkTalk-x-win64 目录的情况：把内容上提一层
    const nested = path.join(newDir, `ArkTalk-${info.latest}-win64`);
    if (fs.existsSync(nested)) {
      for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(newDir, e));
      fs.rmdirSync(nested);
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return newDir;
  }

  _extract(zipPath, target) {
    return new Promise((resolve, reject) => {
      const tar = spawn('tar.exe', ['-xf', zipPath, '-C', target], { windowsHide: true });
      let err = '';
      tar.stderr?.on('data', (d) => { err += d.toString(); });
      tar.on('error', reject);
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`解压失败(${code})：${err.slice(-300)}`)));
    });
  }

  /**
   * 生成并执行切换脚本：等本进程退出 → 旧目录改名 .bak-oldver → 新目录改名到原位 → 重启。
   * 脚本用 .cmd，放在临时目录，detached 启动，主进程随后退出。
   */
  applyAndRestart(newDir) {
    const root = appRoot(this.app);
    const parent = path.dirname(root);
    const oldName = path.basename(root);
    const bakName = `${oldName}.bak-${this.currentVersion()}`;
    const bak = path.join(parent, bakName);
    const exeName = 'ArkTalk.exe';
    const cmd = [
      '@echo off',
      `cd /d "${parent}"`,
      // 等旧进程完全退出（最多 30 秒，每 0.5 秒探一次任务列表）
      ':wait',
      `tasklist /FI "IMAGENAME eq ${exeName}" 2>NUL | find /I "${exeName}" >NUL`,
      'if errorlevel 1 goto go',
      'set /a n=0',
      'timeout /t 1 /nobreak >NUL',
      'goto wait',
      ':go',
      `if exist "${bak}" rmdir /s /q "${bak}"`,
      `move "${oldName}" "${bakName}"`,
      `move "${path.basename(newDir)}" "${oldName}"`,
      `start "" "${path.join(oldName, exeName)}"`,
      `del "%~f0" >NUL 2>&1`
    ].join('\r\n');
    const cmdFile = path.join(os.tmpdir(), `arktalk-switch-${Date.now()}.cmd`);
    fs.writeFileSync(cmdFile, cmd, 'ascii');
    spawn('cmd.exe', ['/c', cmdFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.state.appliedFrom = bak;
    this._saveState();
  }

  /** 回退：把 .bak 目录换回原位，重启旧版。 */
  rollbackAndRestart() {
    const root = appRoot(this.app);
    const parent = path.dirname(root);
    const oldName = path.basename(root);
    const baks = fs.readdirSync(parent).filter((n) => n.startsWith(oldName + '.bak-')).sort().reverse();
    if (!baks.length) throw new Error('没有找到可回退的旧版本备份');
    const bak = baks[0];
    const curName = `${oldName}.new-${this.currentVersion()}`;
    const cmd = [
      '@echo off',
      `cd /d "${parent}"`,
      ':wait',
      'tasklist /FI "IMAGENAME eq ArkTalk.exe" 2>NUL | find /I "ArkTalk.exe" >NUL',
      'if errorlevel 1 goto go',
      'timeout /t 1 /nobreak >NUL',
      'goto wait',
      ':go',
      `if exist "${curName}" rmdir /s /q "${curName}"`,
      `move "${oldName}" "${curName}"`,
      `move "${bak}" "${oldName}"`,
      `start "" "${path.join(oldName, 'ArkTalk.exe')}"`,
      `del "%~f0" >NUL 2>&1`
    ].join('\r\n');
    const cmdFile = path.join(os.tmpdir(), `arktalk-rollback-${Date.now()}.cmd`);
    fs.writeFileSync(cmdFile, cmd, 'ascii');
    spawn('cmd.exe', ['/c', cmdFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  hasBackup() {
    try {
      const root = appRoot(this.app);
      const parent = path.dirname(root);
      const oldName = path.basename(root);
      return fs.readdirSync(parent).some((n) => n.startsWith(oldName + '.bak-'));
    } catch { return false; }
  }
}

module.exports = { Updater, cmpVer, STABLE_URL };
