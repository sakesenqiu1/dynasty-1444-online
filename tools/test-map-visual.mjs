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

/* 把镜头挪到指定位并强制重画一帧（LOD 换档也在这时发生） */
const VIEW = `window.__view=(z,x,y)=>{ cam.z=z; cam.x=x; cam.y=y; _frameKey=''; render(performance.now()); return lodTier; };`;

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

/* ---- 省界的显示 / 隐藏 ---- */
const bord = await p.eval(`
  ${VIEW}
  // 找一个「同国相邻」的省界：界像素 vs 省内非界像素的亮度比
  let pid=-1, qid=-1;
  for(let i=1;i<provinces.length&&pid<0;i++){
    const p=provinces[i]; if(!p||!p.pix.length) continue;
    for(const [q,arr] of p.borderPix){
      const qp=provinces[q];
      if(qp&&qp.controller===p.controller&&arr.length>=6){ pid=i; qid=q; break; }
    }
  }
  if(pid<0) return null;
  const p=provinces[pid];
  const bp=new Set();
  for(const [,arr] of p.borderPix) for(const x of arr) bp.add(x);
  const lum=(idx)=>{ const o=idx*4,d=imgData.data; return d[o]*0.3+d[o+1]*0.59+d[o+2]*0.11; };
  const measure=()=>{
    const arr=p.borderPix.get(qid);
    let bl=0; for(const x of arr) bl+=lum(x); bl/=arr.length;
    let il=0,n=0; for(const x of p.pix){ if(bp.has(x)) continue; il+=lum(x); n++; }
    il/=Math.max(1,n);
    return { border:Math.round(bl*10)/10, inner:Math.round(il*10)/10, ratio:Math.round(bl/il*1000)/1000 };
  };
  __view(0.9,720,320);
  const small=measure();
  __view(2.4,742,196);
  const medium=measure();
  __view(6.0,748,190);
  const large=measure();
  return { small, medium, large, prov:p.id, provName:p.name };
`);
log(`省界亮度比：小 ${bord.small.ratio} / 中 ${bord.medium.ratio} / 大 ${bord.large.ratio}`);
check('小比例尺不画省界（界像素≈省内底色）', bord && bord.small.ratio > 0.94,
  bord && (bord.small.ratio + ' (' + bord.small.border + ' vs ' + bord.small.inner + ')'));
check('中比例尺画出省界（明显比小比例尺暗）', bord && bord.medium.ratio < bord.small.ratio - 0.05,
  bord && bord.medium.ratio);
check('大比例尺仍有省界', bord && bord.large.ratio < bord.small.ratio - 0.05, bord && bord.large.ratio);

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
check('底图合成开销可忽略 (<8ms)', frame.every(f => f.blit < 8), frame.map(f => f.z + ':' + f.blit).join(' '));

/* ---- 截图 ---- */
const capView = await p.eval("return {x:cam.x, y:cam.y};");
const shots = [
  ['1-world-small', "cam.z=0.88; cam.x=720; cam.y=310; mapMode='political';"],
  ['2-europe-mid', "cam.z=2.4; cam.x=742; cam.y=196;"],
  ['3-eastasia-mid', "cam.z=2.4; cam.x=1082; cam.y=182;"],
  ['4-close-big', "cam.z=6.2; cam.x=748; cam.y=190;"],
  ['5-zoomcity', "cam.z=11; cam.x=744; cam.y=192;"],
  ['7-capital', `cam.z=7.5; cam.x=${capView.x}; cam.y=${capView.y};`],
  ['8-mountains', "cam.z=5.0; cam.x=1055; cam.y=250;"],
  ['9-andes', "cam.z=4.0; cam.x=430; cam.y=470;"],
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
  cam.z=2.4; cam.x=742; cam.y=196; _frameKey=''; render(performance.now()); return true;
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
