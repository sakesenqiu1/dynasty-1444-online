// 服务端模拟性能剖析：找出周期性卡顿的来源
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
globalThis.WORLD_DATA = require(join(root, 'web', 'world-data.js'));
const core = require(join(root, 'web', 'game-core.js'));

const now = () => Number(process.hrtime.bigint()) / 1e6;
console.log('\n=== 服务端模拟性能剖析 ===\n');

core.resetWorld();
let t0 = now();
core.buildWorld();
console.log('建世界:', (now() - t0).toFixed(0), 'ms');

core.setHumans([140, 44]);

/* ---------- 逐日计时，标出含月度结算的日子 ---------- */
const totalDays = 5475;          // 15 年
const dayMs = new Float64Array(totalDays);
const monthlyMs = [];
let prevCal = { ...core.getState().cal };

for (let d = 0; d < totalDays; d++) {
  const before = core.getState();
  const prevD = before.cal.d, prevM = before.cal.m;
  const s = now();
  core.tickDay();
  const el = now() - s;
  dayMs[d] = el;
  const st = core.getState();
  // 日期回绕说明这一帧里跑了 monthlyTick
  const wrapped = (st.cal.d < prevD) || (st.cal.m !== prevM && st.cal.d === 1);
  if (wrapped) monthlyMs.push(el);
}

const sorted = Array.from(dayMs).sort((a, b) => a - b);
const sum = sorted.reduce((a, b) => a + b, 0);
const pct = (q) => sorted[Math.floor(sorted.length * q)];
console.log(`\n模拟 ${totalDays} 天（2 名人类玩家）`);
console.log(`  单日平均   ${(sum / totalDays).toFixed(3)} ms`);
console.log(`  分位  p50=${pct(0.5).toFixed(3)}  p90=${pct(0.9).toFixed(3)}  p99=${pct(0.99).toFixed(2)}  max=${sorted[sorted.length - 1].toFixed(1)} ms`);
const mx = Math.max(...monthlyMs);
const avgM = monthlyMs.reduce((a, b) => a + b, 0) / monthlyMs.length;
console.log(`  月度结算   ${monthlyMs.length} 次，平均 ${avgM.toFixed(1)} ms，最慢 ${mx.toFixed(1)} ms`);

/* ---------- 帧预算：服务端每 50ms 一个 tick ---------- */
console.log(`\n=== 帧预算（每 50ms 一个 tick）===`);
const avgDay = sum / totalDays;
const p99Day = pct(0.99);
for (const sp of [2, 5, 10, 20, 40]) {
  const n = sp * 0.05;                       // 这一帧要推进多少天
  // 月度结算只发生在其中一天，其余天是常规成本
  const normal = n * p99Day;
  const hitMonth = mx + (n - 1) * avgDay;    // 最坏：其中一天撞上月度结算
  const flag = hitMonth > 50 ? '❌ 会丢帧' : (hitMonth > 30 ? '⚠️ 偏紧' : '✅ 安全');
  console.log(`  速度${[1, 2, 3, 4, 5][[2, 5, 10, 20, 40].indexOf(sp)]} (${String(sp).padStart(2)} 天/秒): 常规帧 ${normal.toFixed(2)} ms，撞上月度结算 ${hitMonth.toFixed(1)} ms（中位月份只有 ${(monthlyMs.slice().sort((a, b) => a - b)[Math.floor(monthlyMs.length / 2)] + (n - 1) * avgDay).toFixed(1)} ms）  ${flag}`);
}

/* ---------- 直接量 vassalReachable / seaAdjacent 的成本 ---------- */
console.log(`\n=== 关键函数单次成本 ===`);
core.resetWorld(); core.buildWorld();
const cs = core.countries();
const alive = cs.filter(c => c && c.alive);

function bench(fn, n, label) {
  // 先热身一次
  try { fn(0); } catch (e) {}
  const s = now();
  for (let i = 0; i < n; i++) fn(i);
  const el = (now() - s) / n;
  console.log(`  ${label.padEnd(28)} ${el.toFixed(3)} ms/次  (${n} 次)`);
  return el;
}

const pairs = [];
for (let i = 0; i < alive.length && pairs.length < 40; i++)
  for (let j = i + 1; j < alive.length && pairs.length < 40; j++)
    pairs.push([alive[i].id, alive[j].id]);

const tReach = bench((i) => core.vassalReachable(pairs[i % pairs.length][0], pairs[i % pairs.length][1]), 20, 'vassalReachable(冷)');
const tAdj = bench((i) => core.countriesAdjacent(pairs[i % pairs.length][0], pairs[i % pairs.length][1]), 200, 'countriesAdjacent');

/* seaAdjacent 缓存只有一格，交替不同对就会每次都重算 */
console.log(`\n  注：seaAdjacent 内部会 new Int32Array(${1440 * 720}) 并 fill，约 4 MB/次`);
console.log(`  按 ${tReach.toFixed(2)} ms/次 估算：aiMonthly 里调用 20 次就是 ${(tReach * 20).toFixed(0)} ms 的服务端停顿`);

/* ---------- rebuildLabels 成本 ---------- */
core.resetWorld(); core.buildWorld();
const tLbl = bench(() => core.rebuildLabels(), 20, 'rebuildLabels');
console.log(`  按速度5折算：客户端若每秒重算 2.6 次 = ${(tLbl * 2.6).toFixed(1)} ms/秒`);

console.log(`\n内存: RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`);
