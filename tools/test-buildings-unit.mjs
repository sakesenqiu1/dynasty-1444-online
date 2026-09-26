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

console.log('\n=== 城市建筑 / 城防控制区 ===\n');
run('resetWorld(); setSeed(SCENARIO_SEED); buildWorld();');

/* ================= 1. 建造校验 ================= */
console.log('-- 1. 建造校验 --');
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
  out.barracks=p.barracks;
  out.errDup=buildBuilding(A.id,pid,'barracks');          // 重复建
  out.fortBefore=p.fort;
  out.ok2=buildBuilding(A.id,pid,'fort');
  out.fortAfter=p.fort;
  A.gold=0;
  out.errPoor=buildBuilding(A.id,pid,'fort');             // 没钱
  // 升到满级
  A.gold=100000;
  let ups=0;
  while(p.fort<FORT_MAX&&!buildBuilding(A.id,pid,'fort')) ups++;
  out.ups=ups; out.fortMax=p.fort;
  out.errMax=buildBuilding(A.id,pid,'fort');
  // 被别人占领时不能建
  p.controller=B.id;
  out.errOcc=buildBuilding(A.id,pid,'fort');
  p.controller=A.id;
  return out;
`);
check('只能在自己的领土上建造', /只能在自己/.test(b1.errOwn || ''), b1.errOwn);
check('未知建筑被拒绝', /未知的建筑/.test(b1.errKind || ''), b1.errKind);
check('兵营建造成功并扣钱', b1.ok1 === null && b1.barracks === 1 && b1.goldBefore - b1.goldAfter === 150,
  [b1.ok1, b1.barracks, b1.goldBefore - b1.goldAfter]);
check('兵营不能重复建', /已有兵营/.test(b1.errDup || ''), b1.errDup);
check('城防从 0 升到 1 级', b1.ok2 === null && b1.fortBefore === 0 && b1.fortAfter === 1, [b1.fortBefore, b1.fortAfter]);
check('金币不足会被拒绝', /金币不足/.test(b1.errPoor || ''), b1.errPoor);
check(`城防能升到满级 Lv.${b1.fortMax}`, b1.fortMax === 5, [b1.ups, b1.fortMax]);
check('满级后拒绝再升', /最高等级/.test(b1.errMax || ''), b1.errMax);
check('本省不在自己控制下不能建造', /不在你控制/.test(b1.errOcc || ''), b1.errOcc);

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

/* ================= 3. 攻城结算：兵力 / 城防 / 运气 ================= */
console.log('\n-- 3. 攻城结算 --');
const sg = run(`
  const p={fort:0};
  const avg=(bstr,fort,n)=>{ p.fort=fort; let s=0; for(let i=0;i<n;i++) s+=siegeDailyProgress(bstr,p); return s/n; };
  const weak=avg(3000,0,4000), mid=avg(3000,1,4000), strong=avg(3000,3,4000), max5=avg(3000,5,4000);
  const big=avg(30000,3,4000), tiny=avg(300,3,4000);
  // 运气：同样条件下多摇几次，应当有波动且落在 ±45% 内
  p.fort=0;
  let lo=1e9, hi=-1e9;
  for(let i=0;i<4000;i++){ const v=siegeDailyProgress(3000,p); if(v<lo)lo=v; if(v>hi)hi=v; }
  const base=3000/SIEGE_DIV;
  return { weak,mid,strong,max5,big,tiny, lo:lo/base, hi:hi/base, base };
`);
console.log(`  每日进度（3000 兵）：无城防 ${sg.weak.toFixed(3)} → Lv1 ${sg.mid.toFixed(3)} → Lv3 ${sg.strong.toFixed(3)} → Lv5 ${sg.max5.toFixed(3)}`);
console.log(`  运气幅度：${sg.lo.toFixed(3)} ~ ${sg.hi.toFixed(3)}（基准 ${sg.base.toFixed(3)}）`);
check('没有城防时和以前一样（进度 = 兵力/3000）', Math.abs(sg.weak - sg.base) < sg.base * 0.08, [sg.weak, sg.base]);
check('城防越高围得越慢', sg.mid < sg.weak && sg.strong < sg.mid && sg.max5 < sg.strong,
  [sg.weak, sg.mid, sg.strong, sg.max5]);
check('攻方兵力越多围得越快', sg.big > sg.strong, [sg.big, sg.strong]);
check('兵力远小于驻军时几乎围不动（但有下限，不是永远为 0）', sg.tiny > 0 && sg.tiny < sg.strong * 0.35, [sg.tiny, sg.strong]);
check('运气在 ±45% 以内波动', sg.lo > 0.54 && sg.hi < 1.46 && sg.hi - sg.lo > 0.5, [sg.lo, sg.hi]);

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
