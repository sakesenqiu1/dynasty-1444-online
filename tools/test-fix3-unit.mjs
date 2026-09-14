// 验证本轮性能优化的正确性：
//  1. 双向 BFS 的海路可达性与原单向实现完全一致，且返回的是一条合法航路
//  2. campOf 缓存失效机制正确（附庸关系变化后必须立刻反映）
//  3. 脏矩形只回写改动区域，recolorAll 才整幅回写
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 240) : '')); } };

const noop = () => {};
const putLog = [];
function ctx2d() {
  return {
    _m: [1, 0, 0, 1, 0, 0],
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', imageSmoothingEnabled: true,
    setTransform(a, b, c, d, e, f) { this._m = [a, b, c, d, e, f]; },
    save: noop, restore: noop, translate: noop, scale: noop,
    fillRect: noop, clearRect: noop, strokeRect: noop,
    putImageData(img, dx, dy, sx, sy, sw, sh) { putLog.push(sx === undefined ? 'FULL' : [sx, sy, sw, sh].join(',')); },
    drawImage: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, stroke: noop, fill: noop, setLineDash: noop, strokeText: noop, fillText: noop,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
}
const mk = (id) => {
  const e = {
    id: id || '', width: 1280, height: 800, style: {}, dataset: {}, value: '', textContent: '', children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h || ''; }, set(v) { e._h = v; } });
  return e;
};
const els = {};
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, requestAnimationFrame: noop,
  document: { addEventListener: noop, getElementById: (i) => els[i] || (els[i] = mk(i)), createElement: () => mk(''), querySelector: () => null, querySelectorAll: () => [], body: { appendChild: noop } },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false, noop,
  addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
sb.putLog = putLog;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 本轮优化的正确性验证 ===\n');
run('resetWorld(); buildWorld(); started=true; player=140; MP.online=true;');

/* ================= 1. 双向 BFS 与原实现等价 ================= */
console.log('-- 1. 海路 BFS（双向 vs 原单向）--');
const navTest = run(`
  // 原单向实现（照抄优化前的版本）作为参照
  function refNaval(fromPid,toPid){
    if(fromPid===toPid) return [];
    const from=provinces[fromPid], to=provinces[toPid];
    if(!from.coastPix.length||!to.coastPix.length) return null;
    const startPx=from.coastPix[0], endPx=to.coastPix[0];
    if(startPx===endPx) return [];
    const prev=new Int32Array(NPIX).fill(-1);
    prev[startPx]=startPx;
    const q=[startPx]; let h=0;
    while(h<q.length){
      const u=q[h++]; const r=(u/COLS)|0, c=u%COLS;
      function tryPush(v){
        if(prev[v]!==-1) return;
        if(land[v]===0||v===endPx){ prev[v]=u; if(v!==endPx) q.push(v); }
      }
      if(c>0) tryPush(u-1);
      if(c+1<COLS) tryPush(u+1);
      if(r>0) tryPush(u-COLS);
      if(r+1<ROWS) tryPush(u+COLS);
      if(prev[endPx]!==-1) break;
    }
    if(prev[endPx]===-1) return null;
    const path=[]; let x=endPx;
    while(x!==startPx){ path.push(x); x=prev[x]; }
    path.reverse();
    return path;
  }
  // 找一批有海岸线的省份
  const coastal=[];
  for(let i=1;i<provinces.length && coastal.length<40;i++){
    const p=provinces[i];
    if(p&&p.pix.length&&p.coastPix&&p.coastPix.length) coastal.push(i);
  }
  let same=0, diff=0, bothNull=0, mismatch=[];
  let valid=0, invalid=0, longer=0, maxRatio=1;
  for(let k=0;k<60;k++){
    const a=coastal[(k*7)%coastal.length], b=coastal[(k*13+5)%coastal.length];
    if(a===b) continue;
    const mine=findNavalPath(a,b);
    const ref=refNaval(a,b);
    const mineNull=(mine===null), refNull=(ref===null);
    if(mineNull&&refNull){ bothNull++; continue; }
    if(mineNull!==refNull){ diff++; mismatch.push([a,b,!!mineNull,!!refNull]); continue; }
    same++;
    // 校验合法性
    const s=provinces[a].coastPix[0], e=provinces[b].coastPix[0];
    let ok=true;
    if(mine.length===0){ ok=(s===e); }
    else {
      if(mine[mine.length-1]!==e) ok=false;
      let prevPx=s;
      for(const px of mine){
        // 相邻
        const dr=Math.abs(((px/COLS)|0)-((prevPx/COLS)|0)), dc=Math.abs((px%COLS)-(prevPx%COLS));
        if(dr+dc!==1){ ok=false; break; }
        // 除终点外必须是海
        if(px!==e && land[px]!==0){ ok=false; break; }
        prevPx=px;
      }
    }
    if(ok) valid++; else invalid++;
    if(mine.length>ref.length){ longer++; maxRatio=Math.max(maxRatio, mine.length/ref.length); }
  }
  return { same, diff, bothNull, mismatch, valid, invalid, longer, maxRatio };
`);
check(`可达性完全一致（${navTest.same} 组有路 + ${navTest.bothNull} 组无路）`, navTest.diff === 0, navTest.mismatch);
check(`返回的航路全部合法（${navTest.valid} 条）`, navTest.invalid === 0, { valid: navTest.valid, invalid: navTest.invalid });
check(`路径长度不超过参照实现（最长 ${navTest.maxRatio.toFixed(2)} 倍）`, navTest.maxRatio <= 1.001, navTest.maxRatio);

/* ================= 2. campOf 缓存失效 ================= */
console.log('\n-- 2. campOf 缓存 --');
const camp = run(`
  // 挑三个互不相关的国家，先把它们的宗主关系清干净，避免受世界初始附庸关系干扰
  const cs=countries.filter(c=>c&&c.alive).slice(0,12);
  for(const c of cs) c.overlord=0;
  invalidateCamps();
  const A=cs[0].id, B=cs[1].id, C=cs[2].id;
  countries[B].overlord=A;
  countries[C].overlord=B;      // A->B->C 三级
  invalidateCamps();
  const s1=[...campOf(A)].sort((x,y)=>x-y);
  const s2=[...campOf(C)].sort((x,y)=>x-y);
  const cached = campOf(A)===campOf(A);        // 同一状态应命中缓存
  countries[C].overlord=0; invalidateCamps();  // 断开 C
  const s3=[...campOf(A)].sort((x,y)=>x-y);
  countries[C].overlord=B; invalidateCamps();  // 接回来
  const s4=[...campOf(A)].sort((x,y)=>x-y);
  countries[B].alive=false; invalidateCamps(); // 中间层灭亡
  const s5=[...campOf(A)].sort((x,y)=>x-y);
  countries[B].alive=true;
  return { A,B,C, s1, s2, s3, s4, s5, cached };
`);
check('三级附庸链：宗主能看到最底层', camp.s1.includes(camp.B) && camp.s1.includes(camp.C), camp.s1);
check('附庸的阵营 = 自己 + 祖先宗主（原设计如此）', camp.s2.includes(camp.C) && camp.s2.includes(camp.B) && camp.s2.includes(camp.A), camp.s2);
check('附庸阵营是宗主阵营的子集', camp.s2.every(x => camp.s1.includes(x)), { s2: camp.s2, s1: camp.s1 });
check('同一状态重复调用命中缓存', camp.cached);
check('解除附庸后立刻反映（缓存已失效）', !camp.s3.includes(camp.C), camp.s3);
check('接回附庸后立刻反映', camp.s4.includes(camp.C), camp.s4);
check('中间宗主灭亡后，其附庸不再属于原阵营', !camp.s5.includes(camp.C) && !camp.s5.includes(camp.B), camp.s5);

/* ================= 3. 脏矩形 ================= */
console.log('\n-- 3. 脏矩形回写 --');
const dirty = run(`
  cw=1280; ch=800; dpr=1; cam.x=720; cam.y=360; cam.z=1;
  putLog.length=0;
  recolorAll();                      // 整幅重绘
  render();
  const full=putLog.slice();
  putLog.length=0;
  // 只让一个省变色
  const pid=provinces.findIndex(p=>p&&p.pix.length>50);
  recolorProvince(pid);
  render();
  const one=putLog.slice();
  // 再让一个大范围变化
  putLog.length=0;
  for(let i=1;i<=40;i++) recolorProvince(i);
  recolorAll();
  render();
  const again=putLog.slice();
  return { full, one, again };
`);
check('recolorAll 走整幅回写', dirty.full.includes('FULL'), dirty.full);
check('单省变色只回写一小块区域', dirty.one.length && dirty.one[0] !== 'FULL', dirty.one);
if (dirty.one.length && dirty.one[0] !== 'FULL') {
  const [x, y, w, h] = dirty.one[0].split(',').map(Number);
  check(`脏矩形远小于整幅（${w}×${h} vs 1440×720）`, w * h < 1440 * 720 * 0.1, { w, h });
}

/* ================= 4. 回归 ================= */
console.log('\n-- 4. 回归 --');
const reg = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<1500;i++) tickDay();
  return { day: dayCount, armies: armies.length, wars: wars.length, alive: countries.filter(c=>c&&c.alive).length };
`);
check('模拟 1500 天无异常', reg.day === 1500 && reg.armies > 0, reg);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
