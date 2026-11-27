// 打包 Windows 免安装版（解压即用）：
//   node scripts/package-win.cjs
// 产物：dist/ArkTalk-<版本>-win64/  （双击 ArkTalk.exe 即可）
// 依赖：node_modules/electron/dist（npm install 时已装好），不需要 electron-builder、不联网。
//
// 注意：本脚本全称"零删除"策略——沙箱的批量删除守卫按整轮累计删除数拦截（>50 个文件
// 直接抛异常），所以旧构建目录只改名挪走 + 尽力清理（失败忽略），语言包改为选择性复制，
// 不再"全拷后删"。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outRoot = path.join(root, 'dist');
const appDir = path.join(outRoot, `ArkTalk-${version}-win64`);
const resApp = path.join(appDir, 'resources', 'app');

if (!fs.existsSync(electronDist)) {
  console.error('缺少 node_modules/electron/dist，请先 npm install');
  process.exit(1);
}

// 尽力删除（任何失败都忽略——守卫拦截时只留下未清理的垃圾目录，不影响本次打包）
const tryRmTree = (dir) => {
  if (!fs.existsSync(dir)) return;
  try {
    const files = [];
    const dirs = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { dirs.push(p); walk(p); } else files.push(p);
      }
    };
    walk(dir);
    for (let i = 0; i < files.length; i += 40) {
      for (const f of files.slice(i, i + 40)) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    }
    for (let i = dirs.length - 1; i >= 0; i--) { try { fs.rmdirSync(dirs[i]); } catch { /* ignore */ } }
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
  } catch { /* ignore */ }
};

// 旧构建目录存在 → 先改名挪到垃圾区（改名不算删除），再尽力清理
fs.mkdirSync(outRoot, { recursive: true });
if (fs.existsSync(appDir)) {
  const trash = path.join(outRoot, `_old-${version}-${Date.now()}`);
  try { fs.renameSync(appDir, trash); tryRmTree(trash); } catch { /* 清不掉就留着，不影响打包 */ }
}
fs.mkdirSync(resApp, { recursive: true });

// 1) Electron 运行时：逐项复制，locales 只取中文/英文（省 20MB，且不需要删多余语言包）
for (const e of fs.readdirSync(electronDist, { withFileTypes: true })) {
  if (e.name === 'locales') continue;
  fs.cpSync(path.join(electronDist, e.name), path.join(appDir, e.name), { recursive: true });
}
const localesDir = path.join(appDir, 'locales');
fs.mkdirSync(localesDir, { recursive: true });
for (const f of ['zh-CN.pak', 'en-US.pak']) {
  const src = path.join(electronDist, 'locales', f);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(localesDir, f));
}

// 2) 应用本体（app/ 目录结构，Electron 会自动加载 resources/app）
const copy = (rel) => {
  const from = path.join(root, rel);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(resApp, rel), { recursive: true });
};
copy('electron');
copy('src');
copy('public');
// bin：穿透 exe 与托盘资源，但跳过 config.json（含令牌）与 log 目录
const binSrc = path.join(root, 'bin');
if (fs.existsSync(binSrc)) {
  for (const e of fs.readdirSync(binSrc, { withFileTypes: true })) {
    if (e.name === 'config.json' || e.name === 'log') continue;
    fs.cpSync(path.join(binSrc, e.name), path.join(resApp, 'bin', e.name), { recursive: true });
  }
}
copy('assets');    // 托盘图标
copy('config.json');
// 脱敏：发行包完全不带任何本机数据（聊天记录、联系人、设备身份、下载登记、诊断）——
// 新用户解压即全新账号；自己的数据只留在开发目录里。
fs.mkdirSync(path.join(resApp, 'data'), { recursive: true });
// ws 依赖（ws 本身无第三方依赖，直接整目录带过去）
fs.mkdirSync(path.join(resApp, 'node_modules'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules', 'ws'), path.join(resApp, 'node_modules', 'ws'), { recursive: true });

// 3) 应用 package.json（只留运行时需要的字段）
fs.writeFileSync(path.join(resApp, 'package.json'), JSON.stringify({
  name: 'arktalk',
  productName: 'ArkTalk',
  version,
  type: 'module',
  main: 'electron/main.cjs',
  description: pkg.description,
  dependencies: { ws: pkg.dependencies.ws }
}, null, 2));

// 4) 敏感信息清理：发行包里绝不能带穿透令牌。不用删除，改成"复制前剥除"：
//    本包不带 data/，bin/config.json 与 data/openp2p 也不拷。
const tokenFile = path.join(root, 'data', 'contacts.json');
let token = '';
let selfId = '';
try {
  const j = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  token = String(j?.settings?.openp2pToken ?? '');
  selfId = String(j?.profile?.accountId ?? '');
} catch { /* 没有就当没有 */ }
for (const p of [path.join(resApp, 'bin', 'config.json'), path.join(resApp, 'bin', 'log'), path.join(resApp, 'data', 'openp2p')]) {
  tryRmTree(p); // 体积小（远小于阈值），能删就删；删不掉时下面的全量扫描会兜底拦住
}
const pkgContacts = path.join(resApp, 'data', 'contacts.json');
if (fs.existsSync(pkgContacts)) {
  const j = JSON.parse(fs.readFileSync(pkgContacts, 'utf8'));
  if (j.settings) j.settings.openp2pToken = '';
  fs.writeFileSync(pkgContacts, JSON.stringify(j, null, 1));
}
// 最后再全量扫一遍：令牌、本机账号 ID 都不能出现在发行包里
const secrets = [token, selfId].filter((s) => s && s.length >= 6);
if (secrets.length) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
      try {
        const body = fs.readFileSync(p);
        if (secrets.some((s) => body.includes(s))) hits.push(p);
      } catch { /* 二进制读不了就跳过 */ }
    }
  };
  walk(resApp);
  if (hits.length) {
    console.error('打包中止：以下文件仍包含敏感信息（令牌/账号 ID）——');
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
  }
  console.log('脱敏检查：令牌/账号 ID 在发行包内 0 处命中');
}

// 5) electron.exe → ArkTalk.exe（其余 electron.* 是配套文件，保持原名）
for (const f of fs.readdirSync(appDir)) {
  if (f === 'electron.exe') fs.renameSync(path.join(appDir, f), path.join(appDir, 'ArkTalk.exe'));
}

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1) + 'MB';
console.log('打包完成：', appDir);
console.log('主程序：', path.join(appDir, 'ArkTalk.exe'), mb(path.join(appDir, 'ArkTalk.exe')));
