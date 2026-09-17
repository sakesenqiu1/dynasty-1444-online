// 地图大厅 + 管理后台（客户端）单元测试
// 用假的 fetch 模拟服务端，验证：列表渲染、选用地图重建世界、回到官方地图、
// 管理端登录/列表/预览/恢复/审核/删除 的整条链路。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

/* ---------- 先造一份真实的剧本（在独立 VM 里跑内核） ---------- */
function mkScenario() {
  const sb = {
    console, Math, Date, JSON, Set, Map, Array, Object, Number, String, isFinite, parseInt, parseFloat,
    Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
    UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
    module: { exports: {} }, globalThis: null,
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(read('web/world-data.js'), ctx, { filename: 'w' });
  vm.runInContext(read('web/game-core.js'), ctx, { filename: 'c' });
  const core = sb.module.exports;
  core.resetWorld(); core.setSeed(987654321); core.buildWorld(); core.captureScenarioBase();
  const C = core.countries();
  const a = C.find(c => c && c.alive && c.provList.length > 8);
  const b = C.find(c => c && c.alive && c.id !== a.id && c.provList.length > 5);
  const moved = a.provList.slice(0, 3);
  for (const pid of moved) core.transferProvince(pid, b.id);
  C[a.id].name = '大厅帝国';
  const sc = core.makeScenario({ name: '大厅测试图', author: '作者乙', desc: '一句话简介' });
  return { sc, hash: core.scenarioHash(sc), moved, fromId: a.id, toId: b.id };
}
const MADE = mkScenario();

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
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop, click: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h; }, set(v) { e._h = v; } });
  return e;
}
const els = {};
const calls = [];
let adminMapsPending = [{ id: 'm111', name: '待审图', author: '甲', desc: '说明', hash: 'aaaa1111', size: 4096, createdAt: '2026-01-02T03:04:05Z', plays: 0, provinces: 3, countries: 1 }];
let adminMapsApproved = [{ id: 'm222', name: '已上线图', author: '乙', desc: '', hash: 'bbbb2222', size: 2048, createdAt: '2026-01-01T00:00:00Z', plays: 7, provinces: 5, countries: 2 }];
let lastReview = null, lastDelete = null;

const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, requestAnimationFrame: noop,
  document: {
    addEventListener: noop, getElementById: (i) => els[i] || (els[i] = mk('div')), createElement: (t) => mk(t),
    querySelector: () => null, querySelectorAll: () => [], body: { appendChild: noop }, hidden: false,
  },
  location: { search: '', pathname: '/gs/', protocol: 'https:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  ImageData: function (w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  alert: noop, confirm: () => true, prompt: () => '',
  URLSearchParams, navigator: { userAgent: 'node' },
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.fetch = async (url, opt) => {
  calls.push({ url, opt });
  const body = (o) => ({ status: 200, json: async () => o });
  if (url.endsWith('/api/maps')) return body({ ok: true, maps: adminMapsApproved.concat([]), stats: {} });
  if (/\/api\/maps\/([A-Za-z0-9_-]+)\/play$/.test(url)) return body({ ok: true });
  if (/\/api\/maps\/([A-Za-z0-9_-]+)$/.test(url)) {
    return body({ ok: true, meta: adminMapsPending[0], scenario: MADE.sc });
  }
  if (url.endsWith('/api/admin/login')) {
    const p = JSON.parse(opt.body).password;
    return body(p === 'goodpass' ? { ok: true, token: 'tok123.exp', expiresAt: Date.now() + 3600e3 } : { ok: false, err: '密码错误' });
  }
  if (url.includes('/api/admin/maps?status=')) {
    const which = url.split('status=')[1];
    return body({ ok: true, maps: which === 'approved' ? adminMapsApproved : adminMapsPending,
                  stats: { total: 2, pending: 1, approved: 1 } });
  }
  if (/\/api\/admin\/maps\/[A-Za-z0-9_-]+$/.test(url)) {
    return body({ ok: true, meta: adminMapsPending[0], status: 'pending', note: '上次备注', scenario: MADE.sc });
  }
  if (url.endsWith('/api/admin/review')) { lastReview = JSON.parse(opt.body); return body({ ok: true, status: 'approved' }); }
  if (url.endsWith('/api/admin/delete')) { lastDelete = JSON.parse(opt.body); return body({ ok: true }); }
  return body({ ok: false, err: 'unhandled ' + url });
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });
const settle = () => new Promise(r => setTimeout(r, 40));

console.log('\n=== 地图大厅 / 管理后台 验证 ===\n');

/* ================= 1. 地图大厅 ================= */
console.log('-- 1. 地图大厅列表 --');
await run(`openMapHall(); return 1;`);
await settle();
const h1 = run(`return document.getElementById('hall-list').innerHTML;`);
check('列表里出现「官方地图」入口', h1.includes('hall-official'), h1.slice(0, 160));
check('列表里出现已通过审核的地图', h1.includes('已上线图') && h1.includes('hall-pick'), h1.slice(0, 300));
check('显示了作者与游玩次数', h1.includes('乙') && h1.includes('▶7'), h1.slice(0, 300));
check('请求打到了 /gs/api/maps', calls.some(c => /\/gs\/api\/maps$/.test(c.url)), calls.map(c => c.url).slice(0, 3));

console.log('\n-- 2. 搜索过滤 --');
const h2 = run(`
  hallFilter='不存在的地图名'; renderHallList();
  const noMatch=document.getElementById('hall-list').innerHTML;
  hallFilter=''; renderHallList();
  return { noMatch, restored:document.getElementById('hall-list').innerHTML };
`);
check('搜不到时给出提示', h2.noMatch.includes('没有匹配的地图'), h2.noMatch.slice(0, 160));
check('清空搜索后恢复列表', h2.restored.includes('已上线图'), h2.restored.slice(0, 160));

/* ================= 3. 选用自定义地图 ================= */
console.log('\n-- 3. 选用自定义地图 → 本地世界被重建 --');
await run(`pickHallMap('m111'); return 1;`);
await settle();
const s3 = run(`
  const C=countries;
  return { mapId:currentMap&&currentMap.id, mapName:currentMap&&currentMap.name,
           hash:currentMap&&currentMap.hash,
           fromName:C[${MADE.fromId}].name,
           ownerOk:${JSON.stringify(MADE.moved)}.every(p=>provinces[p].owner===${MADE.toId}),
           modalHidden:document.getElementById('hallmodal').classList.contains('hidden'),
           badge:document.getElementById('map-badge').innerHTML };
`);
check('currentMap 记下了这张地图', s3.mapId === 'm111' && s3.mapName === '待审图', s3);
check('【核心】本地世界按剧本重建', s3.fromName === '大厅帝国', s3);
check('【核心】划走的省份归属正确', s3.ownerOk === true, s3);
check('大厅弹窗已关闭', s3.modalHidden === true, s3);
check('开始页徽章显示当前地图', s3.badge.includes('待审图'), s3.badge.slice(0, 160));

/* ================= 4. 回到官方地图 ================= */
console.log('\n-- 4. 切回官方地图 --');
run(`useOfficialMap(); return 1;`);
const s4 = run(`
  const C=countries;
  return { map:currentMap, name:C[${MADE.fromId}].name,
           badge:document.getElementById('map-badge').innerHTML,
           hash:MP.mapHash||'' };
`);
check('currentMap 清空', s4.map === null, s4);
check('世界恢复成官方地图', s4.name !== '大厅帝国', s4);
check('徽章回到「官方地图」', s4.badge.includes('官方地图'), s4.badge.slice(0, 160));

/* ================= 5. 管理后台登录 ================= */
console.log('\n-- 5. 管理后台：登录 --');
run(`openAdmin(); return 1;`);
const a0 = run(`return { shown:!document.getElementById('admin-login').classList.contains('hidden') };`);
check('未登录时显示登录框', a0.shown === true, a0);

run(`document.getElementById('admin-pass').value='wrongpass'; adminLogin(); return 1;`);
await settle();
const a1 = run(`return { msg:document.getElementById('admin-msg').textContent,
                         stillLogin:!document.getElementById('admin-login').classList.contains('hidden'),
                         tok:adminTok };`);
check('密码错误时给出提示且不进入', a1.msg.includes('密码错误') && a1.stillLogin === true && a1.tok === '', a1);

run(`document.getElementById('admin-pass').value='goodpass'; adminLogin(); return 1;`);
await settle();
const a2 = run(`
  return { tok:adminTok, mainShown:!document.getElementById('admin-main').classList.contains('hidden'),
           loginHidden:document.getElementById('admin-login').classList.contains('hidden'),
           stored:sessionStorage.getItem('gs_admin_tok')||'' };
`);
check('密码正确后进入主界面', a2.tok === 'tok123.exp' && a2.mainShown === true && a2.loginHidden === true, a2);
check('令牌写进 sessionStorage（刷新不掉线）', a2.stored === 'tok123.exp', a2);

/* ================= 6. 待审列表 ================= */
console.log('\n-- 6. 待审列表 --');
const a3 = run(`return { list:document.getElementById('admin-list').innerHTML,
                         stats:document.getElementById('admin-stats').textContent };`);
check('列表显示待审地图', a3.list.includes('待审图') && a3.list.includes('admin-preview'), a3.list.slice(0, 240));
check('显示统计', a3.stats.includes('待审 1') && a3.stats.includes('已上线 1'), a3.stats);
check('请求带上了管理令牌', calls.some(c => c.opt && c.opt.headers && c.opt.headers['x-admin-token'] === 'tok123.exp'), 'no token header');

console.log('\n-- 7. 切换标签 --');
run(`adminTab='approved'; loadAdminList(); return 1;`);
await settle();
const a4 = run(`return document.getElementById('admin-list').innerHTML;`);
check('切到「已上线」后显示的是另一批', a4.includes('已上线图') && !a4.includes('待审图'), a4.slice(0, 200));
run(`adminTab='pending'; loadAdminList(); return 1;`);
await settle();

/* ================= 8. 预览 ================= */
console.log('\n-- 8. 预览：把地图套到背景世界 --');
await run(`adminPreview('m111'); return 1;`);
await settle();
const a5 = run(`
  const C=countries;
  return { pvId:adminPvId, name:C[${MADE.fromId}].name,
           ownerOk:${JSON.stringify(MADE.moved)}.every(p=>provinces[p].owner===${MADE.toId}),
           info:document.getElementById('admin-pv-info').innerHTML,
           previewShown:!document.getElementById('admin-preview').classList.contains('hidden'),
           modalHidden:document.getElementById('adminmodal').classList.contains('hidden') };
`);
check('进入预览态', a5.pvId === 'm111' && a5.previewShown === true, a5);
check('【核心】世界套用了待审地图', a5.name === '大厅帝国' && a5.ownerOk === true, a5);
check('预览时让出屏幕看地图', a5.modalHidden === true, a5);
check('预览信息里有哈希与改动量', a5.info.includes('aaaa1111') && a5.info.includes('上次备注'), a5.info.slice(0, 240));

/* ================= 9. 审核通过 ================= */
console.log('\n-- 9. 审核通过 --');
await run(`adminReview('approve'); return 1;`);
await settle();
const a6 = run(`
  const C=countries;
  return { review:${JSON.stringify(null)}, pvId:adminPvId,
           name:C[${MADE.fromId}].name,
           mainShown:!document.getElementById('admin-main').classList.contains('hidden'),
           modalShown:!document.getElementById('adminmodal').classList.contains('hidden') };
`);
check('发出了通过请求', lastReview && lastReview.id === 'm111' && lastReview.action === 'approve', lastReview);
check('审核后自动退出预览', a6.pvId === '' && a6.mainShown === true && a6.modalShown === true, a6);
check('【核心】世界已恢复（不再是待审地图）', a6.name !== '大厅帝国', a6);

/* ================= 10. 拒绝与删除 ================= */
console.log('\n-- 10. 拒绝与删除 --');
run(`
  currentMap={id:'m222',name:'已上线图',author:'乙',hash:'bbbb2222',scenario:${JSON.stringify(MADE.sc)}};
  buildWorldFromScenario(currentMap.scenario);
  return 1;
`);
await run(`adminPreview('m111'); return 1;`);
await settle();
await run(`adminReview('reject'); return 1;`);
await settle();
check('发出了拒绝请求', lastReview && lastReview.action === 'reject', lastReview);
const a7 = run(`return { name:countries[${MADE.fromId}].name, mapId:currentMap&&currentMap.id };`);
check('拒绝后恢复到预览前用的那张地图', a7.mapId === 'm222' && a7.name === '大厅帝国', a7);

await run(`adminPreview('m111'); return 1;`);
await settle();
await run(`adminDelete(); return 1;`);
await settle();
check('发出了删除请求', lastDelete && lastDelete.id === 'm111', lastDelete);
check('删除后也恢复了原地图', run(`return currentMap&&currentMap.id;`) === 'm222');

/* ================= 11. 退出登录 ================= */
console.log('\n-- 11. 退出登录 --');
run(`adminLogout(); return 1;`);
const a8 = run(`return { tok:adminTok, stored:sessionStorage.getItem('gs_admin_tok')||'',
                         loginShown:!document.getElementById('admin-login').classList.contains('hidden') };`);
check('清空令牌并回到登录框', a8.tok === '' && a8.stored === '' && a8.loginShown === true, a8);

/* ================= 12. 联机时地图包对齐 ================= */
console.log('\n-- 12. 联机房间地图对齐（mpSyncMap） --');
const s12 = run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
  MP.mapHash='';
  const defName=countries[${MADE.fromId}].name;
  // 收到带地图包的大厅消息 → 本地世界重建
  const changed=mpSyncMap({id:'m111',name:'大厅测试图',hash:'${MADE.hash}',scenario:${JSON.stringify(MADE.sc)}});
  const afterName=countries[${MADE.fromId}].name;
  const hashNow=MP.mapHash;
  // 同一张图再来一次：不该重复重建
  const again=mpSyncMap({id:'m111',name:'大厅测试图',hash:'${MADE.hash}',scenario:${JSON.stringify(MADE.sc)}});
  // 换回默认（不带地图包）→ 重建官方世界
  const back=mpSyncMap(null);
  return { defName, changed, afterName, hashNow, again, back, finalName:countries[${MADE.fromId}].name };
`);
check('初始是官方地图', s12.defName !== '大厅帝国', s12);
check('【核心】收到地图包后重建世界', s12.changed === true && s12.afterName === '大厅帝国', s12);
check('记下了地图哈希', s12.hashNow === MADE.hash, s12);
check('同一张图不重复重建', s12.again === false, s12);
check('切回默认时也重建', s12.back === true && s12.finalName !== '大厅帝国', s12);

/* ================= 13. 弹窗互斥（三个线上 bug 的根因） ================= */
console.log('\n-- 13. 弹窗互斥：任何时刻只能有一个顶层弹窗 --');
run(`['lobby','selectmodal','hallmodal','adminmodal','helpmodal','defeatmodal','slotmodal'].forEach(i=>$(i)); return 1;`);
const visible = () => run(`
  return ['lobby','selectmodal','hallmodal','adminmodal','helpmodal','defeatmodal','slotmodal']
    .filter(i=>!$(i).classList.contains('hidden'));
`);

run(`showOnlyModal('lobby'); return 1;`);
check('showOnlyModal 只留一个', JSON.stringify(visible()) === JSON.stringify(['lobby']), visible());

run(`mpSolo(); return 1;`);
check('单机游戏 → 只剩「选择王朝」', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());

/* bug 1：两个地图大厅按钮 —— 根因是两层弹窗同时可见且背景半透明 */
await run(`openMapHall(); return 1;`);
await settle();
check('【bug1】从选国界面开大厅 → 只剩大厅一层', JSON.stringify(visible()) === JSON.stringify(['hallmodal']), visible());

await run(`closeMapHall(); return 1;`);
check('【bug1】返回回到原来那一层（选国界面）', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());

run(`showOnlyModal('lobby'); lbShow('entry'); return 1;`);
await run(`openMapHall(); return 1;`);
await settle();
check('【bug1】从大厅开大厅 → 只剩大厅一层', JSON.stringify(visible()) === JSON.stringify(['hallmodal']), visible());
await run(`closeMapHall(); return 1;`);
check('【bug1】返回回到大厅', JSON.stringify(visible()) === JSON.stringify(['lobby']), visible());

/* bug 2：点编辑器后大厅还留着，挡住编辑界面 */
run(`editorFrom='lobby'; openEditor(); return 1;`);
check('【bug2】进编辑器 → 所有弹窗都收起来', JSON.stringify(visible()) === JSON.stringify([]), visible());
run(`closeEditor(); return 1;`);
check('【bug2】退出编辑器 → 回到大厅', JSON.stringify(visible()) === JSON.stringify(['lobby']), visible());

run(`mpSolo(); editorFrom='selectmodal'; openEditor(); return 1;`);
check('【bug2】从选国界面进编辑器 → 也是全收起', JSON.stringify(visible()) === JSON.stringify([]), visible());
run(`closeEditor(); return 1;`);
check('【bug2】退出后回到选国界面', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());

/* 管理后台 */
run(`showOnlyModal('lobby'); adminFrom='lobby'; openAdmin(); return 1;`);
check('管理后台独占一层', JSON.stringify(visible()) === JSON.stringify(['adminmodal']), visible());
run(`closeAdmin(); return 1;`);
check('关掉管理后台回到大厅', JSON.stringify(visible()) === JSON.stringify(['lobby']), visible());

/* 开局必须清空所有弹窗 */
run(`mpSolo(); showOnlyModal('selectmodal'); startGame(1); started=false; player=0; return 1;`);
check('开局后所有弹窗都收掉', JSON.stringify(visible()) === JSON.stringify([]), visible());
run(`closeSlotModal(); return 1;`);
check('存档弹窗关闭后回到选国界面（未开局）', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());

/* ================= 14. 大厅默认官方地图 ================= */
console.log('\n-- 14. 地图大厅默认显示官方地图 --');
run(`currentMap=null; hallMaps=[]; hallFilter=''; renderHallList(); return 1;`);
const h14 = run(`return document.getElementById('hall-list').innerHTML;`);
check('【bug3】没有自定义地图时也有官方地图入口', h14.includes('官方地图') && h14.includes('hall-official'), h14.slice(0, 200));
check('【bug3】官方地图标为「正在使用」', h14.includes('正在使用'), h14.slice(0, 240));
check('给出了"怎么做出第一张图"的提示', h14.includes('地图编辑器'), h14.slice(0, 400));

run(`hallMaps=[{id:'mX',name:'别人的图',author:'甲',desc:'',hash:'h',size:2048,createdAt:'2026-01-01T00:00:00Z',plays:3,provinces:5,countries:1}]; renderHallList(); return 1;`);
const h15 = run(`return document.getElementById('hall-list').innerHTML;`);
check('有自定义地图时官方地图仍排在最前', h15.indexOf('官方地图') < h15.indexOf('别人的图'), h15.slice(0, 300));
check('自定义地图有分组标题', h15.includes('玩家自制地图'), h15.slice(0, 300));
check('使用中的自定义地图会被标出', (() => {
  run(`currentMap={id:'mX',name:'别人的图',author:'甲',hash:'h',scenario:{}}; renderHallList(); return 1;`);
  const h = run(`return document.getElementById('hall-list').innerHTML;`);
  const seg = h.slice(h.indexOf('别人的图'));
  return seg.includes('正在使用');
})(), h15.slice(0, 300));

/* 选完地图应直接进入选国界面（而不是留在原地） */
await run(`currentMap=null; pickHallMap('m111'); return 1;`);
await settle();
check('【bug3】选中地图后直接进入选国界面', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());
check('选国界面也显示了当前地图名', run(`return document.getElementById('sel-mapbadge').innerHTML;`).includes('待审图'),
  run(`return document.getElementById('sel-mapbadge').innerHTML;`).slice(0, 160));

run(`useOfficialMap(); return 1;`);
check('选官方地图后同样进入选国界面', JSON.stringify(visible()) === JSON.stringify(['selectmodal']), visible());
check('徽章回到官方地图', run(`return document.getElementById('sel-mapbadge').innerHTML;`).includes('官方地图'));

/* ================= 15. 按钮不重复（静态检查） ================= */
console.log('\n-- 15. 静态检查：入口按钮不重复 --');
{
  const html = read('web/index.html');
  const count = (s) => (html.split(s).length - 1);
  // 「换地图」和「地图大厅」是同一个 action，但文案不同、处于互斥的两层弹窗里，
  // 所以这里按**文案**校验唯一性，而不是按 data-act。
  check('「🗺 地图大厅」按钮只有一个', count('🗺 地图大厅') === 1, count('🗺 地图大厅'));
  check('「🛠 地图编辑器」按钮只有一个', count('🛠 地图编辑器') === 1, count('🛠 地图编辑器'));
  check('「⬆ 导入地图」按钮只有一个', count('⬆ 导入地图') === 1, count('⬆ 导入地图'));
  check('「⚙ 地图审核」按钮只有一个', count('⚙ 地图审核') === 1, count('⚙ 地图审核'));
  check('选国界面用的是「换地图」而不是又一个「地图大厅」', count('🗺 换地图') === 1, count('🗺 换地图'));
  check('选国界面有「返回大厅」', html.includes('data-act="sel-back"'));
  // 所有顶层弹窗初始都应该是 hidden（#lobby 由 init 里 showOnlyModal('lobby') 打开）
  const modals = ['selectmodal', 'hallmodal', 'adminmodal', 'helpmodal', 'defeatmodal', 'slotmodal'];
  const notHidden = modals.filter(id => !new RegExp('id="' + id + '" class="modal hidden"').test(html));
  check('除大厅外的弹窗初始都是隐藏的', notHidden.length === 0, notHidden);
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
