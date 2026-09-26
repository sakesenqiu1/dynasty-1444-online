// 定位「服务端最坏帧」：把 aiMonthly / monthlyTick 逐月计时，顺便量一行海路 BFS 的代价。
//   node _tools/profile-naval.mjs [代码根目录]     默认 ..
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? process.argv[2] : join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const noop = () => {};
const stub = () => ({ classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, appendChild: noop, style: {}, dataset: {}, value: '', textContent: '',
  innerHTML: '', querySelector: () => null, querySelectorAll: () => [], closest: () => null });
const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener: noop, getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [] },
  location: { search: '', pathname: '/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop },
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, requestAnimationFrame: noop, URLSearchParams };
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'p' });

console.log('代码根目录: ' + root);
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld();');
const info = run(`
  return { shift:(typeof MAP_SHIFT==='number'?MAP_SHIFT:'-'),
           withPix:provinces.filter(p=>p&&p.pix.length).length,
           minPix:Math.min(...provinces.filter(p=>p&&p.pix.length).map(p=>p.pix.length)) };
`);
console.log(`省份 ${info.withPix}，最小 ${info.minPix} 像素，MAP_SHIFT=${info.shift}`);

/* ---- 1) 海路 BFS：一批沿海省份两两配对，量单次耗时与访问量 ---- */
const nav = run(`
  const coastal=[];
  for(let i=1;i<provinces.length&&coastal.length<60;i++){ const p=provinces[i]; if(p&&p.pix.length&&p.coastPix&&p.coastPix.length) coastal.push(i); }
  const pairs=[];
  for(let k=0;k<40;k++){ const a=coastal[(k*7)%coastal.length], b=coastal[(k*13+5)%coastal.length]; if(a!==b) pairs.push([a,b]); }
  const t0=performance.now();
  let ok=0, nul=0, worst=0;
  for(const [a,b] of pairs){
    const s=performance.now(); const r=findNavalPath(a,b); const d=performance.now()-s;
    if(d>worst) worst=d;
    if(r) ok++; else nul++;
  }
  return { n:pairs.length, ok, nul, total:Math.round(performance.now()-t0), worst:Math.round(worst*100)/100 };
`);
console.log(`海路 BFS：${nav.n} 次，有路 ${nav.ok} / 无路 ${nav.nul}，合计 ${nav.total}ms，最慢一次 ${nav.worst}ms`);

/* ---- 2) 逐月给 aiMonthly / monthlyTick 计时 ---- */
const prof = run(`
  const months=[];
  for(let m=0;m<36;m++){
    // 推进到下一个月初（monthlyTick 在每月 1 号触发）
    let guard=0;
    while(cal.d!==1&&guard++<40) tickDay();
    const t0=performance.now(); tickDay(); const dt=performance.now()-t0;
    months.push(Math.round(dt*100)/100);
  }
  months.sort((a,b)=>a-b);
  const q=(f)=>months[Math.floor(months.length*f)];
  return { med:q(0.5), p90:q(0.9), max:months[months.length-1], all:months.slice(-8) };
`);
console.log(`单日推进（每月初那一下最重）：中位 ${prof.med}ms  p90 ${prof.p90}ms  最坏 ${prof.max}ms`);
console.log('最后 8 次: ' + prof.all.join(', '));
