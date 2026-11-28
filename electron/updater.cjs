// 自动更新（Windows 免安装 zip 版）。
// 机制：只有仓库 stable.json 里 stable=true 的版本才算「正式稳定版」才会被检测。
// 更新方式：下载新 zip → 解压到同级新目录 → 旧目录改名备份 → 重启到新版。
// 回退：把备份目录换回来再重启。全程不覆盖正在运行的 exe（Windows 不允许自覆盖）。
//
// v0.6.4 起：多线路并发测速，谁快用谁；每条线路都有应用层硬超时，避免国内
// 访问 raw.githubusercontent.com 在 DNS 阶段卡死导致界面永远「检查中」。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');

// 公告牌多线路（并发测速，谁先返回用谁）。jsDelivr / ghproxy 互为备份。
const STABLE_URLS = [
  'https://raw.githubusercontent.com/panxian-AI/arktalk/main/stable.json',
  'https://cdn.jsdelivr.net/gh/panxian-AI/arktalk@main/stable.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/panxian-AI/arktalk/main/stable.json'
];
const STABLE_URL = STABLE_URLS[0]; // 兼容旧引用

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

/** 统一 HTTP(S) GET，支持重定向；registry 用于并发取消。返回 Buffer。 */
function request(url, { timeoutMs = 8000, redirects = 0, registry = null, range = null } = {}) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? https : http;
    const headers = { 'user-agent': 'ArkTalk-Updater' };
    if (range) headers.range = range; // 如 'bytes=0-2047'，用于测速探针
    let req;
    try {
      req = mod.get(url, { timeout: timeoutMs, headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects < 4) return resolve(request(res.headers.location, { timeoutMs, redirects: redirects + 1, registry, range }));
          return reject(new Error('重定向次数过多'));
        }
        // 206（分段）与 200 都视为成功
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
    } catch (e) { return reject(e); }
    if (registry) registry.add(req);
    const cleanup = () => { if (registry) registry.delete(req); };
    req.on('timeout', () => { req.destroy(new Error('线路超时')); });
    req.on('error', (e) => { cleanup(); reject(e); });
    req.on('close', cleanup);
  });
}

/**
 * 公告牌拉取：收齐所有成功线路后选内容最新的那份（不再"谁快用谁"）。
 * 镜像缓存滞后会吐旧公告牌（实测 jsDelivr 滞后 10-60 分钟、ghproxy 5 分钟窗口）——
 * 合并取优后，任何一条新线都能穿透旧缓存。
 * 评分：主键 max(stable,beta) 的 versionCode，次键 stable 的 versionCode，beta 清空视为更新状态。
 */
function boardScore(info) {
  const stableVc = Number(info?.versionCode) || 0;
  const beta = (info?.beta && typeof info.beta === 'object' && !Array.isArray(info.beta)) ? info.beta : null;
  const betaVc = beta ? (Number(beta.versionCode) || 0) : 0;
  const top = Math.max(stableVc, betaVc);
  return top * 1000000 + stableVc * 100 + (beta ? 0 : 1);
}

async function fetchBestBoard(urls, { timeoutMs = 8000, hardMs = 12000 } = {}) {
  const safe = urls.map((u) =>
    request(u, { timeoutMs, registry: null })
      .then((buf) => {
        const j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
        return j && j.version ? { info: j, url: u } : null;
      })
      .catch(() => null)
  );
  // 每条线自带 timeoutMs（8s）；hardMs 只是兜底。全出结果即返回，不等满硬超时。
  const settled = await Promise.race([
    Promise.all(safe),
    new Promise((r) => setTimeout(() => r(null), hardMs)),
  ]);
  const list = settled ?? (await Promise.allSettled(safe)).map((x) => (x.status === 'fulfilled' ? x.value : null));
  const boards = list.filter(Boolean);
  if (!boards.length) throw new Error(`公告牌全部线路失败（${urls.length} 条）`);
  let best = boards[0];
  for (const b of boards) if (boardScore(b.info) > boardScore(best.info)) best = b;
  return best;
}

/**
 * 多线路并发测速：所有线路同时发请求，谁先成功返回用谁（=最快线路）。
 * 应用层硬超时兜底：即使 DNS 解析阶段卡死，到点也会 reject，不会永远 pending。
 */
function fetchFastest(urls, { timeoutMs = 8000, hardMs = 9000, range = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!urls.length) return reject(new Error('没有可用线路'));
    const registry = new Set();
    let settled = false;
    const errors = [];
    const cancelAll = () => { for (const r of registry) { try { r.destroy(); } catch { /* ignore */ } } registry.clear(); };
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelAll();
      fn(val);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`所有线路均超时（${Math.round(hardMs / 1000)}s）：${errors.slice(0, 2).join('; ') || '无响应'}`));
    }, hardMs);
    for (const u of urls) {
      request(u, { timeoutMs, registry, range })
        .then((buf) => finish(resolve, { url: u, buf }))
        .catch((e) => { errors.push(`${short(u)}:${e.message}`); });
    }
  });
}

function short(u) { try { return new URL(u).hostname; } catch { return String(u).slice(0, 24); } }

/** 把 GitHub 直链展开成多条下载线路（GitHub 直连 + 代理镜像）。 */
function downloadUrls(assetUrl) {
  const list = [];
  if (!assetUrl) return list;
  list.push(assetUrl);
  // ghproxy / gh-proxy 公共镜像（失败会自动回退，不影响主线路）
  if (/^https:\/\/github\.com\//i.test(assetUrl)) {
    list.push('https://ghproxy.net/' + assetUrl);
    list.push('https://gh-proxy.com/' + assetUrl);
  }
  return list;
}

/** 下载文件：先并发探针选最快线路，再用该线路完整下载；主线路失败自动换下一条。 */
async function download(urls, dest, onProgress) {
  const candidates = Array.isArray(urls) ? urls : [urls];
  // 1) 并发探针（只取前 2KB）选最快且可达的线路
  let ordered = candidates;
  try {
    const fastest = await fetchFastest(candidates, { timeoutMs: 7000, hardMs: 8000, range: 'bytes=0-2047' });
    ordered = [fastest.url, ...candidates.filter((u) => u !== fastest.url)];
  } catch { /* 探针全失败也照常逐个尝试完整下载 */ }

  let lastErr;
  for (const url of ordered) {
    try { await downloadOne(url, dest, onProgress); return { bytes: fs.statSync(dest).size, url }; }
    catch (e) { lastErr = e; try { fs.unlinkSync(dest); } catch { /* ignore */ } }
  }
  throw lastErr || new Error('所有下载线路均失败');
}

function downloadOne(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u, n) => {
      const mod = /^https:/i.test(u) ? https : http;
      const req = mod.get(u, { timeout: 30000, headers: { 'user-agent': 'ArkTalk-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); if (n < 4) return follow(res.headers.location, n + 1);
          return reject(new Error('重定向次数过多'));
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
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

/** 深合并：以 base 为底，override 的同名值覆盖；对象递归，数组/标量直接替换。 */
function deepMerge(base, override) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 更新迁移：把当前版本的账号 ID / 配置 / 聊天记录带进新目录，保证「更新后 ID 配置不变」。
 * 打包版用户数据在 <root>/resources/app/{config.json,data/}；开发版直接在 <root>/。
 * 回退无需处理：.bak 本身就是含完整数据的旧目录，换回来即原样恢复。
 */
function migrateUserData(oldRoot, newRoot, log = () => {}) {
  const appSub = (r) => {
    const c = path.join(r, 'resources', 'app');
    return fs.existsSync(c) ? c : r;
  };
  const oldApp = appSub(oldRoot);
  const newApp = appSub(newRoot);

  // 1) data/（身份 contacts.json、聊天记录 messages/、已读标记、文件登记…）整目录覆盖复制。
  //    新解压包里的 data/ 是空模板，不存在冲突；force 覆盖同名、保留新版可能新增的文件。
  const oldData = path.join(oldApp, 'data');
  const newData = path.join(newApp, 'data');
  if (fs.existsSync(oldData)) {
    fs.mkdirSync(newData, { recursive: true });
    fs.cpSync(oldData, newData, { recursive: true, force: true });
    log(`迁移数据：${oldData} → ${newData}`);
  }

  // 2) config.json：以新版为底深合并旧的用户配置，既保住存储路径等设置，又保留新版新增字段。
  const oldCfg = path.join(oldApp, 'config.json');
  const newCfg = path.join(newApp, 'config.json');
  if (fs.existsSync(oldCfg)) {
    try {
      const o = JSON.parse(fs.readFileSync(oldCfg, 'utf8').replace(/^\uFEFF/, ''));
      let n = {};
      try { n = JSON.parse(fs.readFileSync(newCfg, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 新版无则用旧的 */ }
      fs.writeFileSync(newCfg, JSON.stringify(deepMerge(n, o), null, 2) + '\n');
      log(`迁移配置：${oldCfg} → ${newCfg}`);
    } catch (e) {
      try { fs.copyFileSync(oldCfg, newCfg); } catch { /* ignore */ }
      log(`配置迁移降级为整份复制：${e.message}`);
    }
  }
}

/** 应用根目录（解压后的 ArkTalk-0.6.x-win64）。开发模式下用 dist 里的应用目录。 */
function appRoot(app) {
  if (app.isPackaged) return path.resolve(app.getAppPath(), '..', '..');
  return path.resolve(__dirname, '..');
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

  /** 内测通道是否已解锁（解锁状态只存哈希，不存内测码原文）。 */
  betaUnlocked() { return !!this.state.betaHash; }

  /**
   * 内测资格代码校验：sha256(输入) 与公告牌 betaCodeHash 比对。
   * 通过则把哈希存进本地状态，开放测试版检测与下载；原文不留存、不提交。
   */
  async setBetaCode(code) {
    const c = String(code || '').trim();
    if (!c) return { ok: false, error: '请输入内测资格代码' };
    const { info } = await fetchBestBoard(STABLE_URLS.map((u) => `${u}?t=${Date.now()}`));
    const target = typeof info.betaCodeHash === 'string' ? info.betaCodeHash.toLowerCase() : '';
    if (!target) return { ok: false, error: '公告牌尚未配置内测通道' };
    const h = crypto.createHash('sha256').update(c, 'utf8').digest('hex');
    if (h !== target) return { ok: false, error: '内测码不正确' };
    this.state.betaHash = h;
    this._saveState();
    this.log('内测通道已解锁');
    return { ok: true };
  }

  /**
   * 检查更新：多线路并发测速拉公告牌。
   * 正式版：stable=true 且版本更高才 available。
   * 测试版：公告牌 beta 条目，仅在输入内测码解锁（且哈希仍与 betaCodeHash 一致）后开放；
   *         同时有正式版与测试版可选时，取版本号更高的一条。
   */
  async check() {
    const { info, url } = await fetchBestBoard(STABLE_URLS.map((u) => `${u}?t=${Date.now()}`));
    const cur = this.currentVersion();
    const beta = (info.beta && typeof info.beta === 'object' && !Array.isArray(info.beta)) ? info.beta : null;
    const betaCodeHash = typeof info.betaCodeHash === 'string' ? info.betaCodeHash.toLowerCase() : '';
    // 解锁有效性：本地存过哈希，且（公告牌没配哈希时保持解锁；配了则必须一致）
    const unlocked = this.betaUnlocked() && (!betaCodeHash || this.state.betaHash === betaCodeHash);

    let pick = null;
    if (info.stable && cmpVer(info.version, cur) > 0) {
      pick = { channel: 'stable', version: info.version, notes: info.notes ?? '', published: info.published ?? '', assetUrl: info.assets?.windows ?? '' };
    }
    if (unlocked && beta && beta.assets?.windows && cmpVer(beta.version, cur) > 0) {
      if (!pick || cmpVer(beta.version, pick.version) > 0) {
        pick = { channel: 'beta', version: beta.version, notes: beta.notes ?? '', published: beta.published ?? '', assetUrl: beta.assets.windows };
      }
    }
    this.log(`公告牌来源：${short(url)}，正式版 ${info.version}${beta ? `，测试版 ${beta.version}` : ''}，当前 ${cur}${unlocked ? '，内测已解锁' : ''}`);
    return {
      current: cur,
      latest: pick?.version ?? info.version ?? '',
      available: !!pick,
      channel: pick?.channel ?? '',
      isBeta: pick?.channel === 'beta',
      notes: pick?.notes ?? '',
      published: pick?.published ?? '',
      assetUrl: pick?.assetUrl ?? '',
      source: short(url),
      skipped: pick ? this.state.skipped === pick.version : false,
      betaUnlocked: unlocked,
      betaLatest: beta?.version ?? '',
      betaPublished: beta?.published ?? ''
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
    const dl = await download(downloadUrls(info.assetUrl), tmp, (pct) => this.log(`下载更新包 ${pct}%`));
    this.log(`下载完成：${dl.bytes} 字节，线路 ${short(dl.url)}`);
    fs.mkdirSync(newDir, { recursive: true });
    await this._extract(tmp, newDir);
    const nested = path.join(newDir, `ArkTalk-${info.latest}-win64`);
    if (fs.existsSync(nested)) {
      for (const e of fs.readdirSync(nested)) fs.renameSync(path.join(nested, e), path.join(newDir, e));
      fs.rmdirSync(nested);
    }
    // 关键：把当前版本的账号 ID / 配置 / 聊天记录迁移进新目录，保证更新后数据不变。
    // 必须在 apply 之前做（此刻旧目录还在运行、可读）。
    migrateUserData(root, newDir, (m) => this.log(m));
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

module.exports = { Updater, cmpVer, STABLE_URL, STABLE_URLS, fetchFastest, downloadUrls };
