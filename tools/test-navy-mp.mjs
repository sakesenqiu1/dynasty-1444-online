// 联机海军抵达后位置回跳 —— 回归测试
//
// 原 bug：舰队抵达目的地后会被画在**出发点**。
// 根因在增量编码：
//   · 陆军路径用空数组表示"没有路径"：  (a.path || []).slice()
//   · 海军航路却用 null：              (a.navPath || null)
//   而行末的 null 又是"本次增量没带这个字段、保持不变"的意思 ——
//   客户端 `if (navPath !== null) a.navPath = navPath` 就把清空信号丢了，
//   旧航路一直留着；同时服务端把 navIdx 归零，
//   渲染 navPath[navIdxF] = navPath[0] = 出发点。
//
// 这个测试真的起服务、用带舰队的自定义地图开一局、下令出海，
// 然后逐帧重放增量，检查抵达那一刻客户端到底怎么处理。
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(join(root, p), 'utf8');
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

/* ---------- 先在内核里挑一对"近海相邻"的省，让航程短一点 ---------- */
const sb = {
  console, Math, Date, JSON, Set, Map, Array, Object, Number, String, Error, isFinite, parseInt, parseFloat,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float64Array,
  UI: { log() {}, panel() {}, topbar() {}, recolorNbrs() {}, cedeReset() {}, defeat() {} },
  module: { exports: {} }, globalThis: null,
};
sb.globalThis = sb;
const vctx = vm.createContext(sb);
vm.runInContext(read('web/world-data.js'), vctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), vctx, { filename: 'game-core.js' });
const core = sb.module.exports;
core.resetWorld(); core.setSeed(987654321); core.buildWorld(); core.captureScenarioBase();

const PAIR = (() => {
  const P = core.provinces();
  const coast = [];
  for (let i = 1; i < P.length; i++) if (P[i].pix.length && P[i].coastPix && P[i].coastPix.length) coast.push(i);
  // 只取前若干个候选，找一条最短的航路
  let best = null;
  for (let k = 0; k < coast.length && k < 8; k++) {
    const a = coast[k];
    for (let m = 0; m < 40; m++) {
      const b = coast[(k * 37 + m * 11 + 5) % coast.length];
      if (a === b) continue;
      const np = core.findNavalPath(a, b);
      if (np && np.length >= 4 && (!best || np.length < best.len)) best = { a, b, len: np.length };
      if (best && best.len <= 30) break;
    }
    if (best && best.len <= 30) break;
  }
  return best;
})();
check('找到一对近海省份用于测试', !!PAIR, PAIR);
if (!PAIR) { console.log('\n无法构造测试场景\n'); process.exit(1); }
console.log(`  （起点 #${PAIR.a} → 终点 #${PAIR.b}，航程 ${PAIR.len} 像素）`);

/* 造一张带开局舰队的地图 */
const OWNER = (() => {
  const C = core.countries();
  const c = C.find(x => x && x.alive && x.provList.length > 3 && x.id !== core.provinces()[PAIR.a].owner);
  return c ? c.id : 2;
})();
const scenario = (() => {
  const P = core.provinces();
  // 把起点省划给玩家，并放一支舰队
  const p = {};
  p[PAIR.a] = { o: OWNER };
  return {
    v: 1, base: 'ne110m', seed: 987654321, name: '海军测试图', author: '测试', desc: '',
    countries: { [OWNER]: { g: 5000 } },
    provinces: p,
    armies: [{ o: OWNER, p: PAIR.a, s: 9000, n: 1 }],
  };
})();

/* ---------- 起服务 ---------- */
const PORT = 7813;
const BASE = '/gs';
const ADMIN_PASS = 'navy-test-pass-3312';
const TMP = join(root, '_tools', '_tmp_navy');
try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
mkdirSync(TMP, { recursive: true });

const srv = spawn(process.execPath, [join(root, 'srv', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE, MAPS_DIR: TMP, MAP_ADMIN_PASS: ADMIN_PASS },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(900);

async function http(method, path, body, headers) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ code: res.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ code: 0, body: null, err: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

/* 提交 + 审核通过 */
const sub = await http('POST', '/api/maps', { meta: { name: '海军测试图', author: '测试' }, scenario });
check('地图提交成功', !!(sub.body && sub.body.ok), sub.body);
const MAPID = sub.body.id;
const login = await http('POST', '/api/admin/login', { password: ADMIN_PASS });
const TOK = login.body.token;
check('审核通过地图', (await http('POST', '/api/admin/review', { id: MAPID, action: 'approve' }, { 'x-admin-token': TOK })).body.ok === true);

/* ---------- 两个客户端开一局 ---------- */
class Client {
  constructor(label) { this.label = label; this.msgs = []; this.errors = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}${BASE}/ws`, { perMessageDeflate: false });
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) {} }
  last(t) { return this.msgs.filter(m => m.t === t).slice(-1)[0]; }
  /* 把 begin 快照 + 所有 ar 增量，按 **和浏览器端 mpApplyArmies 一样的规则** 合并出军队状态 */
  armies() {
    const out = {};
    const beg = this.last('begin');
    if (!beg) return out;
    for (const a of beg.snapshot.arm) {
      out[a.i] = { id: a.i, owner: a.o, prov: a.p, str: a.s, isNavy: a.n ? 1 : 0,
                   path: [], navPath: null, navIdx: 0, navIdxSrv: undefined, navIdxPrev: undefined, dstProv: 0 };
    }
    for (const m of this.msgs) {
      if (m.t !== 'delta' || !m.d.ar) continue;
      if (m.d.ax) for (const id of m.d.ax) delete out[id];
      for (const row of m.d.ar) {
        const id = row[0];
        let a = out[id];
        if (!a) a = out[id] = { id, path: [], navPath: null, navIdx: 0, dstProv: 0 };
        const provChanged = a.prov !== row[2];
        a.owner = row[1]; a.prov = row[2]; a.str = row[3];
        if (row.length <= 5) continue;
        a.isNavy = row[5] ? 1 : 0;
        a.attrit = row[7] || 0;
        a.dstProv = row[10] || 0;
        const ni = row[6] || 0;
        if (a.navIdxSrv === undefined || provChanged) { a.navIdx = ni; a.navIdxPrev = ni; a.navIdxF = ni; }
        else a.navIdxPrev = (a.navIdxF !== undefined ? a.navIdxF : a.navIdx);
        a.navIdxSrv = ni; a.navIdx = ni;
        if (row[8] !== null && row[8] !== undefined) a.path = row[8];
        // 与修好后的 mpApplyArmies 完全一致：空数组 = 明确清空，null = 不带此字段
        if (row[9] !== null && row[9] !== undefined) a.navPath = (row[9].length ? row[9] : null);
      }
    }
    return out;
  }
  /* 渲染位置：与 client.js 的 armyPos() 完全一致
     有航路时 = 航路像素中心；否则 = 所在省份中心坐标 */
  navyPos(a) {
    if (a.isNavy && a.navPath && a.navPath.length) {
      const raw = (a.navIdxF !== undefined ? a.navIdxF : a.navIdx) || 0;
      const i = Math.min(Math.max(0, Math.round(raw)), a.navPath.length - 1);
      const px = a.navPath[i];
      const COLS = core.COLS || 1440;
      return { x: (px % COLS) + 0.5, y: ((px / COLS) | 0) + 0.5, from: 'path' };
    }
    const p = core.provinces()[a.prov];
    return p ? { x: p.cx, y: p.cy, from: 'prov' } : null;
  }
}

console.log('\n=== 联机海军抵达位置 回归测试 ===\n');
const A = new Client('A'), B = new Client('B');
await A.connect();
A.send({ t: 'create', name: '舰队测试', mapId: MAPID });
await sleep(700);
const room = A.last('lobby').room;
check('建房成功', !!room, A.errors.join('|'));
await B.connect();
B.send({ t: 'join', name: '陪玩', room });
await sleep(400);
const OTHER = core.countries().find(c => c && c.alive && c.id !== OWNER).id;
A.send({ t: 'pick', country: OWNER });
B.send({ t: 'pick', country: OTHER });
await sleep(400);
A.send({ t: 'start' });
await sleep(3000);

const beg = A.last('begin');
check('开局成功', !!beg, A.errors.join('|'));
const navyId = beg.snapshot.arm.find(a => a.n === 1) ? beg.snapshot.arm.find(a => a.n === 1).i : 0;
check('地图里的开局舰队存在', navyId > 0, beg.snapshot.arm);
check('舰队在起点省', beg.snapshot.arm.find(a => a.n === 1).p === PAIR.a);

/* ---------- 下单出海 ---------- */
const originPix = core.provinces()[PAIR.a].pix[0];
const destPix = core.provinces()[PAIR.b].pix[0];
A.send({ t: 'cmd', c: 'path', army: navyId, to: PAIR.b });
A.send({ t: 'cmd', c: 'speed', speed: 5 });     // 开局默认暂停，必须恢复时间才会走

/* 跑到舰队抵达（最多 90 秒） */
const t0 = Date.now();
let arrivedAt = 0, midPix = null, sawEmptyNavPath = false, lastNavRow = null;
while (Date.now() - t0 < 90000) {
  await sleep(400);
  const arm = A.armies()[navyId];
  if (!arm) continue;
  // 记录航行途中的位置（应当不在出发点）
  if (arm.navPath && arm.navPath.length && arm.navIdxSrv > 2 && midPix === null) midPix = A.navyPos(arm);
  // 抵达：服务端把 prov 换成目的地、航路清空
  if (arm.prov === PAIR.b && (!arm.navPath || !arm.navPath.length)) {
    arrivedAt = Date.now();
    // 确认收到过"明确清空航路"的帧
    for (const m of A.msgs) {
      if (m.t !== 'delta' || !m.d.ar) continue;
      for (const row of m.d.ar) if (row[0] === navyId && row.length > 5 && Array.isArray(row[9]) && row[9].length === 0) { sawEmptyNavPath = true; lastNavRow = row; }
    }
    break;
  }
  if (arm.prov === PAIR.b && arm.navPath && arm.navPath.length) {
    // 到了目的地但航路还在（旧 bug 的表现）—— 再等等看是否后续帧清掉
  }
}
check('舰队抵达了目的地', arrivedAt > 0, { prov: A.armies()[navyId] && A.armies()[navyId].prov, want: PAIR.b });

const finalArm = A.armies()[navyId];
check('【核心】抵达后舰队不再持有旧航路', !finalArm.navPath || finalArm.navPath.length === 0,
  finalArm.navPath ? finalArm.navPath.length : null);
check('【核心】服务端发过"明确清空航路"的增量（空数组而不是 null）', sawEmptyNavPath === true,
  lastNavRow ? lastNavRow.slice(5, 11) : '没收到这样的帧');
check('抵达后 navIdx 归零', (finalArm.navIdxSrv || 0) === 0, finalArm.navIdxSrv);

/* 渲染位置：应该在目的地，而不是出发点 */
const drawPos = A.navyPos(finalArm);
const destProv = core.provinces()[PAIR.b];
const originProv = core.provinces()[PAIR.a];
const near = (a, b, tol) => a && b && Math.abs(a.x - b.x) < (tol || 1) && Math.abs(a.y - b.y) < (tol || 1);
check('【核心】舰队被画在目的地省中心', near(drawPos, { x: destProv.cx, y: destProv.cy }) === true,
  { drawPos, dest: { x: destProv.cx, y: destProv.cy } });
check('【核心】舰队没有被打回出发点', near(drawPos, { x: originProv.cx, y: originProv.cy }) === false,
  { drawPos, origin: { x: originProv.cx, y: originProv.cy } });
check('位置来自省份而不是残留航路', drawPos && drawPos.from === 'prov', drawPos);

/* 航行途中确实在动（不是一直在原地） */
check('航行途中确实移动过（不是一直在原地）', midPix !== null && midPix.from === 'path',
  midPix ? { x: midPix.x, y: midPix.y, from: midPix.from } : null);
check('航行途中的位置不在出发点', !midPix || !near(midPix, { x: originProv.cx, y: originProv.cy }),
  { midPix, origin: { x: originProv.cx, y: originProv.cy } });

/* ---------- 反向验证：旧写法会怎样 ---------- */
{
  const bad = A.armies()[navyId];
  // 模拟旧客户端的处理：navPath === null 时保持不动
  const legacy = Object.assign({}, bad);
  let legacyNavPath = null;
  for (const m of A.msgs) {
    if (m.t !== 'delta' || !m.d.ar) continue;
    for (const row of m.d.ar) {
      if (row[0] !== navyId || row.length <= 5) continue;
      if (row[9] !== null && row[9] !== undefined) legacyNavPath = row[9];
    }
  }
  legacy.navPath = (legacyNavPath && legacyNavPath.length) ? legacyNavPath : null;
  check('【反证】服务端已不再用 null 表达清空，旧客户端也能正确清掉',
    !legacy.navPath || legacy.navPath.length === 0, legacy.navPath ? legacy.navPath.length : null);
}

/* ---------- 清理 ---------- */
A.close(); B.close();
await sleep(400);
await http('POST', '/api/admin/delete', { id: MAPID }, { 'x-admin-token': TOK });
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
srv.kill();
try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(failures ? 1 : 0);
