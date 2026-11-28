// 内测资格代码 + 测试版通道 端到端验证（真公告牌）
// 用法: node test/beta-channel-test.js <正确内测码>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Updater } = require('../electron/updater.cjs');

const CODE = process.argv[2] || '';
const stateFile = path.join(os.tmpdir(), 'arktalk-update-state.json');
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

// 用独立 stateFile，避免污染真实解锁状态
const u = new Updater({ isPackaged: false }, () => {});
u.stateFile = stateFile.replace('.json', `-beta-test-${Date.now()}.json`);
u.state = u._loadState();

// 1. 错误码被拒绝
const bad = await u.setBetaCode('xxxxxxxxxxxxxxxxxxxx');
ok('错误内测码被拒绝', bad.ok === false && /不正确/.test(bad.error || ''));

// 2. 正确码解锁（真公告牌 betaCodeHash）
const good = await u.setBetaCode(CODE);
ok('正确内测码解锁成功', good.ok === true);

// 3. 本地只存哈希不存原文
const raw = fs.readFileSync(u.stateFile, 'utf8');
ok('状态文件不含内测码原文', !raw.includes(CODE) && /betaHash/.test(raw));

// 4. 解锁态生效
ok('betaUnlocked()=true', u.betaUnlocked() === true);

// 5. check() 正常返回且带新字段（公告牌 beta=null 时 latest=正式版号）
const r = await u.check();
ok('check() 返回 channel/betaUnlocked 字段', typeof r.channel === 'string' && typeof r.betaUnlocked === 'boolean');
ok('公告牌 beta=null 时不开测试版', r.isBeta === false && r.betaLatest === '');

// 6. 哈希一致性自证：sha256(正确码) === 公告牌 betaCodeHash
const h = crypto.createHash('sha256').update(CODE, 'utf8').digest('hex');
ok('sha256(内测码) 与公告牌一致', h === '28abd4672798dd885ba42d6302381b8ddeebab440356630cd6776c7d802e4379');

// 清理测试 state 文件
try { fs.unlinkSync(u.stateFile); } catch {}
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
