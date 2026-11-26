// ArkTalk 自检：起 A/B 两个真实例（各自账号 + P2P 内核），验证端对端收发。
// 不碰任何 QQ / SnowLuma —— 本软件与它们无数据沟通。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Bridge } from '../src/bridge.js';
import { LocalStore } from '../src/store.js';

const results = [];
let failed = 0;
function check(name, ok, extra = '') {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let portSeq = 23400;
const nextPort = () => ++portSeq;

function makeInstance(dataDir) {
  const store = new LocalStore(dataDir, () => {});
  return new Bridge({
    store,
    listen: { host: '127.0.0.1', port: nextPort() },
    p2p: { host: '127.0.0.1', port: nextPort() },
    log: () => {}
  });
}

function rpcOver(ui, name, params) {
  return new Promise((resolve, reject) => {
    const reqId = `t_${name}_${Math.random().toString(36).slice(2)}`;
    const onMsg = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'action-result' && m.reqId === reqId) { ui.off('message', onMsg); m.ok ? resolve(m.data) : reject(new Error(m.error)); }
    };
    ui.on('message', onMsg);
    ui.send(JSON.stringify({ type: 'rpc', name, params, reqId }));
    setTimeout(() => { ui.off('message', onMsg); reject(new Error('rpc 超时')); }, 10000);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowchat-selftest-'));
  const A = makeInstance(path.join(tmpDir, 'A'));
  const B = makeInstance(path.join(tmpDir, 'B'));
  const C = makeInstance(path.join(tmpDir, 'C'));
  await Promise.all([A.start(), B.start(), C.start()]);

  // 1) hello 帧：完全独立，无任何 QQ/上游字段
  const framesA = [];
  const framesB = [];
  const uiA = new WebSocket(`ws://127.0.0.1:${A.listen.port}/ws?token=${A.uiToken}`);
  uiA.on('message', (raw) => framesA.push(JSON.parse(String(raw))));
  await new Promise((r) => uiA.on('open', r));
  await sleep(300);
  const hello = framesA.find((f) => f.type === 'hello');
  check('hello 存在', !!hello);
  check('hello 含本机账号（认设备，自动生成）', !!hello?.self?.accountId);
  check('hello 无上游/requests 等 QQ 残留字段', !('upstreamOnline' in (hello ?? {})) && !('requests' in (hello ?? {})));
  check('hello 联系人为空（待手动添加）', (hello?.friends ?? []).length === 0);

  // 2) 加联系人 + 直连上线
  let uiB = new WebSocket(`ws://127.0.0.1:${B.listen.port}/ws?token=${B.uiToken}`);
  uiB.on('message', (raw) => framesB.push(JSON.parse(String(raw))));
  await new Promise((r) => uiB.on('open', r));
  let bOnline = null;
  B.link.on('peer-online', (id) => { bOnline = id; });
  const addRes = await rpcOver(uiA, 'add-friend', { userId: B.local.profile.accountId, remark: 'B 设备', endpoint: `127.0.0.1:${B.p2pCfg.port}` });
  check('添加联系人成功', addRes?.added === true);
  // 双向：B 也添加 A（联系人手动模型，两边都要加）
  await rpcOver(uiB, 'add-friend', { userId: A.local.profile.accountId, remark: 'A 设备', endpoint: `127.0.0.1:${A.p2pCfg.port}` });
  await sleep(700);
  check('P2P 直连建立（B 侧 peer-online）', String(bOnline) === String(A.local.profile.accountId));

  // 3) 资料互报：B 设置昵称 → A 的联系人资料自动补全
  await rpcOver(uiB, 'set-profile', { nickname: '小B' });
  await sleep(400);
  const fA = A.local.friends.find((f) => String(f.user_id) === String(B.local.profile.accountId));
  check('对端资料经 P2P 通讯补全（昵称）', fA?.nickname === '小B');

  // 4) 私聊收发（P2P 端对端）
  const gotMsg = new Promise((resolve) => {
    const h = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'event' && m.chatKey === `p${A.local.profile.accountId}` && m.record) { uiB.off('message', h); resolve(m.record); }
    };
    uiB.on('message', h);
  });
  const sendRes = await rpcOver(uiA, 'send-private', { userId: B.local.profile.accountId, segs: [{ type: 'text', data: { text: '你好 B' } }] });
  check('发送经 P2P 直发（未排队）', sendRes?.queued === false);
  const received = await gotMsg;
  check('B 收到 A 的消息', received?.message?.[0]?.data?.text === '你好 B');
  await sleep(200);
  check('消息落 B 本机（离线信息留本机）', B.store.read(`p${A.local.profile.accountId}`, 10).some((x) => x.message?.[0]?.data?.text === '你好 B'));
  check('消息落 A 本机（自发记录）', A.store.read(`p${B.local.profile.accountId}`, 10).some((x) => x.self_sent === true));

  // 5) 未知账号来讯被忽略（C 未被 B 添加）
  const bEventCount = framesB.filter((f) => f.type === 'event').length;
  B._onPeerMessage({ from: String(C.local.profile.accountId), to: String(B.local.profile.accountId), time: Math.floor(Date.now() / 1000), segs: [{ type: 'text', data: { text: '陌生消息' } }], id: 'fake1' });
  await sleep(300);
  check('未知账号消息被忽略（不进会话）', framesB.filter((f) => f.type === 'event').length === bEventCount
    && !B.store.listChats().some((c) => c.chatKey === `p${C.local.profile.accountId}`));

  // 6) 本地群群发
  const g = await rpcOver(uiA, 'create-group', { name: '测试群', memberIds: [B.local.profile.accountId] });
  await rpcOver(uiA, 'send-to-group', { groupId: g.group_id, message: [{ type: 'text', data: { text: '群里好' } }] });
  await sleep(400);
  check('本地群消息逐成员送达 B', B.store.read(`p${A.local.profile.accountId}`, 10).some((x) => x.message?.[0]?.data?.text === '群里好'));

  // 7) 离线发件箱：停 B → A 发 → 重启 B → 补发
  await B.stop();
  await sleep(300);
  const queuedRes = await rpcOver(uiA, 'send-private', { userId: B.local.profile.accountId, segs: [{ type: 'text', data: { text: '离线补发' } }] });
  check('对端离线时消息入箱（queued）', queuedRes?.queued === true);
  await B.start();
  uiB.close(); // 旧 socket 连的是被停掉的实例，重连新实例
  uiB = new WebSocket(`ws://127.0.0.1:${B.listen.port}/ws?token=${B.uiToken}`);
  uiB.on('message', (raw) => framesB.push(JSON.parse(String(raw))));
  await new Promise((r) => uiB.on('open', r));
  await sleep(3500); // A 自动重连（2s 退避）+ 补发
  check('B 重启后离线消息自动补发', B.store.read(`p${A.local.profile.accountId}`, 10).some((x) => x.message?.[0]?.data?.text === '离线补发'));

  // 8) 非法输入校验
  const badAdd = await rpcOver(uiA, 'add-friend', { userId: 'abc' }).then(() => ({ ok: true }), (e) => ({ ok: false, e }));
  check('非法账号被拒绝', badAdd?.ok === false);

  // 9) 文件传输：A 上传 → 发卡片 → B 点保存 → 分块并发拉取 → 落盘一致
  const payload = Buffer.alloc(1024 * 1024 + 12345); // ~1 MB（跨多块）
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const upRes = await fetch(`http://127.0.0.1:${A.listen.port}/api/upload?token=${A.uiToken}&name=${encodeURIComponent('测试.bin')}`, {
    method: 'POST', body: new Uint8Array(payload)
  }).then((r) => r.json());
  check('HTTP 上传落盘（返回 fileId/size）', !!upRes?.fileId && upRes?.size === payload.length);
  const fileSend = await rpcOver(uiA, 'send-file', { userId: B.local.profile.accountId, fileId: upRes.fileId, name: upRes.name, size: upRes.size });
  check('文件卡片经 P2P 直发', fileSend?.queued === false);
  await sleep(200);
  const card = B.store.read(`p${A.local.profile.accountId}`, 10).find((x) => x.message?.[0]?.type === 'file');
  check('B 收到文件卡片（元数据）', card?.message?.[0]?.data?.file_id === upRes.fileId);
  const dlDone = new Promise((resolve) => {
    const h = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'file-done' && m.fileId === upRes.fileId) { framesB.forEach(() => {}); resolve(m); }
    };
    uiB.on('message', h);
  });
  await rpcOver(uiB, 'download-file', { userId: A.local.profile.accountId, fileId: upRes.fileId, name: card.message[0].data.name, size: upRes.size });
  const dl = await dlDone;
  const saved = fs.readFileSync(dl.path);
  check('下载完成且内容逐字节一致（分块并发）', saved.length === payload.length && saved.equals(payload));
  await sleep(500); // file-done 回执异步到 A
  const ackSeen = framesA.some((f) => f.type === 'file-ack' && f.fileId === upRes.fileId);
  check('A 收到对方接收确认（file-ack）', ackSeen);
  check('下载进度有推送（file-progress）', framesB.some((f) => f.type === 'file-progress' && f.fileId === upRes.fileId));

  uiA.close(); uiB.close();
  await Promise.all([A.stop(), B.stop(), C.stop()]);
  A.store.close(); B.store.close(); C.store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('自检异常：', e); process.exit(1); });
