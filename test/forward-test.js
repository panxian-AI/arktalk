/* 转发专项测试：forward-messages 的文件准备、逐条/合并分支与跳过回报。
   只测 _forwardMessages：用 Object.create 挂最小依赖（不启动 P2P/存储）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';

function makeBridge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
  const filesDir = path.join(tmp, 'files');
  fs.mkdirSync(filesDir);
  const b = Object.create(Bridge.prototype);
  b.filesDir = filesDir;
  b.outFiles = new Map();
  b.downloadsDone = new Map();
  b._saveOutRegistry = () => {};
  b.sent = [];
  b.groupSent = [];
  b._sendToPeerPersist = async (uid, segs) => { b.sent.push({ uid, segs }); return { queued: false }; };
  b._sendToGroup = async ({ groupId, message }) => { b.groupSent.push({ groupId, message }); return { failed: 0 }; };
  b.tmp = tmp;
  return b;
}

test('转发：自己发过的文件（filesDir 已有）直接逐条重发', async () => {
  const b = makeBridge();
  fs.writeFileSync(path.join(b.filesDir, 'fidA'), 'hello');
  b.outFiles.set('fidA', { name: 'a.txt', size: 5 });
  const items = [{ sender_name: '张三', time: 100, segs: [{ type: 'text', data: { text: 'hi' } }] },
                 { sender_name: '我', time: 200, segs: [{ type: 'file', data: { file_id: 'fidA', name: 'a.txt', size: 5 } }] }];
  const r = await b._forwardMessages({ userId: 111, mode: 'one', items });
  assert.equal(r.sent, 2);
  assert.equal(r.skipped.length, 0);
  assert.equal(b.sent.length, 2);
  assert.deepEqual(b.sent.map((x) => x.uid), [111, 111]);
  assert.equal(b.sent[0].segs[0].data.text, 'hi');
});

test('转发：接收的文件未保存 → 跳过并回报；已保存 → 复制进 filesDir 并注册 outFiles', async () => {
  const b = makeBridge();
  const src = path.join(b.tmp, 'saved.bin');
  fs.writeFileSync(src, 'saved-content');
  const notSaved = path.join(b.tmp, 'nope.bin');
  fs.writeFileSync(notSaved, 'x');
  b.downloadsDone.set('fidOK', { path: src, name: 'saved.bin' });
  // 未保存的文件：downloadsDone 没有登记
  const itemsOK = [{ sender_name: '李四', time: 1, segs: [{ type: 'file', data: { file_id: 'fidOK', name: 'saved.bin', size: 13 } }] }];
  const r1 = await b._forwardMessages({ userId: 222, mode: 'merged', items: itemsOK });
  assert.equal(r1.sent, 1);
  assert.equal(b.groupSent.length, 0);
  assert.equal(b.sent.length, 1);
  const seg = b.sent[0].segs[0];
  assert.equal(seg.type, 'forward');
  assert.equal(seg.data.items.length, 1);
  assert.equal(seg.data.items[0].sender_name, '李四');
  assert.ok(fs.existsSync(path.join(b.filesDir, 'fidOK')), '已下载副本应复制进 filesDir');
  assert.ok(b.outFiles.has('fidOK'), '应注册 outFiles 供第三人拉取');
  // 未保存的文件：整条被跳过 → 没有可转发内容 → 报错
  const itemsBad = [{ sender_name: '王五', time: 1, segs: [{ type: 'file', data: { file_id: 'fidNope', name: 'nope.bin', size: 1 } }] }];
  await assert.rejects(() => b._forwardMessages({ userId: 222, mode: 'one', items: itemsBad }), /尚未保存/);
});

test('转发：合并模式发到群（单条 forward seg）；逐条模式发到群保持条数', async () => {
  const b = makeBridge();
  const items = [
    { sender_name: 'A', time: 1, segs: [{ type: 'text', data: { text: '一' } }] },
    { sender_name: 'B', time: 2, segs: [{ type: 'text', data: { text: '二' } }] },
    { sender_name: 'C', time: 3, segs: [{ type: 'text', data: { text: '三' } }] },
  ];
  const rm = await b._forwardMessages({ groupId: 9, mode: 'merged', items });
  assert.equal(rm.sent, 1);
  assert.equal(b.groupSent.length, 1);
  assert.equal(b.groupSent[0].groupId, 9);
  assert.equal(b.groupSent[0].message[0].type, 'forward');
  assert.equal(b.groupSent[0].message[0].data.items.length, 3);
  const ro = await b._forwardMessages({ groupId: 9, mode: 'one', items });
  assert.equal(ro.sent, 3);
  assert.equal(b.groupSent.length, 4);
  assert.equal(b.groupSent[1].message[0].data.text, '一');
  assert.equal(b.groupSent[3].message[0].data.text, '三');
});

test('转发：空 items 与超限条数（>50 截断）', async () => {
  const b = makeBridge();
  await assert.rejects(() => b._forwardMessages({ userId: 1, mode: 'one', items: [] }), /没有可转发/);
  const many = Array.from({ length: 60 }, (_, i) => ({ sender_name: 'x', time: i, segs: [{ type: 'text', data: { text: String(i) } }] }));
  const r = await b._forwardMessages({ userId: 1, mode: 'merged', items: many });
  assert.equal(r.sent, 1);
  assert.equal(b.sent[0].segs[0].data.items.length, 50, '超过 50 条应截断');
});
