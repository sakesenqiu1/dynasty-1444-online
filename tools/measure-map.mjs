// 一次性测量：给「地图接缝该放哪条经线」和「多小的地块算碎块」找依据。
//   node _tools/measure-map.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const noop = () => {};
const stub = () => ({
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, appendChild: noop, style: {}, dataset: {}, value: '', textContent: '',
  innerHTML: '', querySelector: () => null, querySelectorAll: () => [], closest: () => null,
});
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener: noop, getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [] },
  location: { search: '', pathname: '/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop },
  performance: { now: () => Date.now() }, requestAnimationFrame: noop, URLSearchParams,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
const run = (c) => vm.runInContext(`(function(){ ${c} })()`, ctx, { filename: 'm' });
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld();');

/* ---- 1) 每列陆地像素数：找没有陆地的经线（地图接缝放这里最不碍事） ---- */
const cols = run(`
  const out=new Int32Array(COLS);
  for(let c=0;c<COLS;c++){ let n=0; for(let r=0;r<ROWS;r++) if(provOf[r*COLS+c]) n++; out[c]=n; }
  return Array.from(out);
`);
const lon = (c) => (-180 + c * 0.25).toFixed(2);
// 找出所有「连续 window 列全为 0」的区间
function emptyRuns(window) {
  const runs = [];
  let s = -1;
  for (let i = 0; i < cols.length + window; i++) {
    const v = cols[i % cols.length] || 0;
    if (v === 0) { if (s < 0) s = i; }
    else { if (s >= 0 && i - s >= window) runs.push([s, i - 1]); s = -1; }
  }
  return runs;
}
console.log('=== 无陆地经线区间（接缝候选） ===');
for (const w of [1, 3, 5]) {
  const runs = emptyRuns(w).map(([a, b]) => `${lon(a % cols.length)}°..${lon((b + 1) % cols.length)}° (宽 ${(b - a + 1) * 0.25}°)`);
  console.log(`  需要连续 ${w} 列无陆地：` + (runs.length ? runs.slice(0, 6).join('  |  ') : '(无)'));
}
// 距 180° 最近的无陆地经线
let best = -1, bestD = 1e9;
for (let c = 0; c < cols.length; c++) {
  if (cols[c] !== 0) continue;
  const d = Math.min(c, cols.length - c);
  if (d < bestD) { bestD = d; best = c; }
}
console.log(`  离 180° 最近的空经线：${lon(best)}°（偏移 ${best} 列 = ${(best * 0.25).toFixed(2)}°）`);

/* ---- 2) 省份像素数分布：多小算碎块 ---- */
const stat = run(`
  const a=[];
  for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(p&&p.pix.length) a.push(p.pix.length); }
  a.sort((x,y)=>x-y);
  const q=(f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
  let total=0; for(const v of a) total+=v;
  const sumLE=(n)=>a.filter(v=>v<=n).reduce((s,v)=>s+v,0);
  const cntLE=(n)=>a.filter(v=>v<=n).length;
  return { n:a.length, min:a[0], p10:q(0.1), p25:q(0.25), med:q(0.5), p75:q(0.75), p90:q(0.9), max:a[a.length-1], total,
           le4:cntLE(4), le8:cntLE(8), le12:cntLE(12), le20:cntLE(20), le30:cntLE(30),
           areaLE8:sumLE(8), areaLE12:sumLE(12), areaLE20:sumLE(20), areaLE30:sumLE(30) };
`);
console.log('\n=== 省份像素数分布 ===');
console.log(`  共 ${stat.n} 省，总陆地 ${stat.total} px`);
console.log(`  最小 ${stat.min}，10% ${stat.p10}，25% ${stat.p25}，中位 ${stat.med}，75% ${stat.p75}，90% ${stat.p90}，最大 ${stat.max}`);
for (const k of ['4', '8', '12', '20', '30']) {
  console.log(`  ≤${k}px：${stat['le' + k]} 个省 (${(stat['le' + k] / stat.n * 100).toFixed(1)}%)，占陆地面积 ${(stat['areaLE' + k] / stat.total * 100).toFixed(2)}%`);
}

/* ---- 3) 接缝两侧的陆地看着有多碎 ---- */
const seam = run(`
  let seamPix=0, seamProv=new Set();
  for(let r=0;r<ROWS;r++) for(const c of [0,1,COLS-2,COLS-1]){
    const i=r*COLS+c; if(provOf[i]){ seamPix++; seamProv.add(provOf[i]); }
  }
  const countries=new Set();
  for(const pid of seamProv) countries.add(provinces[pid].owner);
  return { seamPix, seamProv:seamProv.size, countries:[...countries].filter(Boolean).map(c=>countries0[c]&&countries0[c].name) };
`.replace('countries0', 'countries'));
console.log('\n=== 当前接缝（180°）附近的陆地 ===');
console.log(`  ${seam.seamPix} 个陆地像素，属于 ${seam.seamProv} 个省`);
console.log('  涉及国家：' + (seam.countries.join('、') || '(无)'));
