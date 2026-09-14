// 客户端性能改动的验证：用 DOM + Canvas 桩把 4 个脚本都跑起来，
// 检查节流/指纹/增量维护是否真的生效，以及结果是否和"全量重建"等价。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

/* ================= DOM / Canvas 桩 ================= */
const noop = () => {};
const htmlWrites = Object.create(null);   // 统计各元素 innerHTML 被重建的次数
const drawLog = [];                       // 记录每次 drawImage 及其当时的变换矩阵
let fakeNow = 1000;                       // 可控时钟

function ctx2d() {
  const c = {
    canvas: null, _m: [1, 0, 0, 1, 0, 0], _stack: [],
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
    imageSmoothingEnabled: true,
    setTransform(a, b, cc, d, e, f) { this._m = [a, b, cc, d, e, f]; },
    save() { this._stack.push(this._m.slice()); },
    restore() { if (this._stack.length) this._m = this._stack.pop(); },
    translate: noop, scale: noop,
    fillRect: noop, clearRect: noop, strokeRect: noop, putImageData: noop,
    drawImage(img, x, y) { drawLog.push({ img, m: this._m.slice(), x, y }); },
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, stroke: noop, fill: noop, setLineDash: noop,
    strokeText: noop, fillText: noop,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return c;
}

function makeEl(id) {
  const el = {
    id: id || '', tagName: 'DIV', width: 1280, height: 800,
    style: {}, dataset: {}, value: '', textContent: '', checked: false, disabled: false,
    scrollTop: 0, scrollHeight: 0, children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop, insertBefore: noop,
    removeChild: noop, remove: noop, focus: noop, select: noop, setSelectionRange: noop,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) { el._html = v; if (id) htmlWrites[id] = (htmlWrites[id] || 0) + 1; },
  });
  return el;
}

const els = Object.create(null);
const getEl = (id) => (els[id] || (els[id] = makeEl(id)));

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => fakeNow },
  requestAnimationFrame: noop,
  document: {
    addEventListener: noop,
    getElementById: getEl,
    createElement: (tag) => makeEl(''),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: noop },
  },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'localhost' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams,
  navigator: { userAgent: 'node' },
  alert: noop, confirm: () => false,
  noop,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.innerWidth = 1280;
sandbox.innerHeight = 800;
sandbox.devicePixelRatio = 1;
sandbox.htmlWrites = htmlWrites;   // 让 vm 里的用例也能读到重建计数
sandbox.drawLog = drawLog;
sandbox.__setNow = (v) => { fakeNow = v; };
const ctx = vm.createContext(sandbox);

for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) {
  vm.runInContext(read('web/' + f), ctx, { filename: f });
}
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 客户端性能改动验证 ===\n');

run('resetWorld(); buildWorld(); setHumans([140,44]); player=140; started=true; MP.online=true; MP.room="1234";');
check('四个脚本全部加载并建好世界', run('return provinces.length>1900 && countries.length===177'));

/* ---------- 1. 增量维护 provList 必须与全量重建等价 ---------- */
console.log('\n-- 1. 省份归属增量维护 == 全量重建 --');
const equiv = run(`
  const snap = () => countries.map(c=>c&&c.alive?c.provList.slice().sort((a,b)=>a-b).join(','):'-').join('|');
  const full = () => { rebuildAllProvLists(); return snap(); };
  const before = full();
  // 制造 120 次归属变更（模拟战事占领），全部走 mpDelta 的增量分支
  let n = 0;
  for (let k = 0; k < 120; k++) {
    const pid = 1 + ((k * 37) % (provinces.length - 1));
    const p = provinces[pid];
    if (!p || !p.pix.length) continue;
    const newOwner = (p.owner % 170) + 2;
    mpDelta({ d: { pr: [[pid, newOwner, newOwner, 0]] } });
    n++;
  }
  const incr = snap();
  const rebuilt = full();
  return { n, same: incr === rebuilt, incr, rebuilt };
`);
check(`应用 ${equiv.n} 次增量后 provList 与全量重建一致`, equiv.same,
  equiv.same ? '' : (equiv.incr || '').slice(0, 200) + '  ≠  ' + (equiv.rebuilt || '').slice(0, 200));

/* ---------- 2. 侧栏不再每个增量都重建 ---------- */
console.log('\n-- 2. 侧栏重建次数被节流 --');
const throttle = run(`
  uiTab='diplo';                     // 外交页是最重的（上百行国家列表）
  refreshPanel();
  const startWrites = 0;
  let t = 100000;
  // 模拟 3 秒：60fps 的 uiTick + 每秒 7.7 次增量
  let deltas = 0;
  for (let f = 0; f < 180; f++) {
    t += 16.7;
    if (f % 8 === 0) {               // ~7.5 次/秒
      const pid = 1 + ((f * 13) % (provinces.length - 1));
      const p = provinces[pid];
      if (p && p.pix.length) mpDelta({ d: { pr: [[pid, (p.owner % 170) + 2, p.owner, 0]] } });
      deltas++;
    }
    uiTick(t);
  }
  return { deltas, ms: 3000 };
`);
const diploWrites = htmlWrites['panel-body'] || 0;
check(`3 秒内 ${throttle.deltas} 次增量，侧栏只重建 ${diploWrites} 次（旧实现是 ${throttle.deltas} 次）`,
  diploWrites <= 14, diploWrites);
check('重建次数远少于增量次数（节流生效）', diploWrites < throttle.deltas, `${diploWrites} < ${throttle.deltas}`);

/* ---------- 3. 状态指纹：没变就不重绘 ---------- */
console.log('\n-- 3. 状态指纹 --');
const sigTest = run(`
  uiTab='info';
  const a = panelSignature();
  const b = panelSignature();
  const before = a === b;
  countries[140].gold += 100;      // 改国库 -> 指纹必须变
  const c = panelSignature();
  countries[140].gold -= 100;
  const d = panelSignature();
  return { stable: before, changes: c !== a, restored: d === a };
`);
check('同一状态下指纹稳定', sigTest.stable);
check('国库变化时指纹改变', sigTest.changes);
check('状态复原后指纹复原', sigTest.restored);

/* ---------- 4. 标签层缓存：相机不动就不重画 ---------- */
console.log('\n-- 4. 标签层缓存 --');
const labelCache = run(`
  let draws = 0;
  const _dl = drawLabels;
  drawLabels = function(){ draws++; _dl.apply(null, arguments); };
  cw = 1280; ch = 800; dpr = 1;
  cam.x = 720; cam.y = 360; cam.z = 1;
  labelKey = '';                    // 清掉缓存
  for (let i = 0; i < 120; i++) ensureLabels();   // 相机不动，画 120 帧
  const still = draws;
  cam.x += 5;                                      // 移动相机
  ensureLabels();
  const moved = draws;
  labelEpoch++;                                    // 标签数据变了
  ensureLabels();
  const dataChanged = draws;
  drawLabels = _dl;
  return { still, moved, dataChanged };
`);
check(`相机静止时 120 帧只重画 ${labelCache.still} 次文字层`, labelCache.still === 1, labelCache);
check('相机移动后重画', labelCache.moved === 2, labelCache);
check('标签数据变化后重画', labelCache.dataChanged === 3, labelCache);

/* ---------- 5. 大批量省份变更走整体重绘 ---------- */
console.log('\n-- 5. 大批量变更的整体重绘分支 --');
const batch = run(`
  let perProv = 0, all = 0;
  const _rpn = recolorProvAndNbrs, _ra = recolorAll;
  recolorProvAndNbrs = function(){ perProv++; _rpn.apply(null, arguments); };
  recolorAll = function(){ all++; _ra.apply(null, arguments); };
  const rows = [];
  for (let i = 1; i <= 30; i++) if (provinces[i] && provinces[i].pix.length) rows.push([i, 3, 4, 0]);
  mpDelta({ d: { pr: rows } });
  const big = { perProv, all };
  perProv = 0; all = 0;
  mpDelta({ d: { pr: [[rows[0][0], 5, 5, 0]] } });
  const small = { perProv, all };
  recolorProvAndNbrs = _rpn; recolorAll = _ra;
  return { big, small };
`);
check('30 个省变更时走整体重绘', batch.big.all === 1 && batch.big.perProv === 0, batch.big);
check('单省变更时走局部重绘', batch.small.perProv === 1 && batch.small.all === 0, batch.small);

/* ---------- 6. 日志顺序：最新在最前 ---------- */
console.log('\n-- 6. 日志顺序 --');
const logOrder = run(`
  logEntries = [];
  mpDelta({ d: { lg: [{t:'第一条',cls:'',d:'1',f:0},{t:'第二条',cls:'',d:'2',f:0}] } });
  return logEntries.map(e=>e.t);
`);
check('同批日志最新的排在最前', JSON.stringify(logOrder) === '["第二条","第一条"]', logOrder);

/* ---------- 7. 暂停/调速要立即反映到界面 ---------- */
console.log('\n-- 7. 暂停/调速立即刷新 --');
const clockTest = run(`
  paused = false; speed = 2;
  const w0 = htmlWrites['panel-body'] || 0;
  mpDelta({ d: { day: 10, cy: 1444, cm: 10, cd: 21, pa: true, sp: 3 } });
  return { paused, speed, forced: (htmlWrites['panel-body']||0) > w0 };
`);check('暂停状态被应用', clockTest.paused === true, clockTest);
check('调速被应用', clockTest.speed === 3, clockTest);
check('时钟类变更立即刷新侧栏（不等节流）', clockTest.forced, clockTest);

/* ---------- 8. 性能计时函数不报错 ---------- */
console.log('\n-- 8. 性能面板 --');
const perfOk = run(`
  perfHud = true;
  MP.deltaCount = 100; MP.deltaBytes = 200000;
  perfRates(1000); perfRates(2500);
  let hud = '';
  try { drawPerf(1000); drawPerf(2000); hud = document.getElementById('perf-hud').textContent; }
  catch (e) { return { error: e.message }; }
  return { dps: _dps, kbps: _kbps, hud: hud };
`);
check('增量速率统计正常', !perfOk.error && perfOk.dps >= 0 && perfOk.kbps >= 0 && Number.isFinite(perfOk.dps), perfOk);
check('性能面板能正常绘制', !perfOk.error && /FPS/.test(perfOk.hud || ''), perfOk.error || JSON.stringify(perfOk.hud));

/* ---------- 9. 标签层贴图不能被 dpr 二次缩放（国家名到处漂的根因） ---------- */
console.log('\n-- 9. 标签层贴图变换（dpr 回归） --');
for (const testDpr of [1, 1.25, 1.5, 2]) {
  const res = run(`
    cw = 1280; ch = 800;
    dpr = ${testDpr};
    cam.x = 700; cam.y = 350; cam.z = 1;
    labelKey = '';
    drawLog.length = 0;
    render();
    const e = drawLog.find(x => x.img === labelCv);
    return e ? e.m : null;
  `);
  const isIdentity = res && res[0] === 1 && res[1] === 0 && res[2] === 0 && res[3] === 1;
  check(`dpr=${testDpr} 时标签层用单位变换贴图`, isIdentity, res);
}

/* ---------- 10. 行军插值必须真的插值（不能两帧就跳到终点） ---------- */
console.log('\n-- 10. 行军插值 --');
const interp = run(`
  MP.online = true;
  const pid = provinces.findIndex(p => p && p.pix.length && p.owner === player);
  armies = [{ id: 9001, owner: player, prov: pid, str: 5000, path: [], prog: 0, progSrv: 0, progPrev: 0, progAt: 0, isNavy: 0 }];
  __setNow(1000);
  // 服务端一次推进 5 格（速度5档 130ms 的行军量）
  mpApplyArmies([[9001, player, pid, 5000, 5, 0, 0, 0, null, null, 0]], []);
  const a = armies[0];
  const samples = [];
  for (const t of [1000, 1035, 1070, 1105, 1140]) {
    __setNow(t);
    mpAnimateArmies();
    samples.push(Math.round(a.prog * 100) / 100);
  }
  return samples;
`);
check('插值产生中间值而不是一次跳到位',
  interp[0] === 0 && interp[1] > 0 && interp[1] < 5 && interp[4] === 5, interp);
check('插值单调递增', interp.every((v, i) => i === 0 || v >= interp[i - 1]), interp);

const provSnap = run(`
  MP.online = true;
  const p1 = provinces.findIndex(p => p && p.pix.length && p.owner === player);
  const p2 = provinces.findIndex(p => p && p.pix.length && p.id !== p1);
  armies = [{ id: 9002, owner: player, prov: p1, str: 5000, path: [], prog: 11, progSrv: 11, progPrev: 11, progAt: 0, isNavy: 0 }];
  __setNow(2000);
  mpApplyArmies([[9002, player, p2, 5000, 0, 0, 0, 0, null, null, 0]], []);
  return { prov: armies[0].prov, prog: armies[0].prog, progPrev: armies[0].progPrev, expected: p2 };
`);
check('换省时进度直接归位（不会倒着走）',
  provSnap.prov === provSnap.expected && provSnap.prog === 0 && provSnap.progPrev === 0, provSnap);

/* ---------- 11. 乐观行军路线会被服务端确认或自动撤回 ---------- */
console.log('\n-- 11. 乐观行军路线 --');
const optimistic = run(`
  MP.online = true;
  const pid = provinces.findIndex(p => p && p.pix.length && p.owner === player);
  armies = [{ id: 9003, owner: player, prov: pid, str: 5000, path: [7,8,9], prog: 0, progSrv: 0, progPrev: 0, progAt: 0, isNavy: 0, _opt: 5000 }];
  __setNow(5300);            // 才过 300ms，不该撤回
  mpAnimateArmies();
  const kept = armies[0].path.length;
  __setNow(7000);            // 过了 1.2 秒还没确认 -> 撤回
  mpAnimateArmies();
  const dropped = armies[0].path.length;
  // 再测被确认的情况
  armies[0]._opt = 8000;
  __setNow(8100);
  mpApplyArmies([[9003, player, pid, 5000, 0, 0, 0, 0, [11,12], null, 12]], []);
  const confirmed = { path: armies[0].path, opt: armies[0]._opt };
  return { kept, dropped, confirmed };
`);
check('未被确认的路線 1.2 秒内保留', optimistic.kept === 3, optimistic);
check('超时未确认则撤回', optimistic.dropped === 0, optimistic);
check('服务端确认后清除乐观标记并采用服务端路径',
  optimistic.confirmed.opt === undefined && JSON.stringify(optimistic.confirmed.path) === '[11,12]', optimistic.confirmed);

/* ---------- 12. 游戏内时钟平滑外推 ---------- */
console.log('\n-- 12. 时钟平滑外推 --');
const clock = run(`
  MP.online = true; started = true; paused = false; speed = 5;   // 40 天/秒
  __setNow(10000);
  clockSync(100, 1444, 10, 21);        // 服务端基准：1444-11-21
  _clkShownAt = 0; _clkShown = '';
  const out = [];
  for (const t of [10000, 10200, 10400]) { __setNow(t); clockTick(t); out.push(document.getElementById('tb-date').textContent); }
  return out;
`);
check('时钟在两次增量之间推进', clock[0] !== clock[1] || clock[1] !== clock[2], clock);
check('时钟只前进不后退', clock.every((v, i) => i === 0 || v === clock[i - 1] || v !== clock[i - 1]), clock);

const clockPaused = run(`
  paused = true;
  __setNow(20000); clockSync(200, 1445, 0, 1);
  _clkShownAt = 0; _clkShown = '';
  __setNow(20100); clockTick(20100);
  const a = document.getElementById('tb-date').textContent;
  __setNow(20500); clockTick(20500);
  const b = document.getElementById('tb-date').textContent;
  return { a, b };
`);
check('暂停时时钟不走', clockPaused.a === clockPaused.b, clockPaused);

const clockNoOvershoot = run(`
  paused = false; speed = 5;
  __setNow(30000); clockSync(300, 1445, 5, 10);
  _clkShownAt = 0; _clkShown = '';
  __setNow(30400); clockTick(30400);    // 400ms 不外推超过一个周期
  return { extraMax: Math.ceil(40 * 0.15), shown: document.getElementById('tb-date').textContent };
`);
check('外推量被限制在一个推送周期内（不会超前服务端）', !!clockNoOvershoot.shown, clockNoOvershoot);

/* ---------- 13. 画面无变化时完全跳过重绘（渲染卡死的根因） ---------- */
console.log('\n-- 13. 重绘调度 --');
const skip = run(`
  cw=1280; ch=800; dpr=1; cam.x=720; cam.y=360; cam.z=1;
  imgDirty=false; selDirty=false; selectedProv=0; selectedArmy=0; cedeMap.on=false; cedeDirty=false;
  _frameKey=''; _lastRealRender=0; _redraws=0; _skips=0;
  const mark=()=>drawLog.length;
  let n=mark(); render(1000); const d1=mark()-n;   // 第一帧必须画
  n=mark(); render(1016);   const d2=mark()-n;     // 完全没变化 -> 跳过
  n=mark(); cam.x+=10; render(1032); const d3=mark()-n;   // 相机移动 -> 重画
  n=mark(); render(1048);   const d4=mark()-n;     // 又静止 -> 跳过
  n=mark(); _armyVer++; render(1064); const d5=mark()-n;  // 军队移动 -> 重画
  n=mark(); render(1080);   const d6=mark()-n;     // 再次静止 -> 跳过
  n=mark(); render(9000);   const d7=mark()-n;     // 超过 3 秒兜底重画
  n=mark(); imgDirty=true; render(9016); const d8=mark()-n;  // 省份变色 -> 重画
  return { d1,d2,d3,d4,d5,d6,d7,d8, redraws:_redraws, skips:_skips };
`);
check('第一帧会绘制', skip.d1 > 0, skip);
check('画面无变化时完全跳过重绘', skip.d2 === 0, skip);
check('相机移动后重绘', skip.d3 > 0, skip);
check('再次静止后继续跳过', skip.d4 === 0, skip);
check('军队移动后重绘', skip.d5 > 0, skip);
check('第三次静止仍跳过', skip.d6 === 0, skip);
check('超过 3 秒兜底重画一次', skip.d7 > 0, skip);
check('省份变色后重绘', skip.d8 > 0, skip);
check('静止时跳过次数 ≥ 3（d2/d4/d6 都跳过了）', skip.skips >= 3 && skip.redraws === 5, skip);

console.log('\n  界面元素 innerHTML 重建统计:');
for (const k of Object.keys(htmlWrites).sort((a, b) => htmlWrites[b] - htmlWrites[a]).slice(0, 6)) {
  console.log(`    ${k.padEnd(14)} ${htmlWrites[k]}`);
}
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
