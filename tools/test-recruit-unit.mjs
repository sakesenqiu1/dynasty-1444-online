// 验证征兵队列：需要集结期、期间省份易主会中止退款、存档/读档保留进度
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 260) : '')); } };

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
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false, noop,
  addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 征兵队列验证 ===\n');

/* ================= 1. 不再"点一下立刻成军" ================= */
console.log('-- 1. 集结期 --');
run('resetWorld(); buildWorld(); player=140; setHumans([140]); countries[140].gold=5000;');
const t1 = run(`
  const pid=countries[140].provList.find(i=>provinces[i].pix.length);
  const mine=()=>armies.filter(a=>a.owner===140).length;
  const myRec=()=>recruits.filter(r=>r.owner===140).length;
  const before=mine();
  const goldBefore=countries[140].gold, mpBefore=countries[140].mp;
  addRecruit(140,pid,5000,false);
  const justAdded=mine();
  const goldAfter=countries[140].gold, mpAfter=countries[140].mp;
  // 只推进 364 天：应该还没有军队
  for(let i=0;i<364;i++) tickDay();
  const at364=mine();
  const recAt364=myRec();
  tickDay();                       // 第 365 天
  const at365=mine();
  const recAt365=myRec();
  return { pid, before, justAdded, at364, at365, recAt364, recAt365, goldBefore, goldAfter, mpBefore, mpAfter,
           days:RECRUIT_DAYS, navyDays:NAVY_DAYS, aiQueued:recruits.filter(r=>r.owner!==140).length };
`);
check('创建征兵时不会立刻生成军队', t1.justAdded === t1.before, t1);
check(`第 ${t1.days - 1} 天仍未成军`, t1.at364 === t1.before && t1.recAt364 === 1, t1);
check(`第 ${t1.days} 天成军`, t1.at365 === t1.before + 1 && t1.recAt365 === 0, t1);
check('陆军集结期 = 1 年（365 天）', t1.days === 365, t1.days);
check('舰队组建期 = 9 个月（270 天）', t1.navyDays === 270, t1.navyDays);
check('AI 也走同一套征兵队列（同样要等集结期）', t1.aiQueued > 0, t1.aiQueued);

/* ================= 2. 成本由服务端/内核扣除（不在 create 时扣） ================= */
console.log('\n-- 2. 资源扣除由调用方负责（内核只排队） --');
check('addRecruit 本身不改国库（由指令层扣费）', t1.goldAfter === t1.goldBefore && t1.mpAfter === t1.mpBefore, t1);

/* ================= 3. 集结期间省份易主 -> 中止并退款 ================= */
console.log('\n-- 3. 征兵中断与退款 --');
const t3 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const c=countries[140]; c.gold=1000; c.mp=100000;
  const pid=c.provList.find(i=>provinces[i].pix.length);
  const myRec=()=>recruits.filter(r=>r.owner===140).length;
  const myArmies=()=>armies.filter(a=>a.owner===140).length;
  c.gold-=25; c.mp-=5000;
  addRecruit(140,pid,5000,false);
  for(let i=0;i<30;i++) tickDay();          // 推进到月中，避开月度收入
  const armBefore=myArmies();
  const g0=c.gold, m0=c.mp;
  provinces[pid].controller=999;            // 省份易主
  tickDay();
  return { pid, g0, m0, armBefore, gold:c.gold, mp:c.mp, rec:myRec(), armies:myArmies(), mpCap:c.mpCap };
`);
check('省份易主后征兵被取消', t3.rec === 0, t3);
check('没有生成军队', t3.armies === t3.armBefore, t3);
check('25 金已退回', t3.gold >= t3.g0 + 25 - 0.01, t3);
check('5000 人力已退回（受上限约束）', t3.mp === Math.min(t3.mpCap, t3.m0 + 5000), t3);

/* ================= 4. pendingStrength ================= */
console.log('\n-- 4. 在征兵力统计 --');
const t4 = run(`
  resetWorld(); buildWorld(); player=140;
  const pid=countries[140].provList.find(i=>provinces[i].pix.length);
  const s0=pendingStrength(140);
  addRecruit(140,pid,5000,false);
  addRecruit(140,pid,4000,true);
  const s1=pendingStrength(140);
  const other=pendingStrength(141);
  return { s0, s1, other };
`);
check('初始为 0', t4.s0 === 0, t4);
check('两支在征 = 9000', t4.s1 === 9000, t4);
check('不影响别国', t4.other === 0, t4);

/* ================= 5. 存档 / 读档保留进度 ================= */
console.log('\n-- 5. 存档往返 --');
const t5 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const pid=countries[140].provList.find(i=>provinces[i].pix.length);
  const myRecs=()=>recruits.filter(r=>r.owner===140).map(r=>r.days).sort((a,b)=>a-b);
  const myArmies=()=>armies.filter(a=>a.owner===140).length;
  addRecruit(140,pid,5000,false);
  addRecruit(140,pid,4000,true);
  for(let i=0;i<100;i++) tickDay();
  const beforeDays=myRecs();
  const snap=makeSaveData();
  applySaveData(JSON.parse(JSON.stringify(snap)));
  const afterDays=myRecs();
  const armiesBefore=myArmies();
  const soonest=afterDays[0]||0;
  for(let i=0;i<soonest;i++) tickDay();
  return { beforeDays, afterDays, armiesBefore, armiesAfter:myArmies(), left:myRecs().length };
`);
check('读档后剩余天数一致', JSON.stringify(t5.beforeDays) === JSON.stringify(t5.afterDays), t5);
check('读档后继续推进能正常成军', t5.left < t5.afterDays.length && t5.armiesAfter > t5.armiesBefore, t5);

/* ================= 6. 亡国清理在征队列 ================= */
console.log('\n-- 6. 亡国清理 --');
const t6 = run(`
  resetWorld(); buildWorld();
  const victim=countries.find(c=>c&&c.alive&&c.provList.length>0);
  const pid=victim.provList[0];
  addRecruit(victim.id,pid,5000,false);
  const before=recruits.length;
  // 把它所有省份转走，触发 checkDeath
  const taker=countries.find(c=>c&&c.alive&&c.id!==victim.id);
  for(const p of [...victim.provList]) transferProvince(p,taker.id);
  return { before, after:recruits.length, over:recruits.filter(r=>r.owner===victim.id).length };
`);
check('亡国的在征队列被清空', t6.before === 1 && t6.after === 0 && t6.over === 0, t6);

/* ================= 7. 客户端面板显示征兵进度 ================= */
console.log('\n-- 7. 界面显示 --');
const t7 = run(`
  resetWorld(); buildWorld(); player=140; started=true; MP.online=false;
  selectedProv=countries[140].provList.find(i=>provinces[i].pix.length);
  selectedArmy=0; uiTab='info';
  addRecruit(140,selectedProv,5000,false);
  refreshPanel();
  const html=document.getElementById('panel-body').innerHTML;
  return { hasQueue:html.includes('征兵中'), hasMonths:html.includes('个月后成军'), hasTitle:html.includes('集结期') };
`);
check('省份面板显示"征兵中"', t7.hasQueue === true, t7);
check('按钮注明成军周期', t7.hasMonths === true, t7);
check('按钮带集结期说明', t7.hasTitle === true, t7);

/* ================= 8. 回归：模拟仍正常 ================= */
console.log('\n-- 8. 回归 --');
const t8 = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<1500;i++) tickDay();
  return { day:dayCount, armies:armies.length, wars:wars.length, recruits:recruits.length };
`);
check('模拟 1500 天无异常', t8.day === 1500 && t8.armies > 0, t8);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
