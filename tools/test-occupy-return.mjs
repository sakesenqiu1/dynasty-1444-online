// 占领归还回归测试
// 原 bug：makePeace 只在"owner 与 controller 分属战争两侧"时归还占领，
// 漏掉了同阵营的情形 —— 敌人占了附庸的省、宗主再打回来，owner 与 controller
// 同属一方，于是永远不还，表现为"宗主国一直占着附庸的领土"。
// 盟友互相收复、附庸替宗主收复、放附庸独立后残留的占领都是同一个洞。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };

const noop = () => {};
function ctx2d() {
  return {
    canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', imageSmoothingEnabled: true,
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop,
    fillRect: noop, clearRect: noop, strokeRect: noop, putImageData: noop, drawImage: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, stroke: noop, fill: noop,
    setLineDash: noop, strokeText: noop, fillText: noop,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
}
function mk(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(), id: '', width: 1280, height: 800, style: {}, dataset: {},
    value: '', textContent: '', children: [], _h: '', checked: false, disabled: false,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h; }, set(v) { e._h = v; } });
  return e;
}
const els = {};
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, requestAnimationFrame: noop,
  document: {
    addEventListener: noop, getElementById: (i) => els[i] || (els[i] = mk('div')), createElement: (t) => mk(t),
    querySelector: () => null, querySelectorAll: () => [], body: { appendChild: noop }, hidden: false,
  },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false,
  promptReply: '测试国',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.prompt = () => sb.promptReply;
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 占领归还（幽灵占领）验证 ===\n');

/* ================= 1. 宗主收复附庸的省 ================= */
console.log('-- 1. 敌人占附庸的省 → 宗主打回来 → 议和后必须还给附庸 --');
const t1 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==vid&&!c.overlord&&c.provList.length>1);
  const vprov=countries[vid].provList[0];
  const ownerName=countries[vid].name;

  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  // 敌人占领附庸的省
  provinces[vprov].controller=foe.id;
  const step1={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  // 宗主打回来（同阵营"解放"）
  provinces[vprov].controller=140;
  const step2={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  const atWarBefore=atWar(140,vid);

  makePeace(w,[],true);
  const step3={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  return { vid, foeId:foe.id, vprov, ownerName, step1, step2, step3, atWarBefore };
`);
check('敌人先占住了附庸的省', t1.step1.owner === t1.vid && t1.step1.controller === t1.foeId, t1.step1);
check('宗主把该省打回来（controller=宗主）', t1.step2.controller === 140, t1.step2);
check('宗主与附庸同阵营 → 不算交战', t1.atWarBefore === false, t1);
check('【修复】议和后该省归还附庸', t1.step3.controller === t1.vid, t1.step3);
check('所有者始终是附庸', t1.step3.owner === t1.vid, t1.step3);

/* ================= 1b. 反证：把旧逻辑装回去，测试必须失败 ================= */
console.log('\n-- 1b. 反证：旧逻辑（只认"分属两侧"）在同一场景下会漏掉 --');
const t1b = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==vid&&!c.overlord&&c.provList.length>1);
  const vprov=countries[vid].provList[0];
  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  provinces[vprov].controller=140;   // 宗主"解放"了附庸的省

  // 把释放函数换成旧实现：只有 owner/controller 分属本战争两侧才归还
  const real=releaseStaleOccupations;
  releaseStaleOccupations=function(){
    const aCamp=campOf(w.a), dCamp=campOf(w.d);
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(p.pix.length&&p.controller!==p.owner){
        const ownA=aCamp.has(p.owner), ctlA=aCamp.has(p.controller);
        const ownD=dCamp.has(p.owner), ctlD=dCamp.has(p.controller);
        if((ownA&&ctlD)||(ownD&&ctlA)){ p.controller=p.owner; p.siege=0; }
      }
    }
    return 0;
  };
  makePeace(w,[],true);
  const withOldBug={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  releaseStaleOccupations=real;   // 恢复真实现
  return { vprov, vid, withOldBug };
`);
check('【反证成立】旧逻辑下该省确实没有归还（controller 仍是我朝 140）',
  t1b.withOldBug.controller === 140 && t1b.withOldBug.owner === t1b.vid, t1b.withOldBug);
check('说明第 1 组的断言确实在检验本次修复，而不是空过',
  t1b.withOldBug.controller !== t1b.vid, t1b.withOldBug);

/* ================= 2. 附庸替宗主收复 ================= */
console.log('\n-- 2. 附庸替宗主收复失地 → 议和后也要还给宗主 --');
const t2 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==vid&&!c.overlord&&c.provList.length>1);
  const mprov=countries[140].provList.find(i=>provinces[i].pix.length);
  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  provinces[mprov].controller=foe.id;
  // 附庸的军队收复了宗主的省
  provinces[mprov].controller=vid;
  const mid={ owner:provinces[mprov].owner, controller:provinces[mprov].controller };
  makePeace(w,[],true);
  const after={ owner:provinces[mprov].owner, controller:provinces[mprov].controller };
  return { mprov, vid, mid, after };
`);
check('附庸暂时控制着宗主的省', t2.mid.owner === 140 && t2.mid.controller === t2.vid, t2.mid);
check('【修复】议和后该省归还宗主', t2.after.controller === 140, t2.after);

/* ================= 3. 盟友互相收复 ================= */
console.log('\n-- 3. 盟友互相收复 → 议和后归还 --');
const t3 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const ally=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>2);
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==ally.id&&!c.overlord&&c.provList.length>1);
  formAlliance(140,ally.id);
  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  const aprov=ally.provList.find(i=>provinces[i].pix.length);
  provinces[aprov].controller=foe.id;      // 敌人占了盟友的省
  provinces[aprov].controller=140;         // 我朝替盟友收复
  const mid={ owner:provinces[aprov].owner, controller:provinces[aprov].controller };
  makePeace(w,[],true);
  const after={ owner:provinces[aprov].owner, controller:provinces[aprov].controller };
  return { aprov, allyId:ally.id, mid, after, allied:isAllied(140,ally.id) };
`);
check('盟友关系成立', t3.allied === true, t3);
check('我朝暂时控制着盟友的省', t3.mid.owner === t3.allyId && t3.mid.controller === 140, t3.mid);
check('【修复】议和后该省归还盟友', t3.after.controller === t3.allyId, t3.after);

/* ================= 4. 敌方占领仍按和约处置 ================= */
console.log('\n-- 4. 敌方占领：割地才易主，没割的要还 --');
const t4 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>4);
  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  const foeProvs=foe.provList.filter(i=>provinces[i].pix.length);
  const ceded=foeProvs[0], kept=foeProvs[1];
  // 我朝占领了两省
  provinces[ceded].controller=140;
  provinces[kept].controller=140;
  makePeace(w,[{pid:ceded,to:140}],true);
  return { ceded, kept, foeId:foe.id,
           cededAfter:{owner:provinces[ceded].owner,controller:provinces[ceded].controller},
           keptAfter:{owner:provinces[kept].owner,controller:provinces[kept].controller} };
`);
check('割让的省归我朝', t4.cededAfter.owner === 140 && t4.cededAfter.controller === 140, t4.cededAfter);
check('没割的省还给原主', t4.keptAfter.owner === t4.foeId && t4.keptAfter.controller === t4.foeId, t4.keptAfter);

/* ================= 5. 第三方的占领不能被误清 ================= */
console.log('\n-- 5. 第三方在别的战争里的占领必须保留 --');
const t5 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const foe1=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>3);
  const foe2=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==foe1.id&&!c.overlord&&c.provList.length>3);
  const myProv=countries[140].provList.find(i=>provinces[i].pix.length);
  declareWar(140,foe1.id);
  declareWar(140,foe2.id);
  provinces[myProv].controller=foe2.id;    // foe2 占了我的省（另一场战争）
  const w1=wars.find(x=>(x.a===140&&x.d===foe1.id)||(x.d===140&&x.a===foe1.id));
  const w2=wars.find(x=>(x.a===140&&x.d===foe2.id)||(x.d===140&&x.a===foe2.id));
  const stillAtWar=atWar(foe2.id,140);
  makePeace(w1,[],true);                    // 只跟 foe1 议和
  const after={ owner:provinces[myProv].owner, controller:provinces[myProv].controller };
  const w2Alive=wars.includes(w2);
  makePeace(w2,[],true);                    // 再跟 foe2 议和
  const final={ owner:provinces[myProv].owner, controller:provinces[myProv].controller };
  return { myProv, foe2Id:foe2.id, stillAtWar, after, final, w2Alive };
`);
check('与 foe2 仍在交战', t5.stillAtWar === true, t5);
check('【关键】只跟 foe1 议和时，foe2 的占领保留', t5.after.controller === t5.foe2Id, t5.after);
check('与 foe2 的战争仍在', t5.w2Alive === true, t5);
check('跟 foe2 议和后占领才归还', t5.final.controller === 140, t5.final);

/* ================= 6. 月度兜底清扫 ================= */
console.log('\n-- 6. 月度兜底：绕开和谈的宗主关系变动也不会留下幽灵占领 --');
const t6 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const vprov=countries[vid].provList[0];
  // 直接制造一个"宗主占着附庸的省，且双方并无战争"的幽灵占领
  provinces[vprov].controller=140;
  const before={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  const n=releaseStaleOccupations();
  const after={ owner:provinces[vprov].owner, controller:provinces[vprov].controller };
  return { vprov, vid, before, after, n };
`);
check('幽灵占领存在（宗主控制附庸的省）', t6.before.owner === t6.vid && t6.before.controller === 140, t6.before);
check('【修复】清扫函数归还了它', t6.after.controller === t6.vid, t6.after);
check('清扫返回归还数量', t6.n === 1, t6.n);

const t6b = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const vprov=countries[vid].provList[0];
  provinces[vprov].controller=140;
  monthlyTick();     // 月度兜底
  return { owner:provinces[vprov].owner, controller:provinces[vprov].controller, vid };
`);
check('monthlyTick 里也会自动归还', t6b.controller === t6b.vid, t6b);

/* ================= 7. 放附庸独立后不残留占领 ================= */
console.log('\n-- 7. 解除附庸关系后不残留占领 --');
const t7 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'藩属国');
  const vprov=countries[vid].provList[0];
  provinces[vprov].controller=140;       // 宗主占着附庸的省
  releaseVassal(vid);                     // 放它独立
  const afterRelease={ overlord:overlordOf(vid), controller:provinces[vprov].controller };
  monthlyTick();
  const afterMonth={ overlord:overlordOf(vid), controller:provinces[vprov].controller };
  return { vprov, vid, afterRelease, afterMonth };
`);
check('已解除附庸关系', t7.afterRelease.overlord === 0, t7.afterRelease);
check('【修复】放独立后（经月度兜底）占领归还', t7.afterMonth.controller === t7.vid, t7.afterMonth);

/* ================= 8. 正常占领不受影响 ================= */
console.log('\n-- 8. 正常交战中的占领不受影响 --');
const t8 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>4);
  const foeProv=foe.provList.find(i=>provinces[i].pix.length);
  declareWar(140,foe.id);
  provinces[foeProv].controller=140;
  const n=releaseStaleOccupations();
  return { foeProv, foeId:foe.id, n, controller:provinces[foeProv].controller };
`);
check('交战中的占领不会被误清', t8.controller === 140 && t8.n === 0, t8);

/* ================= 9. 长跑回归 ================= */
console.log('\n-- 9. 长跑回归 --');
const t9 = run(`
  resetWorld(); buildWorld(); setHumans([140,44]); player=140;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const vid=foundVassal(140,pid,'长跑傀儡');
  for(let i=0;i<1500;i++) tickDay();
  // 统计"控制者与所有者不交战"的幽灵占领数量，应该恒为 0
  let ghost=0, occ=0;
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(!p.pix.length||p.controller===p.owner) continue;
    occ++;
    if(!atWar(p.controller,p.owner)) ghost++;
  }
  return { day:dayCount, ghost, occ, armies:armies.length };
`);
check('模拟 1500 天无异常', t9.day === 1500 && t9.armies > 0, t9);
check('【核心】长跑后幽灵占领数量为 0', t9.ghost === 0, t9);
check('（期间确实发生过占领，说明不是空跑）', t9.occ >= 0, t9);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
