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
  // 要塞本身永远可进
  let toFort=0, toFortOk=0;
  for(const r of ring){ toFort++; if(zocAllows(zocB2,r,F)) toFortOk++; }
  // 自家军队不受自己要塞的影响
  let ownBlocked=0;
  for(const r of ring) for(const q of ring){
    if(r===q||!provinces[r].nbrs.includes(q)) continue;
    if(!zocAllows(zocA2,r,q)) ownBlocked++;
  }
  provinces[F].fort=0;
  return { A:A.id, B:B.id, F, fname:provinces[F].name, ring:ring.length,
           beforeRing, afterRing, blocked, allowed, toFort, toFortOk, ownBlocked };
`);
if (!zoc) {
  console.log('  SKIP  没找到合适的要塞位置');
} else {
  console.log(`  要塞 ${zoc.fname}（#${zoc.F}），外圈 ${zoc.ring} 省`);
  check('没有城防时没有控制区', zoc.beforeRing === 0, zoc.beforeRing);
  check('建了城防之后外圈全部变成控制区', zoc.afterRing === zoc.ring, [zoc.afterRing, zoc.ring]);
  check('敌军在外圈内部横向穿行会被挡', zoc.blocked > 0 && zoc.allowed === 0, [zoc.blocked, zoc.allowed]);
  check('要塞本身永远是攻城入口（外圈每一格都能直接攻打）',
    zoc.toFort === zoc.ring && zoc.toFortOk === zoc.ring, [zoc.toFortOk, zoc.toFort]);
  check('自家军队不受自己要塞控制区影响', zoc.ownBlocked === 0, zoc.ownBlocked);
}

/* ================= 5. 【核心】控制区不会把自己变成打不到的铁乌龟 ================= */
console.log('\n-- 5. 【核心】穷举：任何能在无城防时走到要塞的省，有城防时也一定走得到 --');
const reach = run(`
  const A=countries.find(c=>c&&c.alive&&c.provList.length>10);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id&&c.provList.length>10&&!atWar(A.id,c.id));
  declareWar(B.id,A.id);
  const out=[];
  // 挑 6 个 A 的省当要塞，逐个穷举
  const cands=A.provList.filter(pid=>provinces[pid].pix.length&&provinces[pid].nbrs.length>=3).slice(0,6);
  for(const F of cands){
    provinces[F].fort=0;
    const free=[];
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||i===F) continue;
      free.push(findPath(i,F,B.id)!==null);          // 无城防时能不能到
    }
    provinces[F].fort=4;
    let lost=0, lostIds=[], tested=0;
    let k=0;
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p||!p.pix.length||i===F) continue;
      if(free[k++]){
        tested++;
        if(findPath(i,F,B.id)===null){ lost++; if(lostIds.length<5) lostIds.push(i); }
      }
    }
    provinces[F].fort=0;
    out.push({ F, name:provinces[F].name, tested, lost, lostIds });
  }
  return out;
`);
let totalTested = 0, totalLost = 0;
for (const r of reach) {
  totalTested += r.tested; totalLost += r.lost;
  console.log(`  要塞 ${r.name}：${r.tested} 个省原本能打到，建城防后 ${r.lost} 个打不到`);
}
check(`控制区没有制造任何「打不到的要塞」（穷举 ${totalTested} 个省·要塞组合）`, totalLost === 0,
  reach.filter(r => r.lost).map(r => r.name + ':' + r.lostIds).slice(0, 3));

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

/* ================= 6. 兵营：维护费减半 ================= */
console.log('\n-- 6. 兵营减维护费 --');
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

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===\n`);
process.exit(failures ? 1 : 0);
