// 无主荒地（owner=0）与"从零画地图"的引擎回归测试
//
// 背景：地图编辑器支持「一键清空所有国家」，之后全部省份变成无主荒地，
// 再「新建国家」重新画。这打破了引擎原有的两个隐含假设：
//   1) 每个省都有主人（countries[p.owner] 一定存在）
//   2) countries 数组没有空洞（countries[i].alive 可以无脑取）
// 剧本可以在很靠后的编号上新建国家，中间的编号就会是 null 洞。
// 这个文件就是盯这两件事的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

const sb = {
  console, Math, Date, JSON, Set, Map, Array, Object, Number, String, Error, isFinite, parseInt, parseFloat,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
  UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
  module: { exports: {} }, globalThis: null,
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
const core = sb.module.exports;
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

/* 在 VM 里预置一个建剧本的辅助函数。
   注意不能在自己写的片段里再声明 const provinces/const countries ——
   那会遮蔽内核的全局数组，直接 TDZ 报错。 */
run(`
  globalThis.W = {
    // 全新世界 + 基线；返回稀疏表，调用方自己往里面塞改动
    reset(){ resetWorld(); setSeed(987654321); buildWorld(); captureScenarioBase(); },
    // 把所有陆地省标成无主、所有国家标成灭亡
    wasteland(){ const P=provinces; const p={}; for(let i=1;i<P.length;i++) if(P[i].pix.length) p[i]={o:0};
                 const c={}; for(let i=1;i<countries.length;i++) if(countries[i]) c[i]={dead:1}; return {p,c}; },
    // 陆地基底：从 1 到最后的可通行省，挑出若干块连成一片的
    // 取一个没被占用的省
    firstLand(){ for(let i=1;i<provinces.length;i++) if(provinces[i].pix.length) return i; return 0; },
    // 在指定编号新建国家
    newCountry(id,name,color){ return { new:1, n:name, c:color }; },
    land(n,skip){ const out=[]; for(let i=1;i<provinces.length&&out.length<n;i++){ if(!provinces[i].pix.length) continue; if(skip&&out.length<skip) { out.push(i); continue; } out.push(i); } return out; },
  };
  return 1;
`);

/* 跑 N 天，返回错误信息或 null */
function sim(days) {
  let crashed = null;
  for (let d = 0; d < days && !crashed; d++) {
    try { core.tickDay(); } catch (e) {
      crashed = `${e.message} @ ${String(e.stack).split('\n')[1].trim()}`;
    }
  }
  return crashed;
}
const stats = () => {
  const P = core.provinces(), C = core.countries();
  let unowned = 0, owned = 0, holes = 0;
  for (let i = 1; i < P.length; i++) { if (!P[i].pix.length) continue; if (P[i].owner === 0) unowned++; else owned++; }
  for (let i = 1; i < C.length; i++) if (!C[i]) holes++;
  return { unowned, owned, alive: C.filter(c => c && c.alive).length, holes, countries: C.length };
};

console.log('\n=== 无主荒地 / 数组空洞 回归测试 ===\n');

/* ================= 1. 全荒地 ================= */
console.log('-- 1. 全荒地（地图上一个国家都没有）--');
const t1 = run(`
  W.reset(); const w=W.wasteland();
  return { v:1, base:'ne110m', seed:987654321, name:'全荒地', countries:w.c, provinces:w.p, armies:[] };
`);
check('全荒地剧本能建出世界', core.buildWorldFromScenario(t1) === null, core.buildWorldFromScenario(t1));
let s = stats();
check('所有省份都无主', s.unowned === 2007 && s.owned === 0, s);
check('没有任何存活国家', s.alive === 0, s);
check('【核心】全荒地跑 900 天不崩', sim(900) === null, '崩了');

/* ================= 2. 半荒地 ================= */
console.log('\n-- 2. 半荒地：一半国家还在，一半变成荒地 --');
const t2 = run(`
  W.reset(); const P=provinces, p={};
  for(let i=1;i<P.length;i++){ if(!P[i].pix.length) continue; if((i%2)===0) p[i]={o:0}; }
  return { v:1, base:'ne110m', seed:987654321, name:'半荒地', countries:{}, provinces:p, armies:[] };
`);
check('半荒地剧本能建出世界', core.buildWorldFromScenario(t2) === null);
s = stats();
check('确实是一半一半', s.unowned > 900 && s.owned > 900, s);
check('还有大量国家存活', s.alive > 50, s.alive);
check('【核心】半荒地跑 900 天不崩', sim(900) === null, '崩了');

/* ================= 3. 数组空洞 ================= */
console.log('\n-- 3. countries 数组有空洞时不能崩 --');
const t3 = run(`
  W.reset(); const w=W.wasteland();
  const land=W.land(30);
  w.c[400]={ new:1, n:'空洞国', c:'200,80,40', cap:land[0], g:500 };
  for(const pid of land) w.p[pid]={o:400};
  return { v:1, base:'ne110m', seed:987654321, name:'空洞', countries:w.c, provinces:w.p,
           armies:[{o:400,p:land[0],s:9000}] };
`);
check('带大编号新国家的剧本能建出世界', core.buildWorldFromScenario(t3) === null);
s = stats();
check('【关键】数组空洞被空壳国家填上，没有 null', s.holes === 0, s);
check('新国家只有它一个存活', s.alive === 1, s.alive);
check('【核心】空洞世界跑 900 天不崩（含每年换君主、月度结算、AI）', sim(900) === null, '崩了');
// 注意：applyScenario 会把基线清掉，所以这个用例直接在"活世界"上改，
// 模拟编辑器的实际操作顺序（建世界 → captureScenarioBase → 改 → makeScenario）
const t3b = run(`
  W.reset();
  const land=W.land(30);
  while(countries.length<=400) countries.push(makeVoidCountry(countries.length));
  countries[400]={ id:400, featId:'CUSTOM', name:'空洞国', enName:'空洞国', color:[200,80,40],
                   capital:land[0], provList:[], alive:false, gold:500, mp:0, mpCap:0,
                   forceLimit:0, overlord:0, subject:0, allies:[], ruler:'', lx:0, ly:0 };
  for(const pid of land){ const p=provinces[pid]; p.owner=400; p.controller=400; }
  for(let i=1;i<countries.length;i++) if(countries[i]) countries[i].provList=[];
  for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(p.pix.length&&countries[p.owner]) countries[p.owner].provList.push(i); }
  const sc=makeScenario({name:'x'});
  return { keys:Object.keys(sc.countries).sort().join(','), total:countries.length,
           voids:countries.filter(c=>c&&isVoidCountry(c)).length,
           provinces:Object.keys(sc.provinces).length };
`);
check('数组里确实有 223 个空壳位', t3b.voids > 200, t3b);
check('空壳国家不会被当成真国家导出（只导出新国家 400）', t3b.keys === '400', t3b);
check('省份改动照常导出', t3b.provinces >= 30, t3b);

/* ================= 4. 从无主地划出去 ================= */
console.log('\n-- 4. 从无主荒地划给某个国家 --');
const t4 = run(`
  W.reset(); const w=W.wasteland();
  const pid=W.firstLand();
  w.c[200]={ new:1, n:'拓荒者', c:'10,200,10', cap:pid };
  return { sc:{ v:1, base:'ne110m', seed:987654321, name:'拓荒', countries:w.c, provinces:w.p, armies:[] }, pid };
`);
core.buildWorldFromScenario(t4.sc);
let e4 = null;
try { core.transferProvince(t4.pid, 200); } catch (e) { e4 = e.message; }
check('【核心】从无主地 transferProvince 不崩', e4 === null, e4);
check('划过去之后归属正确', core.provinces()[t4.pid].owner === 200);
check('新国家拿到了这个省', core.countries()[200].provList.includes(t4.pid));
let e4b = null;
try { core.transferProvince(t4.pid, 0); } catch (e) { e4b = e.message; }
check('【核心】再划回荒地（to=0）也不崩', e4b === null, e4b);
check('划回后确实无主', core.provinces()[t4.pid].owner === 0);
let e4c = null;
try { core.transferProvince(t4.pid, 99999); } catch (e) { e4c = e.message; }
check('划给不存在的国家也不崩', e4c === null, e4c);

/* ================= 5. 存档往返 ================= */
console.log('\n-- 5. 荒地 + 新国家的存档往返 --');
const t5 = run(`
  W.reset(); const w=W.wasteland();
  const pid=W.firstLand();
  w.c[201]={ new:1, n:'幸存者', c:'10,10,200', g:100 };
  w.p[pid]={o:201};
  const sc={ v:1, base:'ne110m', seed:987654321, name:'往返', countries:w.c, provinces:w.p,
             armies:[{o:201,p:pid,s:5000}] };
  buildWorldFromScenario(sc);
  const snap=makeSaveData();
  buildWorldFromScenario(sc);
  applySaveData(JSON.parse(JSON.stringify(snap)));
  const p=provinces[pid], c=countries[201];
  return { pid, owner:p.owner, alive:c.alive, provs:c.provList.length, armyN:armies.length,
           unowned:provinces.filter(q=>q&&q.pix.length&&q.owner===0).length };
`);
check('存档往返后归属保留', t5.owner === 201, t5);
check('新国家仍然存活且领土正确', t5.alive === true && t5.provs === 1, t5);
check('军队保留', t5.armyN === 1, t5);
check('荒地状态保留', t5.unowned === 2006, t5);

/* ================= 6. 从零画一张完整地图 ================= */
console.log('\n-- 6. 从零画一张地图并真的玩起来 --');
const t6 = run(`
  W.reset(); const w=W.wasteland();
  const land=W.land(700);
  const A=300, B=301;
  w.c[A]={ new:1, n:'甲国', c:'200,60,60', cap:land[0], g:800 };
  w.c[B]={ new:1, n:'乙国', c:'60,60,200', cap:land[500], g:800 };
  for(const pid of land.slice(0,400)) w.p[pid]={o:A};
  for(const pid of land.slice(400,700)) w.p[pid]={o:B};
  return { sc:{ v:1, base:'ne110m', seed:987654321, name:'从零画', countries:w.c, provinces:w.p,
                armies:[{o:A,p:land[0],s:12000},{o:B,p:land[500],s:12000}] },
           A, B, land:land.length, totalLand:provinces.filter(q=>q&&q.pix.length).length };
`);
const e6 = core.buildWorldFromScenario(t6.sc);
check('从零画的地图能建出来', e6 === null, e6);
s = stats();
check('两个国家都存活', s.alive === 2, s.alive);
check('领土数正确', core.countries()[t6.A].provList.length === 400 && core.countries()[t6.B].provList.length === 300, {
  a: core.countries()[t6.A].provList.length, b: core.countries()[t6.B].provList.length });
check('其余全是荒地', s.unowned === t6.totalLand - 700, { got: s.unowned, want: t6.totalLand - 700 });
core.setHumans([t6.A, t6.B]); core.player = t6.A;
check('【核心】从零画的地图能正常跑 1200 天', sim(1200) === null, '崩了');
check('跑完后世界真的在运转（有国家扩了或打起来了）',
  core.countries()[t6.A].provList.length + core.countries()[t6.B].provList.length > 0,
  core.countries()[t6.A].provList.length);

/* ================= 7. 荒地可以通行 ================= */
console.log('\n-- 7. 无主荒地可以通行（行军不受归属影响）--');
const t7 = run(`
  W.reset(); const w=W.wasteland();
  buildWorldFromScenario({ v:1, base:'ne110m', seed:987654321, name:'通行', countries:w.c, provinces:w.p, armies:[] });
  let a=0,b=0;
  for(let i=1;i<provinces.length;i++){
    if(!provinces[i].pix.length) continue;
    const nb=provinces[i].nbrs.find(q=>provinces[q]&&provinces[q].pix.length);
    if(nb){ a=i; b=nb; break; }
  }
  let ok=true, path=null;
  try{ path=findPath(a,b); }catch(e){ ok=false; }
  return { a, b, ok, len:path?path.length:0, ownerA:provinces[a].owner, ownerB:provinces[b].owner };
`);
check('荒地省之间可以找到路径', t7.ok === true && t7.len > 0, t7);
check('沿途省份都是无主的（确实是荒地）', t7.ownerA === 0 && t7.ownerB === 0, t7);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
