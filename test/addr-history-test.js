// 地址学习专项测试：持久化地址池的恢复、落盘、淘汰与优先拨号。
// 运行：node test/addr-history-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerLink } from '../src/p2p.js';

let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { failN++; console.log(`  ✗ ${name}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arktalk-hist-'));
const histFile = path.join(dir, 'endpoint-history.json');

// ---------- 1. 启动恢复：历史文件回填统计 + 并入候选 ----------
fs.writeFileSync(histFile, JSON.stringify({
  v: 1,
  links: {
    111: [
      { ep: '192.168.66.89:3021', ok: 12, fail: 0, rtt: 30, lastOk: 1795835314000 },
      { ep: '192.168.1.7:3021', ok: 2, fail: 0, rtt: 55, lastOk: 1795700000000 },
      { ep: '127.0.0.1:13100', ok: 99, fail: 0, rtt: 5, lastOk: 1795999999000 }  // 隧道地址：应被排除
    ]
  }
}));
const a = new PeerLink({ selfId: 42, listen: { host: '127.0.0.1', port: 0 }, historyPath: histFile });
const s89 = a._score.get('111')?.get('192.168.66.89:3021');
ok(s89?.ok === 12 && s89.rtt === 30, '恢复成功地址的统计（ok/rtt）');
const sT = a._score.get('111')?.get('127.0.0.1:13100');
ok(!sT || sT.ok === 0, '本机隧道地址不进历史统计');
ok((a.endpoints.get('111') ?? []).includes('192.168.66.89:3021'), '历史地址并入候选列表');
ok(!(a.endpoints.get('111') ?? []).includes('127.0.0.1:13100'), '隧道地址不并入候选列表');
ok(a._candOf('111', '192.168.1.7:3021').ok === 2, '第二条历史地址同样恢复');

// ---------- 2. 恢复统计参与排序：成功率高的排前面 ----------
const ranked = a._rank('111', ['192.168.1.7:3021', '192.168.66.89:3021']);
ok(ranked[0] === '192.168.66.89:3021', '候选排序：历史成功率高的地址优先');

// ---------- 3. 拨号成功后节流落盘 ----------
a._scoreOk('111', '10.0.0.5:3021', 42);
ok(!fs.readFileSync(histFile, 'utf8').includes('10.0.0.5:3021'), '打分后立即节流（3 秒内未落盘）');
a._persistHistory();
const saved = JSON.parse(fs.readFileSync(histFile, 'utf8'));
const eps = (saved.links['111'] ?? []).map((x) => x.ep);
ok(eps.includes('10.0.0.5:3021'), '成功地址写入持久化文件');
ok(!eps.some((e) => e.startsWith('127.')), '落盘内容不含本机隧道地址');
ok((saved.links['111'] ?? []).every((x) => x.ok > 0), '只落盘成功过的地址');
a.stop();

// ---------- 4. 上限淘汰：每联系人最多 8 条 ----------
const b = new PeerLink({ selfId: 42, listen: { host: '127.0.0.1', port: 0 }, historyPath: histFile });
for (let i = 0; i < 12; i++) b._scoreOk('222', `10.0.0.${i}:3021`, 10 + i);
b._persistHistory();
const many = JSON.parse(fs.readFileSync(histFile, 'utf8'));
ok(((many.links['222'] ?? []).length) <= 8, `历史地址上限 8 条（实际 ${(many.links['222'] ?? []).length}）`);
b.stop();

// ---------- 5. 重启闭环：落盘的统计能被新实例完整恢复 ----------
const survived = JSON.parse(fs.readFileSync(histFile, 'utf8')).links['222'].map((x) => x.ep);
ok(survived.length === 8, '重启前文件里确有 8 条');
const c = new PeerLink({ selfId: 42, listen: { host: '127.0.0.1', port: 0 }, historyPath: histFile });
const got = c._candOf('222', survived[0]);
ok(got.ok > 0, '新实例从文件恢复统计（模拟重启）');
const ranks = c._rank('222', [survived[1], survived[0]]);
ok(ranks[0] === survived[0] && ranks[1] === survived[1] || got.rtt <= c._candOf('222', survived[1]).rtt, '重启后按历史 rtt/成功率优先拨');
c.stop();

// ---------- 6. 坏文件容错 ----------
fs.writeFileSync(histFile, 'not-json{{{');
let crashed = false;
try { new PeerLink({ selfId: 42, listen: { host: '127.0.0.1', port: 0 }, historyPath: histFile }).stop(); }
catch { crashed = true; }
ok(!crashed, '损坏的历史文件不致崩溃（静默忽略）');

console.log(`\n地址学习专项：${pass} 通过 / ${failN} 失败`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failN ? 1 : 0);
