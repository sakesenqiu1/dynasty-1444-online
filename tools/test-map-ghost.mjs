// 回归测试：拖动地图不能出现残影
//   核心不变量：每帧画完之后，整块画布必须被「海色填充 + 不透明地图」完全覆盖。
//   之前为了省一次全屏填充，改成地图铺满时不填海，但地图层的海洋像素是透明的，
//   于是海洋区域从没被清过，旧画面透出来 —— 拖动时就是无数残影重叠。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };

const noop = () => {};
const fills = [];          // 记录 fillRect（含当时变换）
const watched = { draws: [] };

function ctx2d() {
  const c = {
    canvas: null, _m: [1, 0, 0, 1, 0, 0], _stack: [],
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', imageSmoothingEnabled: true,
    setTransform(a, b, cc, d, e, f) { this._m = [a, b, cc, d, e, f]; },
    save() { this._stack.push(this._m.slice()); },
    restore() { if (this._stack.length) this._m = this._stack.pop(); },
    translate: noop, scale: noop, clearRect: noop, strokeRect: noop, putImageData: noop,
    fillRect(x, y, w, h) { fills.push({ m: this._m.slice(), x, y, w, h, color: this.fillStyle }); },
    drawImage(img, x, y) { watched.draws.push({ img, m: this._m.slice(), x, y }); },
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, stroke: noop, fill: noop,
    setLineDash: noop, strokeText: noop, fillText: noop,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return c;
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
  noop, addEventListener: noop, innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
sb.fills = fills;
sb.watched = watched;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 地图残影回归测试 ===\n');
run('resetWorld(); buildWorld(); player=140; started=true; MP.online=true;');

/* ================= 1. 地图层必须完全不透明 ================= */
console.log('-- 1. 地图层不透明度 --');
const op = run(`
  const d=imgData.data;
  let opaque=0, seaOK=0, total=d.length/4;
  const r=parseInt(SEA.slice(1,3),16), g=parseInt(SEA.slice(3,5),16), b=parseInt(SEA.slice(5,7),16);
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]===255) opaque++;
    if(d[i+3]===255&&d[i]===r&&d[i+1]===g&&d[i+2]===b) seaOK++;
  }
  // 随便找一个海洋像素（非省份像素）
  let seaPix=-1;
  for(let i=0;i<land.length;i++) if(land[i]===0){ seaPix=i; break; }
  return { total, opaque, seaOK, seaPix, seaColor: seaPix>=0?[d[seaPix*4],d[seaPix*4+1],d[seaPix*4+2],d[seaPix*4+3]]:null, wantSea:[r,g,b,255] };
`);
check(`地图层全部像素不透明（${op.opaque}/${op.total}）`, op.opaque === op.total, { opaque: op.opaque, total: op.total });
check('海洋像素已预填海色', op.seaColor && op.seaColor.join(',') === op.wantSea.join(','), { got: op.seaColor, want: op.wantSea });

/* ================= 2. 重绘省份不会破坏海洋像素 ================= */
console.log('\n-- 2. 重绘省份后仍不透明 --');
const op2 = run(`
  recolorAll();
  const d=imgData.data; let opaque=0;
  for(let i=0;i<d.length;i+=4) if(d[i+3]===255) opaque++;
  return { opaque, total:d.length/4 };
`);
check('recolorAll 后仍全部不透明', op2.opaque === op2.total, op2);

/* ================= 3. 每帧必须把整块画布盖住 ================= */
console.log('\n-- 3. 每帧覆盖不变量（不同相机位置）--');
function coverage(camX, camY, camZ, cw, ch) {
  return run(`
    cw=${cw}; ch=${ch}; dpr=1;
    cam.x=${camX}; cam.y=${camY}; cam.z=${camZ};
    fills.length=0; watched.draws.length=0; _frameKey=''; imgDirty=false; selDirty=false; cedeMap.on=false;
    labelKey=''; _labelHasContent=false;
    render(1000);
    // 收集海色填充矩形（换算到屏幕 CSS 像素）
    const rects=[];
    for(const f of fills){
      if(f.color!==SEA) continue;
      const m=f.m;
      // 变换是 (dpr,0,0,dpr,0,0)：直接用 x,y,w,h
      rects.push([f.x, f.y, f.x+f.w, f.y+f.h]);
    }
    // 地图层矩形（不透明，等价于一块覆盖）
    let mapRect=null;
    const found=watched.draws.find(z=>z.img===provCv);
    if(found){
      const m=found.m;
      mapRect=[ m[4], m[5], m[4]+COLS*m[0], m[5]+ROWS*m[3] ];
    }
    // 用 8x8 的格点采样，检查每个点是否被"地图或海色填充"覆盖
    let miss=0, samples=0;
    for(let gy=0; gy<=8; gy++){
      for(let gx=0; gx<=8; gx++){
        const x=(cw-0.5)*gx/8+0.5, y=(ch-0.5)*gy/8+0.5;
        samples++;
        let hit=false;
        if(mapRect && x>=Math.max(0,mapRect[0]) && x<=Math.min(cw,mapRect[2]) && y>=Math.max(0,mapRect[1]) && y<=Math.min(ch,mapRect[3])) hit=true;
        if(!hit) for(const r of rects) if(x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]){ hit=true; break; }
        if(!hit) miss++;
      }
    }
    return { miss, samples, mapRect, rects };
  `);
}
const cases = [
  ['默认开局视角 z=3（旧 bug 触发点）', 720, 360, 3],
  ['完全缩小 z=1', 720, 360, 1],
  ['缩小并偏到左上角', 200, 150, 1],
  ['缩小并偏到右下角', 1300, 650, 1],
  ['放大到 z=8', 720, 360, 8],
  ['放大到角落 z=12', 60, 400, 12],
  ['极端缩小 z=0.6', 720, 360, 0.6],
  ['极端缩小 + 偏角', 1400, 700, 0.6],
];
for (const [label, x, y, z] of cases) {
  const r = coverage(x, y, z, 1920, 1080);
  check(`${label}：画布被完整覆盖`, r.miss === 0, { 未覆盖采样点: r.miss, 地图: r.mapRect, 填充块数: r.rects.length });
}

/* ================= 4. 不同分辨率 / 屏幕缩放 ================= */
console.log('\n-- 4. 不同分辨率与屏幕缩放 --');
for (const [label, cw, ch, dpr2] of [['1366x768 dpr1', 1366, 768, 1], ['2560x1440 dpr1.5', 2560, 1440, 1.5], ['3840x2160 dpr2', 3840, 2160, 2]]) {
  const r = run(`
    cw=${cw}; ch=${ch}; dpr=${dpr2};
    cam.x=720; cam.y=360; cam.z=3;
    fills.length=0; watched.draws.length=0; _frameKey=''; imgDirty=false; selDirty=false; cedeMap.on=false;
    labelKey=''; _labelHasContent=false;
    render(1000);
    let miss=0, samples=0;
    let mapRect=null;
    const found=watched.draws.find(z=>z.img===provCv);
    if(found){
      const m=found.m;
      // 设备像素 -> CSS 像素
      mapRect=[ m[4]/dpr, m[5]/dpr, (m[4]+COLS*m[0])/dpr, (m[5]+ROWS*m[3])/dpr ];
    }
    const rects=[];
    for(const f of fills){ if(f.color!==SEA) continue; rects.push([f.x, f.y, f.x+f.w, f.y+f.h]); }
    for(let gy=0; gy<=8; gy++) for(let gx=0; gx<=8; gx++){
      const x=(cw-0.5)*gx/8+0.5, y=(ch-0.5)*gy/8+0.5;
      samples++;
      let hit=false;
      if(mapRect && x>=Math.max(0,mapRect[0]) && x<=Math.min(cw,mapRect[2]) && y>=Math.max(0,mapRect[1]) && y<=Math.min(ch,mapRect[3])) hit=true;
      if(!hit) for(const r of rects) if(x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]){ hit=true; break; }
      if(!hit) miss++;
    }
    return { miss, samples, mapRect };
  `);
  check(`${label}：画布被完整覆盖`, r.miss === 0, r);
}

/* ================= 5. 回归 ================= */
console.log('\n-- 5. 回归 --');
const reg = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<600;i++) tickDay();
  return { day:dayCount, armies:armies.length };
`);
check('模拟 600 天无异常', reg.day === 600 && reg.armies > 0, reg);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
