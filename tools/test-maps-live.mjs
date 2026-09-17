// 线上验证：地图工坊全链路（真机 + nginx + wss）
// 提交 → 审核 → 地图大厅可见 → 两个玩家用这张地图联机开局 → 世界与剧本一致 → 清理
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST", "GS_PASS", "GS_DOMAIN", "MAP_ADMIN_PASS"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));
const read = (p) => readFileSync(join(root, p), 'utf8');
const DOM = process.env.GS_DOMAIN || 'localhost';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 260) : '')); } };

/* 管理员口令只存在服务器本地；线上测试通过环境变量提供 */
const ADMIN = process.env.MAP_ADMIN_PASS || '';
if (!ADMIN) { console.error('缺少 MAP_ADMIN_PASS 环境变量（口令在服务器 srv/.env 里）'); process.exit(2); }

/* ---------- 造一份真实剧本 ---------- */
function makeScenario() {
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
  C[a.id].name = '线上测试帝国';
  C[b.id].overlord = a.id; C[b.id].subject = core.SUBJ_PUPPET;
  const sc = core.makeScenario({ name: '线上自检图', author: '自检脚本', desc: '线上端到端验证用，稍后自动删除' });
  return { sc, hash: core.scenarioHash(sc), moved, fromId: a.id, toId: b.id };
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const r = await fetch(`https://${DOM}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return { code: r.status, body: JSON.parse(t) }; } catch (e) { return { code: r.status, body: null, raw: t }; }
}

console.log('\n=== 线上：地图工坊全链路 ===\n');
const MADE = makeScenario();
check('造出一份剧本', Object.keys(MADE.sc.provinces).length > 0, Object.keys(MADE.sc.provinces).length);

/* ================= 1. 管理员登录 ================= */
console.log('-- 1. 管理员登录 --');
const bad = await api('POST', '/api/admin/login', { password: 'definitely-wrong' });
check('错误口令被拒绝', bad.body && bad.body.ok === false, bad.body);
const login = await api('POST', '/api/admin/login', { password: ADMIN });
check('正确口令拿到令牌', login.body && login.body.ok === true && !!login.body.token, login.body);
const TOK = login.body.token;

/* ================= 2. 提交 ================= */
console.log('\n-- 2. 提交地图 --');
const hallBefore = await api('GET', '/api/maps');
const n0 = hallBefore.body.maps.length;
const sub = await api('POST', '/api/maps', { meta: { name: '线上自检图', author: '自检脚本', desc: '线上端到端验证用' }, scenario: MADE.sc });
check('提交成功', sub.body && sub.body.ok === true && !!sub.body.id, sub.body);
const MID = sub.body.id;
check('哈希与本地算的一致', sub.body.hash === MADE.hash, { server: sub.body.hash, local: MADE.hash });

/* ================= 3. 待审不可见 ================= */
console.log('\n-- 3. 未过审不可见 --');
check('大厅里看不到', (await api('GET', '/api/maps')).body.maps.every(m => m.id !== MID));
check('公开取图 404', (await api('GET', '/api/maps/' + MID)).code === 404);
check('未带令牌的管理接口 401', (await api('GET', '/api/admin/maps')).code === 401);

/* ================= 4. 审核 ================= */
console.log('\n-- 4. 审核通过 --');
check('待审列表里有它', (await api('GET', '/api/admin/maps?status=pending', undefined, TOK)).body.maps.some(m => m.id === MID));
const appr = await api('POST', '/api/admin/review', { id: MID, action: 'approve', note: '自检通过' }, TOK);
check('审核通过', appr.body && appr.body.ok === true, appr.body);
const hallAfter = await api('GET', '/api/maps');
check('【核心】大厅里出现了', hallAfter.body.maps.some(m => m.id === MID), hallAfter.body.maps.map(m => m.id));
check('大厅数量 +1', hallAfter.body.maps.length === n0 + 1, { before: n0, after: hallAfter.body.maps.length });
const fetched = await api('GET', '/api/maps/' + MID);
check('【核心】取回的剧本与提交的完全一致', JSON.stringify(fetched.body.scenario) === JSON.stringify(MADE.sc));

/* ================= 5. 用这张地图联机开局 ================= */
console.log('\n-- 5. 两个玩家用这张地图联机开局 --');
function mkClient(label) {
  const ws = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
  const c = { label, ws, msgs: [], errors: [] };
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    if (m.t === 'error') c.errors.push(m.msg);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.last = (t) => c.msgs.filter(m => m.t === t).slice(-1)[0];
  return c;
}
const A = mkClient('A'), B = mkClient('B');
await Promise.all([
  new Promise(r => { A.ws.on('open', r); A.ws.on('error', r); }),
  new Promise(r => { B.ws.on('open', r); B.ws.on('error', r); }),
]);
A.send({ t: 'create', name: '图主', mapId: MID });
await sleep(1200);
const lob = A.last('lobby');
check('建房成功', !!lob, A.errors.join('|'));
check('【核心】大厅回包带地图包', !!lob && !!lob.map && !!lob.map.scenario, lob && lob.map && lob.map.id);
check('地图哈希一致', lob && lob.map && lob.map.hash === MADE.hash, lob && lob.map && lob.map.hash);
const room = lob.room;

B.send({ t: 'join', name: '友军', room });
await sleep(1200);
check('加入成功', B.errors.length === 0, B.errors.join('|'));
check('【核心】加入者也拿到同一张地图', B.last('lobby') && B.last('lobby').map && B.last('lobby').map.hash === MADE.hash,
  B.last('lobby') && B.last('lobby').map && B.last('lobby').map.hash);

A.send({ t: 'pick', country: MADE.fromId });
B.send({ t: 'pick', country: MADE.toId });
await sleep(800);
A.send({ t: 'start' });
await sleep(9000);

const begA = A.last('begin'), begB = B.last('begin');
check('双方都开局', !!begA && !!begB, `${!!begA}/${!!begB}`);
check('begin 也带地图包（供重连）', !!begA && !!begA.map && begA.map.hash === MADE.hash, begA && begA.map && begA.map.hash);

/* 最关键：服务端确实按剧本建了世界 */
const owners = {};
begA.snapshot.prov.forEach((p, i) => { owners[i + 1] = p[0]; });
check('【核心】服务端世界按剧本建（划走的省归属正确）',
  MADE.moved.every(pid => owners[pid] === MADE.toId),
  { moved: MADE.moved, got: MADE.moved.map(p => owners[p]), want: MADE.toId });
const row = begA.snapshot.ct[MADE.toId - 1];
check('【核心】剧本里的宗主+傀儡国体生效', !!row && row.ov === MADE.fromId && row.sj === 2, row);

await sleep(2000);
check('世界正常推进', A.msgs.filter(m => m.t === 'delta').length > 10, 'deltas=' + A.msgs.filter(m => m.t === 'delta').length);

/* ================= 6. 清理 ================= */
console.log('\n-- 6. 清理自检地图 --');
A.ws.close(); B.ws.close();
await sleep(600);
check('删除成功', (await api('POST', '/api/admin/delete', { id: MID }, TOK)).body.ok === true);
check('删除后大厅恢复原状', (await api('GET', '/api/maps')).body.maps.length === n0);
check('删除后取图 404', (await api('GET', '/api/maps/' + MID)).code === 404);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
