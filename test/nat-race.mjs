import { PeerLink } from '../src/p2p.js';

const log = (t) => (m, l) => { if (l !== 'info' || /竞速|拨号|在线|离线/.test(m)) console.log(`[${t}] ${m}`); };
const A = new PeerLink({ selfId: '111', listen: { host: '127.0.0.1', port: 13021 }, log: log('A') });
const B = new PeerLink({ selfId: '222', listen: { host: '127.0.0.1', port: 13022 }, log: log('B') });
await A.start(); await B.start();

const t0 = Date.now();
let on = 0, off = 0;
B.on('peer-online', () => { on++; console.log(`B online @${Date.now()-t0}ms`); });
B.on('peer-offline', () => { off++; console.log(`B OFFLINE @${Date.now()-t0}ms`); });

// 关键场景：3 个候选里第 1 个是死地址（不可路由，会一直挂），第 3 个才是真的
B.setEndpoint('111', '10.255.255.1:13021, 192.0.2.9:13021, 127.0.0.1:13021');

setTimeout(async () => {
  console.log(`\n结果：online=${on} offline=${off} isOnline=${B.isOnline('111')} map=${JSON.stringify(B.onlineMap())}`);
  // 再等 12 秒看会不会闪断
  setTimeout(async () => {
    console.log(`12s 后：online=${on} offline=${off} isOnline=${B.isOnline('111')}`);
    await A.stop(); await B.stop(); process.exit(0);
  }, 12000);
}, 8000);
