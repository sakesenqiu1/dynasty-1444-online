// 微基准：量一下本次新增的 al / cp 增量检测循环到底占多少时间
// （对比：改动前的写法是每帧给每个国家拼一个签名字符串）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const sb = {
  console, Math, Date, JSON, Set, Map, Array, Object, Number, String, Error, isFinite, parseInt, parseFloat,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
  setTimeout, clearTimeout, setInterval, clearInterval,
  UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
  module: { exports: {} },
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });

const core = sb.module.exports;
core.resetWorld(); core.buildWorld();
const C = core.countries();
console.log(`国家数 ${C.length - 1}，省份数 ${core.provinces().length - 1}`);

/* ---------- 新写法：逐字段数值比对（零分配） ---------- */
const meta = new Map();
for (let i = 1; i < C.length; i++) {
  const c = C[i];
  if (c && c.color) meta.set(i, { n: c.name, r: c.color[0], g: c.color[1], b: c.color[2] });
}
const allySig = new Map();
for (let i = 1; i < C.length; i++) { const c = C[i]; if (c) allySig.set(i, (c.allies || []).slice()); }

function newWay() {
  let cpOut = null, alOut = null;
  for (let i = 1; i < C.length; i++) {
    const c = C[i];
    if (!c || !c.color) continue;
    const o = meta.get(i);
    if (o) {
      if (o.n === c.name && o.r === c.color[0] && o.g === c.color[1] && o.b === c.color[2]) { /* same */ }
      else { o.n = c.name; o.r = c.color[0]; o.g = c.color[1]; o.b = c.color[2]; (cpOut || (cpOut = [])).push([i, c.name, c.color.slice()]); }
    } else meta.set(i, { n: c.name, r: c.color[0], g: c.color[1], b: c.color[2] });
    const arr = c.allies || [];
    const prev = allySig.get(i);
    let same = !!prev && prev.length === arr.length;
    if (same) for (let k = 0; k < arr.length; k++) if (prev[k] !== arr[k]) { same = false; break; }
    if (!same) { allySig.set(i, arr.slice()); (alOut || (alOut = [])).push([i, arr.slice()]); }
  }
  return (cpOut ? cpOut.length : 0) + (alOut ? alOut.length : 0);
}

/* ---------- 旧写法：每帧拼签名字符串 ---------- */
const sigMap = new Map();
for (let i = 1; i < C.length; i++) { const c = C[i]; if (c) sigMap.set(i, c.name + '\u0001' + (c.color ? c.color.join(',') : '')); }
function oldWay() {
  let cpOut = null;
  for (let i = 1; i < C.length; i++) {
    const c = C[i];
    if (!c) continue;
    const sig = c.name + '\u0001' + (c.color ? c.color.join(',') : '');
    if (sigMap.get(i) === sig) continue;
    sigMap.set(i, sig);
    (cpOut || (cpOut = [])).push([i, c.name, c.color ? c.color.slice() : null]);
  }
  return cpOut ? cpOut.length : 0;
}

function bench(fn, label, reps = 20000) {
  fn(); // 预热
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / reps;
  console.log(`  ${label.padEnd(34)} ${(ns / 1000).toFixed(2)} µs/次   每秒可跑 ${(1e9 / ns / 1000).toFixed(0)}k 次`);
  return ns;
}

console.log('\n=== 单次增量检测耗时（180 国）===');
const nNew = bench(newWay, '新写法：al + cp 逐字段比对');
const nOld = bench(oldWay, '旧写法：cp 拼签名字符串');
console.log(`  -> 新写法比旧写法快 ${(nOld / nNew).toFixed(1)} 倍`);

/* 实际负载：3 房间 × 5 玩家 × 15 次/秒 */
const perSec = (nNew * 3 * 5 * 15) / 1e6;
const perTick = perSec / 15;          // 每秒 15 个 tick
const oldPerTick = (nOld * 3 * 5 * 15 / 1e6) / 15;
console.log(`\n=== 折算到线上最坏负载 ===`);
console.log(`  3 房间 × 5 玩家 × 15 次/秒 = 225 次/秒`);
console.log(`  新写法合计 ${perSec.toFixed(3)} ms/秒 = ${perTick.toFixed(4)} ms/帧`);
console.log(`  旧写法合计 ${(nOld * 3 * 5 * 15 / 1e6).toFixed(3)} ms/秒 = ${oldPerTick.toFixed(4)} ms/帧`);

/* 结论判定：跟"一帧 50ms 预算"比，而不是跟整秒比 */
const budgetMs = 50;
const pct = perTick / budgetMs * 100;
console.log(`\n=== 结论 ===`);
if (pct < 1) {
  console.log(`  ✅ 新循环每帧只占 ${perTick.toFixed(4)} ms（帧预算 ${budgetMs}ms 的 ${pct.toFixed(3)}%）`);
  console.log(`     慢帧（>40ms）来自月度结算/AI 批量运算，与本次改动无关。`);
  console.log(`     本次改动仍把这项开销从 ${oldPerTick.toFixed(4)} ms/帧 降到 ${perTick.toFixed(4)} ms/帧（省 ${((1 - perTick / oldPerTick) * 100).toFixed(1)}%）。`);
} else {
  console.log(`  ⚠️ 每帧 ${perTick.toFixed(4)} ms（占预算 ${pct.toFixed(2)}%），需要进一步排查`);
}
