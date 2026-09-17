// 网页端地图编辑器单元测试
// 覆盖：进入/退出、涂地、改首都、改发展度、改省名/国名/国色、起始军队、
//       撤销、工具路由、下载导出、提交审核（含服务端拒绝的处理）。
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
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
}
function mk(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(), id: '', width: 1280, height: 800, style: {}, dataset: {},
    value: '', textContent: '', children: [], _h: '', checked: false, disabled: false, href: '', download: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop, click: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h; }, set(v) { e._h = v; } });
  return e;
}
const els = {};
let downloads = [];       // 记录下载内容
let fetchCalls = [];      // 记录提交请求
let fetchReply = { ok: true, id: 'mtest1', hash: 'abcd1234' };
let promptQueue = [];
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
  Blob: function (parts, opt) { this.parts = parts; this.type = (opt || {}).type; downloads.push(parts.join('')); },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  fetch: (url, opt) => { fetchCalls.push({ url, opt }); return Promise.resolve({ status: 200, json: () => Promise.resolve(fetchReply) }); },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => true,
  promptReply: null,
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.prompt = () => (promptQueue.length ? promptQueue.shift() : sb.promptReply);
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 地图编辑器验证 ===\n');

/* ================= 1. 进入编辑器 ================= */
console.log('-- 1. 进入编辑器 --');
const t1 = run(`
  openEditor();
  const C=countries;
  const alive=C.filter(c=>c&&c.alive).length;
  return { on:editMode.on, tool:editMode.tool, brush:editMode.brush, name:editMode.name,
           player, started, paused, mode:mapMode, alive, base:scenarioBaseReady(),
           brushAlive:!!(C[editMode.brush]&&C[editMode.brush].alive),
           barHasTools:document.getElementById('editbar').innerHTML.includes('edit-tool') };
`);
check('进入编辑模式', t1.on === true && t1.started === true, t1);
check('编辑期间世界暂停', t1.paused === true, t1);
check('切到政治地图模式', t1.mode === 'political', t1);
check('没有"我方"国家', t1.player === 0, t1);
check('默认画笔是一个存活国家', t1.brushAlive === true, t1);
check('默认工具是「选择」', t1.tool === 'select', t1);
check('基线已采集（用于导出差分）', t1.base === true, t1);
check('工具条渲染出了工具按钮', t1.barHasTools === true, t1);
check('世界里仍有存活国家', t1.alive > 100, t1.alive);

/* ================= 2. 涂地 ================= */
console.log('\n-- 2. 涂地改归属 --');
const t2 = run(`
  const C=countries;
  const from=C.find(c=>c&&c.alive&&c.provList.length>6&&c.id!==editMode.brush);
  const to=C[editMode.brush];
  const pid=from.provList.find(i=>provinces[i].pix.length);
  const before={ owner:provinces[pid].owner, fromN:from.provList.length, toN:to.provList.length };
  editPaint(pid);
  const after={ owner:provinces[pid].owner, fromN:from.provList.length, toN:to.provList.length,
                ctrl:provinces[pid].controller };
  const sc=makeScenario({name:'t'});
  return { pid, fromId:from.id, toId:to.id, before, after, undoN:editMode.undo.length,
           dirty:editMode.dirty, inScenario:!!sc.provinces[pid], scOwner:sc.provinces[pid]&&sc.provinces[pid].o };
`);
check('省份归属改成画笔国家', t2.after.owner === t2.toId && t2.after.ctrl === t2.toId, t2.after);
check('原国家少一省，画笔国家多一省',
  t2.after.fromN === t2.before.fromN - 1 && t2.after.toN === t2.before.toN + 1, t2);
check('改动被记进撤销栈', t2.undoN >= 1, t2.undoN);
check('改动出现在导出的剧本里', t2.inScenario === true && t2.scOwner === t2.toId, t2);

/* ================= 3. 撤销 ================= */
console.log('\n-- 3. 撤销 --');
const t3 = run(`
  const C=countries;
  const from=C.find(c=>c&&c.alive&&c.provList.length>6&&c.id!==editMode.brush);
  const pid=from.provList.find(i=>provinces[i].pix.length);
  const o0=provinces[pid].owner;
  const from0=from.provList.length, to0=C[editMode.brush].provList.length;
  editPaint(pid);
  const o1=provinces[pid].owner, from1=from.provList.length, to1=C[editMode.brush].provList.length;
  editUndo();
  const o2=provinces[pid].owner, from2=from.provList.length, to2=C[editMode.brush].provList.length;
  return { pid, o0, o1, o2, from0, from1, from2, to0, to1, to2, depth:editMode.undo.length };
`);
check('涂地后归属变了', t3.o1 !== t3.o0, t3);
check('【核心】撤销一次就把归属完整还原', t3.o2 === t3.o0, t3);
check('【核心】撤销是整步回滚：两国省份数都还原',
  t3.from2 === t3.from0 && t3.to2 === t3.to0, t3);

/* ================= 4. 定都 / 发展度 / 省名 ================= */
console.log('\n-- 4. 定都、发展度、省名 --');
const t4 = run(`
  const C=countries;
  const brush=C[editMode.brush];
  const pid=brush.provList[1];
  const oldCap=brush.capital;
  editSetCapital(pid);
  const capNow=brush.capital;
  // 不能把别人的省设为首都
  const other=C.find(c=>c&&c.alive&&c.id!==editMode.brush&&c.provList.length>3);
  const otherPid=other.provList[0];
  editSetCapital(otherPid);
  const capStill=brush.capital;
  // 发展度
  const t0=provinces[pid].tax, p0=provinces[pid].prod, m0=provinces[pid].man;
  editSetDev(pid,'tax',77);
  editSetDev(pid,'prod',200);     // 越界应被夹到 99
  editSetDev(pid,'man',-5);       // 越界应被夹到 1
  const dev={tax:provinces[pid].tax, prod:provinces[pid].prod, man:provinces[pid].man};
  // 省名
  editSetProvName(pid,'天府之国');
  const nm=provinces[pid].name;
  editSetProvName(pid,'   ');
  const nmKeep=provinces[pid].name;
  const sc=makeScenario({name:'t'});
  return { oldCap, capNow, capStill, pid, otherPid, dev, nm, nmKeep,
           inSc:sc.provinces[pid]||null };
`);
check('定都生效', t4.capNow === t4.pid && t4.capNow !== t4.oldCap, t4);
check('不能把他国省份设为首都', t4.capStill === t4.pid, t4);
check('发展度可改', t4.dev.tax === 77, t4.dev);
check('发展度上限夹到 99', t4.dev.prod === 99, t4.dev);
check('发展度下限夹到 1', t4.dev.man === 1, t4.dev);
check('省名可改', t4.nm === '天府之国', t4);
check('空省名被拒绝（保留原名）', t4.nmKeep === '天府之国', t4);
check('发展度与省名都进了剧本', !!t4.inSc && t4.inSc.t === 77 && t4.inSc.n === '天府之国', t4.inSc);

/* ================= 5. 国名 / 国色 ================= */
console.log('\n-- 5. 改国名与旗色 --');
const t5 = run(`
  const C=countries;
  const b=C[editMode.brush];
  const oldName=b.name, oldColor=b.color.slice();
  editSetCountryName(b.id,'<b>新帝国</b>');
  editSetCountryColor(b.id,[12,200,90]);
  editSetCountryColor(b.id,[999,-5,'x']);      // 含非法值 → 应整体拒绝
  const after={ name:b.name, color:b.color.slice() };
  editSetCountryColor(b.id,[300,-20,128.6]);   // 越界 → 应被夹住
  const clamped=b.color.slice();
  const sc=makeScenario({name:'t'});
  return { id:b.id, oldName, oldColor, after, clamped, sc:sc.countries[b.id]||null };
`);
check('国名可改且剥掉尖括号', t5.after.name === 'b新帝国/b', t5.after);
check('旗色可改', JSON.stringify(t5.after.color) === '[12,200,90]', t5.after);
check('含非法值的颜色被整体拒绝', JSON.stringify(t5.after.color) === '[12,200,90]', t5.after);
check('越界颜色被夹到 0..255', JSON.stringify(t5.clamped) === '[255,0,129]', t5.clamped);
check('国名与旗色都进了剧本', !!t5.sc && t5.sc.n === 'b新帝国/b' && t5.sc.c === '255,0,129', t5.sc);

/* ================= 6. 起始军队 ================= */
console.log('\n-- 6. 起始军队 --');
const t6 = run(`
  const C=countries;
  const brush=C[editMode.brush];
  const before=armies.length;
  editClearArmies();
  const cleared=armies.length;
  const pid=brush.provList[0];
  editAddArmy(pid,12000,false);
  editAddArmy(pid,999999999,false);   // 越界应被夹到 200000
  editAddArmy(pid,10,true);           // 下界夹到 100
  const list=armies.map(a=>({o:a.owner,p:a.prov,s:a.str,n:a.isNavy}));
  const sc=makeScenario({name:'t'});
  return { before, cleared, list, scArmies:sc.armies.length, brushId:brush.id, pid };
`);
check('清空军队', t6.cleared === 0, t6);
check('放置了 3 支军队', t6.list.length === 3, t6);
check('军队归属画笔国家', t6.list.every(a => a.o === t6.brushId && a.p === t6.pid), t6.list);
check('兵力上限被夹到 200000', t6.list[1].s === 200000, t6.list);
check('兵力下限被夹到 100', t6.list[2].s === 100, t6.list);
check('舰队标记正确', t6.list[2].n === 1 && t6.list[0].n === 0, t6.list);
check('军队进了剧本', t6.scArmies === 3, t6);

/* ================= 7. 工具路由 ================= */
console.log('\n-- 7. 地图点击按工具分流 --');
const t7 = run(`
  const C=countries;
  const from=C.find(c=>c&&c.alive&&c.provList.length>6&&c.id!==editMode.brush);
  const pid=from.provList.find(i=>provinces[i].pix.length);
  // 选择工具：只选中不改归属
  editMode.tool='select';
  const o0=provinces[pid].owner;
  editMapClick(pid);
  const selOnly={ owner:provinces[pid].owner, sel:selectedProv };
  // 涂地工具：立刻改归属
  editMode.tool='paint';
  editMapClick(pid);
  const painted=provinces[pid].owner;
  // 吸色工具：把该省归属设为画笔
  editMode.tool='pick';
  const before=(()=>{const q=C.find(c=>c&&c.alive&&c.provList.length>6&&c.id!==editMode.brush);return q.id;})();
  editMode.brush=before;
  editMapClick(pid);
  const picked=editMode.brush;
  // 点海面：什么都不做也不报错
  const sea=provinces.findIndex(p=>p&&!p.pix.length);
  const okSea=editMapClick(sea);
  return { pid, o0, selOnly, painted, picked, brushBefore:before, okSea, brushId:C[editMode.brush].id };
`);
check('「选择」工具只选中、不改归属', t7.selOnly.owner === t7.o0 && t7.selOnly.sel === t7.pid, t7.selOnly);
check('「涂地」工具立刻改归属', t7.painted === t7.brushId, t7);
check('「吸色」工具把该省归属设为画笔', t7.picked === t7.painted, t7);
check('点海面安全返回', t7.okSea === true, t7);

/* ================= 8. 面板与工具条 ================= */
console.log('-- 8. 面板与工具条内容 --');
const t8 = run(`
  const C=countries;
  selectedProv=C[editMode.brush].provList[0];
  refreshPanel();
  const panel=document.getElementById('panel-body').innerHTML;
  updateEditBar();
  const bar=document.getElementById('editbar').innerHTML;
  return { panel, bar,
           hasPaint:panel.includes('edit-paint-here'), hasCapital:panel.includes('edit-capital-here'),
           hasDev:panel.includes('edit-dev'), hasPname:panel.includes('edit-pname-set'),
           hasArmy:panel.includes('edit-army-add'), hasCname:panel.includes('edit-cname-set'),
           hasCcolor:panel.includes('edit-ccolor'), hasAbsorb:panel.includes('edit-absorb'),
           barHasUndo:bar.includes('edit-undo'), barHasDownload:bar.includes('edit-download'),
           barHasSubmit:bar.includes('edit-submit'), barHasBrush:bar.includes('edit-brush'),
           barHasTools:bar.includes('edit-tool') };
`);
check('面板有「划给画笔国家」', t8.hasPaint === true, t8.panel.slice(0, 150));
check('面板有「设为画笔首都」', t8.hasCapital === true, t8.panel.slice(0, 150));
check('面板有发展度三项输入', t8.hasDev === true, t8.panel.slice(0, 150));
check('面板有省名改名', t8.hasPname === true, t8.panel.slice(0, 150));
check('面板有起始军队', t8.hasArmy === true, t8.panel.slice(0, 150));
check('面板有国名改名', t8.hasCname === true, t8.panel.slice(0, 150));
check('面板有 36 色调色板', t8.hasCcolor === true, t8.panel.slice(0, 150));
check('面板有「并入他国」', t8.hasAbsorb === true, t8.panel.slice(0, 150));
check('工具条有撤销/下载/提交/画笔', t8.barHasUndo && t8.barHasDownload && t8.barHasSubmit && t8.barHasBrush, t8.bar.slice(0, 200));

/* ================= 9. 并入他国 ================= */
console.log('\n-- 9. 把某国并入他国（删掉一个国家） --');
const t9 = run(`
  const C=countries;
  const victim=C.find(c=>c&&c.alive&&c.id!==editMode.brush&&c.provList.length>3&&c.provList.length<12);
  const to=C[editMode.brush];
  const n0=victim.provList.length;
  const toN0=to.provList.length;
  editAbsorb(victim.id);
  const sc=makeScenario({name:'t'});
  return { vid:victim.id, n0, toN0, alive:victim.alive, vNow:victim.provList.length,
           toNow:to.provList.length, deadInSc:sc.countries[victim.id]&&sc.countries[victim.id].dead };
`);
check('被并入的国家领土清空', t9.vNow === 0, t9);
check('被并入的国家灭亡', t9.alive === false, t9);
check('画笔国家接收了全部省份', t9.toNow === t9.toN0 + t9.n0, t9);
check('灭亡状态写进剧本', t9.deadInSc === 1, t9);

/* ================= 10. 下载 ================= */
console.log('\n-- 10. 下载到本地 --');
const t10 = (() => {
  downloads.length = 0;
  const r = run(`
    editMode.name='我的世界'; editMode.author='作者甲'; editMode.desc='说明文字';
    editDownload();
    return 1;
  `);
  const raw = downloads[0] || '';
  let j = null; try { j = JSON.parse(raw); } catch (e) {}
  return { n: downloads.length, len: raw.length, ok: !!j,
           name: j && j.name, author: j && j.author, desc: j && j.desc,
           v: j && j.v, base: j && j.base, provs: j ? Object.keys(j.provinces).length : 0 };
})();
check('触发了下载', t10.n === 1 && t10.len > 100, t10);
check('下载内容是可解析的剧本 JSON', t10.ok === true, t10);
check('地图信息写进了文件', t10.name === '我的世界' && t10.author === '作者甲' && t10.desc === '说明文字', t10);
check('带版本与底图标识', t10.v === 1 && t10.base === 'ne110m', t10);
check('含前面所有编辑', t10.provs > 0, t10.provs);

/* ================= 11. 提交审核 ================= */
console.log('\n-- 11. 提交审核 --');
const t11 = await (async () => {
  fetchCalls.length = 0; fetchReply = { ok: true, id: 'mtest1', hash: 'abcd1234' };
  run(`editSubmit();`);
  await new Promise(r => setTimeout(r, 60));
  const c1 = fetchCalls[0];
  let body1 = null; try { body1 = JSON.parse(c1.opt.body); } catch (e) {}
  const logAfterOk = els['log-body'] ? els['log-body'].innerHTML : '';

  // 服务端拒绝
  fetchCalls.length = 0; fetchReply = { ok: false, err: '地图版本不符' };
  run(`editSubmit();`);
  await new Promise(r => setTimeout(r, 60));
  const c2 = fetchCalls[0];

  // 没有改动时应当直接拒绝、不发请求
  fetchCalls.length = 0;
  run(`resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase(); editMode.undo=[]; editMode.dirty=0; editSubmit();`);
  await new Promise(r => setTimeout(r, 60));
  const noChangeCalls = fetchCalls.length;

  return { c1: !!c1, url: c1 && c1.url, method: c1 && c1.opt && c1.opt.method,
           meta: body1 && body1.meta, hasScenario: !!(body1 && body1.scenario),
           c2: !!c2, noChangeCalls };
})();
check('提交发出了 POST 请求', t11.c1 === true && t11.method === 'POST', t11);
check('请求打到正确的 API 路径（含 /gs 前缀）', /\/gs\/api\/maps$/.test(t11.url || ''), t11.url);
check('请求体带元信息与剧本', t11.meta && t11.meta.name === '我的世界' && t11.hasScenario === true, t11.meta);
check('服务端拒绝后也发出过请求（错误处理路径可达）', t11.c2 === true, t11);
check('没有任何改动时不发请求', t11.noChangeCalls === 0, t11.noChangeCalls);

/* ================= 12. 退出编辑器 ================= */
console.log('\n-- 12. 退出编辑器 --');
const t12 = run(`
  closeEditor();
  updateEditBar();
  return { on:editMode.on, started, player,
           barHidden:document.getElementById('editbar').innerHTML==='' };
`);
check('退出后不再处于编辑模式', t12.on === false, t12);
check('退出后回到未开局状态', t12.started === false && t12.player === 0, t12);
check('工具条被清空', t12.barHidden === true, t12);

/* ================= 13. 编辑后的地图能直接开一局 ================= */
console.log('\n-- 13. 编辑成果可以直接玩 --');
const t13 = run(`
  openEditor();
  const C=countries;
  const victim=C.find(c=>c&&c.alive&&c.id!==editMode.brush&&c.provList.length>5);
  const brushId=editMode.brush;
  for(const pid of [...victim.provList].slice(0,3)) editPaint(pid);
  editSetCountryName(brushId,'编辑器帝国');
  const devPid=C[brushId].provList[0];
  editSetDev(devPid,'tax',88);
  editAddArmy(C[brushId].provList[0],7000,false);
  editMode.name='可玩地图'; editMode.author='甲'; editMode.desc='';
  const sc=makeScenario({name:'可玩地图',author:'甲',desc:''});
  // 用这份剧本重建世界（等价于服务端开局）
  const err=buildWorldFromScenario(sc);
  const after=countries;
  setHumans([brushId]); player=brushId; started=true;
  for(let i=0;i<400;i++) tickDay();
  return { err, devPid, name:after[brushId].name, tax:provinces[devPid].tax,
           day:dayCount, armies:armies.length, hash:scenarioHash(sc) };
`);
check('编辑器产出的剧本能建出世界', t13.err === null, t13.err);
check('改的国名生效', t13.name === '编辑器帝国', t13);
check('改的发展度生效', t13.tax === 88, t13);
check('能正常跑 400 天', t13.day === 400 && t13.armies > 0, t13);
check('剧本哈希稳定可算', /^[0-9a-f]{8}$/.test(t13.hash), t13.hash);

/* ================= 14. 新建国家 ================= */
console.log('\n-- 14. 凭空新建国家 --');
const t14 = run(`
  openEditor();
  const n0=countries.length;
  const alive0=countries.filter(c=>c&&c.alive).length;
  const id=editNewCountry('测试新国');
  const c=countries[id];
  const created={ id, isNew:id>=n0, name:c&&c.name, alive:c&&c.alive, provs:c?c.provList.length:0,
                  featId:c&&c.featId, colorOk:!!(c&&c.color&&c.color.length===3),
                  brush:editMode.brush };
  // 现在它是画笔了，涂几个省
  const host=countries.find(x=>x&&x.alive&&x.id!==id&&x.provList.length>4);
  const pids=host.provList.slice(0,3);
  for(const pid of pids) editPaint(pid);
  const after={ alive:c.alive, provs:c.provList.length, ownerOk:pids.every(p=>provinces[p].owner===id) };
  const sc=makeScenario({name:'新国测试'});
  return { n0, alive0, created, after, pids,
           scHas:!!sc.countries[id], scNew:sc.countries[id]&&sc.countries[id].new,
           scName:sc.countries[id]&&sc.countries[id].n,
           scProvs:pids.map(p=>sc.provinces[p]&&sc.provinces[p].o) };
`);
check('新国家的编号接在最后（不挖空数组）', t14.created.isNew === true, t14);
check('名字与旗色正确', t14.created.name === '测试新国' && t14.created.colorOk === true, t14.created);
check('刚建出来时没有领土、不存在', t14.created.provs === 0 && t14.created.alive === false, t14.created);
check('自动成为画笔', t14.created.brush === t14.created.id, t14.created);
check('涂地后有了领土并立国', t14.after.alive === true && t14.after.provs === 3 && t14.after.ownerOk === true, t14.after);
check('剧本里以 new:1 记录新国家', t14.scHas === true && t14.scNew === 1 && t14.scName === '测试新国', t14);
check('剧本里省份归属指向新国家', t14.scProvs.every(o => o === t14.created.id), t14.scProvs);

/* 新建国家能在另一端忠实重建 */
const t14b = run(`
  const id=countries.findIndex(c=>c&&c.name==='测试新国');
  const sc=makeScenario({name:'新国测试'});
  const err=buildWorldFromScenario(sc);
  const c=countries[id];
  return { err, id, exists:!!c, name:c&&c.name, alive:c&&c.alive, provs:c?c.provList.length:0,
           cap:c&&c.capital, capIsOwn:c&&c.provList.includes(c.capital) };
`);
check('【核心】新建的国家能在独立重建后存在', t14b.err === null && t14b.exists === true, t14b);
check('名字与领土保留', t14b.name === '测试新国' && t14b.alive === true && t14b.provs === 3, t14b);
check('首都自动落在一块自己的领土上', t14b.capIsOwn === true, t14b);

/* ================= 15. 一键清空所有国家 → 无主荒地 ================= */
console.log('\n-- 15. 清空所有国家 → 无主荒地 --');
const t15 = run(`
  openEditor();
  const alive0=countries.filter(c=>c&&c.alive).length;
  const owned0=provinces.filter(p=>p&&p.pix.length&&p.owner>0).length;
  editClearAllCountries();
  const alive1=countries.filter(c=>c&&c.alive).length;
  const unowned1=provinces.filter(p=>p&&p.pix.length&&p.owner===0).length;
  const total=provinces.filter(p=>p&&p.pix.length).length;
  const brush=editMode.brush;
  const sc=makeScenario({name:'荒地'});
  const wild=Object.values(sc.provinces).filter(o=>o.o===0).length;
  return { alive0, owned0, alive1, unowned1, total, brush, wild,
           armyN:armies.length,
           deadInSc:Object.values(sc.countries).filter(o=>o.dead===1).length };
`);
check('清空前有存活国家', t15.alive0 > 100, t15.alive0);
check('【核心】清空后没有任何存活国家', t15.alive1 === 0, t15.alive1);
check('【核心】全部省份变成无主（owner=0）', t15.unowned1 === t15.total, { unowned: t15.unowned1, total: t15.total });
check('军队一并清空', t15.armyN === 0, t15.armyN);
check('画笔自动切到「无主荒地」', t15.brush === 0, t15.brush);
check('剧本用 o:0 记录荒地', t15.wild === t15.total, { wild: t15.wild, total: t15.total });
check('剧本把所有国家标为 dead', t15.deadInSc > 100, t15.deadInSc);

console.log('\n-- 15b. 荒地上的撤销与重建 --');
const t15b = run(`
  const sc=makeScenario({name:'荒地'});
  const err=buildWorldFromScenario(sc);
  const alive=countries.filter(c=>c&&c.alive).length;
  const unowned=provinces.filter(p=>p&&p.pix.length&&p.owner===0).length;
  // 建一个玩家国家在上面玩
  setHumans([]); player=0; started=true;
  for(let i=0;i<600;i++) tickDay();
  return { err, alive, unowned, day:dayCount };
`);
check('纯荒地世界能在两端重建', t15b.err === null, t15b.err);
check('重建后仍是全荒地', t15b.alive === 0 && t15b.unowned > 1900, t15b);
check('纯荒地世界能正常推进 600 天', t15b.day === 600, t15b);

const t15c = run(`
  openEditor();
  const name0=countries.find(c=>c&&c.alive).name;
  const owned0=provinces.filter(p=>p&&p.pix.length&&p.owner>0).length;
  editClearAllCountries();
  editUndo();
  const name1=countries.find(c=>c&&c.alive).name;
  const owned1=provinces.filter(p=>p&&p.pix.length&&p.owner>0).length;
  return { name0, name1, owned0, owned1, brush:editMode.brush };
`);
check('【核心】清空可以一步撤销，国家全部回来', t15c.name1 === t15c.name0 && t15c.owned1 === t15c.owned0, t15c);

console.log('\n-- 15d. 荒地 + 新建国家 = 从零画一张地图 --');
const t15d = run(`
  openEditor();
  editClearAllCountries();
  const A=editNewCountry('甲国');
  const B=editNewCountry('乙国');
  // 甲国占 200 个省，乙国占 100 个
  const land=provinces.map((p,i)=>p&&p.pix.length?i:0).filter(Boolean);
  editMode.brush=A; for(const pid of land.slice(0,200)) editPaint(pid);
  editMode.brush=B; for(const pid of land.slice(200,300)) editPaint(pid);
  const sc=makeScenario({name:'从零画的地图'});
  const err=buildWorldFromScenario(sc);
  const alive=countries.filter(c=>c&&c.alive).map(c=>c.name).sort();
  const unowned=provinces.filter(p=>p&&p.pix.length&&p.owner===0).length;
  setHumans([A,B]); player=A; started=true;
  for(let i=0;i<400;i++) tickDay();
  return { A, B, err, alive, unowned, day:dayCount, armyN:armies.length,
           aProv:countries[A].provList.length, bProv:countries[B].provList.length,
           scCountries:Object.keys(sc.countries).length, scProvinces:Object.keys(sc.provinces).length };
`);
check('两个新国家都建出来了', t15d.alive.length === 2 && t15d.alive.join(',') === '乙国,甲国', t15d.alive);
check('领土数正确', t15d.aProv === 200 && t15d.bProv === 100, t15d);
check('其余仍是荒地', t15d.unowned === 2007 - 300, t15d.unowned);
check('【核心】从零画的地图能正常跑 400 天', t15d.err === null && t15d.day === 400, t15d);
check('剧本体积仍然很小', JSON.stringify(run(`return makeScenario({name:'x'});`)).length < 60000,
  JSON.stringify(run(`return makeScenario({name:'x'});`)).length);

/* ================= 16. 荒地渲染与交互 ================= */
console.log('\n-- 16. 无主荒地的显示与交互 --');
const t16 = run(`
  openEditor();
  const land=provinces.findIndex(p=>p&&p.pix.length);
  // 把该省变成荒地后，渲染取色不能崩
  editMode.brush=0;
  editPaint(land);
  let fillOk=true, fill=null;
  try{ fill=provFill(provinces[land]); }catch(e){ fillOk=false; fill=e.message; }
  const relOk=(()=>{ const m=mapMode; mapMode='rel'; let r; try{ r=relColorOf(0); }catch(e){ r=null; } mapMode=m; return r; })();
  // 画家用「吸色」在荒地上点一下：画笔应保持 0
  editMode.tool='pick'; editMode.brush=0;
  editMapClick(land);
  const paintOk=(()=>{ let ok=true; try{ editPaint(land); }catch(e){ ok=false; } return ok; })();
  // 荒地省份不应该出现在任何国家的 provList 里
  const inAny=countries.some(c=>c&&c.provList.includes(land));
  return { land, fillOk, fill, relOk, paintOk, inAny,
           brushOpts:editBrushOptions().includes('🧹 无主荒地'),
           barHasNew:document.getElementById('editbar').innerHTML.includes('edit-new-country'),
           barHasClear:document.getElementById('editbar').innerHTML.includes('edit-clear-countries') };
`);
check('荒地省份取色不崩', t16.fillOk === true, t16.fill);
check('外交模式下荒地有专属颜色', Array.isArray(t16.relOk) && t16.relOk.length === 3, t16.relOk);
check('在荒地上涂地/吸色都安全', t16.paintOk === true, t16);
check('荒地不属于任何国家的 provList', t16.inAny === false, t16);
check('画笔下拉里有「无主荒地（橡皮）」', t16.brushOpts === true, t16);
check('工具栏有「➕ 新建国家」', t16.barHasNew === true, t16);
check('工具栏有「🧹 清空所有国家」', t16.barHasClear === true, t16);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
