// 地图外观回归测试：真实浏览器（headless Edge + CDP）加载本地服务，
// 检查三级比例尺的分层、地形/浅海/城镇是否真的画出来了，并把各档截图落盘，
// 方便人工核对「底图是否好看」。
//
//   node _tools/test-map-visual.mjs                    # 跑本地服务
//   GS_URL=https://... node _tools/test-map-visual.mjs # 直接测已部署的站点
//
// 截图输出到 _shots/（可用 GS_SHOTS 改）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = 7801;
const BASE = '/gs';
const CDP_PORT = 9351;
// 默认找 Edge；也可以用 GS_EDGE 指到 Chrome/Chromium
const EDGE = process.env.GS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WORLD_READY = "typeof countries!=='undefined' && countries.length>100";
const SHOTS = process.env.GS_SHOTS || join(root, '_shots');
// 设了 GS_URL 就直接测已部署的站点，不再本地起服务
const LIVE_URL = process.env.GS_URL || '';
const TARGET = LIVE_URL || `http://127.0.0.1:${PORT}${BASE}/`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const TERRN = (i) => ['—', '平原', '草原', '森林', '雨林', '沙漠', '丘陵', '山地', '雪峰', '针叶林', '苔原', '沼泽', '稀树草原'][i] || ('#' + i);

mkdirSync(SHOTS, { recursive: true });

const srv = LIVE_URL ? null : spawn(process.execPath, [join(root, 'srv', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE },
  stdio: 'ignore',
});
const profile = mkdtempSync(join(tmpdir(), 'gsmap-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--mute-audio',
  '--disable-dev-shm-usage', '--remote-allow-origins=*', '--window-size=1280,800',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const origin = `http://127.0.0.1:${CDP_PORT}`;
let ver = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${origin}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch (e) {}
  await sleep(400);
}
if (!ver) { console.error('Edge CDP not ready'); if (srv) srv.kill(); edge.kill(); process.exit(1); }
log('CDP ready: ' + ver.Browser);

/* 先把服务等起来，否则页面根本加载不出来，报错会指向 CDP 而不是服务端 */
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(TARGET); if (r.ok) { up = true; break; } } catch (e) {}
  await sleep(250);
}
if (!up) { console.error(`${TARGET} 打不开`); if (srv) srv.kill(); edge.kill(); process.exit(1); }
log('目标站点已就绪: ' + TARGET);

class Page {
  constructor() { this.id = 0; this.pending = new Map(); this.errs = []; }
  static async open(url) {
    const r = await fetch(`${origin}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const tab = await r.json();
    const p = new Page(); p.tab = tab;
    p.ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((res, rej) => { p.ws.on('open', res); p.ws.on('error', rej); });
    p.ws.on('message', (raw) => p._onMessage(raw));
    await p.send('Runtime.enable'); await p.send('Log.enable'); await p.send('Page.enable');
    return p;
  }
  _onMessage(raw) {
    const m = JSON.parse(raw.toString());
    if (m.id !== undefined && this.pending.has(m.id)) {
      const { res, rej, timer } = this.pending.get(m.id);
      this.pending.delete(m.id); clearTimeout(timer);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.errs.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      this.errs.push('CONSOLE: ' + m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 200));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const e = m.params.entry;
      this.errs.push('LOG: ' + (e.url ? e.url + ' ' : '') + e.text.slice(0, 200));
    }
  }
  send(method, params, ms = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, ms);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(function(){ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
    return r.result.value;
  }
  async waitFor(expr, timeout = 60000, label = expr) {
    const start = Date.now(); let lastErr = '';
    while (Date.now() - start < timeout) {
      try { if (await this.eval(`return !!(${expr})`)) return true; } catch (e) { lastErr = e.message; }
      await sleep(200);
    }
    throw new Error('timeout waiting: ' + label + (lastErr ? ' (' + lastErr + ')' : ''));
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const f = join(SHOTS, name + '.png');
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

console.log('\n=== 地图外观测试 ===\n');

const p = await Page.open(TARGET);
try {
  await p.waitFor(WORLD_READY, 90000, 'world build');
  await p.waitFor("document.getElementById('loading').classList.contains('hidden')", 60000, 'loading hidden');
} catch (e) {
  console.error('\n页面没能进入游戏：' + e.message);
  const diag = [
    ["url/readyState", "return document.readyState+' '+location.href"],
    ["loading 文本", "return (document.getElementById('ld-msg')||{}).textContent"],
    ["countries", "return typeof countries==='undefined'?'undefined':countries.length"],
    ["provinces", "return typeof provinces==='undefined'?'undefined':provinces.length"],
    ["terrHi", "return typeof terrHi"],
    ["ensureTerrain", "return typeof ensureTerrain"],
    ["ensureTownLayer", "return typeof ensureTownLayer"],
  ];
  for (const [k, code] of diag) {
    try { console.error('  ' + k.padEnd(14) + ': ' + await p.eval(code)); }
    catch (e2) { console.error('  ' + k.padEnd(14) + ': <eval 失败> ' + e2.message); }
  }
  console.error('  页面报错       : ' + (p.errs.slice(0, 8).join(' || ') || '(无)'));
  p.close(); if (srv) srv.kill(); edge.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e3) {}
  process.exit(1);
}
log('世界构建完成');

/* 把镜头挪到指定位并强制重画一帧（LOD 换档也在这时发生）。
   坐标写的是「旋转前」的列号，由 __view 统一减去 MAP_SHIFT 的地图接缝偏移。 */
const VIEW = `window.__view=(z,x,y)=>{ cam.z=z; cam.x=x-MAP_SHIFT; cam.y=y; _frameKey=''; render(performance.now()); return lodTier; };`;

/* ---- 地形层 ---- */
const terr = await p.eval(`
  ${VIEW}
  return { ms:Math.round(_terrMs), hist:_terrHist, hi:!!terrHi, lo:!!terrLo,
           shadeMean:Math.round(_shadeMean), shadeSd:Math.round(_shadeSd*10)/10,
           shadeSdLo:Math.round(_shadeSdLo*10)/10,
           n:provinces.length, biomes:TERR_BIOME.length };
`);
log(`地形生成耗时 ${terr.ms}ms，细坡向 σ=${terr.shadeSd}，粗坡向 σ=${terr.shadeSdLo}`);
check('地形层已生成（两级分辨率）', terr.hi && terr.lo);
const total = (terr.hist || []).reduce((a, b) => a + b, 0);
check('地形覆盖全部陆地像素 (' + total + ')', total > 100000, total);
const kinds = (terr.hist || []).map((n, i) => [i, n]).filter(([i, n]) => i > 0 && n / total > 0.004);
check('至少 6 种地貌且都有可观面积', kinds.length >= 6, kinds.map(([i, n]) => TERRN(i) + ':' + (n / total * 100).toFixed(1) + '%'));
check('存在沙漠（回归线干旱带）', (terr.hist[5] || 0) / total > 0.01, ((terr.hist[5] || 0) / total * 100).toFixed(2) + '%');
check('存在森林/针叶林', ((terr.hist[3] || 0) + (terr.hist[9] || 0)) / total > 0.05, (((terr.hist[3] || 0) + (terr.hist[9] || 0)) / total * 100).toFixed(2) + '%');
check('存在山地/雪峰', ((terr.hist[7] || 0) + (terr.hist[8] || 0)) / total > 0.03, (((terr.hist[7] || 0) + (terr.hist[8] || 0)) / total * 100).toFixed(2) + '%');
check('存在苔原/冰原（高纬）', (terr.hist[10] || 0) / total > 0.005, ((terr.hist[10] || 0) / total * 100).toFixed(2) + '%');
check('坡向明暗是连续渐变而非台阶 (细 σ=' + terr.shadeSd + ')', terr.shadeSd > 12, terr.shadeSd);
check('粗地形也有可见起伏 (σ=' + terr.shadeSdLo + ')', terr.shadeSdLo > 22, terr.shadeSdLo);
check('地形生成足够快 (<1200ms)', terr.ms < 1200, terr.ms + 'ms');

/* ---- 三级比例尺 ---- */
const lod = await p.eval(`
  ${VIEW}
  const out={};
  out.world = __view(0.9,720,320);
  out.mid   = __view(2.4,742,196);
  out.hi    = __view(6.0,748,190);
  out.hysterUp = __view(1.62,742,196);   // 刚过阈值
  out.hysterBack = __view(1.50,742,196); // 退回来但在迟滞带内，不应掉档
  out.deep = __view(18,744,192);
  out.back = __view(0.9,720,320);
  return out;
`);
check('小比例尺 = 0 档（只看国家版图）', lod.world === 0, lod.world);
check('中比例尺 = 1 档（国家+省界、粗地形）', lod.mid === 1, lod.mid);
check('大比例尺 = 2 档（细地形+城镇）', lod.hi === 2, lod.hi);
check('放到最大仍是 2 档', lod.deep === 2, lod.deep);
check('回到小比例尺会退回 0 档', lod.back === 0, lod.back);
check('阈值附近有迟滞，不会来回抖', lod.hysterUp === 1 && lod.hysterBack === 1,
  lod.hysterUp + '/' + lod.hysterBack);

/* ---- 省界的显示 / 隐藏（边界在独立的 bordCv 层，用 alpha 判断） ---- */
const bord = await p.eval(`
  ${VIEW}
  let pid=-1, qid=-1;
  for(let i=1;i<provinces.length&&pid<0;i++){
    const p=provinces[i]; if(!p||!p.pix.length) continue;
    for(const [q,arr] of p.borderPix){
      const qp=provinces[q];
      // 省界只画 id 小的一侧，所以取样也要挑 p.id<q 的那一半
      if(qp&&qp.controller===p.controller&&arr.length>=6&&p.id<q){ pid=i; qid=q; break; }
    }
  }
  if(pid<0) return null;
  const p=provinces[pid];
  const provArr=p.borderPix.get(qid);
  // 单独找一个「控制权不同」的边界做对照（开局时=跨国边界）
  let ctryArr=null;
  for(let i=1;i<provinces.length&&!ctryArr;i++){
    const q=provinces[i]; if(!q||!q.pix.length) continue;
    for(const [o,a] of q.borderPix){
      const op=provinces[o];
      if(op&&op.controller!==q.controller&&a.length>=6){ ctryArr=a; break; }
    }
  }
  const meanA=(a)=>{ let s=0; for(const x of a) s+=bordData.data[x*4+3]; return Math.round(s/a.length); };
  const measure=()=>{ bordDirty=true; _frameKey=''; render(performance.now());
    return { prov:meanA(provArr), ctry:ctryArr?meanA(ctryArr):null }; };
  __view(0.9,720,320);  const small=measure();
  __view(2.4,742,196);  const medium=measure();
  __view(6.0,748,190);  const large=measure();
  return { small, medium, large, prov:p.id, provName:p.name,
           tiny:(()=>{ let n=0; for(let i=1;i<provinces.length;i++){ const q=provinces[i]; if(q&&q.pix.length&&q.pix.length<TINY_PIX) n++; } return n; })(),
           tinyPix:TINY_PIX };
`);
log(`边界层不透明度：省界 小 ${bord.small.prov} / 中 ${bord.medium.prov} / 大 ${bord.large.prov}` +
    `，国界 小 ${bord.small.ctry} / 中 ${bord.medium.ctry} / 大 ${bord.large.ctry}`);
check('小比例尺不画省界（边界层该处完全透明）', bord && bord.small.prov === 0, bord && bord.small.prov);
check('中比例尺画出省界', bord && bord.medium.prov > 60, bord && bord.medium.prov);
check('大比例尺仍有省界', bord && bord.large.prov > 60, bord && bord.large.prov);
check('国界在任何比例尺都画（而且比省界实）',
  bord && bord.medium.ctry > bord.medium.prov && bord.small.ctry > 200,
  bord && (bord.small.ctry + '/' + bord.medium.ctry));

/* ---- 碎地块在小/中比例尺并入海面 ---- */
const tiny = await p.eval(`
  ${VIEW}
  let pid=-1;
  for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(p&&p.pix.length&&p.pix.length<TINY_PIX){ pid=i; break; } }
  if(pid<0) return null;
  const p=provinces[pid];
  const px=(idx)=>{ const o=idx*4,d=imgData.data; return d[o]+','+d[o+1]+','+d[o+2]; };
  // 同一个像素旁边那片海：丢岛之后颜色必须和它一模一样，才看不出这里原本有个岛
  const sample=()=>{
    const idx=p.pix[0], r=(idx/COLS)|0, c=idx%COLS;
    const cand=[c>0?idx-1:-1, c+1<COLS?idx+1:-1, r>0?idx-COLS:-1, r+1<ROWS?idx+COLS:-1];
    let seaIdx=-1;
    for(const j of cand) if(j>=0&&!provOf[j]&&seaCol&&seaCol[j]){ seaIdx=j; break; }
    return { got:px(idx), sea: seaIdx>=0?px(seaIdx):'(无海邻居)' };
  };
  __view(0.9,720,320);  const small=sample();
  __view(2.4,742,196);  const medium=sample();
  __view(6.0,748,190);  const big=sample();
  return { pid, n:p.pix.length, small, medium, big };
`);
check(`碎地块有 ${bord.tiny} 个（<${bord.tinyPix}px）`, bord.tiny > 10, bord.tiny);
check('小比例尺下碎地块并入海面（与旁边海水颜色一致）', tiny.small.got === tiny.small.sea, tiny.small);
check('中比例尺下碎地块并入海面（与旁边海水颜色一致）', tiny.medium.got === tiny.medium.sea, tiny.medium);
check('大比例尺下碎地块照常画出来', tiny.big.got !== tiny.big.sea, tiny.big);

/* ---- 1~2 像素的碎岛已经在世界生成阶段被取消 ---- */
const pruned = await p.eval(`
  let min=1e9, n2=0, alive=0;
  for(let i=1;i<provinces.length;i++){
    const q=provinces[i]; if(!q) continue;
    if(q.pix.length){ alive++; if(q.pix.length<min) min=q.pix.length; if(q.pix.length<=2) n2++; }
  }
  // 被取消的省份记录还在（编号不变），只是没有像素、不属于任何国家
  const holes=provinces.filter(q=>q&&!q.pix.length).length;
  const orphan=provinces.filter(q=>q&&!q.pix.length&&q.owner).length;
  return { min, n2, alive, holes, orphan, limit:TINY_ISLAND_PIX };
`);
check(`1~2 像素的碎岛已从世界取消（最小省份 ${pruned.min} 像素）`, pruned.n2 === 0 && pruned.min > 2, pruned);
check('取消的省份记录仍保留（编号不变，老地图还能对得上）', pruned.holes > 0, pruned.holes);
check('被取消的省份不再属于任何国家', pruned.orphan === 0, pruned.orphan);

/* ---- 两端世界必须一模一样 ----
   浏览器是分步建图（要显示加载进度），服务端是一口气 buildWorld()，
   曾经因为客户端自己抄了一遍步骤、漏掉「取消碎岛」和「接缝旋转」，
   两端的栅格错开了 45 列（海军航路会画错位置）。这里逐项比对。 */
const ref = await (async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
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
  const c = vm.createContext(sb);
  vm.runInContext(readFileSync(join(root, 'web/world_data.js'.replace('_', '-')), 'utf8'), c);
  vm.runInContext(readFileSync(join(root, 'web/game-core.js'), 'utf8'), c);
  return vm.runInContext(`(function(){
    resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
    let pixSum=0, holes=0, minPix=1e9, provSum=0;
    for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(!p) continue;
      provSum=(provSum+i*p.pix.length)%2147483647;
      pixSum+=p.pix.length; if(!p.pix.length) holes++; else if(p.pix.length<minPix) minPix=p.pix.length; }
    let provOfSum=0, landSum=0;
    for(let i=0;i<NPIX;i++){ provOfSum=(provOfSum*31+provOf[i])%2147483647; landSum=(landSum*31+land[i])%2147483647; }
    return { n:provinces.length, pixSum, holes, minPix, provSum, provOfSum, landSum, shift:MAP_SHIFT };
  })()`, c, { filename: 'ref' });
})();
const browserWorld = await p.eval(`
  let pixSum=0, holes=0, minPix=1e9, provSum=0;
  for(let i=1;i<provinces.length;i++){ const q=provinces[i]; if(!q) continue;
    provSum=(provSum+i*q.pix.length)%2147483647;
    pixSum+=q.pix.length; if(!q.pix.length) holes++; else if(q.pix.length<minPix) minPix=q.pix.length; }
  let provOfSum=0, landSum=0;
  for(let i=0;i<NPIX;i++){ provOfSum=(provOfSum*31+provOf[i])%2147483647; landSum=(landSum*31+land[i])%2147483647; }
  return { n:provinces.length, pixSum, holes, minPix, provSum, provOfSum, landSum, shift:MAP_SHIFT };
`);
log(`世界指纹 浏览器 ${browserWorld.provOfSum}/${browserWorld.landSum}  服务端内核 ${ref.provOfSum}/${ref.landSum}`);
check('浏览器和内核建出同一个世界（陆地像素数）', browserWorld.pixSum === ref.pixSum, [browserWorld.pixSum, ref.pixSum]);
check('两端 provOf 栅格逐像素一致', browserWorld.provOfSum === ref.provOfSum, [browserWorld.provOfSum, ref.provOfSum]);
check('两端 land 栅格逐像素一致', browserWorld.landSum === ref.landSum, [browserWorld.landSum, ref.landSum]);
check('两端省份数 / 空省份数一致', browserWorld.n === ref.n && browserWorld.holes === ref.holes,
  [browserWorld.n, browserWorld.holes, ref.n, ref.holes]);
check('两端已取消的碎岛一致（最小省份像素数）', browserWorld.minPix === ref.minPix, [browserWorld.minPix, ref.minPix]);

/* ---- 东西环绕：世界是周期性的，跨过接缝能接着走下去 ---- */
const wrap = await p.eval(`
  ${VIEW}
  window.__sig=()=>{
    const W=mapCv.width, H=mapCv.height, d=ctx.getImageData(0,0,W,H).data;
    let s=0;
    for(let y=2;y<H;y+=23) for(let x=2;x<W;x+=17){ const o=(y*W+x)*4; s=(Math.imul(s,31)+d[o]+d[o+1]*3+d[o+2]*7)|0; }
    return s;
  };
  const sigAt=(x,y,z)=>{ __view(z,x,y); _frameKey=''; render(performance.now()); return __sig(); };
  const W=COLS;
  const a=sigAt(400,200,2.0), b=sigAt(400+W,200,2.0), c=sigAt(400+W*3,200,2.0);
  const d=sigAt(0,180,1.9),    e=sigAt(W,180,1.9);
  // 接缝正中：两边的副本应当拼得上，画面不留空
  const seamA=sigAt(W-4,120,1.9), seamB=sigAt(-4,120,1.9);
  return { a,b,c,d,e,seamA,seamB, same1:a===b, same2:a===c, same3:d===e, same4:seamA===seamB,
           blank:(()=>{ __view(1.9,COLS-6,140); _frameKey=''; render(performance.now());
             const W2=mapCv.width,H2=mapCv.height,d2=ctx.getImageData(0,0,W2,H2).data;
             let sea=0,n=0;
             for(let y=2;y<H2;y+=29) for(let x=2;x<W2;x+=19){ const o=(y*W2+x)*4; n++;
               if(Math.abs(d2[o]-42)<9&&Math.abs(d2[o+1]-66)<9&&Math.abs(d2[o+2]-96)<12) sea++; }
             return Math.round(sea/n*1000)/1000; })() };
`);
check('东西平移一个整圈后画面完全一致（世界是周期性的）', wrap.same1 === true, wrap);
check('平移三个整圈也一致', wrap.same2 === true, wrap);
check('从最东侧绕到最西侧画面一致（东西连起来了）', wrap.same3 === true, wrap);
check('接缝两侧拼得上（画面不留空）', wrap.same4 === true, wrap);
check('贴边时画面仍有陆地（不是一片空海）', wrap.blank > 0.01 && wrap.blank < 0.99, wrap.blank);

/* ---- 海域分带 + 陆地投影 ---- */
const sea = await p.eval(`
  const d=imgData.data; let shallow=0, deep=0, shadow=0;
  for(let i=0;i<NPIX;i++){
    if(provOf[i]) continue;
    const o=i*4, r=d[o], g=d[o+1], b=d[o+2];
    if(b>150) shallow++; else if(Math.abs(r-42)<7&&Math.abs(g-66)<7&&Math.abs(b-96)<9) deep++;
    if(r<34&&g<54&&b<80) shadow++;
  }
  return {shallow,deep,shadow};
`);
check('近岸浅海已着色', sea.shallow > 3000, sea);
check('远洋仍占海面主体', sea.deep > sea.shallow * 5, sea);
check('海岸线有背光侧投影（立体感）', sea.shadow > 1500, sea.shadow);

/* ---- 地形确实调制了国色 ---- */
const variance = await p.eval(`
  const d=imgData.data;
  const own={};
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p||!p.pix.length) continue;
    const k=p.owner; if(!k) continue;
    own[k]=own[k]||[];
    let s=0,n=0;
    for(let j=0;j<p.pix.length;j+=7){ const o=p.pix[j]*4; s+=d[o]*0.3+d[o+1]*0.59+d[o+2]*0.11; n++; }
    if(n) own[k].push(s/n);
  }
  let best=0,bestN=0;
  for(const k in own){ if(own[k].length>bestN){bestN=own[k].length;best=+k;} }
  const a=own[best]||[];
  const mean=a.reduce((x,y)=>x+y,0)/a.length;
  const sd=Math.sqrt(a.reduce((s,v)=>s+(v-mean)*(v-mean),0)/a.length);
  return { country:best, provs:a.length, mean:Math.round(mean), sd:Math.round(sd*10)/10 };
`);
check('同国各省因地形产生色差 (σ=' + variance.sd + ')', variance.sd > 6, variance);

/* ---- 城镇层：只在大比例尺出现，而且是真图标不是黑点 ---- */
const towns = await p.eval(`
  ${VIEW}
  const out={};
  out.world = (__view(0.9,720,320), _townCount);
  out.mid   = (__view(2.4,742,196), _townCount);
  out.mid2  = (__view(3.0,748,190), _townCount);
  // 视野里的省份数会随放大而变少，所以要看「有图标省份 / 视野内省份」这个比例
  out.at = (z)=>{ __view(z,1082,300);
    const [wx0,wy0]=s2w(0,0), [wx1,wy1]=s2w(cw,ch);
    let vis=0;
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i]; if(!p||!(p._tpx>=0)) continue;
      const r=(p._tpx/COLS)|0, c=p._tpx%COLS;
      if(c+0.5<wx0||c+0.5>wx1||r+0.5<wy0||r+0.5>wy1) continue;
      vis++;
    }
    return { towns:_townCount, vis, frac:Math.round(_townCount/Math.max(1,vis)*1000)/1000 };
  };
  out.big   = out.at(4.0);      // 印度：陆地密集区，密度压力最大
  out.big2  = out.at(6.5);
  out.huge  = out.at(14);
  out.hasTable=provinces.some(p=>p&&p._tpx>=0);
  const big=countries.filter(c=>c&&c.alive&&c.capital&&provinces[c.capital])
    .sort((a,b)=>b.provList.length-a.provList.length)[0];
  const cp=provinces[big.capital];
  out.capName=cp.name; out.capOwner=big.name;
  out.capTowns=(__view(8,cp.cx,cp.cy), _townCount);
  // 图标 sprite：四个等级 + 国都版各一张，且确实画了东西（非全透明）
  out.sprites=[];
  for(let t=0;t<4;t++) for(const cap of [false,true]){
    const cv=townSprite(t,cap);
    if(!cv){ out.sprites.push(0); continue; }
    const g=cv.getContext('2d');
    const px=g.getImageData(0,0,cv.width,cv.height).data;
    let opaque=0, colored=0;
    for(let i=0;i<px.length;i+=4){
      if(px[i+3]>40) opaque++;
      if(px[i+3]>40 && Math.abs(px[i]-px[i+2])>24) colored++;   // 有瓦色/金色，不是灰黑点
    }
    out.sprites.push({ w:cv.width, h:cv.height, cover:Math.round(opaque/(px.length/4)*1000)/1000,
                       colored:Math.round(colored/(px.length/4)*1000)/1000 });
  }
  out.capBox=(()=>{ const cv=townSprite(2,true); return [cv.width,cv.height]; })();
  out.normBox=(()=>{ const cv=townSprite(2,false); return [cv.width,cv.height]; })();
  return out;
`);
check('城镇位置表已建立', towns.hasTable === true);
check('小比例尺不画城镇', towns.world === 0, towns.world);
check('中比例尺也不画城镇', towns.mid === 0 && towns.mid2 === 0, towns.mid + '/' + towns.mid2);
check('大比例尺才出现城镇（只画国都与城市）', towns.big.towns > 0 && towns.big.towns < 90, towns.big.towns);
check('放大后逐步放出更多城镇',
  towns.big.frac < towns.big2.frac && towns.big2.frac < towns.huge.frac,
  `${towns.big.frac}(${towns.big.towns}/${towns.big.vis}) -> ${towns.big2.frac}(${towns.big2.towns}/${towns.big2.vis}) -> ${towns.huge.frac}(${towns.huge.towns}/${towns.huge.vis})`);
check('陆地密集区也不会糊满图标 (<400)', towns.big2.towns < 400, towns.big2.towns);
check('对准首都时能画出聚落', towns.capTowns > 0, towns.capOwner + '/' + towns.capName + ' -> ' + towns.capTowns);
check('八张城镇图标都已生成', towns.sprites.length === 8 && towns.sprites.every(s => s && s.w > 0));
check('图标不是黑点（含瓦色/旗色像素）', towns.sprites.every(s => s.colored > 0.02),
  towns.sprites.map((s, i) => i + ':' + s.colored).join(' '));
check('图标内容占比合理', towns.sprites.every(s => s.cover > 0.13),
  towns.sprites.map((s, i) => i + ':' + s.cover).join(' '));
check('国都图标比同级普通图标大', towns.capBox[0] > towns.normBox[0], towns.normBox + ' -> ' + towns.capBox);

/* ---- recolorAll 性能 ---- */
const perf = await p.eval(`
  const t=performance.now(); recolorAll(); const a=performance.now()-t;
  const t2=performance.now(); setMode('dev'); const b=performance.now()-t2;
  setMode('political');
  return { all:Math.round(a), dev:Math.round(b) };
`);
log(`recolorAll ${perf.all}ms / 切模式 ${perf.dev}ms`);
check('recolorAll 仍足够快 (<250ms)', perf.all < 250, perf.all + 'ms');

/* ---- 换档一次的开销（跨阈值那一帧要整体重着色） ---- */
const swap = await p.eval(`
  ${VIEW}
  __view(0.9,720,320);
  const t=performance.now(); const a=__view(2.4,742,196); const up=performance.now()-t;
  const t2=performance.now(); __view(0.9,720,320); const down=performance.now()-t2;
  return { up:Math.round(up), down:Math.round(down), tier:a };
`);
log(`换档重着色 上档 ${swap.up}ms / 下档 ${swap.down}ms`);
check('换档重着色不卡顿 (<250ms)', swap.up < 250 && swap.down < 250, swap);

/* ---- 每帧合成开销 ---- */
const frame = await p.eval(`
  ${VIEW}
  const r=[];
  for(const [z,x,y] of [[0.88,720,310],[2.4,742,196],[6.2,748,190],[11,744,192]]){
    __view(z,x,y);
    for(let i=0;i<8;i++){ _frameKey=''; render(performance.now()); }
    r.push({ z, tier:lodTier, blit:Math.round(_msBlit*100)/100, render:Math.round(_renderMs*100)/100 });
  }
  return r;
`);
for (const f of frame) log(`z=${f.z} 档${f.tier}  底图合成 ${f.blit}ms  整帧 ${f.render}ms`);
// headless Edge 用的是软件光栅化（--disable-gpu），两张全屏贴图要几毫秒；
// 真实浏览器走 GPU 合成，这一项接近 0。阈值放宽到 12ms，
// 只用来兜住「不小心画成整幅贴图」这类退化。
check('底图合成开销没有退化 (<12ms)', frame.every(f => f.blit < 12), frame.map(f => f.z + ':' + f.blit).join(' '));

/* ---- 截图 ---- */
const capView = await p.eval("return {x:cam.x, y:cam.y};");
const shots = [
  ['1-world-small', "cam.z=0.88; cam.x=720; cam.y=310; mapMode='political';"],
  ['2-europe-mid', "cam.z=2.4; cam.x=742-MAP_SHIFT; cam.y=196;"],
  ['3-eastasia-mid', "cam.z=2.4; cam.x=1082-MAP_SHIFT; cam.y=182;"],
  ['4-close-big', "cam.z=6.2; cam.x=748-MAP_SHIFT; cam.y=190;"],
  ['5-zoomcity', "cam.z=11; cam.x=744-MAP_SHIFT; cam.y=192;"],
  ['7-capital', `cam.z=7.5; cam.x=${capView.x}; cam.y=${capView.y};`],
  ['8-mountains', "cam.z=5.0; cam.x=1055-MAP_SHIFT; cam.y=250;"],
  ['9-andes', "cam.z=4.0; cam.x=430-MAP_SHIFT; cam.y=470;"],
  ['11-seam', "cam.z=1.9; cam.x=8; cam.y=120;"],   // 白令海峡：接缝两侧
];
await p.eval("document.getElementById('lobby').classList.add('hidden'); return true;");
for (const [name, code] of shots) {
  await p.eval(`
    document.getElementById('sidepanel').style.display='none';
    document.getElementById('modebar').style.display='none';
    ${code}
    _frameKey=''; render(performance.now());
    return true;
  `);
  await sleep(450);
  log('截图 ' + await p.shot(name));
}

/* 带界面的整屏截图 */
await p.eval(`
  document.getElementById('sidepanel').style.display='';
  document.getElementById('modebar').style.display='';
  cam.z=2.4; cam.x=742-MAP_SHIFT; cam.y=196; _frameKey=''; render(performance.now()); return true;
`);
await sleep(450);
log('截图 ' + await p.shot('6-withui'));

/* 城镇图标放大对照表：把八张 sprite 摆出来放大 5 倍，方便肉眼核对 */
await p.eval(`
  let cv=document.getElementById('icon-sheet');
  if(!cv){
    cv=document.createElement('canvas');
    cv.id='icon-sheet';
    cv.style.cssText='position:fixed;left:0;top:0;z-index:9999;background:#2f4a2c';
    document.body.appendChild(cv);
  }
  const M=5, PAD=10, label=['村镇','城镇','城市','大城'];
  const cells=[];
  for(let t=0;t<4;t++) for(const cap of [false,true]) cells.push([t,cap]);
  const cw=TOWN_BOX[3]*M+PAD*2, chh=(TOWN_BOX[3]+5)*M+PAD*2+16;
  cv.width=cw*cells.length; cv.height=chh;
  const g=cv.getContext('2d');
  g.fillStyle='#2f4a2c'; g.fillRect(0,0,cv.width,cv.height);
  cells.forEach(([t,cap],i)=>{
    const s=townSprite(t,cap);
    const w=s.width/TOWN_SS*M, h=s.height/TOWN_SS*M;
    g.drawImage(s,(i+0.5)*cw-w/2,(chh-h)/2-6,w,h);
    g.fillStyle='#f0e6cf'; g.font='13px sans-serif'; g.textAlign='center';
    g.fillText(label[t]+(cap?'·国都':''),(i+0.5)*cw,chh-8);
  });
  return true;
`);
await sleep(400);
log('截图 ' + await p.shot('10-icon-sheet'));
await p.eval("const e=document.getElementById('icon-sheet'); if(e) e.remove(); return true;");

/* ---- 地图模式互不干扰 ---- */
const modes = await p.eval(`
  const out={};
  for(const m of ['political','dev','rel']){ setMode(m); out[m]=true; }
  setMode('political');
  return out;
`);
check('三种地图模式都能着色', modes.political && modes.dev && modes.rel);

/* ---- 无 JS 报错 ---- */
await sleep(500);
const errs = p.errs.filter(e => !/favicon|\.ico/i.test(e) && !/WebSocket is closed/i.test(e));
check('页面无 JS 错误', errs.length === 0, errs.slice(0, 5).join(' || '));

console.log(`\n=== result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ===`);
console.log('截图目录: ' + SHOTS + '\n');

p.close(); if (srv) srv.kill(); edge.kill();
await sleep(600);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(failures ? 1 : 0);
