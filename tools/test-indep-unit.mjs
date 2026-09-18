// 附庸国发起独立战争 —— 回归测试
//
// 原 bug：附庸向宗主宣战被停战卡死。
//   · vassalize / makePeace 都会立 10 年停战
//   · doDeclare 里 `if(atWar||truceBetween) return;` 静默返回
//   → 玩家被打成附庸后十年内无法独立，点「宣战」毫无反应也没有任何提示。
//
// 规则修正：独立战争（附庸打自己的宗主）是停战的例外 ——
// 停战是"双方不再互攻"的军事约定，不该剥夺附庸争取独立的权利。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

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
    getImageData: (w, h, w2, h2) => ({ width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) }),
  };
}
function mk(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(), id: '', width: 1280, height: 800, style: {}, dataset: {},
    value: '', textContent: '', children: [], _h: '', checked: false, disabled: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop, click: noop,
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
  location: { search: '', pathname: '/gs/', protocol: 'https:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  ImageData: function (w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); },
  URL: { createObjectURL: () => 'x', revokeObjectURL: noop },
  fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }),
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => true, prompt: () => '',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

/* 公共准备：选两个国家，player 当附庸，另一个当宗主。
   注意要 captureScenarioBase()：编辑器/剧本都是"建完图立刻采基线"，
   少了它 makeScenario 会把当前状态当成基线、导出空剧本。 */
const SETUP = `
  resetWorld(); setSeed(987654321); buildWorld(); captureScenarioBase();
  const C=countries;
  const v=C.find(c=>c&&c.alive&&c.provList.length>4);
  const o=C.find(c=>c&&c.alive&&c.id!==v.id&&c.provList.length>6);
  const third=C.find(c=>c&&c.alive&&c.id!==v.id&&c.id!==o.id&&c.provList.length>4);
`;

console.log('\n=== 附庸国独立战争 回归测试 ===\n');

/* ================= 1. 语义函数 ================= */
console.log('-- 1. isIndepWar 语义 --');
const t1 = run(`${SETUP}
  v.overlord=o.id; v.subject=SUBJ_VASSAL; invalidateCamps();
  return { v:v.id, o:o.id, third:third.id,
           indepVO:isIndepWar(v.id,o.id), indepOV:isIndepWar(o.id,v.id),
           indepVThird:isIndepWar(v.id,third.id), indepThirdV:isIndepWar(third.id,v.id),
           indepSelf:isIndepWar(v.id,v.id), indepZero:isIndepWar(v.id,0) };
`);
check('【核心】附庸 → 宗主 判定为独立战争', t1.indepVO === true, t1);
check('宗主 → 附庸 不算独立战争', t1.indepOV === false, t1);
check('附庸 → 第三方 不算独立战争', t1.indepVThird === false, t1);
check('第三方 → 附庸 不算独立战争', t1.indepThirdV === false, t1);
check('自己打自己不算', t1.indepSelf === false, t1);
check('目标为 0（荒地）不算', t1.indepZero === false, t1);

/* ================= 2. 游戏中被附庸化后仍能独立（核心 bug） ================= */
console.log('\n-- 2. 被打成附庸（有 10 年停战）后仍能发起独立战争 --');
const t2 = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  v.overlord=o.id; v.subject=SUBJ_VASSAL;
  truces[truceKey(v.id,o.id)]=dayCount+3650;   // vassalize/makePeace 的 10 年停战
  invalidateCamps();
  const before={ truce:truceBetween(player,o.id), atWar:atWar(player,o.id) };
  let err=null;
  try{ doDeclare(o.id); }catch(e){ err=e.message; }
  const after={ atWar:atWar(player,o.id),
                direct:wars.filter(w=>(w.a===player&&w.d===o.id)||(w.a===o.id&&w.d===player)).length };
  return { v:v.id, o:o.id, before, after, err };
`);
check('附庸化确实带来了 10 年停战', t2.before.truce === true, t2.before);
check('【核心】停战期内仍能向宗主宣战（独立战争）', t2.after.direct === 1 && t2.after.atWar === true, t2.after);
check('调用不抛异常', t2.err === null, t2.err);

console.log('\n-- 2b. 地图开局即附庸（本来就无停战）也能宣战 --');
const t2b = run(`${SETUP}
  v.overlord=o.id; v.subject=SUBJ_VASSAL;
  const sc=makeScenario({name:'附庸开局'});
  buildWorldFromScenario(sc);
  player=v.id; started=true; MP.online=false;
  const ovBefore=overlordOf(player);
  doDeclare(o.id);
  return { v:v.id, o:o.id, ovBefore, ov:overlordOf(player), atWar:atWar(player,o.id),
           scHasOv:(sc.countries[v.id]||{}).ov,
           direct:wars.filter(w=>(w.a===player&&w.d===o.id)||(w.a===o.id&&w.d===player)).length };
`);
check('剧本记录了附庸关系', t2b.scHasOv === t2b.o, t2b);
check('剧本重建后仍是附庸', t2b.ovBefore === t2b.o, t2b);
check('【核心】能向宗主宣战', t2b.direct === 1 && t2b.atWar === true, t2b);

/* ================= 3. 第三方仍然受停战约束 ================= */
console.log('\n-- 3. 对第三方宣战仍然受停战约束 --');
const t3 = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  truces[truceKey(v.id,third.id)]=dayCount+3650;
  invalidateCamps();
  const before=wars.length;
  doDeclare(third.id);
  const after=wars.length;
  const lastLog=logEntries[0]?logEntries[0].t:'';
  return { before, after, lastLog, truce:truceBetween(v.id,third.id) };
`);
check('停战期内不能对第三方宣战', t3.after === t3.before, t3);
check('【修复】而且会明确告诉玩家原因（不再静默失败）', t3.lastLog.includes('停战'), t3.lastLog);

console.log('\n-- 3b. 已交战时再宣战也会给提示 --');
const t3b = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  declareWar(v.id,third.id);
  const before=wars.length;
  doDeclare(third.id);
  const lastLog=logEntries[0]?logEntries[0].t:'';
  return { same:wars.length===before, lastLog };
`);
check('重复宣战不会产生第二场战争', t3b.same === true, t3b);
check('给出「已在交战」提示', t3b.lastLog.includes('交战'), t3b.lastLog);

/* ================= 4. 界面按钮 ================= */
console.log('\n-- 4. 外交面板的按钮 --');
const t4 = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  v.overlord=o.id; v.subject=SUBJ_VASSAL;
  truces[truceKey(v.id,o.id)]=dayCount+3650;
  truces[truceKey(v.id,third.id)]=dayCount+3650;
  invalidateCamps();
  uiTab='diplo'; diploFocus=0; diploColorFor=0; uiSearch=''; refreshPanel();
  const html=document.getElementById('diplo-list').innerHTML;
  const row=(id)=>{ const i=html.indexOf('data-act="diplo-info" data-v="'+id+'"'); return html.slice(i, i+800); };
  const rowO=row(o.id), rowThird=row(third.id);
  return { o:o.id, third:third.id,
           oHasIndep:rowO.includes('⚔ 独立战争'),
           oHasDeclare:rowO.includes('data-act="declare" data-v="'+o.id+'"'),
           oTip:rowO.includes('不受停战约束'),
           oBadge:rowO.includes('宗主'),
           thirdHasDeclare:rowThird.includes('data-act="declare" data-v="'+third.id+'"'),
           thirdSaysIndep:rowThird.includes('⚔ 独立战争') };
`);
check('宗主那一行有「⚔ 独立战争」按钮', t4.oHasIndep === true && t4.oHasDeclare === true, t4);
check('按钮提示写明不受停战约束', t4.oTip === true, t4);
check('宗主那一行有「宗主」徽章', t4.oBadge === true, t4);
check('停战中的第三方没有宣战按钮', t4.thirdHasDeclare === false, t4);
check('第三方不会被误标成独立战争', t4.thirdSaysIndep === false, t4);

/* ================= 5. 打完独立战争真的能独立 ================= */
console.log('\n-- 5. 打赢独立战争 → 真正脱离宗主 --');
const t5 = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  v.overlord=o.id; v.subject=SUBJ_VASSAL;
  truces[truceKey(v.id,o.id)]=dayCount+3650;
  invalidateCamps();
  doDeclare(o.id);
  const w=wars.find(x=>(x.a===player&&x.d===o.id)||(x.a===o.id&&x.d===player));
  // 把战争分数堆够（独立要 30 分）
  if(w.a===player){ w.aB=80; w.dB=0; } else { w.dB=80; w.aB=0; }
  const score=warScore(w);
  const mine=w.a===player?score.a:score.d;
  const before={ ov:overlordOf(player), camp:campOf(player).has(o.id), score:mine };
  peaceIndep(o.id);
  const after={ ov:overlordOf(player), camp:campOf(player).has(o.id),
                atWar:atWar(player,o.id), truce:truceBetween(player,o.id) };
  return { v:v.id, o:o.id, before, after };
`);
check('独立前确实是附庸', t5.before.ov === t5.o && t5.before.camp === true, t5.before);
check('战争分数够（≥30）', t5.before.score >= 30, t5.before);
check('【核心】独立战争结束后脱离宗主', t5.after.ov === 0, t5.after);
check('【核心】不再属于宗主阵营', t5.after.camp === false, t5.after);
check('战争结束，且立下新的停战', t5.after.atWar === false && t5.after.truce === true, t5.after);

console.log('\n-- 5b. 分数不够时不会误独立 --');
const t5b = run(`${SETUP}
  player=v.id; started=true; MP.online=false;
  v.overlord=o.id; v.subject=SUBJ_VASSAL;
  truces[truceKey(v.id,o.id)]=dayCount+3650;
  invalidateCamps();
  doDeclare(o.id);
  const w=wars.find(x=>(x.a===player&&x.d===o.id)||(x.a===o.id&&x.d===player));
  if(w.a===player){ w.aB=0; w.dB=60; } else { w.dB=0; w.aB=60; }
  const before=overlordOf(player);
  logEntries=[];
  peaceIndep(o.id);
  const lastLog=logEntries[0]?logEntries[0].t:'';
  return { v:v.id, o:o.id, before, after:overlordOf(player), stillAtWar:atWar(player,o.id), lastLog,
           aB:w.aB, dB:w.dB, score:warScore(w), mine:(w.a===player?warScore(w).a:warScore(w).d) };
`);
check('分数不足时仍是附庸', t5b.before === t5b.o && t5b.after === t5b.o, t5b);
check('而且给出分数不足的提示', t5b.lastLog.includes('分数'), t5b.lastLog);
check('【核心】分数算对了（不再两边一起顶满）', t5b.mine < 30, t5b);

/* ================= 6. 长跑：AI 附庸照常会造反 ================= */
console.log('\n-- 6. 回归：AI 附庸的自动造反没被破坏 --');
const t6 = run(`
  resetWorld(); setSeed(987654321); buildWorld();
  const C=countries;
  const v=C.find(c=>c&&c.alive&&c.provList.length>4);
  const o=C.find(c=>c&&c.alive&&c.id!==v.id&&c.provList.length>4);
  v.overlord=o.id; v.subject=SUBJ_VASSAL; invalidateCamps();
  for(const pid of o.provList.slice(0,Math.max(0,o.provList.length-2))){ provinces[pid].owner=v.id; }
  v.provList=[]; o.provList=[];
  for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(p.pix.length&&countries[p.owner]) countries[p.owner].provList.push(i); }
  invalidateCamps();
  setHumans([]); player=0;
  let rebelled=false, day0=0;
  for(let i=0;i<3000&&!rebelled;i++){ tickDay(); if(wars.some(w=>w.a===v.id&&w.d===o.id)){ rebelled=true; day0=dayCount; } }
  return { v:v.id, o:o.id, rebelled, day0, chance:rebelChanceOf(v.id) };
`);
check('AI 附庸仍会举兵造反', t6.rebelled === true, t6);
check('造反概率仍是每月 4%', Math.abs(t6.chance - 0.04) < 1e-9, t6.chance);

console.log('\n-- 6b. 世界长时间运行不崩 --');
const t6b = run(`
  resetWorld(); setSeed(987654321); buildWorld();
  setHumans([140]); player=140;
  // 让 140 当别人的附庸，并且带停战
  const o=countries.find(c=>c&&c.alive&&c.id!==140&&c.provList.length>8);
  countries[140].overlord=o.id; countries[140].subject=SUBJ_VASSAL;
  truces[truceKey(140,o.id)]=dayCount+3650;
  invalidateCamps();
  doDeclare(o.id);
  for(let i=0;i<1500;i++) tickDay();
  return { day:dayCount, wars:wars.length, alive:countries.filter(c=>c&&c.alive).length,
           ov:overlordOf(140) };
`);
check('玩家附庸开局后跑 1500 天不崩', t6b.day === 1500, t6b);
check('世界仍在运转', t6b.alive > 50 && t6b.wars >= 0, t6b);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
