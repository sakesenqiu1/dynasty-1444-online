// 线上验证：建立附庸国（含新国家同步）+ 复国之机
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

console.log('\n=== 线上：建立附庸国 ===\n');

const a = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
const b = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
await Promise.all([new Promise(r => { a.on('open', r); a.on('error', r); }), new Promise(r => { b.on('open', r); b.on('error', r); })]);
const ma = [], mb = [];
a.on('message', d => ma.push(JSON.parse(d.toString())));
b.on('message', d => mb.push(JSON.parse(d.toString())));
a.send(JSON.stringify({ t: 'create', name: '附庸A' }));
await sleep(1000);
const room = (ma.find(m => m.t === 'lobby') || {}).room;
b.send(JSON.stringify({ t: 'join', name: '附庸B', room }));
await sleep(1000);
a.send(JSON.stringify({ t: 'pick', country: 140 }));
b.send(JSON.stringify({ t: 'pick', country: 44 }));
await sleep(600);
a.send(JSON.stringify({ t: 'start' }));
await sleep(8000);

const snap = ma.find(m => m.t === 'begin').snapshot;
// cn / pr 只在发生变化的那一帧下发，所以要累计扫描而不是只看最后一帧
const allCn = () => ma.filter(m => m.t === 'delta' && m.d.cn).flatMap(m => m.d.cn);
const allPr = () => ma.filter(m => m.t === 'delta' && m.d.pr).flatMap(m => m.d.pr);
const allCnB = () => mb.filter(m => m.t === 'delta' && m.d.cn).flatMap(m => m.d.cn);

// 找本国省份
const myProvs = [];
snap.prov.forEach((p, i) => { if (p[0] === 140 && p[3] > 0) myProvs.push(i + 1); });
check('房主有多块领土', myProvs.length >= 2, myProvs.length);

a.send(JSON.stringify({ t: 'cmd', c: 'found', prov: myProvs[0], name: '测试附庸国' }));
await sleep(1500);
const cn = allCn();
check('服务端下发新国家（增量里带 cn）', cn.length >= 1, cn);
const nid = cn.length ? cn[cn.length - 1][0] : 0;
if (cn.length) {
  const [, name, color, cap] = cn[cn.length - 1];
  check('新国家名字正确', name === '测试附庸国', name);
  check('新国家有合法颜色', Array.isArray(color) && color.length === 3, color);
  check('新国家首都是所选省份', cap === myProvs[0], { cap, want: myProvs[0] });
  check('另一个客户端也收到新国家', allCnB().some(r => r[0] === nid), allCnB());
  const moved = allPr().find(r => r[0] === myProvs[0] && r[1] === nid);
  check('所选省份已划归新国家', !!moved, { want: nid, got: allPr().filter(r => r[0] === myProvs[0]) });
  // 关键：cn 和对应的 pr 必须在同一帧下发，客户端才能"先建国家再划地"，
  // 否则那个省进不了新国家的 provList，名字要刷新才出现
  const sameFrame = ma.some(m => m.t === 'delta' && m.d.cn && m.d.pr &&
    m.d.cn.some(r => r[0] === nid) && m.d.pr.some(r => r[0] === myProvs[0] && r[1] === nid));
  check('【关键】新国家与该省划转在同一帧增量里下发', sameFrame === true);
}

const logs = ma.filter(m => m.t === 'delta' && m.d.lg).flatMap(m => m.d.lg).map(e => e.t);
check('日志里出现「立国」', logs.some(t => t.includes('立国')), logs.slice(-4));

// 边界：只有一省时不能再分封（这里房主领土多，改用非法目标测试）
a.send(JSON.stringify({ t: 'cmd', c: 'found', prov: 1, name: '非法' }));
await sleep(800);
const errs = ma.filter(m => m.t === 'error').map(m => m.msg);
check('拿别人的省建国会被拒绝并提示', errs.some(e => e.includes('只能在自己实际控制的领土上')), errs.slice(-3));

console.log('  info  最近日志:');
for (const t of logs.slice(-4)) console.log('    · ' + t);

a.send(JSON.stringify({ t: 'leave' })); b.send(JSON.stringify({ t: 'leave' }));
a.close(); b.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
