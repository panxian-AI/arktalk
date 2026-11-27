// 端到端文件传输验证：两个真实 Bridge 实例，走真实 P2P 连接 + 真实 HTTP 上传。
// 覆盖：上传 → 发卡片 → 对方拉块 → 乱序写入 → 落地校验 CRC。
// 运行：node test/file-e2e.mjs
import { Bridge } from '../src/bridge.js';
import { LocalStore } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arktalk-file-e2e-'));
const quiet = () => {};
const logs = [];
const PORT = { aUi: 13520, aP2p: 13521, bUi: 13522, bP2p: 13523 };

const A = new Bridge({
  store: new LocalStore(path.join(TMP, 'a'), quiet),
  listen: { host: '127.0.0.1', port: PORT.aUi },
  p2p: { host: '127.0.0.1', port: PORT.aP2p },
  log: (m) => logs.push('[A] ' + m)
});
const B = new Bridge({
  store: new LocalStore(path.join(TMP, 'b'), quiet),
  listen: { host: '127.0.0.1', port: PORT.bUi },
  p2p: { host: '127.0.0.1', port: PORT.bP2p },
  log: (m) => logs.push('[B] ' + m)
});
// 别往用户真实的「下载」目录里塞测试文件
B.downloadsDir = path.join(TMP, 'downloads-b');
fs.mkdirSync(B.downloadsDir, { recursive: true });

const idA = A.local.profile.accountId;
const idB = B.local.profile.accountId;
A.start();
B.start();
A._addFriend({ userId: idB, endpoint: `127.0.0.1:${PORT.bP2p}` });
B._addFriend({ userId: idA, endpoint: `127.0.0.1:${PORT.aP2p}` });
A.link.setEndpoint(idB, `127.0.0.1:${PORT.bP2p}`);
B.link.setEndpoint(idA, `127.0.0.1:${PORT.aP2p}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}

function upload(port, token, name, buf) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `/api/upload?token=${token}&name=${encodeURIComponent(name)}`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': buf.length }
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('bad json: ' + b)); } });
    });
    req.on('error', reject);
    req.end(buf);
  });
}

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failed++; };

const main = async () => {
  console.log(`A=${idA} B=${idB}  临时目录 ${TMP}`);

  const connected = !!(await waitFor(() => A.link.isOnline(idB) && B.link.isOnline(idA), 15000));
  ok(connected, '两端建立 P2P 直连');
  if (!connected) throw new Error('连接没建立');

  // 1.7MB 随机数据：不是 chunkSize(512KB) 的整数倍，能覆盖"最后一块 eof"分支
  const payload = crypto.randomBytes(Math.floor(512 * 1024 * 3.3));
  const sum = crypto.createHash('sha256').update(payload).digest('hex');
  const NAME = '测试文件 v1.bin';

  const up = await upload(PORT.aUi, A.uiToken, NAME, payload);
  ok(up && up.fileId && up.size === payload.length, `A 上传成功（${up?.size} 字节）`);

  await A._sendFile({ userId: idB, fileId: up.fileId, name: up.name, size: up.size });
  const got = await waitFor(() => {
    const list = B.store.read(`p${idA}`, 20) ?? [];
    return list.find((r) => (r.message ?? []).some((s) => s.type === 'file')) || null;
  }, 10000);
  ok(!!got, 'B 收到文件卡片');

  const seg = (got?.message ?? []).find((s) => s.type === 'file');
  const card = seg?.data ?? {};
  ok(String(card.file_id) === String(up.fileId), '卡片里的 fileId 与上传一致');
  ok(Number(card.size) === payload.length, `卡片 size 正确（${card.size}）`);
  ok(String(card.name) === NAME, '卡片文件名（含中文/空格）未被破坏');

  // B 点「保存」
  B._downloadFile({ userId: idA, fileId: String(card.file_id), name: String(card.name), size: Number(card.size) });
  const done = await waitFor(() => B.downloads.size === 0 && fs.existsSync(path.join(B.downloadsDir, NAME)), 40000);
  ok(done, 'B 完成接收并落盘');

  const dest = path.join(B.downloadsDir, NAME);
  if (fs.existsSync(dest)) {
    const recv = fs.readFileSync(dest);
    const gotSum = crypto.createHash('sha256').update(recv).digest('hex');
    ok(recv.length === payload.length, `落盘大小一致（${recv.length} / ${payload.length}）`);
    ok(gotSum === sum, 'SHA-256 校验一致（内容完整）');
  } else {
    ok(false, '落盘文件不存在');
  }

  // 反向再来一次小文件（A 向 B 拉）：验证双向
  const small = Buffer.from('反向传输的小文件 hello arktalk\n');
  const up2 = await upload(PORT.bUi, B.uiToken, 'note.txt', small);
  await B._sendFile({ userId: idA, fileId: up2.fileId, name: up2.name, size: up2.size });
  const card2 = await waitFor(() => {
    const list = A.store.read(`p${idB}`, 20) ?? [];
    // 只认"收到"的（self_sent 的是自己刚发出去的那张卡片）
    return list.find((r) => !r.self_sent && (r.message ?? []).some((s) => s.type === 'file')) || null;
  }, 10000);
  ok(!!card2, 'A 收到 B 的文件卡片');
  const seg2 = (card2?.message ?? []).find((s) => s.type === 'file')?.data ?? {};
  A.downloadsDir = path.join(TMP, 'downloads-a');
  fs.mkdirSync(A.downloadsDir, { recursive: true });
  A._downloadFile({ userId: idB, fileId: String(seg2.file_id), name: String(seg2.name), size: Number(seg2.size) });
  const done2 = await waitFor(() => A.downloads.size === 0 && fs.existsSync(path.join(A.downloadsDir, 'note.txt')), 20000);
  ok(done2, '反向传输完成');
  if (done2) {
    const txt = fs.readFileSync(path.join(A.downloadsDir, 'note.txt'), 'utf8');
    ok(txt === small.toString('utf8'), '反向文件内容一致');
  }

  // 弱网自愈：故意吞掉一个块，验证 12 秒后自动重传而不是整单超时
  const big = crypto.randomBytes(512 * 1024 * 4 + 1234);
  const up3 = await upload(PORT.aUi, A.uiToken, 'loss-test.bin', big);
  await A._sendFile({ userId: idB, fileId: up3.fileId, name: up3.name, size: up3.size });
  const card3 = await waitFor(() => {
    const list = B.store.read(`p${idA}`, 30) ?? [];
    return list.find((r) => !r.self_sent && (r.message ?? []).some((sg) => sg.type === 'file' && sg.data?.name === 'loss-test.bin')) || null;
  }, 10000);
  ok(!!card3, '弱网用例：卡片到达');
  const seg3 = (card3?.message ?? []).find((sg) => sg.type === 'file')?.data ?? {};

  const realChunk = B._onFileChunk.bind(B);
  let dropped = 0;
  B._onFileChunk = (from, f) => {
    if (dropped === 0 && Number(f.seq) === 2) { dropped++; return; } // 模拟第 2 块丢包
    return realChunk(from, f);
  };
  B.downloadsDir = path.join(TMP, 'downloads-loss');
  fs.mkdirSync(B.downloadsDir, { recursive: true });
  B._downloadFile({ userId: idA, fileId: String(seg3.file_id), name: String(seg3.name), size: Number(seg3.size) });
  const fixed = await waitFor(() => B.downloads.size === 0 && fs.existsSync(path.join(B.downloadsDir, 'loss-test.bin')), 45000);
  B._onFileChunk = realChunk;
  ok(dropped === 1, '弱网用例：确实丢了一个块');
  ok(fixed, '弱网用例：丢块后自动重传补齐（未整单失败）');
  if (fixed) {
    const r3 = fs.readFileSync(path.join(B.downloadsDir, 'loss-test.bin'));
    ok(r3.length === big.length && crypto.createHash('sha256').update(r3).digest('hex') === crypto.createHash('sha256').update(big).digest('hex'), '弱网用例：补传后内容完整');
  }

  console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  if (failed) console.log('日志：\n' + logs.filter((l) => /文件|下载|中止|失败/.test(l)).slice(-20).join('\n'));
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('测试异常：', e.message);
  console.log(logs.slice(-25).join('\n'));
  process.exit(1);
});
