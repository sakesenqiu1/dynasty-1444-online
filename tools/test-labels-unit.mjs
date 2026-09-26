// 国名标签：按陆路连通块分块、按面积定字号、按比例尺分级显示、飞地单独成块。
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

console.log('\n=== 国名标签 ===\n');
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); rebuildLabels();');

const info = run(`
  const rows=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive) continue;
    if(!cc.labels||!cc.labels.length) continue;
    rows.push({ id:c, name:cc.name, area:cc.labelPx, n:cc.labels.length,
                fonts:cc.labels.map(l=>l[3]), maxFont:Math.max(...cc.labels.map(l=>l[3])) });
  }
  rows.sort((a,b)=>b.area-a.area);
  const alive=countries.filter(c=>c&&c.alive).length;
  const noLabel=countries.filter(c=>c&&c.alive&&(!c.labels||!c.labels.length)).length;
  return { rows, alive, noLabel, total:rows.length };
`);
console.log(`存活国家 ${info.alive}，有标签 ${info.total}，没标签 ${info.noLabel}`);
check('每个存活国家都有标签', info.noLabel === 0, info.noLabel);

/* ---- 字号随国土面积单调 ---- */
const top = info.rows[0], bottom = info.rows[info.rows.length - 1];
console.log(`最大：${top.name} 面积 ${top.area} 字号 ${top.maxFont}，共 ${top.n} 个标签`);
console.log(`最小：${bottom.name} 面积 ${bottom.area} 字号 ${bottom.maxFont}，共 ${bottom.n} 个标签`);
check('国土越大字号越大', top.maxFont > bottom.maxFont, [top.maxFont, bottom.maxFont]);
check('小国字号不会大得离谱（<=16）', bottom.maxFont <= 16, bottom.maxFont);
check('大国字号不会大到糊屏（<=26）', top.maxFont <= 26, top.maxFont);

/* ---- 单调性：字号是「连通块面积」的函数，面积越大字号不该更小 ---- */
const mono = run(`
  const a=[];
  for(let c=1;c<countries.length;c++){ const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    for(const lb of cc.labels) a.push([lb[2], lb[3]]); }
  a.sort((x,y)=>x[0]-y[0]);
  let bad=0, prev=0;
  for(const [area,f] of a){ if(f<prev-0.001) bad++; prev=f; }
  return { bad, n:a.length };
`);
check('字号随连通块面积单调不减', mono.bad === 0, mono);

/* ---- 大国土有多个标签，且同一块内部的标签彼此分得开 ---- */
const multi = run(`
  const out=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels||cc.labels.length<2) continue;
    // 只有同一块（ci 相同）内部才要求间距；不同岛之间挨得近是天生的
    let minSep=1e9, pairs=0;
    for(let i=0;i<cc.labels.length;i++) for(let j=i+1;j<cc.labels.length;j++){
      if(cc.labels[i][4]!==cc.labels[j][4]) continue;
      pairs++;
      const d=Math.hypot(cc.labels[i][0]-cc.labels[j][0], cc.labels[i][1]-cc.labels[j][1]);
      if(d<minSep) minSep=d;
    }
    if(!pairs) continue;
    out.push({ name:cc.name, n:cc.labels.length, minSep:Math.round(minSep) });
  }
  out.sort((a,b)=>b.n-a.n);
  return out;
`);
console.log('多标签国家（前 5）：' + multi.slice(0, 5).map(m => `${m.name}×${m.n}(间距${m.minSep})`).join('，'));
check('大国有多个标签铺开', multi.length > 5, multi.length);
check('同一块国土内的标签彼此至少隔开 60 像素', multi.every(m => m.minSep >= 60), multi.filter(m => m.minSep < 60).slice(0, 5));

/* ---- 每个标签都落在自己国土上 ---- */
const onLand = run(`
  let bad=0, tot=0;
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    for(const [x,y] of cc.labels){
      tot++;
      // 标签所在的那一格，周围 1 格内必须能找到本国的像素（撒点用的是格内均值，允许半个格子的误差）
      const col=Math.floor(x), row=Math.floor(y);
      let hit=false;
      for(let dr=-14;dr<=14&&!hit;dr+=7) for(let dc=-14;dc<=14&&!hit;dc+=7){
        const r2=row+dr, c2=col+dc;
        if(r2<0||r2>=ROWS||c2<0||c2>=COLS) continue;
        const pid=provOf[r2*COLS+c2];
        if(pid&&provinces[pid].owner===cc.id) hit=true;
      }
      if(!hit) bad++;
    }
  }
  return { bad, tot };
`);
check(`每个标签都落在自己的国土上（${onLand.tot} 个）`, onLand.bad === 0, onLand);

/* ---- 飞地单独成块 ---- */
const exclave = run(`
  // 找一个「有飞地」的国家：国土的连通块数 > 1
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
    if(k>1) found={ id:c, name:cc.name, comps:k, labels:cc.labels.length };
  }
  return found;
`);
if (exclave) {
  console.log(`有飞地的国家：${exclave.name}，本土+飞地共 ${exclave.comps} 块，标签 ${exclave.labels} 个`);
  check('飞地也拿到了自己的标签', exclave.labels >= exclave.comps, exclave);
} else {
  console.log('  SKIP  没找到带飞地的国家');
}

/* ---- 分级显示 ---- */
const tiers = run(`
  const zs=[0.9,1.5,2.4,3.2,4.0,6.0];
  const out=[];
  for(const z of zs){
    const min=labelMinArea(z);
    let n=0;
    for(let c=1;c<countries.length;c++){ const cc=countries[c];
      if(!cc||!cc.alive||!cc.labels) continue;
      for(const lb of cc.labels) if(lb[2]>=min) n++; }
    out.push([z,min,n]);
  }
  return out;
`);
console.log('比例尺 → 显示标签数：' + tiers.map(t => `z=${t[0]}:${t[2]}个(≥${t[1]}px)`).join('  '));
const counts = tiers.map(t => t[2]);
check('比例尺越大显示的国名越多（逐级放开）',
  counts.every((v, i) => i === 0 || v >= counts[i - 1]) && counts[counts.length - 1] > counts[0],
  counts);
check('世界视角不至于糊满（<80 个）', counts[0] < 80, counts[0]);
const allNamed = run(`
  const z=6, min=labelMinArea(z);
  let missing=0;
  for(let c=1;c<countries.length;c++){ const cc=countries[c];
    if(!cc||!cc.alive) continue;
    const vis=(cc.labels||[]).filter(lb=>lb[2]>=min);
    if(!vis.length) missing++;
  }
  return missing;
`);
check('放大到最大时每个存活国家都至少有一个名字', allNamed === 0, allNamed);

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
