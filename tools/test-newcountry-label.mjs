// 验证：新建国家后名字要立刻显示（不需要刷新）
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
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false, prompt: () => 'X',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 新建国家后名字立刻显示 ===\n');

/* ================= 1. 复现：pr + cn 在同一个增量里 ================= */
console.log('-- 1. 同一增量里先建国家再划地 --');
const t1 = run(`
  resetWorld(); buildWorld();
  player=140; MP.online=true; started=true; setHumans([140,44]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const newId=countries.length;                 // 服务端会分配这个 id
  const myProvListLen=me.provList.length;
  // 服务端 foundVassal 之后同一帧广播出去的增量：cn（新国家）+ pr（该省划过去）
  mpDelta({ d: {
    cn: [[newId, '新罗马', [200,120,90], pid]],
    pr: [[pid, newId, newId, 0]],
  }});
  const nc=countries[newId];
  return {
    newId, exists:!!nc, name:nc?nc.name:null,
    provListLen:nc?nc.provList.length:0,
    capital:nc?nc.capital:0,
    lx:nc?nc.lx:0, ly:nc?nc.ly:0,
    labelsDirty:labelsDirty,
    owner:provinces[pid].owner,
    overlordLost: myProvListLen - me.provList.length,
    mpCap: nc?nc.mpCap:0,
  };
`);
check('客户端建出了新国家', t1.exists === true && t1.name === '新罗马', t1);
check('【关键】新国家拿到了那块省的 provList', t1.provListLen === 1, t1);
check('【关键】标签位置已算出（lx/ly 非 0），名字会立刻显示', t1.lx !== 0 && t1.ly !== 0, t1);
check('省份归属正确', t1.owner === t1.newId, t1);
check('宗主少了那一省', t1.overlordLost === 1, t1);
check('新国家的人力上限已按领土算出', t1.mpCap > 0, t1);

/* ================= 2. 对照：如果顺序反了会怎样 ================= */
console.log('\n-- 2. 对照实验（说明为什么顺序重要） --');
const t2 = run(`
  resetWorld(); buildWorld();
  player=140; MP.online=true; started=true;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const newId=countries.length;
  // 故意用旧顺序：先 pr 后 cn
  mpDelta({ d: { pr:[[pid,newId,newId,0]], cn:[[newId,'旧顺序',[1,2,3],pid]] } });
  const nc=countries[newId];
  return { provListLen:nc?nc.provList.length:0, lx:nc?nc.lx:0 };
`);
// 说明：现在的实现已经把 cn 提到前面，所以这里两个顺序结果都一样
check('（当前实现已修正顺序，两种写法结果一致）', t2.provListLen === 1 && t2.lx !== 0, t2);

/* ================= 3. 省份在后续增量才到 ================= */
console.log('\n-- 3. 国家先建、省份后到 --');
const t3 = run(`
  resetWorld(); buildWorld();
  player=140; MP.online=true; started=true;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const newId=countries.length;
  mpDelta({ d: { cn: [[newId,'迟到国',[9,9,9],pid]] } });     // 只有国家
  const midLx=countries[newId].lx;
  mpDelta({ d: { pr: [[pid,newId,newId,0]] } });               // 省份晚一帧
  const nc=countries[newId];
  return { midLx, provListLen:nc.provList.length, lx:nc.lx, labelsDirty };
`);
check('只有国家时还没有标签位置', t3.midLx === 0, t3);
check('省份到达后拿到第一块地并重算了标签', t3.provListLen === 1 && t3.lx !== 0, t3);

/* ================= 4. 外交列表立刻能看到新国家 ================= */
console.log('\n-- 4. 外交列表立刻出现新国家 --');
const t4 = run(`
  resetWorld(); buildWorld();
  player=140; MP.online=true; started=true; uiTab='diplo'; diploFocus=0; uiSearch='';
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const newId=countries.length;
  mpDelta({ d: { cn: [[newId,'立刻可见国',[30,200,90],pid]], pr: [[pid,newId,newId,0]] } });
  uiTick(performance.now()+10000);      // 触发节流后的面板刷新
  const h=document.getElementById('diplo-list').innerHTML;
  return { listed:h.includes('立刻可见国') };
`);
check('外交列表里立刻出现新国家', t4.listed === true, t4);

/* ================= 5. 渲染层确实会画它的名字 ================= */
console.log('-- 5. 渲染层 --');
const t5 = run(`
  resetWorld(); buildWorld();
  player=140; MP.online=true; started=true;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const newId=countries.length;
  mpDelta({ d: { cn: [[newId,'渲染测试国',[30,200,90],pid]], pr: [[pid,newId,newId,0]] } });
  // drawLabels 会跳过 !cc.lx 的国家，这里直接验证条件成立
  const nc=countries[newId];
  return { alive:nc.alive, lx:nc.lx, drawn: !!(nc && nc.alive && nc.lx) };
`);
check('drawLabels 会绘制这个新国家（alive 且 lx 非 0）', t5.drawn === true, t5);

/* ================= 6. 回归 ================= */
console.log('\n-- 6. 回归 --');
const t6 = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<900;i++) tickDay();
  return { day:dayCount, armies:armies.length };
`);
check('模拟 900 天无异常', t6.day === 900 && t6.armies > 0, t6);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
