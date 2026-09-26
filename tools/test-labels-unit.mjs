// 国名标签：一片国土一个国名、按国土主轴斜着摆、字号尽量填满、
// 不飘到邻国或海上；按比例尺分级显示；飞地各自成块。
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
  let alive=0, noLabel=0, bands=0;
  const rows=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive) continue;
    alive++;
    if(!cc.labels||!cc.labels.length){ noLabel++; continue; }
    bands+=cc.labels.length;
    rows.push({ id:c, name:cc.name, comp:cc.labelPx, n:cc.labels.length,
                maxLen:Math.max(...cc.labels.map(l=>l.len)), maxAng:Math.max(...cc.labels.map(l=>Math.abs(l.ang))) });
  }
  rows.sort((a,b)=>b.comp-a.comp);
  return { alive, noLabel, bands, rows };
`);
console.log(`存活国家 ${info.alive}，标签总数 ${info.bands}`);
check('每个存活国家都有标签', info.noLabel === 0, info.noLabel);
console.log('最大：' + info.rows.slice(0,3).map(r => `${r.name}(${r.comp}px, ${r.n}块)`).join('，'));
console.log('最小：' + info.rows.slice(-3).map(r => `${r.name}(${r.comp}px, ${r.n}块)`).join('，'));

/* ---- 【核心】一片地只有一个国名 ---- */
const oneEach = run(`
  let comps=0, labels=0, over=0;
  const detail=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    // 重新数一遍连通块
    const seen=new Set(); let k=0;
    for(const pid of cc.provList){
      if(seen.has(pid)) continue;
      const p0=provinces[pid]; if(!p0||!p0.pix.length) continue;
      k++; seen.add(pid); const st=[pid];
      while(st.length){ const u=st.pop();
        for(const v of provinces[u].nbrs){ const pv=provinces[v];
          if(pv&&pv.pix.length&&pv.owner===cc.id&&!seen.has(v)){ seen.add(v); st.push(v); } } }
    }
    comps+=k; labels+=cc.labels.length;
    if(cc.labels.length!==k){ over++; if(detail.length<5) detail.push([cc.name,k,cc.labels.length]); }
  }
  return { comps, labels, over, detail };
`);
console.log(`连通块 ${oneEach.comps} 个，标签 ${oneEach.labels} 个`);
check('【核心】一片国土只有一个国名（块数 = 标签数）', oneEach.over === 0, oneEach.detail);

/* ---- 【核心】文字框基本落在自己的国土上，不飘到邻国/海上 ---- */
const inside = run(`
  let tot=0, worst=null, worstR=2, ratios=[];
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    for(const lb of cc.labels){
      const N=cc.name.length||1;
      const Z=2.4;   // 测试按 z=2.4 这个常用比例尺算
      const byLen=lb.len*Z*0.84/(N*1.04), byH=lb.half*Z*0.82;
      let f=Math.min(byLen,byH);
      if(Z<3.2) f=Math.min(f,Math.max(10,Math.min(30,labelFontOf(lb.comp))));
      f=Math.min(f,34);
      if(f<8) continue;                    // 地太小写不下，不画
      const w=N*f*1.04/2/Z, h=f*1.45/2/Z;  // 字号是屏幕像素，要换算回世界像素才能比
      const ux=Math.cos(lb.ang), uy=Math.sin(lb.ang);
      let hit=0, n=0;
      for(let i=-4;i<=4;i++) for(let j=-2;j<=2;j++){
        const a=w*i/4, b=h*j/2;
        const px=lb.x+a*ux-b*uy, py=lb.y+a*uy+b*ux;
        const col=Math.floor(px), row=Math.floor(py);
        n++;
        if(col<0||col>=COLS||row<0||row>=ROWS) continue;
        const pid=provOf[row*COLS+col];
        if(pid&&provinces[pid].owner===cc.id) hit++;
      }
      tot++;
      const ratio=hit/n;
      ratios.push(ratio);
      if(ratio<worstR){ worstR=ratio; worst=cc.name; }
    }
  }
  ratios.sort((a,b)=>a-b);
  const median=ratios.length?ratios[Math.floor(ratios.length/2)]:1;
  return { tot, worst:Math.round(worstR*100)/100, worstName:worst, median:Math.round(median*100)/100,
           low:ratios.filter(r=>r<0.35).length };
`);
console.log(`文字框采样：${inside.tot} 个实际画出的国名，覆盖率中位 ${inside.median}，最差 ${inside.worst}（${inside.worstName}）`);
check('【核心】国名基本压在自己的国土上（覆盖率中位 ≥55%）', inside.median >= 0.55, inside);
check('没有明显飘出去的国名（最差覆盖率 ≥20%）', inside.worst >= 0.20, inside);

/* ---- 倾斜角度 ---- */
check('主轴角度夹在 ±48° 内（不会横七竖八）',
  info.rows.every(r => r.maxAng <= 48.01 * Math.PI / 180 + 1e-6),
  info.rows.filter(r => r.maxAng > 48.01 * Math.PI / 180 + 1e-6).slice(0, 3));
const tilted = run(`
  let n=0, tot=0;
  for(let c=1;c<countries.length;c++){ const cc=countries[c];
    if(!cc||!cc.alive||!cc.labels) continue;
    for(const lb of cc.labels){ tot++; if(Math.abs(lb.ang)>0.05) n++; } }
  return { n, tot };
`);
console.log(`有倾斜的标签：${tilted.n}/${tilted.tot}`);
check('狭长的国土确实会斜着摆（不是全部水平）', tilted.n > 10, tilted);

/* ---- 字号随国土大小 ---- */
const sized = run(`
  const a=[];
  for(let c=1;c<countries.length;c++){ const cc=countries[c];
    if(!cc||!cc.alive||!cc.labels) continue;
    for(const lb of cc.labels){
      const N=cc.name.length||1;
      const f=Math.min(Math.max(9,Math.min(34,Math.min(lb.len*0.92/(N*1.04), lb.half*1.05))),
                       Math.max(10,Math.min(30,labelFontOf(lb.comp))));
      a.push([lb.comp,f]);
    } }
  a.sort((x,y)=>x[0]-y[0]);
  const small=a[Math.floor(a.length*0.1)], big=a[Math.floor(a.length*0.9)];
  let bad=0, prev=0;
  for(const [area,f] of a){ if(f<prev-6) bad++; prev=f; }   // 允许因为「塞不下」而缩小
  return { small, big, bad, n:a.length };
`);
console.log(`字号：10% 分位 ${sized.small[1].toFixed(1)}px（面积 ${sized.small[0]}），90% 分位 ${sized.big[1].toFixed(1)}px（面积 ${sized.big[0]}）`);
check('国土大国名大、国土小国名小', sized.big[1] > sized.small[1], sized);

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
    if(k>1) found={ id:c, name:cc.name, comps:k, labels:cc.labels.length };
  }
  return found;
`);
if (exclave) {
  console.log(`有飞地的国家：${exclave.name}，共 ${exclave.comps} 块国土，${exclave.labels} 个标签`);
  check('飞地也拿到了自己的国名', exclave.labels === exclave.comps, exclave);
} else {
  console.log('  SKIP  没找到带飞地的国家');
}

/* ---- 标签中心必须落在本国国土上 ---- */
const center = run(`
  let bad=0, tot=0;
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive||!cc.labels) continue;
    for(const lb of cc.labels){
      tot++;
      const col=Math.floor(lb.x), row=Math.floor(lb.y);
      let hit=false;
      for(let dr=-2;dr<=2&&!hit;dr++) for(let dc=-2;dc<=2&&!hit;dc++){
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
check(`标签中心都落在自己的国土上（${center.tot} 个）`, center.bad === 0, center);

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
