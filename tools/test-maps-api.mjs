// 地图工坊 HTTP API 测试：提交 → 待审 → 管理员登录 → 审核 → 大厅可见 → 下架
// 同时覆盖鉴权、限流、脏数据、路径穿越、超大请求体等安全边界。
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

const PORT = 7812;
const BASE = '/gs';
const ADMIN_PASS = 'unit-test-pass-9471';
const TMP = join(root, '_tools', '_tmp_maps_api');
try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
mkdirSync(TMP, { recursive: true });

const srv = spawn(process.execPath, [join(root, 'srv', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE, MAPS_DIR: TMP, MAP_ADMIN_PASS: ADMIN_PASS },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(900);

/* ---------- HTTP 小工具 ---------- */
async function req(method, p, body, headers) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) },
      (res) => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) {}
          resolve({ code: res.statusCode, body: j, raw: b });
        });
      });
    r.on('error', (e) => resolve({ code: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 造一份真实剧本（用 VM 跑内核导出） ---------- */
function makeScenario() {
  const sb = {
    console, Math, Date, JSON, Set, Map, Array, Object, Number, String, Error, isFinite, parseInt, parseFloat,
    Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
    UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
    module: { exports: {} }, globalThis: null,
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
  vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
  const core = sb.module.exports;
  core.resetWorld(); core.setSeed(987654321); core.buildWorld(); core.captureScenarioBase();
  const C = core.countries();
  const a = C.find(c => c && c.alive && c.provList.length > 8);
  const b = C.find(c => c && c.alive && c.id !== a.id && c.provList.length > 5);
  const moved = a.provList.slice(0, 4);
  for (const pid of moved) core.transferProvince(pid, b.id);
  C[a.id].name = '测试帝国';
  C[b.id].overlord = a.id;
  C[b.id].subject = core.SUBJ_PUPPET;
  const sc = core.makeScenario({ name: '测试地图', author: '测试员', desc: '单元测试用' });
  return { scenario: sc, hash: core.scenarioHash(sc),
           moved, fromId: a.id, toId: b.id, newName: '测试帝国' };
}

console.log('\n=== 地图工坊 API 测试 ===\n');
const made = makeScenario();
const scenario = made.scenario;
check('造出一份剧本', !!scenario && !!scenario.provinces, Object.keys(scenario.provinces || {}).length);

/* ================= 1. 未登录时的公开接口 ================= */
console.log('-- 1. 公开接口：大厅起初是空的 --');
const hall0 = await req('GET', '/api/maps');
check('GET /api/maps 返回空大厅', hall0.code === 200 && hall0.body.ok && hall0.body.maps.length === 0, hall0.body);
check('大厅接口走 /gs 前缀也能用', (await req('GET', '/gs/api/maps')).code === 200);
check('healthz 里带地图统计', (await req('GET', '/healthz')).body.maps && typeof (await req('GET', '/healthz')).body.maps.approved === 'number');

/* ================= 2. 提交地图 ================= */
console.log('\n-- 2. 提交地图 --');
const sub = await req('POST', '/api/maps', { meta: { name: '测试地图', author: '测试员', desc: '单元测试用' }, scenario });
check('提交成功并拿到 id', sub.code === 200 && sub.body.ok && /^m[0-9a-z]+$/.test(sub.body.id || ''), sub.body);
const mapId = sub.body.id;

check('重复提交同一份内容被拒绝', (await req('POST', '/api/maps', { meta: { name: '测试地图' }, scenario })).body.err.includes('已经提交过'));
check('版本不符的剧本被拒绝',
  (await req('POST', '/api/maps', { meta: { name: '坏图' }, scenario: { v: 99, base: 'ne110m' } })).body.err.includes('版本'));
check('缺少名称被拒绝',
  (await req('POST', '/api/maps', { meta: { name: '   ' }, scenario: { v: 1, base: 'ne110m', seed: 1, countries: {}, provinces: {} } })).body.err.includes('名称'));
check('非 JSON 体被拒绝', (await req('POST', '/api/maps', 'not json at all')).body.err.includes('JSON'));
check('超大请求体被拒绝', (await req('POST', '/api/maps', '{"meta":{},"scenario":"' + 'x'.repeat(1200000) + '"}')).code === 413);

/* ================= 3. 待审状态不可游玩 ================= */
console.log('\n-- 3. 未过审的地图无法游玩 --');
check('大厅里看不到待审地图', (await req('GET', '/api/maps')).body.maps.length === 0);
check('直接取图返回 404', (await req('GET', '/api/maps/' + mapId)).code === 404);
check('不存在的 id 返回 404', (await req('GET', '/api/maps/mzzzzzz')).code === 404);
check('路径穿越被挡住', (await req('GET', '/api/maps/..%2F..%2Fsrv%2Fserver.js')).code === 404);

/* ================= 4. 管理员鉴权 ================= */
console.log('\n-- 4. 管理员登录与鉴权 --');
check('未带令牌访问管理接口 → 401', (await req('GET', '/api/admin/maps')).code === 401);
check('伪造令牌 → 401', (await req('GET', '/api/admin/maps', undefined, { 'x-admin-token': 'x.y' })).code === 401);
const badLogin = await req('POST', '/api/admin/login', { password: 'wrong-password' });
check('密码错误被拒绝', badLogin.body.ok === false, badLogin.body);
const login = await req('POST', '/api/admin/login', { password: ADMIN_PASS });
check('密码正确拿到令牌', login.body.ok === true && typeof login.body.token === 'string' && login.body.token.includes('.'), login.body);
const TOK = login.body.token;
check('令牌有 12 小时有效期', login.body.expiresAt - Date.now() > 11 * 3600 * 1000, login.body.expiresAt);
const authed = { 'x-admin-token': TOK };

/* ================= 5. 审核流程 ================= */
console.log('\n-- 5. 审核：预览 → 通过 → 上线 --');
const pend = await req('GET', '/api/admin/maps?status=pending', undefined, authed);
check('待审列表里有刚提交的地图', pend.body.ok && pend.body.maps.some(m => m.id === mapId), pend.body.maps);
const meta0 = pend.body.maps.find(m => m.id === mapId);
check('元信息带名称/作者/大小/哈希', meta0.name === '测试地图' && meta0.author === '测试员' && meta0.size > 0 && /^[0-9a-f]{8}$/.test(meta0.hash), meta0);

const prev = await req('GET', '/api/admin/maps/' + mapId, undefined, authed);
check('管理员能取到待审地图的完整剧本', prev.body.ok && !!prev.body.scenario && prev.body.status === 'pending', prev.body.status);
check('取回的剧本与提交的一致', JSON.stringify(prev.body.scenario) === JSON.stringify(scenario));

const appr = await req('POST', '/api/admin/review', { id: mapId, action: 'approve', note: '不错' }, authed);
check('审核通过', appr.body.ok === true && appr.body.status === 'approved', appr.body);

const hall1 = await req('GET', '/api/maps');
check('【核心】通过后出现在大厅', hall1.body.maps.some(m => m.id === mapId), hall1.body.maps);
const got = await req('GET', '/api/maps/' + mapId);
check('【核心】大厅能取到剧本本体', got.body.ok && JSON.stringify(got.body.scenario) === JSON.stringify(scenario), got.body.meta);
check('元信息里带上了审核时间', !!got.body.meta.reviewedAt, got.body.meta);
check('待审列表里已经没有它', (await req('GET', '/api/admin/maps?status=pending', undefined, authed)).body.maps.length === 0);

/* ================= 6. 游玩计数 ================= */
console.log('\n-- 6. 游玩次数 --');
check('计数初始为 0', (await req('GET', '/api/maps')).body.maps.find(m => m.id === mapId).plays === 0);
await req('POST', '/api/maps/' + mapId + '/play');
await req('POST', '/api/maps/' + mapId + '/play');
check('游玩后计数 +2', (await req('GET', '/api/maps')).body.maps.find(m => m.id === mapId).plays === 2);

/* ================= 7. 下架与删除 ================= */
console.log('\n-- 7. 拒绝 / 重新上架 / 删除 --');
check('拒绝操作生效', (await req('POST', '/api/admin/review', { id: mapId, action: 'reject', note: '不合规' }, authed)).body.status === 'rejected');
check('被拒绝后从大厅消失', !(await req('GET', '/api/maps')).body.maps.some(m => m.id === mapId));
check('被拒绝后公开取图 404', (await req('GET', '/api/maps/' + mapId)).code === 404);
check('撤回待审状态', (await req('POST', '/api/admin/review', { id: mapId, action: 'pending' }, authed)).body.status === 'pending');
check('重新通过', (await req('POST', '/api/admin/review', { id: mapId, action: 'approve' }, authed)).body.status === 'approved');
check('未知操作被拒绝', (await req('POST', '/api/admin/review', { id: mapId, action: 'destroy' }, authed)).body.ok === false);
check('删除不存在的地图被拒绝', (await req('POST', '/api/admin/delete', { id: 'mnope' }, authed)).body.ok === false);
check('删除成功', (await req('POST', '/api/admin/delete', { id: mapId }, authed)).body.ok === true);
check('删除后大厅为空', (await req('GET', '/api/maps')).body.maps.length === 0);
check('删除后公开取图 404', (await req('GET', '/api/maps/' + mapId)).code === 404);

/* ================= 8. 落盘持久化 ================= */
console.log('\n-- 8. 数据确实落盘 --');
const idx = JSON.parse(readFileSync(join(TMP, 'index.json'), 'utf8'));
check('索引文件存在且结构正确', idx && idx.v === 1 && typeof idx.maps === 'object', Object.keys(idx || {}));
check('删除后索引里也没有残留', !idx.maps[mapId]);

/* ================= 9. 没配管理员密码时 fail closed ================= */
console.log('\n-- 9. 未配置管理员密码时整体关闭 --');
{
  const { createMapStore } = require(join(root, 'srv', 'maps.js'));
  const core = (() => {
    const sb = { console, Math, Date, JSON, Set, Map, Array, Object, Number, String, isFinite, parseInt, parseFloat,
      Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
      UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
      module: { exports: {} }, globalThis: null };
    sb.globalThis = sb;
    const ctx = vm.createContext(sb);
    vm.runInContext(read('web/world-data.js'), ctx, { filename: 'w' });
    vm.runInContext(read('web/game-core.js'), ctx, { filename: 'c' });
    return sb.module.exports;
  })();
  const st = createMapStore(core, { adminPass: '', log: () => {} });
  check('adminEnabled 为 false', st.adminEnabled() === false);
  check('登录直接失败', st.login('1.2.3.4', '').ok === false);
  check('任意令牌都不通过', st.checkToken('9999999999999.deadbeef') === false);
  check('短密码（<6位）也算未启用', createMapStore(core, { adminPass: 'abc', log: () => {} }).adminEnabled() === false);
}

/* ================= 10. 联机：自定义地图随房间下发 ================= */
console.log('\n-- 10. 联机：自定义地图下发与哈希校验 --');
{
  const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));
  const WS_URL = `ws://127.0.0.1:${PORT}${BASE}/ws`;
  function mkClient() {
    const ws = new WebSocket(WS_URL, { perMessageDeflate: false });
    const c = { ws, msgs: [], errors: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      if (m.t === 'error') c.errors.push(m.msg);
    });
    c.send = (o) => ws.send(JSON.stringify(o));
    c.last = (t) => c.msgs.filter((m) => m.t === t).slice(-1)[0];
    return c;
  }
  const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

  // 先重新提交并审核通过一张地图（前面的用例把它删了）
  const sub2 = await req('POST', '/api/maps', { meta: { name: '联机测试图', author: '测试员' }, scenario });
  const mid = sub2.body.id;
  await req('POST', '/api/admin/review', { id: mid, action: 'approve' }, authed);

  const A = mkClient(), B = mkClient();
  await Promise.all([
    new Promise((r) => { A.ws.on('open', r); A.ws.on('error', r); }),
    new Promise((r) => { B.ws.on('open', r); B.ws.on('error', r); }),
  ]);
  A.send({ t: 'create', name: '房主', mapId: mid });
  await sleep2(500);
  const lob = A.last('lobby');
  check('建房成功', !!lob, A.errors.join('|'));
  check('【核心】大厅回包带了地图包', !!lob && !!lob.map && !!lob.map.scenario, lob && lob.map && lob.map.id);
  check('地图哈希与提交时一致', lob && lob.map && lob.map.hash === sub2.body.hash, lob && lob.map && lob.map.hash);
  check('地图包内容与提交的一致', lob && JSON.stringify(lob.map.scenario) === JSON.stringify(scenario));
  const room = lob.room;

  B.send({ t: 'join', name: '客人', room });
  await sleep2(500);
  const lobB = B.last('lobby');
  check('【核心】加入者也拿到同一张地图包', !!lobB && !!lobB.map && lobB.map.hash === lob.map.hash, lobB && lobB.map && lobB.map.hash);
  check('加入没有报错', B.errors.length === 0, B.errors.join('|'));

  // 用未过审 / 不存在的地图建房必须被拒绝
  const C2 = mkClient();
  await new Promise((r) => { C2.ws.on('open', r); C2.ws.on('error', r); });
  C2.send({ t: 'create', name: '坏人', mapId: 'mnope' });
  await sleep2(400);
  check('用不存在的地图建房被拒绝', C2.errors.length > 0, C2.errors.join('|'));
  C2.ws.close();

  A.send({ t: 'pick', country: made.fromId });
  B.send({ t: 'pick', country: made.toId });
  await sleep2(400);
  A.send({ t: 'start' });
  await sleep2(2600);

  const begA = A.last('begin'), begB = B.last('begin');
  check('双方都开局了', !!begA && !!begB, `${!!begA}/${!!begB}`);
  check('begin 里也带了地图包（供重连重建）', !!begA && !!begA.map && begA.map.hash === lob.map.hash,
    begA && begA.map && begA.map.hash);

  /* 最关键的一条：服务端确实按自定义地图建了世界。
     剧本把 a 的 4 个省划给了 b，快照里这些省的归属必须是 b。 */
  const owners = {};
  begA.snapshot.prov.forEach((p, i) => { owners[i + 1] = p[0]; });
  const okMove = made.moved.every((pid) => owners[pid] === made.toId);
  check('【核心】服务端世界按剧本建（划走的省份归属正确）', okMove === true,
    { moved: made.moved, owners: made.moved.map((p) => owners[p]), want: made.toId });
  check('剧本里的宗主关系也生效', (() => {
    const row = begA.snapshot.ct[made.toId - 1];
    return row && row.ov === made.fromId && row.sj === 2;
  })(), begA.snapshot.ct[made.toId - 1]);

  A.ws.close(); B.ws.close();
}

/* ================= 11. 静态资源没被 API 影响 ================= */
console.log('\n-- 10. 原有接口未受影响 --');
check('首页仍可访问', (await req('GET', '/gs/')).code === 200);
check('game-core.js 仍可访问', (await req('GET', '/gs/game-core.js')).code === 200);
check('healthz 仍正常', (await req('GET', '/healthz')).body.ok === true);
check('未知 API 返回 404 JSON', (await req('GET', '/api/nope')).code === 404);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
srv.kill();
try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(failures ? 1 : 0);
