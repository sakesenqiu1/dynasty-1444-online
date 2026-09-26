// 国名标签：按陆路连通块分块、逐列记录国土上下沿（字要完全附着在国土上）、
// 按比例尺分级显示、飞地单独成块。
//   node _tools/test-labels-unit.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const noop = () => {};
const stub = () => ({ classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, appendChild: noop, style: {}, dataset: {}, value: '', textContent: '',
  innerHTML: '', querySelector: () => null, querySelectorAll: () => [], closest: () => null });
const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener: noop, getElementById: stub, createElement: stub, querySelector: () => null, querySelectorAll: () => [] },
  location: { search: '', pathname: '/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop },
  performance: { now: () => Date.now() }, requestAnimationFrame: noop, URLSearchParams };
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
const run = (c) => vm.runInContext(`(function(){ ${c} })()`, ctx, { filename: 't' });

console.log('\n=== 国名标签（完全附着在国土上）===\n');
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); rebuildLabels();');

const info = run(`
  let alive=0, noLabel=0, bands=0;
  const rows=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive) continue;
    alive++;
    if(!cc.labels||!cc.labels.length){ noLabel++; continue; }
    bands+=cc.labels.length;
    rows.push({ id:c, name:cc.name, comp:cc.labelPx, n:cc.labels.length,
                maxRows:Math.max(...cc.labels.map(l=>l.rows)), maxCols:Math.max(...cc.labels.map(l=>l.cols)) });
  }
  rows.sort((a,b)=>b.comp-a.comp);
  return { alive, noLabel, bands, rows };
`);
console.log(`存活国家 ${info.alive}，标签总数 ${info.bands}`);
check('每个存活国家都有标签', info.noLabel === 0, info.noLabel);
const top3 = info.rows.slice(0, 3), bot3 = info.rows.slice(-3);
console.log('最大：' + top3.map(r => `${r.name}(${r.comp}px, ${r.n}块)`).join('，'));
console.log('最小：' + bot3.map(r => `${r.name}(${r.comp}px, ${r.n}块)`).join('，'));

/* ---- 【核心】每一列的上下沿必须真的框住本国像素 ---- */
const geom = run(`
  // 独立重算一遍「每个连通块每一列的最上/最下行」，再和标签里的数组逐格对，
  // 这样能抓出 c0 偏移写错、分带串了列之类的错
  let checked=0, badBound=0, badGap=0, mismatch=0, cols=0;
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels||!cc.labels.length) continue;
    // 重算连通块
    const seen=new Set(), comps=[];
    for(const pid of cc.provList){
      if(seen.has(pid)) continue;
      const p0=provinces[pid]; if(!p0||!p0.pix.length) continue;
      seen.add(pid); const st=[pid], comp=[];
      while(st.length){ const u=st.pop(); comp.push(u);
        for(const v of provinces[u].nbrs){ const pv=provinces[v];
          if(pv&&pv.pix.length&&pv.owner===cc.id&&!seen.has(v)){ seen.add(v); st.push(v); } } }
      comps.push(comp);
    }
    const mine=new Map();                  // 像素 -> 属于哪个块
    comps.forEach((comp,ci)=>{ for(const pid of comp) for(const px of provinces[pid].pix) mine.set(px,ci); });
    const real=new Map();                  // ci -> {c0,c1,top,bot}
    comps.forEach((comp,ci)=>{
      let c0=1<<30,c1=-1;
      for(const pid of comp) for(const px of provinces[pid].pix){ const col=px%COLS; if(col<c0)c0=col; if(col>c1)c1=col; }
      const top=new Int16Array(c1-c0+1).fill(32767), bot=new Int16Array(c1-c0+1).fill(-1);
      for(const pid of comp) for(const px of provinces[pid].pix){
        const r=(px/COLS)|0, col=px%COLS, k=col-c0;
        if(r<top[k])top[k]=r; if(r>bot[k])bot[k]=r;
      }
      real.set(ci,{c0,c1,top,bot});
    });
    for(const lb of cc.labels){
      const R=real.get(lb.ci); if(!R){ mismatch++; continue; }
      if(R.c0!==lb.c0) mismatch++;
      for(let k=0;k<lb.top.length;k++){
        cols++;
        if(lb.top[k]!==R.top[k]||lb.bot[k]!==R.bot[k]) mismatch++;
      }
      // 这条带的每一列都必须真的覆盖着本块陆地
      for(let col=lb.x0;col<=lb.x1;col++){
        const k=col-lb.c0;
        if(lb.bot[k]<0||lb.top[k]>32600){ badGap++; continue; }
        const pids=new Set();
        for(let r=lb.top[k];r<=lb.bot[k];r++){ const pid=provOf[r*COLS+col]; if(pid) pids.add(pid); }
        let hit=false;
        for(const pid of pids) if(mine.get(provinces[pid].pix[0])===lb.ci){ hit=true; break; }
        checked++;
        if(!hit) badBound++;
      }
    }
  }
  return { badGap, badBound, mismatch, checked, cols };
`);
console.log(`逐列校验：${geom.cols} 列，其中 ${geom.checked} 列落在本块国土上`);
check('【核心】标签里的上下沿与独立重算的结果逐格一致（偏移没错位）', geom.mismatch === 0, geom.mismatch);
check('【核心】每一列都真的覆盖着本国陆地（文字不会盖到邻国/海上）',
  geom.badBound === 0 && geom.badGap === 0, geom);

/* ---- 分带：宽国土切成几条，名字铺开 ---- */
const multi = run(`
  const out=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels||cc.labels.length<2) continue;
    const cols=cc.labels.reduce((s,l)=>s+l.cols,0);
    out.push({ name:cc.name, n:cc.labels.length, cols, maxCols:Math.max(...cc.labels.map(l=>l.cols)) });
  }
  out.sort((a,b)=>b.n-a.n);
  return out;
`);
console.log('多标签国家（前 5）：' + multi.slice(0, 5).map(m => `${m.name}×${m.n}(${m.cols}列)`).join('，'));
check('宽国土切成多条带，名字铺开', multi.length > 5, multi.length);
// 带宽 = ceil(W / clamp(round(W/180),1,4))，所以最多是 180 的两倍多一点
check('每条带不超过 400 列', multi.every(m => m.maxCols <= 400),
  multi.filter(m => m.maxCols > 400).slice(0, 3));

/* ---- 每列都在本国国土范围内（不会横向越界） ---- */
const inRange = run(`
  let bad=0, tot=0;
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    const mine=new Set();
    for(const pid of cc.provList){ const p=provinces[pid]; if(p&&p.pix.length) mine.add(pid); }
    for(const lb of cc.labels){
      for(let col=lb.x0;col<=lb.x1;col++){
        const k=col-lb.c0; tot++;
        if(k<0||k>=lb.top.length){ bad++; continue; }
        if(lb.bot[k]<0) bad++;                      // 这条带里有列完全没有本国的地
      }
    }
  }
  return { bad, tot };
`);
check(`标签横向范围全部落在本国国土上（${inRange.tot} 列）`, inRange.bad === 0, inRange);

/* ---- 分级显示 ---- */
const tiers = run(`
  const zs=[0.9,1.5,2.4,3.2,4.0,6.0];
  const out=[];
  for(const z of zs){
    const min=labelMinArea(z);
    let n=0;
    for(let c=1;c<countries.length;c++){ const cc=countries[c];
      if(!cc||!cc.alive||!cc.labels) continue;
      for(const lb of cc.labels) if(lb.comp>=min) n++; }
    out.push([z,min,n]);
  }
  const missing=(()=>{ const min=labelMinArea(6); let m=0;
    for(let c=1;c<countries.length;c++){ const cc=countries[c]; if(!cc||!cc.alive) continue;
      if(!(cc.labels||[]).some(lb=>lb.comp>=min)) m++; }
    return m; })();
  return { out, missing };
`);
console.log('比例尺 → 显示标签数：' + tiers.out.map(t => `z=${t[0]}:${t[2]}个(≥${t[1]}px)`).join('  '));
const counts = tiers.out.map(t => t[2]);
check('比例尺越大显示的国名越多（逐级放开）',
  counts.every((v, i) => i === 0 || v >= counts[i - 1]) && counts[counts.length - 1] > counts[0], counts);
check('世界视角不至于糊满（<80 个）', counts[0] < 80, counts[0]);
check('放大到最大时每个存活国家都至少有一个名字', tiers.missing === 0, tiers.missing);

/* ---- 飞地 ---- */
const exclave = run(`
  const compsOf=(cid)=>{
    const seen=new Set(); let n=0;
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||p.owner!==cid||seen.has(i)) continue;
      n++; seen.add(i); const st=[i];
      while(st.length){ const u=st.pop();
        for(const v of provinces[u].nbrs){ const pv=provinces[v];
          if(pv&&pv.pix.length&&pv.owner===cid&&!seen.has(v)){ seen.add(v); st.push(v); } } }
    }
    return n;
  };
  let found=null;
  for(let c=1;c<countries.length&&!found;c++){
    const cc=countries[c]; if(!cc||!cc.alive||cc.provList.length<3) continue;
    const k=compsOf(c);
    if(k>1) found={ id:c, name:cc.name, comps:k, bands:cc.labels.length,
                    cis:new Set(cc.labels.map(l=>l.ci)).size };
  }
  return found;
`);
if (exclave) {
  console.log(`有飞地的国家：${exclave.name} 共 ${exclave.comps} 块国土，标签覆盖 ${exclave.cis} 块`);
  check('每一块飞地都拿到了自己的标签', exclave.cis === exclave.comps, exclave);
} else {
  console.log('  SKIP  没找到带飞地的国家');
}

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
