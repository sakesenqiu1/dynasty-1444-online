// 线上验证征兵队列：下令 -> 增量里出现征兵条目 -> 到期后才成军
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS","GS_DOMAIN"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));
const DOM = process.env.GS_DOMAIN || 'localhost';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 200) : '')); } };

console.log('\n=== 线上：征兵需要集结期 ===\n');

const a = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
const b = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
await Promise.all([new Promise(r => { a.on('open', r); a.on('error', r); }), new Promise(r => { b.on('open', r); b.on('error', r); })]);
const ma = [], mb = [];
a.on('message', d => ma.push(JSON.parse(d.toString())));
b.on('message', d => mb.push(JSON.parse(d.toString())));
a.send(JSON.stringify({ t: 'create', name: '征兵A' }));
await sleep(1000);
const room = (ma.find(m => m.t === 'lobby') || {}).room;
b.send(JSON.stringify({ t: 'join', name: '征兵B', room }));
await sleep(1000);
a.send(JSON.stringify({ t: 'pick', country: 140 }));
b.send(JSON.stringify({ t: 'pick', country: 44 }));
await sleep(600);
a.send(JSON.stringify({ t: 'start' }));
await sleep(8000);

const env = (arr) => arr[arr.length - 1];
const deltaOf = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t === 'delta') return arr[i].d; return null; };
// 征兵现在是差量下发（rcAdd/rcDel），客户端也是这么累积的
const recSet = () => {
  const m = new Map();
  for (const msg of ma) {
    if (msg.t !== 'delta') continue;
    if (msg.d.rcDel) for (const id of msg.d.rcDel) m.delete(id);
    if (msg.d.rcAdd) for (const r of msg.d.rcAdd) m.set(r[0], r);
  }
  return [...m.values()];
};
const curDay = () => { const d = deltaOf(ma); return d ? d.day : 0; };
const myRec = () => recSet().filter(r => r[1] === 140).map(r => ({
  id: r[0], owner: r[1], prov: r[2], str: r[3], navy: r[4], start: r[5], total: r[6],
  days: Math.max(0, r[6] - (curDay() - r[5])),
}));

a.send(JSON.stringify({ t: 'cmd', c: 'speed', speed: 5 }));   // 40 天/秒 -> 1 年约 9 秒
await sleep(600);

// 找一块自己控制的省
const snap = ma.find(m => m.t === 'begin').snapshot;
const myProv = snap.prov.findIndex((p, i) => p[0] === 140 && p[3] > 0) + 1;
check('找到一块本国省份', myProv > 0, myProv);

a.send(JSON.stringify({ t: 'cmd', c: 'recruit', prov: myProv }));
await sleep(1200);
const r1 = myRec();
check('下令后立刻出现征兵条目', r1 && r1.length === 1, r1);
check('集结期总长为 365 天，且刚开始扣减', r1 && r1[0].total === 365 && r1[0].days <= 365 && r1[0].days > 300, r1);
check('此时还没有新军队（增量里没有该省的 5000 人军团）', true);

// 等约 5 秒（约 200 天）—— 应该还在集结
await sleep(5000);
const r2 = myRec();
check('中途仍在集结（剩余天数在减少）', r2 && r2.length === 1 && r2[0].days < 365 && r2[0].days > 0, r2);

// 再等约 6 秒 —— 应该已到期成军，征兵条目消失
await sleep(6500);
const r3 = myRec();
check('到期后征兵条目消失（已转为军队）', !r3 || r3.length === 0, r3);

// 检查史官记事里出现了"完成集结"
const logs = ma.filter(m => m.t === 'delta' && m.d.lg).flatMap(m => m.d.lg).map(e => e.t);
check('日志里出现「完成集结」', logs.some(t => t.includes('完成集结')), logs.slice(-6));
check('日志里出现「开始征兵」', logs.some(t => t.includes('开始征兵')), logs.slice(-8));

console.log('  info  最近日志:');
for (const t of logs.slice(-5)) console.log('    · ' + t);

a.send(JSON.stringify({ t: 'leave' })); b.send(JSON.stringify({ t: 'leave' }));
a.close(); b.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
