// ArkTalk 桌面窗口启动器。
// 某些终端环境预设了 ELECTRON_RUN_AS_NODE=1（会把 Electron 降级成纯 Node），
// 这里统一剥掉再拉起 Electron，保证任何环境下都能弹真窗口。
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, ['.', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
child.on('error', (e) => { console.error('Electron 启动失败：', e.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 0));
