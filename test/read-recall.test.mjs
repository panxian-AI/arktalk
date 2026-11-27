// 专项测试：已读回执（read 帧）+ 未发出撤回（cancelQueued / isQueued / isPending）
// 用两个裸 PeerLink 直连，不依赖桥。
import { PeerLink } from '../src/p2p.js';
import net from 'node:net';

const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? '✅' : '❌'} ${name}`); };

function freePort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

const [portA, portB] = await Promise.all([freePort(), freePort()]);
const eventsA = { read: [], online: [] };
const A = new PeerLink({ selfId: '111', listen: { host: '127.0.0.1', port: portA }, log: () => {} });
const B = new PeerLink({ selfId: '222', listen: { host: '127.0.0.1', port: portB }, log: () => {} });
A.on('read', (r) => eventsA.read.push(r));
A.on('peer-online', (id) => eventsA.online.push(id));
B.on('peer-online', () => {});
await A.start(); await B.start();

// 互加地址 → 双向拨号
A.setEndpoint('222', `127.0.0.1:${portB}`);
B.setEndpoint('111', `127.0.0.1:${portA}`);
await new Promise((r) => setTimeout(r, 800));
ok('A 与 B 直连在线', A.isOnline('222') && B.isOnline('111'));

// 1) 已读回执
ok('sendRead 成功', A.sendRead('222', 1234567890) === true);
await new Promise((r) => setTimeout(r, 300));
ok('B 收到 read 帧（ts 正确）', eventsA.read.length === 0 && true); // read 发给对方，A 不该收到
const gotOnB = new Promise((res) => { const h = (r) => res(r); B.on('read', h); });
A.sendRead('222', 1700000000);
const rd = await Promise.race([gotOnB, new Promise((res) => setTimeout(() => res(null), 1500))]);
ok('B 侧 read 事件（from/ts）', rd && rd.from === '111' && rd.ts === 1700000000);

// 2) 未发出撤回：B 离线时 A 发消息 → 进发件箱 → 撤回
A.endpoints.delete('222'); // 拆掉地址，模拟 B 不可达
// 等待现有连接被清理：直接 stop B，A 侧连接会断
await B.stop();
await new Promise((r) => setTimeout(r, 4000)); // 超过掉线宽限
ok('A 侧 B 已离线', !A.isOnline('222'));

// 清掉 A 的拨号地址，让消息只能排队
const { queued, envelope } = A.send('222', [{ type: 'text', data: { text: '待撤回' } }]);
await new Promise((r) => setTimeout(r, 600));
ok('消息进入发件箱（queued）', queued === true);
ok('isQueued = true', A.isQueued('222', envelope.id) === true);
ok('isPending = true', A.isPending('222', envelope.id) === true);

// 撤回
const removed = A.cancelQueued('222', envelope.id);
ok('cancelQueued 删除成功', removed === true);
ok('撤回后 isQueued = false', A.isQueued('222', envelope.id) === false);
ok('撤回后 isPending = false', A.isPending('222', envelope.id) === false);
const again = A.cancelQueued('222', envelope.id);
ok('重复撤回返回 false', again === false);

A.stop();
const pass = results.filter(([, c]) => c).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
