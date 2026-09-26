// 地图外观回归测试：真实浏览器（headless Edge + CDP）加载本地服务，
// 检查地形/浅海/城镇三层是否真的画出来了，并把几个缩放档位的截图落盘，
// 方便人工核对「底图是否好看」。
//
//   node _tools/test-map-visual.mjs
//
// 截图输出到 _shots/。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const PORT = 7801;
const BASE = '/gs';
const CDP_PORT = 9351;
// 默认找 Edge；也可以用 GS_EDGE 指到 Chrome/Chromium
const EDGE = process.env.GS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WORLD_READY = "typeof countries!=='undefined' && countries.length>100";
const SHOTS = process.env.GS_SHOTS || join(root, '_shots');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

mkdirSync(SHOTS, { recursive: true });

const srv = spawn(process.execPath, [join(root, 'srv', 'server.js')], {
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
if (!ver) { console.error('Edge CDP not ready'); srv.kill(); edge.kill(); process.exit(1); }
log('CDP ready: ' + ver.Browser);

/* 先把 HTTP 服务等起来，否则页面根本加载不出来，报错会指向 CDP 而不是服务端 */
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}${BASE}/`); if (r.ok) { up = true; break; } } catch (e) {}
  await sleep(250);
}
if (!up) { console.error(`本地服务 http://127.0.0.1:${PORT}${BASE}/ 没起来`); srv.kill(); edge.kill(); process.exit(1); }
log('本地服务已就绪');

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

const p = await Page.open(`http://127.0.0.1:${PORT}${BASE}/`);
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
    ["脚本数量", "return document.querySelectorAll('script').length"],
    ["WORLD_DATA", "return typeof WORLD_DATA"],
    ["terrIdx", "return typeof terrIdx"],
    ["ensureTerrain", "return typeof ensureTerrain"],
    ["ensureTownLayer", "return typeof ensureTownLayer"],
    ["loop 是否在跑", "return typeof lastT==='undefined'?'n/a':Math.round(performance.now()-lastT)"],
  ];
  for (const [k, code] of diag) {
    try { console.error('  ' + k.padEnd(14) + ': ' + await p.eval(code)); }
    catch (e2) { console.error('  ' + k.padEnd(14) + ': <eval 失败> ' + e2.message); }
  }
  console.error('  页面报错       : ' + (p.errs.slice(0, 8).join(' || ') || '(无)'));
  p.close(); srv.kill(); edge.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e3) {}
  process.exit(1);
}
log('世界构建完成');

/* ---- 地形层 ---- */
const terr = await p.eval(`
  return { ms:Math.round(_terrMs), hist:_terrHist, terr:!!terrIdx, n:provinces.length };
`);
log(`地形生成耗时 ${terr.ms}ms`);
check('地形层已生成', terr.terr === true);
const total = (terr.hist || []).reduce((a, b) => a + b, 0);
check('地形覆盖全部陆地像素 (' + total + ')', total > 100000, total);
const kinds = (terr.hist || []).map((n, i) => [i, n]).filter(([i, n]) => i > 0 && n / total > 0.004);
check('至少 6 种地貌且都有可观面积', kinds.length >= 6, kinds.map(([i, n]) => TERRN(i) + ':' + (n / total * 100).toFixed(1) + '%'));
function TERRN(i) { return ['—', '平原', '草原', '森林', '雨林', '沙漠', '丘陵', '山地', '雪峰', '针叶林', '苔原', '沼泽', '稀树草原'][i] || ('#' + i); }
check('存在沙漠（回归线干旱带）', (terr.hist[5] || 0) / total > 0.01, ((terr.hist[5] || 0) / total * 100).toFixed(2) + '%');
check('存在森林/针叶林', ((terr.hist[3] || 0) + (terr.hist[9] || 0)) / total > 0.05, (((terr.hist[3] || 0) + (terr.hist[9] || 0)) / total * 100).toFixed(2) + '%');
check('存在山地/雪峰', ((terr.hist[7] || 0) + (terr.hist[8] || 0)) / total > 0.03, (((terr.hist[7] || 0) + (terr.hist[8] || 0)) / total * 100).toFixed(2) + '%');
check('存在苔原/冰原（高纬）', (terr.hist[10] || 0) / total > 0.005, ((terr.hist[10] || 0) / total * 100).toFixed(2) + '%');
check('地形生成足够快 (<600ms)', terr.ms < 600, terr.ms + 'ms');

/* ---- 海域分带 ---- */
const sea = await p.eval(`
  // 统计海面像素里「近岸浅色」与「远洋深色」各自占比
  const d=imgData.data; let shallow=0, deep=0, other=0;
  for(let i=0;i<NPIX;i++){
    if(provOf[i]) continue;
    const o=i*4, r=d[o], g=d[o+1], b=d[o+2];
    if(b>150) shallow++; else if(Math.abs(r-42)<6&&Math.abs(g-66)<6&&Math.abs(b-96)<8) deep++; else other++;
  }
  return {shallow,deep,other};
`);
check('近岸浅海已着色', sea.shallow > 3000, sea);
check('远洋仍占海面主体', sea.deep > sea.shallow * 5, sea);

/* ---- 地形确实调制了国色 ---- */
const variance = await p.eval(`
  // 取省份最多的大国：若地形生效，同国各省像素之间应存在明显色差
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

/* ---- 城镇层 ---- */
const towns = await p.eval(`
  const out={};
  const view=(z,x,y)=>{ cam.z=z; cam.x=x; cam.y=y; _frameKey=''; render(performance.now()); return _townCount; };
  out.world=view(0.9,720,320);
  out.mid  =view(2.4,742,196);
  out.city =view(3.4,742,196);
  out.close=view(6.0,748,190);
  out.hasTable=provinces.some(p=>p&&p._tpx>=0);
  out.caps=countries.filter(c=>c&&c.alive&&c.capital).length;
  // 把镜头对准一个大国的首都，确认国都确实画了标记
  const big=countries.filter(c=>c&&c.alive&&c.capital&&provinces[c.capital])
    .sort((a,b)=>b.provList.length-a.provList.length)[0];
  const cp=provinces[big.capital];
  out.capName=cp.name; out.capOwner=big.name;
  out.capTowns=view(6.0,cp.cx,cp.cy);
  return out;
`);
check('城镇位置表已建立', towns.hasTable === true);
check('世界视角不画城镇', towns.world === 0, towns.world);
check('中等缩放画城市与国都', towns.mid > 0 && towns.mid < 400, towns.mid);
check('放大地图后城镇变多', towns.close > towns.city, towns.city + ' -> ' + towns.close);
check('屏幕内城镇数不失控 (<1200)', towns.close < 1200, towns.close);
check('对准首都时能画出聚落', towns.capTowns > 0, towns.capOwner + '/' + towns.capName + ' -> ' + towns.capTowns);

/* ---- recolorAll 性能 ---- */
const perf = await p.eval(`
  const t=performance.now(); recolorAll(); const a=performance.now()-t;
  const t2=performance.now(); setMode('dev'); const b=performance.now()-t2;
  setMode('political');
  return { all:Math.round(a), dev:Math.round(b) };
`);
log(`recolorAll ${perf.all}ms / 切模式 ${perf.dev}ms`);
check('recolorAll 仍足够快 (<250ms)', perf.all < 250, perf.all + 'ms');

/* ---- 每帧合成开销：底图开了双线性插值，确认没有把 blit 拖慢 ---- */
const frame = await p.eval(`
  const r=[];
  for(const [z,x,y] of [[0.88,720,310],[2.4,742,196],[6.2,748,190],[11,744,192]]){
    cam.z=z; cam.x=x; cam.y=y;
    for(let i=0;i<8;i++){ _frameKey=''; render(performance.now()); }
    r.push({ z, blit:Math.round(_msBlit*100)/100, render:Math.round(_renderMs*100)/100 });
  }
  return r;
`);
for (const f of frame) log(`z=${f.z}  底图合成 ${f.blit}ms  整帧 ${f.render}ms`);
check('底图合成开销可忽略 (<8ms)', frame.every(f => f.blit < 8), frame.map(f => f.z + ':' + f.blit).join(' '));

/* ---- 截图 ---- */
const capView = await p.eval("return {x:cam.x, y:cam.y};");
const shots = [
  ['1-world', "cam.z=0.88; cam.x=720; cam.y=310; mapMode='political';"],
  ['2-europe', "cam.z=2.4; cam.x=742; cam.y=196;"],
  ['3-eastasia', "cam.z=2.4; cam.x=1082; cam.y=182;"],
  ['4-close', "cam.z=6.2; cam.x=748; cam.y=190;"],
  ['5-zoomcity', "cam.z=11; cam.x=744; cam.y=192;"],
  ['7-capital', `cam.z=7.5; cam.x=${capView.x}; cam.y=${capView.y};`],
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
  const f = await p.shot(name);
  log('截图 ' + f);
}

/* 带界面的整屏截图 */
await p.eval(`
  document.getElementById('sidepanel').style.display='';
  document.getElementById('modebar').style.display='';
  cam.z=2.4; cam.x=742; cam.y=196; _frameKey=''; render(performance.now()); return true;
`);
await sleep(450);
log('截图 ' + await p.shot('6-withui'));

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

p.close(); srv.kill(); edge.kill();
await sleep(600);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(failures ? 1 : 0);
