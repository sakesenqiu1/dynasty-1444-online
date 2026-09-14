// 验证：1) 客户端阵营缓存随增量失效（附庸占领地可割）
//       2) 附庸造反时算交战（能打仗、能围城）
//       3) 造反附庸的关系徽章显示"交战中"
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

console.log('\n=== 附庸相关修复验证 ===\n');
run('resetWorld(); buildWorld(); started=true; player=140; MP.online=true; MP.inGame=true;');

/* ================= 1. 客户端阵营缓存随增量失效 ================= */
console.log('-- 1. 客户端阵营缓存（附庸占领地能否出现在割地列表） --');
const cache = run(`
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const P=cs[0].id;
  const V=cs.find(c=>c.id!==P&&c.provList.length>=3&&!c.overlord).id;
  player=P;
  countries.forEach(c=>{ if(c) c.overlord=0; });
  invalidateCamps();
  // 先查一次，把"我方阵营"灌进缓存（此时还没有附庸）
  const beforeHasV = campOf(P).has(V);
  // 服务端下发一条增量，把 V 变成我的附庸（overlord 变了）
  mpDelta({ d: { ct: [[V, 100, 5000, 1, P]] } });
  const afterHasV = campOf(P).has(V);
  // 再解除，同样要立刻反映
  mpDelta({ d: { ct: [[V, 100, 5000, 1, 0]] } });
  const afterRelease = campOf(P).has(V);
  return { P, V, beforeHasV, afterHasV, afterRelease };
`);
check('成为附庸前，阵营里没有它', cache.beforeHasV === false, cache);
check('【修复】增量下发附庸关系后，客户端阵营立刻包含它', cache.afterHasV === true, cache);
check('解除附庸后立刻又不包含它', cache.afterRelease === false, cache);

/* ================= 2. 附庸占领的敌省出现在割地列表 ================= */
console.log('\n-- 2. 附庸占领的敌省可割 --');
const demand = run(`
  resetWorld(); buildWorld();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const P=cs[0].id;
  const E=cs[1].id;
  const V=cs.find(c=>c.id!==P&&c.id!==E&&c.provList.length>=3).id;
  player=P;
  countries.forEach(c=>{ if(c) c.overlord=0; });
  countries[V].overlord=P;
  invalidateCamps();
  declareWar(P,E); invalidateCamps();
  // 让附庸 V 去"占领" 3 个敌省（只改控制者，不改所有者）
  const eProvs=countries[E].provList.filter(pid=>provinces[pid].pix.length).slice(0,3);
  for(const pid of eProvs) provinces[pid].controller=V;
  // 割地列表的筛选逻辑（与 warTab 里一致）
  const occ=[];
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(p.pix.length&&(p.owner===E||campOf(p.owner).has(E))&&(p.controller===P||campOf(p.controller).has(P))) occ.push(i);
  }
  const vassalOcc = eProvs.filter(pid=>occ.includes(pid));
  return { P,E,V, eProvs, occCount: occ.length, vassalOcc: vassalOcc.length };
`);
check('附庸占领的敌省被识别为我方占领（可索要）', demand.vassalOcc === 3,
  { 敌省: demand.eProvs.length, 被识别: demand.vassalOcc });

/* ================= 3. 附庸造反要能打 ================= */
console.log('\n-- 3. 附庸造反算交战 --');
const revolt = run(`
  resetWorld(); buildWorld();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const P=cs[0].id;
  const V=cs.find(c=>c.id!==P&&c.provList.length>=4).id;
  player=P; setHumans([P]);
  countries.forEach(c=>{ if(c) c.overlord=0; });
  countries[V].overlord=P;
  invalidateCamps();
  const beforeWar = atWar(P,V);              // 正常附庸：不算交战
  declareWar(V,P);                            // 附庸举兵造反
  invalidateCamps();
  const afterWar = atWar(P,V);
  // 造反后：双方军队同省应当发生会战
  const target = countries[V].provList.find(pid=>provinces[pid].pix.length);
  armies = [
    { id:9001, owner:P, prov:target, str:20000, path:[], prog:0 },
    { id:9002, owner:V, prov:target, str:5000,  path:[], prog:0 },
  ];
  const strBefore = armies[0].str;
  battleProvs = new Set();
  resolveBattles();
  const p = provinces[target];
  const sieged = (()=>{ // 再验证围城：我方军队单独驻在附庸省份
    armies = [{ id:9003, owner:P, prov:target, str:20000, path:[], prog:0 }];
    battleProvs = new Set();
    p.siege = 0;
    resolveSieges();
    return p.siege;
  })();
  return { P,V, beforeWar, afterWar, target, strBefore, strAfter: armies[0] ? armies[0].str : null,
           vassalArmyGone: !armies.some(a=>a.owner===V), sieged, ownerOfTarget: p.owner===V };
`);
check('正常附庸（未造反）不算交战', revolt.beforeWar === false, revolt);
check('【修复】附庸造反后 atWar 为真', revolt.afterWar === true, revolt);
check('造反后同省军队会发生会战（附庸军队被歼灭）', revolt.vassalArmyGone === true, revolt);
check('造反后我方可以围攻附庸的省份', revolt.sieged > 0, revolt);

/* ================= 4. 关系徽章 ================= */
console.log('\n-- 4. 造反附庸的关系徽章 --');
const badge = run(`
  resetWorld(); buildWorld();          // 干净的局，不要沿用上一段的战争
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const P=cs[0].id, V=cs.find(c=>c.id!==P&&c.provList.length>=4).id;
  player=P;
  countries.forEach(c=>{ if(c) c.overlord=0; });
  countries[V].overlord=P; invalidateCamps();
  const peaceful = relationBadge(V);
  declareWar(V,P); invalidateCamps();
  const revolting = relationBadge(V);
  return { peaceful, revolting };
`);
check('平时显示「我朝附庸」', badge.peaceful.includes('我朝附庸'), badge);
check('【修复】造反后显示「交战中」', badge.revolting.includes('交战中'), badge);

/* ================= 5. 回归：正常附庸仍随宗主参战 ================= */
console.log('\n-- 5. 回归 --');
const reg = run(`
  resetWorld(); buildWorld();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const P=cs[0].id, E=cs.find(c=>c.id!==P).id, V=cs.find(c=>c.id!==P&&c.id!==E&&c.provList.length>=3).id;
  player=P;
  countries.forEach(c=>{ if(c) c.overlord=0; });
  countries[V].overlord=P; invalidateCamps();
  declareWar(P,E); invalidateCamps();
  return { vassalAtWarWithEnemy: atWar(V,E), overlordNotAtWarWithVassal: atWar(P,V) };
`);
check('正常附庸仍随宗主与敌国交战', reg.vassalAtWarWithEnemy === true, reg);
check('正常附庸不会与宗主"交战"', reg.overlordNotAtWarWithVassal === false, reg);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
