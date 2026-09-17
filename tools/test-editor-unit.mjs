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

/* ================= 17. 导入 ================= */
console.log('\n-- 17. 导入本地地图接着改 --');
const t17 = run(`
  // 先做一张图并导出
  openEditor();
  const land=provinces.map((p,i)=>p&&p.pix.length?i:0).filter(Boolean);
  editClearAllCountries();
  const A=editNewCountry('导入甲'), B=editNewCountry('导入乙');
  editMode.brush=A; for(const pid of land.slice(0,50)) editPaint(pid);
  editMode.brush=B; for(const pid of land.slice(50,90)) editPaint(pid);
  editSetOverlord(B,A,SUBJ_PUPPET);
  editAddAlly(A,B);                       // 附庸不能结盟，应被拒
  editClearOverlord(B);
  editAddAlly(A,B);                       // 解除后再结盟，应成功
  editToggleWar(A,B===0?B:B);             // 同一个国家，应无效
  // 找一个第三方国家做敌人
  const third=countries.find(c=>c&&!isVoidCountry(c)&&c.id!==A&&c.id!==B&&c.provList.length>0);
  if(third){ editMode.brush=A; editToggleWar(A,third.id); }
  editMode.name='导入测试图'; editMode.author='作者丙'; editMode.desc='说明';
  const exported=makeScenario({name:'导入测试图',author:'作者丙',desc:'说明'});
  const digestBefore=(function(){
    let s=''; for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(!p.pix.length) continue; s+=i+':'+p.owner+';'; }
    for(let i=1;i<countries.length;i++){ const c=countries[i]; if(!c||isVoidCountry(c)) continue; s+=i+':'+c.name+','+c.color.join('-')+','+(c.overlord||0)+','+(c.subject||0)+','+(c.allies||[]).join('/')+';'; }
    s+='W'+wars.map(w=>w.a+'-'+w.d).sort().join(',');
    return s;
  })();
  const aliveBefore=countries.filter(c=>c&&c.alive).length;
  closeEditor();
  return { exported, digestBefore, aliveBefore, A, B, third:third?third.id:0,
           name:exported.name, author:exported.author,
           exportedWars:(exported.wars||[]).length };
`);
check('导出的剧本带上地图信息', t17.name === '导入测试图' && t17.author === '作者丙', t17);
check('导出带上了起始战争', t17.exportedWars >= 1, t17.exportedWars);

const t17b = run(`
  // 模拟"关掉页面后重新打开并导入"
  const ok=importScenarioIntoEditor(${JSON.stringify(t17.exported)},'导入测试图');
  const digestAfter=(function(){
    let s=''; for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(!p.pix.length) continue; s+=i+':'+p.owner+';'; }
    for(let i=1;i<countries.length;i++){ const c=countries[i]; if(!c||isVoidCountry(c)) continue; s+=i+':'+c.name+','+c.color.join('-')+','+(c.overlord||0)+','+(c.subject||0)+','+(c.allies||[]).join('/')+';'; }
    s+='W'+wars.map(w=>w.a+'-'+w.d).sort().join(',');
    return s;
  })();
  return { ok, digestAfter, editOn:editMode.on, name:editMode.name, author:editMode.author,
           alive:countries.filter(c=>c&&c.alive).length,
           baseReady:scenarioBaseReady(),
           barHidden:document.getElementById('editbar').innerHTML==='' };
`);
check('导入成功并进入编辑器', t17b.ok === true && t17b.editOn === true, t17b);
check('【核心】导入后的世界与导出前逐省逐国一致', t17b.digestAfter === t17.digestBefore,
  { same: t17b.digestAfter === t17.digestBefore, a: t17b.digestAfter.length, b: t17.digestBefore.length });
check('地图信息一并恢复', t17b.name === '导入测试图' && t17b.author === '作者丙', t17b);
check('【核心】导入后基线仍然可用（能继续编辑）', t17b.baseReady === true, t17b);
check('导入后编辑器 UI 已就绪', t17b.barHidden === false, t17b);

const t17c = run(`
  // 导入后继续改，再导出，改动应该叠加而不是丢失
  // （这张图是从"清空所有国家"起的，2007 个省本来就已经在 diff 里了，
  //   所以这里验证的是"改动确实落到剧本的对应字段上"）
  const target=countries.find(c=>c&&c.alive&&c.provList.length>3);
  const pid=target.provList[0];
  const newC=countries.find(c=>c&&!isVoidCountry(c)&&c.id!==target.id&&c.provList.length>0);
  editMode.brush=newC.id;
  editPaint(pid);
  const sc=makeScenario({name:'导入测试图'});
  const painted=(sc.provinces[pid]||{}).o;
  // 改省名与发展度也要落进去
  editSetProvName(pid,'导入后改的名');
  editSetDev(pid,'tax',55);
  const sc2=makeScenario({name:'导入测试图'});
  const p2=sc2.provinces[pid]||{};
  const again=importScenarioIntoEditor(sc2,'x');
  const restored=provinces[pid];
  return { pid, painted, want:newC.id, again,
           name:p2.n, tax:p2.t, restoredName:restored.name, restoredTax:restored.tax,
           provinces:Object.keys(sc2.provinces).length };
`);
check('【核心】导入后涂地生效并写进剧本', t17c.painted === t17c.want, t17c);
check('【核心】导入后改名/改发展度也写进剧本', t17c.name === '导入后改的名' && t17c.tax === 55, t17c);
check('二次导出再导入，改动完整保留', t17c.again === true && t17c.restoredName === '导入后改的名' && t17c.restoredTax === 55, t17c);

console.log('\n-- 17d. 导入非法文件 --');
const t17d = run(`
  const bad1=importScenarioIntoEditor(null,'x');
  const bad2=importScenarioIntoEditor({v:99},'x');
  const bad3=importScenarioIntoEditor({v:1,base:'other'},'x');
  const okv=importScenarioIntoEditor({v:1,base:'ne110m',seed:987654321,name:'空',countries:{},provinces:{},armies:[]},'x');
  return { bad1, bad2, bad3, okv, on:editMode.on };
`);
check('导入 null 被拒绝', t17d.bad1 === false, t17d);
check('导入版本不符被拒绝', t17d.bad2 === false, t17d);
check('导入底图不符被拒绝', t17d.bad3 === false, t17d);
check('导入合法的最小剧本成功', t17d.okv === true && t17d.on === true, t17d);

/* ================= 18. 外交关系 ================= */
console.log('\n-- 18. 开局外交关系（宗主/属国、盟友、战争） --');
const t18 = run(`
  openEditor();
  const C=countries;
  const list=C.filter(c=>c&&c.alive&&c.provList.length>2).slice(0,4);
  const [a,b,x,y]=list.map(c=>c.id);
  // 宗主 / 属国
  editSetOverlord(b,a,SUBJ_VASSAL);
  editSetOverlord(x,a,SUBJ_PUPPET);
  // 盟友
  editAddAlly(a,y);
  // 战争
  editToggleWar(a,y);   // 先宣战（与盟友并存是可以的，这一条只验证机制）
  const mid={ bOv:C[b].overlord, bSj:C[b].subject, xOv:C[x].overlord, xSj:C[x].subject,
              aAlly:(C[a].allies||[]).includes(y), yAlly:(C[y].allies||[]).includes(a),
              wars:wars.length };
  // 附庸不能结盟：给 b 结盟应被拒
  editAddAlly(b,y);
  const vassalAllyRefused=!(C[b].allies||[]).includes(y);
  // 解除臣属后应能结盟
  editClearOverlord(b);
  editAddAlly(b,y);
  const afterClearAlly=(C[b].allies||[]).includes(y);
  // 解除战争
  editToggleWar(a,y);
  const warsAfter=wars.filter(w=>(w.a===a&&w.d===y)||(w.a===y&&w.d===a)).length;
  const sc=makeScenario({name:'外交测试'});
  return { a,b,x,y, mid, vassalAllyRefused, afterClearAlly, warsAfter,
           scB:sc.countries[b]||{}, scX:sc.countries[x]||{}, scA:sc.countries[a]||{},
           scWars:sc.wars||[] };
`);
check('附庸关系建立', t18.mid.bOv === t18.a && t18.mid.bSj === 1, t18.mid);
check('傀儡关系建立', t18.mid.xOv === t18.a && t18.mid.xSj === 2, t18.mid);
check('盟友双向建立', t18.mid.aAlly === true && t18.mid.yAlly === true, t18.mid);
check('战争建立', t18.mid.wars >= 1, t18.mid.wars);
check('【规则】附庸不能另行结盟', t18.vassalAllyRefused === true, t18);
check('解除臣属后可以结盟', t18.afterClearAlly === true, t18);
check('可以解除战争', t18.warsAfter === 0, t18.warsAfter);
check('【核心】剧本按需记录外交，没改的字段不写', (() => {
  const e = run(`return makeScenario({name:'x'}).countries;`);
  // x 是傀儡国，必须记下宗主与国体
  const okX = e[t18.x] && e[t18.x].ov === t18.a && e[t18.x].sj === 2;
  // b 的宗主在测试中途被解除了 → 回到基线值，剧本里不该出现 ov 字段
  const okB = !e[t18.b] || e[t18.b].ov === undefined;
  // a 与 y 互为盟友
  const okA = e[t18.a] && (e[t18.a].al || []).includes(t18.y);
  return okX && okB && okA;
})(), run(`return makeScenario({name:'x'}).countries;`));

console.log('\n-- 18b. 外交关系能忠实重建 --');
const t18b = (() => {
  const sc = run(`
    openEditor();
    const C=countries;
    const list=C.filter(c=>c&&c.alive&&c.provList.length>2).slice(0,4);
    const [a,b,x,y]=list.map(c=>c.id);
    editSetOverlord(b,a,SUBJ_PUPPET);
    editAddAlly(a,y);
    editToggleWar(a,x);
    return { sc:makeScenario({name:'外交重建'}), a,b,x,y };
  `);
  const ok = run(`return importScenarioIntoEditor(${JSON.stringify(sc.sc)},'z');`);
  const after = run(`
    const C=countries;
    return { bOv:C[${sc.b}].overlord, bSj:C[${sc.b}].subject,
             aAlly:(C[${sc.a}].allies||[]).includes(${sc.y}), yAlly:(C[${sc.y}].allies||[]).includes(${sc.a}),
             war:wars.some(w=>(w.a===${sc.a}&&w.d===${sc.x})||(w.a===${sc.x}&&w.d===${sc.a})),
             campShared:campOf(${sc.b}).has(${sc.a}) };
  `);
  return { ok, after, sc };
})();
check('重建成功', t18b.ok === true, t18b.ok);
check('【核心】傀儡关系重建', t18b.after.bOv === t18b.sc.a && t18b.after.bSj === 2, t18b.after);
check('【核心】盟友关系双向重建', t18b.after.aAlly === true && t18b.after.yAlly === true, t18b.after);
check('【核心】战争状态重建', t18b.after.war === true, t18b.after);
check('属国被正确算进宗主阵营（外交/战争逻辑生效）', t18b.after.campShared === true, t18b.after);

const t18c = run(`
  // 关系指向不存在的国家时要被忽略，不能崩
  const sc={ v:1, base:'ne110m', seed:987654321, name:'脏外交',
             countries:{ '44':{ ov:99999, sj:9, al:[88888,44] } }, provinces:{}, armies:[] };
  const ok=importScenarioIntoEditor(sc,'脏');
  const c=countries[44];
  return { ok, ov:c.overlord, sj:c.subject, al:c.allies, on:editMode.on };
`);
check('非法宗主/盟友被忽略', t18c.ok === true && t18c.ov === 0 && t18c.sj === 0 && t18c.al.length === 0, t18c);

/* ================= 19. 兼容老地图 ================= */
console.log('\n-- 19. 老地图（没有外交字段的 v1 剧本）仍然兼容 --');
const t19 = run(`
  // 模拟编辑器在"加外交功能之前"导出的文件：只有省份/国家/军队，没有 ov/sj/al/wars
  const old={ v:1, base:'ne110m', seed:987654321, name:'老地图', author:'古人', desc:'',
              countries:{ '44':{ n:'老法国', c:'10,20,30' } },
              provinces:{ '1':{ o:44, t:9 }, '2':{ n:'老街' } },
              armies:[{ o:44, p:1, s:3000 }] };
  const bad=validateScenario(old);
  const ok=importScenarioIntoEditor(old,'老地图');
  const c=countries[44];
  return { bad, ok, name:c.name, color:c.color, ov:c.overlord, sj:c.subject,
           al:(c.allies||[]).length, wars:wars.length, armyN:armies.length,
           p1:provinces[1].owner, p1t:provinces[1].tax, p2n:provinces[2].name,
           mapName:editMode.name };
`);
check('老剧本通过校验', t19.bad === null, t19.bad);
check('老剧本能导入', t19.ok === true, t19.ok);
check('国名/旗色照常生效', t19.name === '老法国' && t19.color.join(',') === '10,20,30', t19);
check('省份改动照常生效', t19.p1 === 44 && t19.p1t === 9 && t19.p2n === '老街', t19);
check('军队照常生效', t19.armyN === 1, t19);
check('【核心】没有外交字段 = 没有外交关系（不是报错）',
  t19.ov === 0 && t19.sj === 0 && t19.al === 0 && t19.wars === 0, t19);
check('导入后可以直接再导出/再提交', run(`return !!makeScenario({name:'x'}).provinces['1'];`) === true);

const t19b = run(`
  // 老地图重新导出 → 再导入，仍然一致（不会因为新字段而漂移）
  const old={ v:1, base:'ne110m', seed:987654321, name:'老地图2',
              countries:{ '44':{ n:'老法国2', c:'10,20,30' } },
              provinces:{ '1':{ o:44, t:9 } }, armies:[] };
  importScenarioIntoEditor(old,'老地图2');
  const again=makeScenario({name:'老地图2'});
  importScenarioIntoEditor(again,'x');
  const again2=makeScenario({name:'老地图2'});
  return { same:JSON.stringify(again)===JSON.stringify(again2),
           keys:Object.keys(again).sort().join(','),
           hasWars:!!again.wars, hasDiplo:!!(again.countries['44']&&(again.countries['44'].ov||again.countries['44'].al)) };
`);
check('老地图往返两次结果稳定', t19b.same === true, t19b);
check('没有外交/战争时不会写出多余字段', t19b.hasWars === false && t19b.hasDiplo === false, t19b);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
