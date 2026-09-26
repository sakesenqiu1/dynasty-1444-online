// 城市建筑：兵营（维护费减半）、城防（驻军 + 控制区 + 攻城结算）。
// 重点是「城防的控制区永远不会把自己变成打不到的铁乌龟」这一条，做成穷举验证。
//   node _tools/test-buildings-unit.mjs
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
/* 内核里的常量，测试里直接引用，免得两边写死两套数字 */
const K = run('return { BARRACKS_COST, BARRACKS_DAYS, FORT_COST, FORT_DAYS, FORT_MAX, FORT_MIN_DAYS, FORT_GARRISON };');
const BARRACKS_COST_B = K.BARRACKS_COST, FORT_COST_B = K.FORT_COST, FORT_DAYS_B = K.FORT_DAYS;

console.log('\n=== 城市建筑 / 城防控制区 ===\n');
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld();');

/* ================= 1. 建造校验与工期 ================= */
console.log('-- 1. 建造校验与工期 --');
const b1 = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>6);
  const pid=A.provList[0];
  const p=provinces[pid];
  const out={ pid, A:A.id, B:B.id, name:p.name };
  A.gold=1000;
  out.errOwn=buildBuilding(B.id,pid,'barracks');          // 不是自己的地
  out.errKind=buildBuilding(A.id,pid,'castle');           // 未知建筑
  out.goldBefore=A.gold;
  out.ok1=buildBuilding(A.id,pid,'barracks');
  out.goldAfter=A.gold;
  out.barracksRightAfter=p.barracks;                       // 刚下单还没建成
  out.days=p.buildDays; out.total=p.buildTotal;
  out.errBusy=buildBuilding(A.id,pid,'fort');              // 工地占着，不能再开一个
  // 工期走完
  let d=0; while(p.buildKind&&d<2000){ tickBuild(); d++; }
  out.builtDays=d; out.barracks=p.barracks;
  out.errDup=buildBuilding(A.id,pid,'barracks');           // 重复建
  A.gold=100000;
  // 城防：从 0 一路升到满级，每一级都要等工期
  const spent=[];
  for(let lv=1;lv<=FORT_MAX;lv++){
    out['fortErr'+lv]=buildBuilding(A.id,pid,'fort');
    let k=0; while(p.buildKind&&k<3000){ tickBuild(); k++; }
    spent.push(k);
  }
  out.fortSteps=spent; out.fortMax=p.fort;
  out.errMax=buildBuilding(A.id,pid,'fort');
  // 占领中不能建
  const oldC=p.controller; p.controller=B.id;
  out.errOcc=buildBuilding(A.id,pid,'fort');
  p.controller=oldC;
  // 没钱
  A.gold=0; p.fort=0;
  out.errPoor=buildBuilding(A.id,pid,'fort');
  A.gold=100000;
  return out;
`);
check('只能在自己的领土上建造', /只能在自己/.test(b1.errOwn || ''), b1.errOwn);
check('未知建筑被拒绝', /未知的建筑/.test(b1.errKind || ''), b1.errKind);
check('下单时立即扣钱', b1.ok1 === null && b1.goldBefore - b1.goldAfter === BARRACKS_COST_B,
  [b1.ok1, b1.goldBefore - b1.goldAfter]);
check('【核心】下单不会立刻建成，要等工期', b1.barracksRightAfter === 0 && b1.days > 0,
  [b1.barracksRightAfter, b1.days]);
check(`兵营工期 = ${b1.total} 天（约 ${Math.round(b1.total / 30)} 个月）`, b1.total === 90 && b1.builtDays === 90, b1);
check('工期走完才真的建好', b1.barracks === 1, b1.barracks);
check('工地占着时不能再开一个', /正在修建/.test(b1.errBusy || ''), b1.errBusy);
check('兵营不能重复建', /已有兵营/.test(b1.errDup || ''), b1.errDup);
check(`城防能逐级升到满级 Lv.${b1.fortMax}`, b1.fortMax === 5, [b1.fortSteps, b1.fortMax]);
check('每一级城防都有自己的工期', b1.fortSteps.every((k, i) => k === FORT_DAYS_B[i + 1]), b1.fortSteps);
check('满级后拒绝再升', /最高等级/.test(b1.errMax || ''), b1.errMax);
check('本省不在自己控制下不能建造', /不在你控制/.test(b1.errOcc || ''), b1.errOcc);
check('金币不足会被拒绝', /金币不足/.test(b1.errPoor || ''), b1.errPoor);

/* ================= 1b. 拆除 ================= */
console.log('\n-- 1b. 拆除与退款 --');
const b1b = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const pid=A.provList.find(x=>provinces[x].pix.length);
  const p=provinces[pid];
  p.fort=0; p.barracks=0; p.buildKind=''; p.buildDays=0; p.buildTotal=0;
  A.gold=100000;
  // 建一座兵营再拆
  buildBuilding(A.id,pid,'barracks'); while(p.buildKind) tickBuild();
  const g0=A.gold;
  const e1=demolishBuilding(A.id,pid,'barracks');
  const g1=A.gold;
  // 建两级城防再拆一级
  buildBuilding(A.id,pid,'fort'); while(p.buildKind) tickBuild();
  buildBuilding(A.id,pid,'fort'); while(p.buildKind) tickBuild();
  const fortBefore=p.fort, g2=A.gold;
  const e2=demolishBuilding(A.id,pid,'fort');
  const after=e2===null?provinces[pid].fort:null;   // 立刻记下来，后面还要复用这个省
  const g3=A.gold;
  // 拆工地
  buildBuilding(A.id,pid,'fort');
  const g4=A.gold;
  const e3=demolishBuilding(A.id,pid,'cancel');
  const g5=A.gold; const kindAfter=p.buildKind;
  // 拆不存在的东西
  p.fort=0; p.barracks=0;
  const e4=demolishBuilding(A.id,pid,'barracks');
  const e5=demolishBuilding(A.id,pid,'fort');
  const e6=demolishBuilding(A.id,pid,'cancel');
  return { e1, refundBarracks:g1-g0, e2, fortBefore, after,
           refundFort:g3-g2, e3, refundCancel:g5-g4, kindAfter, e4, e5, e6 };
`);
check('拆除兵营成功并退回一半', b1b.e1 === null && b1b.refundBarracks === 75, b1b);
check('拆除城防降一级（不是全拆）', b1b.e2 === null && b1b.after === b1b.fortBefore - 1, b1b);
check('城防退款是当前等级造价的一半', b1b.refundFort === Math.floor(FORT_COST_B[b1b.fortBefore] / 2), b1b);
check('可以给在建工程停工并退回一半', b1b.e3 === null && b1b.refundCancel > 0 && b1b.kindAfter === '', b1b);
check('拆不存在的东西会被拒绝', /没有/.test(b1b.e4 || '') && /没有/.test(b1b.e5 || '') && /没有/.test(b1b.e6 || ''),
  [b1b.e4, b1b.e5, b1b.e6]);

/* ================= 1c. 工地被占领 ================= */
console.log('\n-- 1c. 工地易主 --');
const b1c = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id);
  const pid=A.provList.find(x=>provinces[x].pix.length);
  const p=provinces[pid];
  p.fort=0; p.barracks=0; p.buildKind=''; p.buildDays=0;
  A.gold=100000;
  buildBuilding(A.id,pid,'fort');
  const had=p.buildKind;
  p.controller=B.id;                 // 敌人打进来了
  tickBuild();
  const after=p.buildKind, fort=p.fort;
  p.controller=A.id;
  return { had, after, fort };
`);
check('在建工地被敌人占领则废弃（不会给敌人修城防）',
  b1c.had === 'fort' && b1c.after === '' && b1c.fort === 0, b1c);

/* ================= 2. 城防驻军 ================= */
console.log('\n-- 2. 城防守军 --');
const g = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const pid=A.provList.find(x=>provinces[x].pix.length);
  const p=provinces[pid];
  const out=[];
  for(let L=0;L<=FORT_MAX;L++){ p.fort=L; out.push([L, garrisonOf(p)]); }
  p.fort=0;
  return out;
`);
check('每级城防 +1000 驻军', g.every(([L, gar]) => gar === L * 1000), g);

/* ================= 3. 攻城结算：兵力 / 城防 / 运气 / 最短工期 ================= */
console.log('\n-- 3. 攻城结算 --');
const sg = run(`
  const p={fort:0};
  const avg=(bstr,fort,n)=>{ p.fort=fort; let s=0; for(let i=0;i<n;i++) s+=siegeDailyProgress(bstr,p); return s/n; };
  const days=(bstr,fort)=>Math.round(100/avg(bstr,fort,3000));
  const out={
    noFort: days(3000,0),                       // 无城防基准
    lv1: days(10000,1), lv3: days(10000,3), lv5: days(10000,5),
    lv5huge: days(300000,5),                    // 30 万大军打 5 级
    lv1huge: days(300000,1),
    lv3tiny: days(300,3),                       // 300 人打 3 级
    lv5big: days(100000,5),
  };
  p.fort=0;
  let lo=1e9, hi=-1e9;
  for(let i=0;i<4000;i++){ const v=siegeDailyProgress(3000,p); if(v<lo)lo=v; if(v>hi)hi=v; }
  const base=3000/SIEGE_DIV;
  return { ...out, lo:lo/base, hi:hi/base, minDays:FORT_MIN_DAYS, base };
`);
console.log(`  围城天数：无城防 ${sg.noFort} 天`);
console.log(`  1万兵：Lv1 ${sg.lv1} 天，Lv3 ${sg.lv3} 天，Lv5 ${sg.lv5} 天`);
console.log(`  30万兵：Lv1 ${sg.lv1huge} 天，Lv5 ${sg.lv5huge} 天`);
console.log(`  300 兵打 Lv3：${sg.lv3tiny} 天`);
check('没有城防时和以前一样（进度 = 兵力/3000）', Math.abs(sg.base - 1) < 1e-9, sg.base);
check('城防越高围得越久', sg.lv1 < sg.lv3 && sg.lv3 < sg.lv5, [sg.lv1, sg.lv3, sg.lv5]);
check(`【核心】城堡至少拖住敌人一两个月（Lv1 ${sg.lv1huge} 天 ≥ ${sg.minDays[1]}）`,
  sg.lv1huge >= sg.minDays[1], sg.lv1huge);
check(`【核心】Lv3 至少 ${sg.minDays[3]} 天`, sg.lv3 >= sg.minDays[3], sg.lv3);
check(`【核心】Lv5 至少 ${sg.minDays[5]} 天`, sg.lv5 >= sg.minDays[5], sg.lv5);
check('【核心】堆兵到 30 万也不能更快突破（和 10 万一样慢）',
  sg.lv5huge >= sg.minDays[5] && sg.lv5huge === sg.lv5big, [sg.lv5huge, sg.lv5big]);
check('弱旅照样磨得下来，只是慢很多（不会永远卡住）',
  sg.lv3tiny > sg.lv3 * 2 && sg.lv3tiny < 4000, [sg.lv3tiny, sg.lv3]);
check('运气在 ±35% 以内波动', sg.lo > 0.64 && sg.hi < 1.36 && sg.hi - sg.lo > 0.5, [sg.lo, sg.hi]);

/* ================= 4. 控制区（ZOC） ================= */
console.log('\n-- 4. 城防控制区 --');
const zoc = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>10);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>10&&!atWar(A.id,c.id));
  // 找一块 A 的内陆省当要塞：邻省多、且邻省都属于 A
  let F=0;
  for(const pid of A.provList){
    const p=provinces[pid]; if(!p||!p.pix.length||p.nbrs.length<3) continue;
    if(p.nbrs.every(q=>provinces[q].owner===A.id)){ F=pid; break; }
  }
  if(!F) return null;
  const F0=map=>map;
  const ring=provinces[F].nbrs.slice();
  declareWar(B.id,A.id);
  const zocB=zocMapFor(B.id), zocA=zocMapFor(A.id);
  // 未设城防时：没有控制区
  const beforeRing=ring.map(r=>!!zocB.get(r)).filter(Boolean).length;
  provinces[F].fort=3;
  const zocB2=zocMapFor(B.id), zocA2=zocMapFor(A.id);
  const afterRing=ring.map(r=>!!zocB2.get(r)).filter(Boolean).length;
  // 同国外圈内部穿行：必须被挡
  let blocked=0, allowed=0;
  for(const r of ring) for(const q of ring){
    if(r===q) continue;
    if(!provinces[r].nbrs.includes(q)) continue;
    if(zocAllows(zocB2,r,q)) allowed++; else blocked++;
  }
  // 要塞/城市那一格：不能穿过去，但可以作为行军终点走进去（到了就攻城）
  let toFort=0, toFortOk=0, cityAsDest=0;
  for(const r of ring){ toFort++; if(zocAllows(zocB2,r,F)) toFortOk++; if(zocAllows(zocB2,r,F,F)) cityAsDest++; }
  // 站在外圈不会开打要塞城市：外圈那一格不是要塞城市格，围的是它自己脚下的省
  let ringSiege=0;
  for(const r of ring) if(hostileFortAt(r,B.id)===F) ringSiege++;
  // 自家军队不受自己要塞的影响
  let ownBlocked=0;
  for(const r of ring) for(const q of ring){
    if(r===q||!provinces[r].nbrs.includes(q)) continue;
    if(!zocAllows(zocA2,r,q)) ownBlocked++;
  }
  provinces[F].fort=0;
  return { A:A.id, B:B.id, F, fname:provinces[F].name, ring:ring.length,
           beforeRing, afterRing, blocked, allowed, toFort, toFortOk, cityAsDest, ringSiege, ownBlocked };
`);
if (!zoc) {
  console.log('  SKIP  没找到合适的要塞位置');
} else {
  console.log(`  要塞 ${zoc.fname}（#${zoc.F}），外圈 ${zoc.ring} 省`);
  check('没有城防时没有控制区', zoc.beforeRing === 0, zoc.beforeRing);
  check('建了城防之后外圈全部变成控制区', zoc.afterRing === zoc.ring, [zoc.afterRing, zoc.ring]);
  check('敌军在外圈内部横向穿行会被挡', zoc.blocked > 0 && zoc.allowed === 0, [zoc.blocked, zoc.allowed]);
  check('【核心】城市那一格不能穿过去（路过一律挡住）', zoc.toFortOk === 0, [zoc.toFortOk, zoc.toFort]);
  check('【核心】但可以把城市那一格当作行军终点走进去（到达城市地块才攻城）',
    zoc.cityAsDest === zoc.ring, [zoc.cityAsDest, zoc.ring]);
  check('【核心】站在外圈不会自动打邻居的城（不再"在旁边的地块就攻城"）',
    zoc.ringSiege === 0, [zoc.ringSiege, zoc.ring]);
  check('自家军队不受自己要塞控制区影响', zoc.ownBlocked === 0, zoc.ownBlocked);
}

/* ================= 5. 【核心】控制区不会让要塞变成打不到的铁乌龟 ================= */
console.log('\n-- 5. 【核心】穷举：有城防之后，军队仍然能走到城市地块（不会变成打不到的铁乌龟） --');
const reach = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>10);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>10&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  const out=[];
  const cands=A.provList.filter(pid=>provinces[pid].pix.length&&provinces[pid].nbrs.length>=3).slice(0,6);
  for(const F of cands){
    const ring=provinces[F].nbrs.filter(r=>provinces[r].pix.length);
    provinces[F].fort=0;
    const free=[];
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||i===F) continue;
      free.push(findPath(i,F,B.id)!==null);          // 无城防时能不能到这座城
    }
    provinces[F].fort=4;
    let lost=0, lostIds=[], tested=0, through=0;
    let k=0;
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||i===F) continue;
      const path=findPath(i,F,B.id);
      if(path){
        // 城市格只能出现在路径最后一格：中途出现 = 穿城而过 = bug
        for(let j=0;j<path.length-1;j++) if(path[j]===F) through++;
      }
      if(free[k++]){
        tested++;
        // 有城防之后照样要能走到城市所在地块（否则就是永远打不下来的铁乌龟）
        if(!path){ lost++; if(lostIds.length<5) lostIds.push(i); }
      }
    }
    // 外圈也应当能走到（列阵位置）
    let ringLost=0;
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||i===F) continue;
      if(ring.length&&!ring.some(r=>findPath(i,r,B.id)!==null)) ringLost++;
    }
    provinces[F].fort=0;
    out.push({ F, name:provinces[F].name, tested, lost, lostIds, through, ringLost });
  }
  return out;
`);
let totalTested = 0, totalLost = 0, totalThrough = 0, totalRingLost = 0;
for (const r of reach) {
  totalTested += r.tested; totalLost += r.lost; totalThrough += r.through; totalRingLost += r.ringLost;
  console.log(`  要塞 ${r.name}：${r.tested} 个省原本能打到，建城防后 ${r.lost} 个够不着、${r.through} 条路径穿城而过`);
}
check(`控制区没有制造任何「打不到的城市」（穷举 ${totalTested} 个省·要塞组合）`, totalLost === 0,
  reach.filter(r => r.lost).map(r => r.name + ':' + r.lostIds).slice(0, 3));
check('【核心】没有任何一条路径从城市那一格穿过去', totalThrough === 0, totalThrough);

/* ---- 控制区确实改变了路线（不是形同虚设） ---- */
const blockedPath = run(`
  // 找一条「必须贴着要塞外圈横穿」的路线：绕路会变长或直接不通
  const A=countries.find(c=>c&&c.alive&&c.provList.length>10);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>10&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  let found=null;
  for(const F of A.provList){
    const p=provinces[F]; if(!p||!p.pix.length||p.nbrs.length<3) continue;
    p.fort=0;
    const ring=p.nbrs.filter(q=>provinces[q].pix.length);
    if(ring.length<2) continue;
    // 外圈里相邻的一对
    let pair=null;
    for(const r of ring) for(const q of ring) if(r!==q&&provinces[r].nbrs.includes(q)) pair=[r,q];
    if(!pair) continue;
    p.fort=4;
    if(!zocAllows(zocMapFor(B.id),pair[0],pair[1])){ found={ F, name:p.name, a:provinces[pair[0]].name, b:provinces[pair[1]].name }; }
    p.fort=0;
    if(found) break;
  }
  return found;
`);
check('确实存在被控制区挡住的具体走法（不是形同虚设）', !!blockedPath, blockedPath);
if (blockedPath) console.log(`  例：${blockedPath.a} → ${blockedPath.b}（${blockedPath.name} 的外圈）被挡住`);

/* ================= 6. 【核心】端到端：开进城市地块才能攻城 ================= */
console.log('\n-- 6. 【核心】站在外圈不攻城；开进城市所在地块才开打，直到攻克 --');
const e2e = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>10);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>10&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  let F=0;
  for(const pid of A.provList){
    const p=provinces[pid]; if(!p||!p.pix.length||p.nbrs.length<3) continue;
    if(p.nbrs.every(q=>provinces[q].owner!==B.id)){ F=pid; break; }
  }
  if(!F) return null;
  const p=provinces[F];
  p.fort=3;
  // 外圈要挑一块真正属于 A、由 A 控制的邻省（荒地/第三方不算，围它不会掉）
  const ring=p.nbrs.filter(r=>provinces[r].pix.length&&provinces[r].controller===A.id);
  armies=armies.filter(a=>a.owner!==B.id);
  // ① 先站在外圈：绝不能碰到城市本身
  const ringProv=ring[0];
  armies.push({id:91001,owner:B.id,prov:ringProv,str:20000,path:[],prog:0});
  const ctrlBefore=p.controller;
  const ringP=provinces[ringProv];
  let d1=0;
  while(d1<300&&ringP.controller!==B.id){ resolveSieges(); d1++; }
  const fortHeldFromRing=p.controller;          // 站在外圈期间，要塞城市必须还在 A 手里
  const ringTaken=ringP.controller===B.id;      // 外圈那一格会被正常占领（这是普通围城）
  // ② 再开进城市地块：这一次才能真正开始攻城
  armies=armies.filter(a=>a.id!==91001);
  armies.push({id:91002,owner:B.id,prov:F,str:20000,path:[],prog:0});
  const pathToCity=findPath(ringProv,F,B.id);   // 从外圈能走进城市格
  let days=0, captured=false;
  while(days<2000&&!captured){
    resolveSieges(); days++;
    if(p.controller===B.id) captured=true;
  }
  const res={ F, ring:ring.length, ringProv, ctrlBefore, fortHeldFromRing, ringTaken, ringDays:d1,
              sameOwner:fortHeldFromRing===ctrlBefore, canEnter:!!pathToCity,
              pathEndsAtCity:!!pathToCity&&pathToCity[pathToCity.length-1]===F,
              after:p.controller, days, captured };
  armies=armies.filter(a=>a.id!==91001&&a.id!==91002);
  ringP.controller=ringP.owner; ringP.siege=0;
  p.fort=0; p.controller=p.owner; p.siege=0;
  return res;
`);
if (!e2e) {
  console.log('  SKIP  没找到合适的位置');
} else {
  console.log(`  要塞 #${e2e.F}（Lv3）：外圈 #${e2e.ringProv} 站 300 天不碰城市；开进城市后 ${e2e.days} 天攻破`);
  check('【核心】站在外圈不会把城市打下来（外圈只围它自己脚下那一省）',
    e2e.ringTaken === true && e2e.sameOwner === true, e2e);
  check('【核心】从外圈可以走进城市所在地块（有路，且终点就是城市）',
    e2e.canEnter === true && e2e.pathEndsAtCity === true, e2e);
  check('【核心】开进城市地块之后才真的把城市打下来', e2e.captured === true && e2e.after !== e2e.ctrlBefore, e2e);
  check(`围城耗时 ${e2e.days} 天，落在「最短 60 天」的合理范围内`,
    e2e.days >= 60 && e2e.days < 400, e2e.days);
}

/* ================= 8. 【核心】打下了一座要塞，不等于周围就通了 ================= */
console.log('\n-- 8. 【核心】打下 F1 之后，旁边 F2 的控制区必须照旧生效 --');
const multi = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>12);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>12&&!atWar(A.id,c.id));
  if(!A||!B) return null;
  declareWar(B.id,A.id);
  let F1=0,F2=0;
  for(const pid of A.provList){
    const p=provinces[pid];
    if(!p||!p.pix.length||p.nbrs.length<3) continue;
    if(!p.nbrs.every(q=>provinces[q].owner===A.id)) continue;
    for(const q of p.nbrs){
      const pq=provinces[q];
      if(pq&&pq.pix.length&&pq.nbrs.length>=3&&pq.nbrs.every(r=>provinces[r].owner===A.id)){ F1=pid; F2=q; break; }
    }
    if(F1) break;
  }
  if(!F1||!F2) return null;
  provinces[F1].fort=3; provinces[F2].fort=3;
  const zocB1=zocMapFor(B.id);
  const inZ1=new Set([F1]), inZ2=new Set([F2]);
  for(const r of provinces[F1].nbrs) inZ1.add(r);
  for(const r of provinces[F2].nbrs) inZ2.add(r);
  const overlap=[...inZ1].filter(x=>inZ2.has(x));

  // 城市格（要塞本格）不参与"外圈互穿"的统计：站在城里随时可以撤出来
  const isCityTile=(m,pid)=>!!(m.get(pid)&&m.get(pid).indexOf(pid)>=0);
  const blockedBefore=(()=>{
    let bad=0, tot=0;
    for(const x of inZ2) for(const y of provinces[x].nbrs){
      if(!inZ2.has(y)||x===y||y===F2||isCityTile(zocB1,x)) continue;
      tot++; if(zocAllows(zocB1,x,y)) bad++;
    }
    return { bad, tot };
  })();

  // 模拟「打下 F1」：控制者换成 B
  const savedC=provinces[F1].controller;
  provinces[F1].controller=B.id;
  const zocB2=zocMapFor(B.id);

  const blockedAfter=(()=>{
    let bad=0, tot=0, sample=null;
    for(const x of inZ2) for(const y of provinces[x].nbrs){
      if(!inZ2.has(y)||x===y||y===F2||isCityTile(zocB2,x)) continue;
      tot++; if(zocAllows(zocB2,x,y)){ bad++; if(!sample) sample=[x,y]; }
    }
    return { bad, tot, sample };
  })();
  // 城市格：不能作为路过点，但可以走进去打、也可以从里面退出来
  let cityTransit=0, cityIn=0, cityOut=0;
  for(const x of provinces[F2].nbrs){
    if(zocAllows(zocB2,x,F2)) cityTransit++;        // 从外圈"路过"城市格 = 不该发生
    if(zocAllows(zocB2,x,F2,F2)) cityIn++;          // 终点就是城市格 = 攻城接近，允许
    if(zocAllows(zocB2,F2,x)) cityOut++;            // 从城市格撤出来，允许
  }
  const overlapStill=(()=>{
    let blocked=0, pairs=0;
    for(const x of overlap) for(const y of provinces[x].nbrs){
      if(!overlap.includes(y)||x===y) continue;
      pairs++; if(!zocAllows(zocB2,x,y)) blocked++;
    }
    return { blocked, pairs, has:overlap.length };
  })();
  let enterF2=0, destF2=0;
  for(const x of provinces[F2].nbrs){ if(zocAllows(zocB2,x,F2)) enterF2++; if(zocAllows(zocB2,x,F2,F2)) destF2++; }

  provinces[F1].controller=savedC;
  provinces[F1].fort=0; provinces[F2].fort=0;
  return { F1, F2, overlaps:overlap.length,
           before:blockedBefore, after:blockedAfter, overlapStill, enterF2, destF2,
           cityTransit, cityIn, cityOut };
`);
if (!multi) {
  console.log('  SKIP  没找到相邻的两座要塞位置');
} else {
  console.log(`  要塞 F1=#${multi.F1}、F2=#${multi.F2}，两座控制区重叠 ${multi.overlaps} 个省`);
  check('打下之前：F2 的控制区内部不能互穿', multi.before.bad === 0, multi.before);
  check('【核心】打下 F1 之后，F2 的控制区照旧不能互穿（不是打一个就全通）',
    multi.after.bad === 0, multi.after);
  check('两座要塞重叠的省，打掉一座之后仍归另一座管',
    multi.overlapStill.pairs === 0 || multi.overlapStill.blocked > 0, multi.overlapStill);
  check('打下 F1 之后依然不能穿过 F2（路过一律挡住）', multi.enterF2 === 0, multi.enterF2);
  check('但 F2 仍然可以打：从外圈能走进它的城市格', multi.destF2 > 0, multi.destF2);
  check('城市格不能被当成路过点，但可以走进去打、也可以退出来',
    multi.cityTransit === 0 && multi.cityIn > 0 && multi.cityOut > 0, multi);
}

/* ================= 7. 兵营：维护费减半 ================= */
console.log('\n-- 7. 兵营减维护费 --');
const up = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id);
  const pid=A.provList.find(x=>provinces[x].pix.length);
  const p=provinces[pid];
  p.barracks=0;
  armies=armies.filter(a=>a.owner!==A.id);
  armies.push({id:90001,owner:A.id,prov:pid,str:10000,path:[],prog:0});
  A.gold=100000;
  economy(A); const before=A.income;
  p.barracks=1;
  economy(A); const after=A.income;
  // 兵营所在省被别人占着 -> 不生效。注意占领会同时影响税收，所以要跟「同样被占、但没兵营」比
  const oldC=p.controller;
  p.controller=B.id; p.barracks=0; economy(A); const occNoBarracks=A.income;
  p.controller=B.id; p.barracks=1; economy(A); const occWithBarracks=A.income;
  p.controller=oldC;
  p.barracks=0;
  armies=armies.filter(a=>a.id!==90001);
  return { before, after, occNoBarracks, occWithBarracks, pid, name:p.name };
`);
console.log(`  ${up.name}：无兵营收支 ${up.before.toFixed(3)}，有兵营 ${up.after.toFixed(3)}（差 ${(up.after - up.before).toFixed(3)}）`);
check('兵营让驻扎军队维护费减半', Math.abs((up.after - up.before) - 10000 / 1000 * 0.15 * 0.5) < 1e-6,
  [up.before, up.after]);
check('兵营被敌人占领时不生效', Math.abs(up.occWithBarracks - up.occNoBarracks) < 1e-9,
  [up.occWithBarracks, up.occNoBarracks]);

/* ================= 7. 存档 / 剧本往返 ================= */
console.log('\n-- 7. 存档与剧本往返 --');
const rt = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>8);
  const pid=A.provList.find(x=>provinces[x].pix.length);
  const p=provinces[pid];
  p.fort=3; p.barracks=1;
  const snap=makeSaveData();
  p.fort=0; p.barracks=0;
  applySaveData(JSON.parse(JSON.stringify(snap)));
  const after={ fort:provinces[pid].fort, barracks:provinces[pid].barracks };
  // 剧本往返
  const sc=makeScenario({name:'建筑测试'});
  p.fort=0; p.barracks=0;
  buildWorldFromScenario(sc);
  const fromScen={ fort:provinces[pid].fort, barracks:provinces[pid].barracks };
  return { pid, after, fromScen };
`);
check('存档保留城防与兵营', rt.after.fort === 3 && rt.after.barracks === 1, rt.after);
check('剧本保留城防与兵营', rt.fromScen.fort === 3 && rt.fromScen.barracks === 1, rt.fromScen);

/* ================= 9. 【核心】控制区是墙，不是减速带 ================= */
console.log('\n-- 9. 【核心】寻路结果不许「路过」控制区；只有去攻城时才能走进那一圈 --');
const wall = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>12);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>12&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  // 给 A 的一批内陆省塞满城防，控制区尽量连成片
  let forts=0;
  for(const pid of A.provList){
    const p=provinces[pid];
    if(!p||!p.pix.length||p.nbrs.length<3) continue;
    if(!p.nbrs.every(q=>provinces[q].pix.length)) continue;
    p.fort=4; if(++forts>=8) break;
  }
  const zoc=zocMapFor(B.id);
  const covered=pid=>!!zoc.get(pid);
  const isFort=pid=>{ const p=provinces[pid]; return !!(p&&p.fort&&p.controller&&p.controller!==B.id&&atWar(B.id,p.controller)); };
  let checked=0, transit=0, throughCity=0, sample=null;
  // 随机取 (起点,终点) 对，检查返回的路径
  let seed=12345;
  const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  const list=[];
  for(let i=1;i<provinces.length;i++) if(provinces[i].pix.length) list.push(i);
  for(let t=0;t<600;t++){
    const from=list[(rnd()*list.length)|0], to=list[(rnd()*list.length)|0];
    const path=findPath(from,to,B.id);
    if(!path) continue;
    checked++;
    const toIsCity=isFort(to);
    for(let k=0;k<path.length;k++){
      const last=(k===path.length-1);
      // 城市格只能出现在路径最后一格：中途出现 = 穿城而过
      if(isFort(path[k])&&!last){ throughCity++; if(!sample) sample=[from,to,path.slice()]; }
      if(!covered(path[k])||last) continue;
      /* 中途可以出现在控制区里的唯一情形：终点就是这座要塞的城市格（为了打它而接近那一圈）。
         其余任何中途踩进控制区 = 穿墙。 */
      if(!(toIsCity&&zoc.get(path[k]).indexOf(to)>=0)){ transit++; if(!sample) sample=[from,to,path.slice()]; }
    }
  }
  const res={ forts, checked, transit, throughCity, sample };
  for(const pid of A.provList) if(provinces[pid]) provinces[pid].fort=0;
  return res;
`);
console.log(`  ${wall.forts} 座要塞的控制区，抽查 ${wall.checked} 条可达路径`);
check('【核心】没有任何一条路径中途穿过控制区（打下要塞≠旁边就通）', wall.transit === 0, wall.sample);
check('【核心】没有任何一条路径从城市那一格穿过去', wall.throughCity === 0, wall.sample);

/* ================= 10. 【核心】行军每一步都复核控制区 ================= */
console.log('\n-- 10. 【核心】路径是城防修好之前算好的，也必须停在墙外 --');
const march = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>12);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>8&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  // 找一座要塞 F：从 B 的地盘能走到 F 另一侧的省（中间必须经过 F 或它的外圈）
  let F=0, start=0, dst=0;
  for(const pid of A.provList){
    const p=provinces[pid];
    if(!p||!p.pix.length||p.nbrs.length<3) continue;
    const ring=p.nbrs.filter(r=>provinces[r].pix.length);
    if(ring.length<2) continue;
    p.fort=0;
    for(const r of ring){
      const behind=provinces[r].nbrs.find(q=>q!==pid&&provinces[q].pix.length&&!ring.includes(q));
      if(!behind) continue;
      for(let s=1;s<provinces.length;s++){
        const sp=provinces[s];
        if(!sp.pix.length||s===pid||ring.includes(s)||s===behind) continue;
        if(sp.controller===B.id||sp.owner===B.id) continue;
        const via=findPath(s,behind,B.id);
        if(via&&via.includes(pid)){ start=s; dst=behind; F=pid; break; }
      }
      if(F) break;
    }
    if(F) break;
  }
  if(!F) return null;
  const p=provinces[F];
  // ① 没城防时先算好一条「穿过要塞那一格」的旧路径
  const stale=findPath(start,dst,B.id);
  if(!stale||!stale.includes(F)) return null;
  // ② 城防落成（路径已经握在手里了 —— 模拟 AI 的路径 / 你在敌人修城防之前下的令）
  p.fort=4;
  armies=armies.filter(a=>a.owner!==B.id);
  const a={id:92001,owner:B.id,prov:start,str:20000,path:stale.slice(),prog:0};
  armies.push(a);
  let halted=0, haltedAt=0, sieged=false, captured=false, capDay=0, reachedDay=0, everEnteredCityBeforeFall=0;
  for(let d=0;d<220;d++){
    const before=a.prov;
    tickDay();
    if(a.prov!==before){
      // 军队实际迈出的每一步，都必须过得了当时的控制区（终点按当时的路径末点算）
      const ok=zocAllows(zocMapFor(a.owner),before,a.prov,a.path.length?a.path[a.path.length-1]:a.prov);
      if(!ok) everEnteredCityBeforeFall++;
    }
    if(p.siege>0) sieged=true;
    if(p.controller===B.id&&!captured){ captured=true; capDay=d+1; }
    if(halted===0&&a.path.length===0){ halted=d+1; haltedAt=a.prov; }
    if(a.prov===dst&&!reachedDay) reachedDay=d+1;
  }
  const res={ F, name:p.name, start, dst, halted, haltedAt,
              reached:!!reachedDay, reachedDay, illegal:everEnteredCityBeforeFall,
              final:a.prov, sieged, captured, capDay, siege:provinces[F].siege,
              fortController:p.controller===B.id };
  armies=armies.filter(x=>x.id!==92001);
  p.fort=0; p.controller=p.owner; p.siege=0;
  return res;
`);
if (!march) {
  console.log('  SKIP  没找到合适的「必须穿墙」的位置');
} else {
  console.log(`  要塞 ${march.name}：军队带着旧路径出发，第 ${march.halted} 天停在 #${march.haltedAt}` +
    (march.captured ? `，第 ${march.capDay} 天攻破` : ''));
  check('【核心】旧路径不能穿墙：攻下要塞之前军队没到过墙对面', !march.reachedDay || march.reachedDay > march.capDay, march);
  check('【核心】行军途中没有任何一步违反控制区规则', march.illegal === 0, march);
  check('【核心】撞墙后改去打挡路的那座要塞，并最终攻破（打不下才是死局）',
    march.sieged === true && march.captured === true, march);
}

/* ================= 11. 城池图标锚点必须落在自己的省内 ================= */
console.log('\n-- 11. 城池图标锚点（城市画在谁的领土上） --');
const anchor = run(`
  // 复刻 client.js 里 ensureTownTable 的锚点算法：取离本省质心最近的本省像素
  let ok=0, bad=0, badSample=null, noAnchor=0, farSample=null, maxD=0;
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(!p||!p.pix||!p.pix.length) continue;
    let best=-1, bd=Infinity;
    for(const px of p.pix){
      const r=(px/COLS)|0, c=px%COLS;
      const dx=c+0.5-p.cx, dy=r+0.5-p.cy, d=dx*dx+dy*dy;
      if(d<bd){ bd=d; best=px; }
    }
    if(best<0){ noAnchor++; continue; }
    // ① 锚点必须属于本省（否则城池会画到隔壁省头上 —— 就是「占错城」）
    if(provOf[best]===p.id) ok++; else { bad++; if(!badSample) badSample=[p.id,provOf[best],p.name]; }
    // ② 锚点离质心不该太远（太远说明画到了飞地/小岛上）
    const d=Math.sqrt(bd);
    if(d>maxD) maxD=d;
    if(d>12&&!farSample) farSample=[p.id,p.name,+d.toFixed(1)];
  }
  return { ok, bad, badSample, noAnchor, maxD:+maxD.toFixed(1), farSample, total:ok+bad };
`);
console.log(`  抽查 ${anchor.total} 个省：锚点落在本省 ${anchor.ok} 个，越界 ${anchor.bad} 个，最远距质心 ${anchor.maxD} 像素`);
check('【核心】每个省的城池图标锚点都落在本省领土内（不会画到隔壁省）', anchor.bad === 0, anchor.badSample);
check('每个有领土的省都有城池锚点', anchor.noAnchor === 0, anchor.noAnchor);

/* ================= 12. 只打脚下那一座城：站在外圈绝不开打 ================= */
console.log('\n-- 12. 【核心】站在外圈不开打；走到城市地块才开打，且只打这一座 --');
const pick = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>12);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>8&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  let X=0,F1=0,F2=0;
  for(const pid of A.provList){
    const p=provinces[pid];
    if(!p||!p.pix.length||p.nbrs.length<3) continue;
    const fs=p.nbrs.filter(q=>provinces[q].pix.length&&provinces[q].controller===A.id&&provinces[q].nbrs.length>=2);
    if(fs.length>=2){ X=pid; F1=fs[0]; F2=fs[1]; break; }
  }
  if(!X) return null;
  provinces[F1].fort=5; provinces[F2].fort=1;
  armies=armies.filter(a=>a.owner!==B.id);
  const f1c=provinces[F1].controller, f2c=provinces[F2].controller;
  // ① 站在夹缝那一格（它同时挨着两座要塞）：两座城都不该掉
  armies.push({id:93001,owner:B.id,prov:X,str:60000,path:[],prog:0});
  for(let d=0;d<400;d++) resolveSieges();
  const Xc=provinces[X].controller;
  const heldF1=provinces[F1].controller===f1c, heldF2=provinces[F2].controller===f2c;
  // ② 走进 F1 的城市格：只有 F1 会掉
  armies=armies.filter(a=>a.id!==93001);
  provinces[X].controller=provinces[X].owner; provinces[X].siege=0;
  armies.push({id:93002,owner:B.id,prov:F1,str:60000,path:[],prog:0});
  let d1=0; while(d1<2000&&provinces[F1].controller===f1c){ resolveSieges(); d1++; }
  const tookF1=provinces[F1].controller===B.id, heldF2b=provinces[F2].controller===f2c;
  const canEnterF1=!!findPath(X,F1,B.id);
  const res={ X, F1, F2, Xtaken:Xc===B.id, heldF1, heldF2, tookF1, heldF2b, d1, canEnterF1 };
  armies=armies.filter(a=>a.id!==93001&&a.id!==93002);
  provinces[F1].fort=0; provinces[F2].fort=0;
  provinces[F1].controller=f1c; provinces[F2].controller=f2c; provinces[F1].siege=0;
  return res;
`);
if (!pick) {
  console.log('  SKIP  没找到夹在两座要塞中间的省');
} else {
  console.log(`  省 #${pick.X} 同时挨着 #${pick.F1}(Lv5) 与 #${pick.F2}(Lv1)`);
  check('【核心】站在外圈（同时挨着两座城）不会自动开打任何一座城',
    pick.heldF1 === true && pick.heldF2 === true, pick);
  check('脚下那一格照旧会被正常占领（那不是攻城，是普通围城）', pick.Xtaken === true, pick);
  check('【核心】走进 F1 的城市格之后只有 F1 被打下来，隔壁 F2 毫发无损',
    pick.tookF1 === true && pick.heldF2b === true, pick);
  check('从外圈能走进城市格（有路可走）', pick.canEnterF1 === true, pick);
}

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
