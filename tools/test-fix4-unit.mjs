// 验证：1) 吞并规则修正  2) 服务端报错在游戏内可见  3) 按钮置灰说明原因
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 260) : '')); } };

/* ---------- DOM 桩（记录创建出来的元素） ---------- */
const noop = () => {};
const created = [];
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
    value: '', textContent: '', children: [], _h: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h; }, set(v) { e._h = v; } });
  created.push(e);
  return e;
}
const els = {};
const getEl = (i) => els[i] || (els[i] = mk('div'));
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, requestAnimationFrame: noop,
  document: {
    addEventListener: noop, getElementById: getEl, createElement: (t) => mk(t),
    querySelector: () => null, querySelectorAll: () => [],
    body: { appendChild: (e) => { e._appended = true; } },
    hidden: false,
  },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false, noop,
  addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
sb.created = created;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 吞并规则 + 报错可见性 验证 ===\n');
run('resetWorld(); buildWorld(); started=true; player=140; MP.online=true; MP.inGame=true;');

/* ================= 1. 吞并判定（原版规则） ================= */
console.log('-- 1. 吞并前置条件（原版规则：交战中不可吞并） --');
const annex = run(`
  resetWorld(); buildWorld();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const me=cs[0];
  const vassal=cs.find(c=>c.id!==me.id&&c.provList.length>=2&&!c.overlord);
  const foe=cs.find(c=>c.id!==me.id&&c.id!==vassal.id);
  vassal.overlord=me.id; me.gold=5000; invalidateCamps();
  // 与服务端 annex 分支一致的判定（恢复后的原版规则）
  const canAnnex=()=>({ ok:!inWar(vassal.id) && me.gold>=Math.round(totalDev(vassal)*4), atWar:inWar(vassal.id) });
  const peace=canAnnex();
  declareWar(me.id,foe.id); invalidateCamps();
  const atWar=canAnnex();
  // 战后议和，应恢复可吞并
  const w=wars.find(x=>x&&((x.a===me.id&&x.d===foe.id)||(x.d===me.id&&x.a===foe.id)));
  if(w) makePeace(w,[],false);
  invalidateCamps();
  const afterPeace=canAnnex();
  return { peace, atWar, afterPeace };
`);
check('和平时期可以吞并', annex.peace.ok === true, annex.peace);
check('【原版规则】我方交战时附庸算"交战中"，不可吞并', annex.atWar.ok === false && annex.atWar.atWar === true, annex.atWar);
check('结束战事后又能吞并', annex.afterPeace.ok === true, annex.afterPeace);

/* ================= 2. 服务端报错在游戏内可见 ================= */
console.log('\n-- 2. 报错可见性 --');
const toast = run(`
  logEntries=[];
  created.length=0;
  mpHandle({t:'error', msg:'附庸正与他人交战，无法吞并'});
  const el=created.find(e=>e.id==='gs-toast');
  return { toastText: el?el.textContent:null, appended: el?!!el._appended:false, logs: logEntries.map(e=>e.t) };
`);
check('弹出了浮动提示', toast.toastText === '附庸正与他人交战，无法吞并', toast);
check('提示挂到了页面上', toast.appended === true, toast);
check('同时记入史官记事', (toast.logs[0] || '').includes('附庸正与他人交战'), toast.logs);

/* ================= 3. 按钮置灰时说明原因 ================= */
console.log('\n-- 3. 按钮提示 --');
const btn = run(`
  resetWorld(); buildWorld();            // 干净的局，避免上一段的战争残留
  MP.online=true; started=true; MP.inGame=true;
  uiTab='diplo'; diploFocus=0; uiSearch='';
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const me=cs[0]; player=me.id;
  const vassal=cs.find(c=>c.id!==me.id&&c.provList.length>=2&&!c.overlord);
  vassal.overlord=me.id; me.gold=5000; invalidateCamps();
  refreshPanel();
  // DOM 桩不会真的根据 innerHTML 建子元素，外交列表是渲染进 #diplo-list 的，直接读它
  const html1=document.getElementById('diplo-list').innerHTML;
  const hasAnnex=html1.includes('吞并');
  const enabled1=hasAnnex && !/data-act="annex-vassal"[^>]*disabled/.test(html1);
  me.gold=0; refreshPanel();
  const html2=document.getElementById('diplo-list').innerHTML;
  const hasWarn=html2.includes('国库不足');
  return { hasAnnex, enabled1, hasWarn, vassalName: vassal.name };
`);
check('附庸行出现「吞并」按钮', btn.hasAnnex === true, btn);
check('条件满足时按钮可用', btn.enabled1 === true, btn);
check('国库不足时按钮带原因提示', btn.hasWarn === true, btn);

/* ================= 4. 源码一致性 ================= */
console.log('\n-- 4. 服务端与客户端规则一致（原版规则） --');
const srv = read('srv/server.js');
const cli = read('web/client.js');
check('服务端用 inWar 判定（原版规则）', srv.includes("if (core.inWar(t)) throw new Error('附庸处于交战状态"));
check('服务端不再使用放宽后的 foreignWar 判定', !srv.includes('const foreignWar = st.wars.some'));
check('客户端按钮用同一套 inWar 判定', cli.includes('const atWar=inWar(c.id);'));
check('客户端不再使用放宽后的判定', !cli.includes('const foreignWar=wars.some(w=>{'));
check('客户端按钮仍带禁用原因 title', cli.includes('const why=noGold'));

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
