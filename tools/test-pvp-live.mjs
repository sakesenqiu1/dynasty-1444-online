// 线上验证：两个真人玩家之间，和谈必须对方同意
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
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 220) : '')); } };

console.log('\n=== 线上：PvP 和谈需要双方同意 ===\n');

const A = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
const B = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
await Promise.all([new Promise(r => { A.on('open', r); A.on('error', r); }), new Promise(r => { B.on('open', r); B.on('error', r); })]);
const ma = [], mb = [];
A.on('message', d => ma.push(JSON.parse(d.toString())));
B.on('message', d => mb.push(JSON.parse(d.toString())));
A.send(JSON.stringify({ t: 'create', name: '甲方' }));
await sleep(1000);
const room = (ma.find(m => m.t === 'lobby') || {}).room;
B.send(JSON.stringify({ t: 'join', name: '乙方', room }));
await sleep(1000);
A.send(JSON.stringify({ t: 'pick', country: 140 }));   // 大明
B.send(JSON.stringify({ t: 'pick', country: 44 }));    // 法兰西
await sleep(600);
A.send(JSON.stringify({ t: 'start' }));
await sleep(8000);

// 让双方adjacent太麻烦，直接宣战即可（宣战不需要接壤）
A.send(JSON.stringify({ t: 'cmd', c: 'war', target: 44 }));
await sleep(1500);
const warsA = () => { for (let i = ma.length - 1; i >= 0; i--) if (ma[i].t === 'delta' && ma[i].d.wr) return ma[i].d.wr; return null; };
check('双方进入战争', (warsA() || []).some(w => (w.a === 140 && w.d === 44) || (w.a === 44 && w.d === 140)), warsA());

const ofA = () => { for (let i = ma.length - 1; i >= 0; i--) if (ma[i].t === 'delta' && ma[i].d.of) return ma[i].d.of; return null; };
const ofB = () => { for (let i = mb.length - 1; i >= 0; i--) if (mb[i].t === 'delta' && mb[i].d.of) return mb[i].d.of; return null; };
const soA = () => { for (let i = ma.length - 1; i >= 0; i--) if (ma[i].t === 'delta' && ma[i].d.so) return ma[i].d.so; return null; };
const errsA = () => ma.filter(m => m.t === 'error').map(m => m.msg);

// 甲方提议白色和平（空条件，不涉及领土，最容易走通）
A.send(JSON.stringify({ t: 'cmd', c: 'white', enemy: 44 }));
await sleep(1500);

const w1 = (warsA() || []).some(w => (w.a === 140 && w.d === 44) || (w.a === 44 && w.d === 140));
check('【关键】甲方提出和谈后战争仍在继续（没有立即缔和）', w1 === true, { warStillOn: w1, errs: errsA() });

const proposalForB = (ofB() || {})['44'];
check('乙方收到了待决提案', !!proposalForB, proposalForB);
check('提案标记为来自玩家', proposalForB && proposalForB.human === true, proposalForB);
check('提案方能看到自己已递交的提案', !!(soA() || {})['140'], soA());

// 乙方拒绝
B.send(JSON.stringify({ t: 'cmd', c: 'offer', accept: false }));
await sleep(1500);
const w2 = (warsA() || []).some(w => (w.a === 140 && w.d === 44) || (w.a === 44 && w.d === 140));
check('乙方拒绝后：战争继续', w2 === true, w2);
const logsA = ma.filter(m => m.t === 'delta' && m.d.lg).flatMap(m => m.d.lg).map(e => e.t);
check('甲方收到「对方拒绝」通知', logsA.some(t => t.includes('拒绝')), logsA.slice(-4));

// 甲方再提一次（应能重新提，不被去重挡住）
A.send(JSON.stringify({ t: 'cmd', c: 'white', enemy: 44 }));
await sleep(1500);
check('拒绝后甲方可以重新提案', !!(ofB() || {})['44'], (ofB() || {})['44']);

// 乙方接受
B.send(JSON.stringify({ t: 'cmd', c: 'offer', accept: true }));
await sleep(2000);
const w3 = (warsA() || []).some(w => (w.a === 140 && w.d === 44) || (w.a === 44 && w.d === 140));
check('【关键】乙方接受后战争才结束', w3 === false, w3);

const logsAll = ma.filter(m => m.t === 'delta' && m.d.lg).flatMap(m => m.d.lg).map(e => e.t);
check('日志里出现「递交和约条件」', logsAll.some(t => t.includes('递交和约条件')), logsAll.slice(-6));

console.log('  info  甲方最近日志:');
for (const t of logsAll.slice(-5)) console.log('    · ' + t);

A.send(JSON.stringify({ t: 'leave' })); B.send(JSON.stringify({ t: 'leave' }));
A.close(); B.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
