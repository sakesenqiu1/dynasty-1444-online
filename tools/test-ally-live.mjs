// 线上验证：盟约同步（盟友变蓝 / 可断盟）
// 真机 + nginx + wss 全链路
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS","GS_DOMAIN"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));
const DOM = process.env.GS_DOMAIN || 'localhost';

// 140 大明、6 哈萨克诸部：接壤且国力相近，结盟接受率 0.60
const ME = 140, ALLY = 6;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 220) : '')); } };

console.log('\n=== 线上：盟约同步 ===\n');

function mkClient(label) {
  const ws = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
  const c = { label, ws, msgs: [], errors: [] };
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    if (m.t === 'error') c.errors.push(m.msg);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.snap = () => { const m = c.msgs.find(x => x.t === 'begin'); return m ? m.snapshot : null; };
  c.alRows = (from = 0) => c.msgs.slice(from).filter(m => m.t === 'delta' && m.d.al).flatMap(m => m.d.al);
  c.alFrames = (from = 0) => c.msgs.slice(from).filter(m => m.t === 'delta' && m.d.al).length;
  c.allianceOf = (cid) => {
    let arr = [];
    const s = c.snap();
    if (s) { const r = s.ct[cid - 1]; if (r) arr = (r.al || []).slice(); }
    for (const m of c.msgs) {
      if (m.t !== 'delta' || !m.d.al) continue;
      for (const row of m.d.al) if (row[0] === cid) arr = (row[1] || []).slice();
    }
    return arr;
  };
  return c;
}

const a = mkClient('A'), b = mkClient('B');
await Promise.all([
  new Promise(r => { a.ws.on('open', r); a.ws.on('error', r); }),
  new Promise(r => { b.ws.on('open', r); b.ws.on('error', r); }),
]);
a.send({ t: 'create', name: '盟主A' });
await sleep(1200);
const room = (a.msgs.find(m => m.t === 'lobby') || {}).room;
check('创建房间', !!room, room);
b.send({ t: 'join', name: '盟友B', room });
await sleep(1200);
a.send({ t: 'pick', country: ME });
b.send({ t: 'pick', country: ALLY });
await sleep(800);
a.send({ t: 'start' });
await sleep(9000);
check('双方进入对局', !!a.snap() && !!b.snap(), `${!!a.snap()}/${!!b.snap()}`);

const snapAlly = (a.snap().ct[ME - 1] || {}).al || [];
check('快照带 allies 字段', Array.isArray(snapAlly), JSON.stringify(a.snap().ct[ME - 1]));
check('开局不是盟友', !snapAlly.includes(ALLY), JSON.stringify(snapAlly));

/* ---- 1. 结盟 ---- */
console.log('\n-- 1. 结盟后双方都收到 al 增量 --');
let ok = false, tries = 0;
for (; tries < 15 && !ok; tries++) {
  const mark = a.msgs.length;
  a.send({ t: 'cmd', c: 'ally', target: ALLY });
  await sleep(900);
  const rows = a.alRows(mark).filter(r => r[0] === ME);
  if (rows.length && (rows[rows.length - 1][1] || []).includes(ALLY)) ok = true;
}
check('结盟成功（重试 ' + tries + ' 次）', ok === true, a.errors.slice(-3).join('|'));
check('【核心】A 端 allies 含对方', a.allianceOf(ME).includes(ALLY), JSON.stringify(a.allianceOf(ME)));
check('【核心】B 端 allies 含对方', b.allianceOf(ALLY).includes(ME), JSON.stringify(b.allianceOf(ALLY)));
check('B 端收到了 al 增量（地图会变蓝 / 出现断盟按钮）',
  b.msgs.some(m => m.t === 'delta' && m.d.al), 'no al frame');

/* ---- 2. al 不重复下发 ---- */
console.log('\n-- 2. al 不重复下发（带宽） --');
const alBefore = a.alFrames();
await sleep(4000);
check('4 秒内没有多余的 al 帧', a.alFrames() === alBefore, `${alBefore} -> ${a.alFrames()}`);
check('普通增量照常', a.msgs.filter(m => m.t === 'delta').length > 10,
  'deltas=' + a.msgs.filter(m => m.t === 'delta').length);

/* ---- 3. 断盟 ---- */
console.log('\n-- 3. 断盟广播 --');
a.send({ t: 'cmd', c: 'unally', target: ALLY });
await sleep(1500);
check('【核心】A 端盟约已解除', !a.allianceOf(ME).includes(ALLY), JSON.stringify(a.allianceOf(ME)));
check('【核心】B 端盟约也已解除', !b.allianceOf(ALLY).includes(ME), JSON.stringify(b.allianceOf(ALLY)));

/* ---- 4. 重新结盟 + 由 B 侧断开 ---- */
console.log('\n-- 4. 由盟友一侧断盟同样生效 --');
let ok2 = false;
for (let i = 0; i < 15 && !ok2; i++) {
  a.send({ t: 'cmd', c: 'ally', target: ALLY });
  await sleep(900);
  if (a.allianceOf(ME).includes(ALLY)) ok2 = true;
}
check('重新结盟成功', ok2 === true, a.errors.slice(-2).join('|'));
if (ok2) {
  b.send({ t: 'cmd', c: 'unally', target: ME });
  await sleep(1500);
  check('B 侧断盟后 A 端也解除', !a.allianceOf(ME).includes(ALLY), JSON.stringify(a.allianceOf(ME)));
  check('B 侧自己也解除了', !b.allianceOf(ALLY).includes(ME), JSON.stringify(b.allianceOf(ALLY)));
}

/* ---- 5. 稳定 ---- */
console.log('\n-- 5. 稳定性 --');
a.send({ t: 'cmd', c: 'speed', speed: 5 });
await sleep(5000);
check('世界仍在推进', a.msgs.filter(m => m.t === 'delta').length > 20,
  'deltas=' + a.msgs.filter(m => m.t === 'delta').length);

a.ws.close(); b.ws.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
