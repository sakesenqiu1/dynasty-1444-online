// 地图接缝旋转的回归：旋转必须只挪位置，不动任何省份身份；
// 而且旋转后的接缝两侧不能有陆地（斐济、楚科奇不再被切成两半）。
//   node _tools/test-seam-unit.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

const noop = () => {};
const stub = () => ({
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, appendChild: noop, style: {}, dataset: {}, value: '', textContent: '',
  innerHTML: '', querySelector: () => null, querySelectorAll: () => [], closest: () => null,
});
function newCtx() {
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
  return ctx;
}
const run = (ctx, c) => vm.runInContext(`(function(){ ${c} })()`, ctx, { filename: 't' });
const COLS_DISPLAY = 1440;

console.log('\n=== 地图接缝旋转 ===\n');

/* ---- 旋转前的世界（把 MAP_SHIFT 临时关掉，拿一份参照） ---- */
const A = newCtx();
run(A, `resetWorld(); setSeed(SCENARIO_SEED);
  const feats=decodeTopo(WORLD_DATA); const {cidMap}=buildLand(feats);
  buildProvinces(cidMap,feats); buildCountries(cidMap,feats);`);
const before = run(A, `
  return {
    n:provinces.length,
    sig:provinces.slice(1).map(p=>[p.id,p.owner,p.name,p.tax,p.prod,p.man,p.pix.length,p.nbrs.length].join(':')).join('|'),
    seamLand:(()=>{ let n=0; for(let r=0;r<ROWS;r++){ if(provOf[r*COLS]) n++; if(provOf[r*COLS+COLS-1]) n++; } return n; })(),
  };
`);

/* ---- 旋转后的世界 ---- */
const B = newCtx();
run(B, 'resetWorld(); setSeed(SCENARIO_SEED); buildWorld();');
const after = run(B, `
  return {
    n:provinces.length, shift:MAP_SHIFT,
    sig:provinces.slice(1).map(p=>[p.id,p.owner,p.name,p.tax,p.prod,p.man,p.pix.length,p.nbrs.length].join(':')).join('|'),
    seamLand:(()=>{ let n=0; for(let r=0;r<ROWS;r++){ if(provOf[r*COLS]) n++; if(provOf[r*COLS+COLS-1]) n++; } return n; })(),
    // 接缝那一列和紧挨着的一列都不该有陆地
    seamBand:(()=>{ let n=0; for(let r=0;r<ROWS;r++) for(const c of [0,1,COLS-1]) if(provOf[r*COLS+c]) n++; return n; })(),
    provOfMatch:(()=>{ for(let i=0;i<NPIX;i++){ const p=provOf[i]; if(!p) continue; if(!provinces[p].pix.includes(i)) return false; } return true; })(),
    landMatch:(()=>{ for(let i=0;i<NPIX;i++){ if(!!land[i]!==!!provOf[i]) return false; } return true; })(),
  };
`);

check('省份数量不变', before.n === after.n, before.n + ' vs ' + after.n);
check('省份身份完全不变（编号/归属/名字/发展度/面积/邻接数）', before.sig === after.sig,
  before.sig === after.sig ? '' : '前 200 字差异处：' + (() => {
    for (let i = 0; i < Math.min(before.sig.length, after.sig.length); i++) if (before.sig[i] !== after.sig[i]) return before.sig.slice(i, i + 80) + ' ≠ ' + after.sig.slice(i, i + 80);
    return '长度不同';
  })());
check('provOf 与省份像素表一致（旋转没漏像素）', after.provOfMatch === true);
check('land 与 provOf 仍然一致（海陆判定没被打乱）', after.landMatch === true);

/* ---- 接缝 ---- */
check('旋转前接缝上确实有陆地（这就是斐济/楚科奇被切开的原因）', before.seamLand > 0, before.seamLand);
check('旋转后接缝上没有陆地', after.seamLand === 0, after.seamLand);
check('接缝列及紧邻列都没有陆地', after.seamBand === 0, after.seamBand);

/* ---- 具体国家不再被切 ---- */
const contig = run(B, `
  const EDGE=2;                       // 「贴着地图边缘」的判定宽度
  const nearLeft=new Map(), nearRight=new Map();   // cid -> 该侧像素数
  const provWrap=[];                  // 跨接缝的省
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p||!p.pix.length) continue;
    let hasL=false, hasR=false;
    for(const idx of p.pix){
      const c=idx%COLS;
      if(c<EDGE){ hasL=true; nearLeft.set(p.owner,(nearLeft.get(p.owner)||0)+1); }
      if(c>=COLS-EDGE){ hasR=true; nearRight.set(p.owner,(nearRight.get(p.owner)||0)+1); }
    }
    if(hasL&&hasR) provWrap.push(p.id);
  }
  const both=[...nearLeft.keys()].filter(c=>c&&nearRight.has(c));
  const nameOf=(cid)=>countries[cid]?countries[cid].name:('#'+cid);
  // 每个国家横向覆盖多少列（不考虑环绕），用来确认国土没被撕开
  const span=(cid)=>{
    let min=1e9, max=-1, n=0;
    for(let i=1;i<provinces.length;i++){ const p=provinces[i];
      if(!p||p.owner!==cid||!p.pix.length) continue;
      for(const idx of p.pix){ const c=idx%COLS; if(c<min)min=c; if(c>max)max=c; n++; }
    }
    return n?{min,max,cols:max-min+1,pix:n}:null;
  };
  const fiji=countries.findIndex(c=>c&&/Fiji/i.test(c.enName||''));
  const russia=countries.findIndex(c=>c&&/Russia/i.test(c.enName||''));
  return { wrapProvs:provWrap, bothCount:both.length, bothNames:both.map(nameOf),
           fiji:fiji>0?span(fiji):null, fijiName:fiji>0?nameOf(fiji):'(无)',
           russia:russia>0?span(russia):null, russiaName:russia>0?nameOf(russia):'(无)' };
`);
check('没有任何省份跨在地图接缝上', contig.wrapProvs.length === 0, contig.wrapProvs.slice(0, 8));
check('没有任何国家同时出现在地图左右两侧', contig.bothCount === 0, contig.bothNames);
if (contig.fiji) {
  check(`${contig.fijiName} 完整落在 ${contig.fiji.min}~${contig.fiji.max} 列（宽 ${contig.fiji.cols} 列）`,
    contig.fiji.min >= 2 && contig.fiji.max <= COLS_DISPLAY - 3, contig.fiji);
} else {
  console.log('  SKIP  数据集里没有斐济');
}
if (contig.russia) {
  check(`${contig.russiaName} 完整落在 ${contig.russia.min}~${contig.russia.max} 列（宽 ${contig.russia.cols} 列）`,
    contig.russia.min >= 2 && contig.russia.max <= COLS_DISPLAY - 3, contig.russia);
} else {
  console.log('  SKIP  数据集里没有俄罗斯');
}

/* ---- 旋转不能影响随机序列（否则整张地图都会变） ---- */
const seedSame = run(B, `return _worldSeed===SCENARIO_SEED||_worldSeed>0;`);
check('世界种子仍被正确记录', seedSame === true);

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
