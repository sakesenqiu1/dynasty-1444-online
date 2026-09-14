// 线上验证：傀儡国国体 / 属国改色 / 花钱改国名（真机 + nginx + wss）
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

console.log('\n=== 线上：傀儡国 / 改色 / 改名 ===\n');

function mkClient(label) {
  const ws = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
  const c = { label, ws, msgs: [], errors: [] };
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    if (m.t === 'error') c.errors.push(m.msg);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.errMark = () => c.errors.length;
  c.newErrors = (k) => c.errors.slice(k);
  /* 累计扫描所有增量里的 ct / cn / cp（增量只在变化帧下发，不能只看最后一帧） */
  c.snap = () => { const m = c.msgs.find(x => x.t === 'begin'); return m ? m.snapshot : null; };
  c.ctRows = () => c.msgs.filter(m => m.t === 'delta' && m.d.ct).flatMap(m => m.d.ct);
  c.cnRows = () => c.msgs.filter(m => m.t === 'delta' && m.d.cn).flatMap(m => m.d.cn);
  c.cpRows = () => c.msgs.filter(m => m.t === 'delta' && m.d.cp).flatMap(m => m.d.cp);
  return c;
}

const a = mkClient('A'), b = mkClient('B');
await Promise.all([
  new Promise(r => { a.ws.on('open', r); a.ws.on('error', r); }),
  new Promise(r => { b.ws.on('open', r); b.ws.on('error', r); }),
]);
a.send({ t: 'create', name: '宗主A' });
await sleep(1200);
const room = (a.msgs.find(m => m.t === 'lobby') || {}).room;
check('创建房间', !!room, room);
b.send({ t: 'join', name: '邻国B', room });
await sleep(1200);
a.send({ t: 'pick', country: 140 });
b.send({ t: 'pick', country: 44 });
await sleep(800);
a.send({ t: 'start' });
await sleep(9000);
const snap = a.snap(), snapB = b.snap();
check('双方进入对局', !!snap && !!snapB, `${!!snap}/${!!snapB}`);

/* ---- 1. 建立傀儡国 ---- */
console.log('\n-- 1. 建立傀儡国 --');
const myProvs = [];
snap.prov.forEach((p, i) => { if (p[0] === 140 && p[3] > 0) myProvs.push(i + 1); });
check('房主有足够领土', myProvs.length >= 2, myProvs.length);

a.send({ t: 'cmd', c: 'found', prov: myProvs[0], name: '辽东国' });
await sleep(2000);
const cn = a.cnRows();
check('新国家随 cn 下发', cn.length >= 1, cn.length);
const nid = cn.length ? cn[cn.length - 1][0] : 0;
check('新国家名字正确', cn.length && cn[cn.length - 1][1] === '辽东国', cn[cn.length - 1]);
check('B 端也收到新国家', b.cnRows().some(r => r[0] === nid), b.cnRows().map(r => r[0]));

/* 国体 subject 走 ct 增量 */
const ctRows = a.ctRows().filter(r => r[0] === nid);
const lastCt = ctRows.length ? ctRows[ctRows.length - 1] : null;
check('ct 增量里带上国体字段（第6列）', !!lastCt && lastCt.length >= 6, lastCt);
check('【核心】新国家国体 = 傀儡国（subject=2）', !!lastCt && lastCt[5] === 2, lastCt);
check('宗主 = 140', !!lastCt && lastCt[4] === 140, lastCt);
const ctRowsB = b.ctRows().filter(r => r[0] === nid);
check('B 端也同步到傀儡国体', ctRowsB.length > 0 && ctRowsB[ctRowsB.length - 1][5] === 2, ctRowsB[ctRowsB.length - 1]);

/* ---- 2. 修改属国颜色 ---- */
console.log('\n-- 2. 修改属国颜色 ----');
const goldBefore = (a.ctRows().filter(r => r[0] === 140).slice(-1)[0] || [, snap.ct[139].g])[1];
a.send({ t: 'cmd', c: 'recolor', target: nid, rgb: [12, 200, 90] });
await sleep(2000);
const cpA = a.cpRows().filter(r => r[0] === nid);
const cpB = b.cpRows().filter(r => r[0] === nid);
check('宗主端收到 cp 颜色增量', cpA.length > 0 && Array.isArray(cpA[cpA.length - 1][2]), cpA[cpA.length - 1]);
check('颜色值正确', cpA.length > 0 && String(cpA[cpA.length - 1][2]) === '12,200,90', cpA[cpA.length - 1] && cpA[cpA.length - 1][2]);
check('【核心】B 端也收到同样的颜色', cpB.length > 0 && String(cpB[cpB.length - 1][2]) === '12,200,90', cpB[cpB.length - 1] && cpB[cpB.length - 1][2]);

/* 非宗主不能改 */
const bMark = b.errMark();
b.send({ t: 'cmd', c: 'recolor', target: nid, rgb: [1, 2, 3] });
await sleep(1500);
check('非宗主改色被服务端拒绝', b.newErrors(bMark).length > 0, b.newErrors(bMark).join('|'));

/* ---- 3. 花钱改国名 ---- */
console.log('\n-- 3. 花 200 金改国名 ----');
const gBefore = a.ctRows().filter(r => r[0] === 140).slice(-1)[0];
const goldAt = gBefore ? gBefore[1] : snap.ct[139].g;
a.send({ t: 'cmd', c: 'rename', name: '大周帝国' });
await sleep(2500);
const cpNameA = a.cpRows().filter(r => r[0] === 140);
const cpNameB = b.cpRows().filter(r => r[0] === 140);
check('宗主端收到改名增量', cpNameA.length > 0 && cpNameA[cpNameA.length - 1][1] === '大周帝国', cpNameA[cpNameA.length - 1]);
check('【核心】B 端也看到新国名', cpNameB.length > 0 && cpNameB[cpNameB.length - 1][1] === '大周帝国', cpNameB[cpNameB.length - 1]);
const gAfter = a.ctRows().filter(r => r[0] === 140).slice(-1)[0];
const goldNow = gAfter ? gAfter[1] : null;
check('扣了 200 金', goldNow !== null && Math.abs((goldAt - goldNow) - 200) < 1.5, `${goldAt} -> ${goldNow}`);

/* 非法改名 */
const aMark = a.errMark();
a.send({ t: 'cmd', c: 'rename', name: '  ' });
await sleep(1500);
check('空国名被拒绝', a.newErrors(aMark).length > 0, a.newErrors(aMark).join('|'));

/* ---- 4. 跑一段时间，确认稳定 ---- */
console.log('\n-- 4. 稳定性 ----');
a.send({ t: 'cmd', c: 'speed', speed: 5 });
await sleep(6000);
const deltas = a.msgs.filter(m => m.t === 'delta').length;
check('持续收到增量（世界在跑）', deltas > 20, 'deltas=' + deltas);
check('全流程无致命错误', a.newErrors(aMark).length <= 1, a.newErrors(aMark).join('|'));

a.ws.close(); b.ws.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
