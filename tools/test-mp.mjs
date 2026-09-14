// End-to-end multiplayer test: boots the server, connects two clients,
// creates/joins a room, picks countries, starts, issues commands and
// verifies the authoritative state stays consistent.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const PORT = 7799;
const BASE = '/gs';
const URL = `ws://127.0.0.1:${PORT}${BASE}/ws`;

// NOTE: piped stdio is blocked in this sandbox, so the server inherits our stdio.
const srv = spawn(process.execPath, [join(root, 'srv', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE },
  stdio: 'inherit',
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.lobby = null;
    this.snapshot = null;
    this.you = 0;
    this.humans = [];
    this.deltas = 0;
    this.lastDelta = null;
    this.errors = [];
    this.defeats = [];
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        if (m.t === 'lobby') this.lobby = m;
        if (m.t === 'begin') { this.snapshot = m.snapshot; this.you = m.you; this.humans = m.humans; }
        if (m.t === 'delta') { this.deltas++; this.lastDelta = m.d; }
        if (m.t === 'error') this.errors.push(m.msg);
        if (m.t === 'defeat') this.defeats.push(m.country);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) {} }
  /* 把 begin 快照 + 后续增量合并成客户端看到的世界（与浏览器端 mpDelta 同逻辑） */
  world() {
    if (!this.snapshot) return null;
    const W = { prov: {}, ct: {}, army: {}, day: this.snapshot.dayCount, wars: this.snapshot.wars };
    this.snapshot.prov.forEach((a, i) => { W.prov[i + 1] = { o: a[0], c: a[1], t: a[2], p: a[3], m: a[4] }; });
    this.snapshot.ct.forEach((a, i) => { if (a) W.ct[i + 1] = { g: a.g, mp: a.mp, alive: a.a, ov: a.ov }; });
    for (const a of this.snapshot.arm) W.army[a.id || Math.random()] = a;
    for (const m of this.msgs) {
      if (m.t !== 'delta') continue;
      const d = m.d;
      if (d.pr) for (const r of d.pr) W.prov[r[0]] = Object.assign(W.prov[r[0]] || {}, { o: r[1], c: r[2] });
      if (d.dev) for (const r of d.dev) Object.assign(W.prov[r[0]] || (W.prov[r[0]] = {}), { t: r[1], p: r[2], m: r[3] });
      if (d.ct) for (const r of d.ct) W.ct[r[0]] = { g: r[1], mp: r[2], alive: r[3], ov: r[4] };
      if (d.day !== undefined) W.day = d.day;
      if (d.wr !== undefined) W.wars = d.wr;
      if (d.aw) {
        if (d.ax) for (const id of d.ax) delete W.army[id];
        for (const r of d.ar) W.army[r[0]] = { id: r[0], o: r[1], p: r[2], s: r[3], gone: false };
      }
    }
    return W;
  }
}

console.log('\n=== 王朝纪元 多人联机测试 ===\n');
await sleep(700);

const host = new Client('host');
const guest = new Client('guest');
await host.connect();
console.log('host connected');

/* ---- 大厅 ---- */
host.send({ t: 'create', name: '房主' });
await sleep(250);
check('创建房间返回 lobby', !!host.lobby, JSON.stringify(host.msgs.slice(-1)));
const room = host.lobby && host.lobby.room;
check('房间号为 4 位数字', /^\d{4}$/.test(room || ''), room);
check('创建者是房主', host.lobby && host.lobby.host === true);

await guest.connect();
guest.send({ t: 'join', name: '客人', room });
await sleep(250);
check('加入房间成功（无错误）', guest.errors.length === 0, guest.errors.join('|'));
check('房主看到 2 名玩家', host.lobby && host.lobby.players.length === 2, JSON.stringify(host.lobby && host.lobby.players));
check('非房主 host=false', guest.lobby && guest.lobby.host === false);

/* ---- 加入不存在的房间 ---- */
const bad = new Client('bad');
await bad.connect();
bad.send({ t: 'join', name: 'x', room: '0000' });
await sleep(200);
check('加入不存在的房间被拒绝', bad.errors.length > 0, bad.errors.join('|'));
bad.close();

/* ---- 选国 ---- */
host.send({ t: 'pick', country: 140 });      // 大明
await sleep(150);
guest.send({ t: 'pick', country: 140 });     // 抢同一个
await sleep(150);
check('抢占已选国家被拒绝', guest.errors.length > 0, guest.errors.join('|'));
guest.send({ t: 'pick', country: 44 });      // 法兰西
await sleep(150);
check('客人选国成功', guest.lobby && guest.lobby.players.some(p => p.k === guest.lobby.you && p.country === 44));

/* ---- 非房主不能开始 ---- */
guest.send({ t: 'start' });
await sleep(150);
check('非房主开始被拒绝', guest.errors.some(e => e.includes('房主')), guest.errors.join('|'));

/* ---- 房主开始 ---- */
host.send({ t: 'start' });
await sleep(2200);                            // 建世界约需 0.5s
check('房主收到 begin', !!host.snapshot);
check('客人收到 begin', !!guest.snapshot);
check('begin.you 正确', host.you === 140 && guest.you === 44, `${host.you},${guest.you}`);
check('humans 含两国', host.humans.length === 2 && host.humans.includes(140) && host.humans.includes(44), host.humans.join(','));
check('快照含省份数据', host.snapshot && host.snapshot.prov.length > 1900, host.snapshot && host.snapshot.prov.length);

/* ---- 开局暂停中，先做指令 ---- */
const goldBefore = host.snapshot.ct[140].g;
host.send({ t: 'cmd', c: 'recruit', prov: host.snapshot.prov.findIndex((p, i) => p[0] === 140) + 1 });
await sleep(150);
host.send({ t: 'cmd', c: 'develop', prov: host.snapshot.prov.findIndex((p, i) => p[0] === 140) + 1 });
await sleep(150);
console.log('  info  招募/发展指令已发送');

/* 非法指令 */
guest.send({ t: 'cmd', c: 'recruit', prov: 1 });   // 不是自己的省
await sleep(150);
check('非法招募被拒绝', guest.errors.length > 0, guest.errors.join('|'));

/* ---- 开始时间 ---- */
host.send({ t: 'cmd', c: 'speed', speed: 5 });
await sleep(3000);
check('房主收到增量', host.deltas > 5, 'deltas=' + host.deltas);
check('客人收到增量', guest.deltas > 5, 'deltas=' + guest.deltas);

const hw = host.world(), gw = guest.world();
check('两个客户端天数一致', hw && gw && hw.day === gw.day, `${hw && hw.day} vs ${gw && gw.day}`);
check('时间在推进', hw && hw.day > 0, hw && hw.day);

/* 抽样比较省份归属 */
let diff = 0, n = 0;
for (const pid of Object.keys(hw.prov)) {
  const a = hw.prov[pid], b = gw.prov[pid];
  if (!a || !b) continue;
  n++;
  if (a.o !== b.o || a.c !== b.c) diff++;
}
check('省份归属两端一致（抽样 ' + n + '）', diff === 0, 'diff=' + diff);

/* 金币 */
check('房主金币已扣（造兵/发展）', hw.ct[140].g !== goldBefore, `${goldBefore} -> ${hw.ct[140].g}`);

/* ---- 暂停 / 继续 ---- */
host.send({ t: 'cmd', c: 'pause', paused: true });
await sleep(400);
const d1 = host.world().day;
await sleep(600);
const d2 = host.world().day;
check('暂停后时间停止', d1 === d2, `${d1} -> ${d2}`);

/* 非房主也能控制时间（设计允许） */
guest.send({ t: 'cmd', c: 'speed', speed: 1 });
await sleep(700);
const d3 = guest.world().day;
check('恢复后时间继续', d3 > d2, `${d2} -> ${d3}`);

/* ---- 聊天 ---- */
guest.send({ t: 'chat', text: '大家好' });
await sleep(200);
check('聊天广播到房主', host.msgs.some(m => m.t === 'chat' && m.text === '大家好'));

/* ---- 宣战：客人打法鸡？用真实邻国测试 ---- */
const w = guest.world();
const myProv = Object.entries(w.prov).find(([pid, p]) => p.o === 44);
guest.send({ t: 'cmd', c: 'war', target: 140 });
await sleep(400);
check('可以宣战', guest.world().wars.some(x => (x.a === 44 && x.d === 140) || (x.a === 140 && x.d === 44)),
  JSON.stringify(guest.world().wars));

/* ---- 断线重连 ---- */
guest.close();
await sleep(400);
const guest2 = new Client('guest2');
await guest2.connect();
guest2.send({ t: 'join', name: '客人', room, rejoin: true });
await sleep(1800);
check('断线重连回到对局', !!guest2.snapshot && guest2.you === 44, `you=${guest2.you} snap=${!!guest2.snapshot}`);
check('重连收到增量', guest2.deltas > 0 || guest2.msgs.some(m => m.t === 'delta'), 'deltas=' + guest2.deltas);

/* ---- 状态收敛再确认 ---- */
await sleep(1200);
const hw2 = host.world(), gw2 = guest2.world();
check('重连后天数仍然一致', hw2.day === gw2.day, `${hw2.day} vs ${gw2.day}`);

/* ---- HTTP 静态资源 ---- */
const http = await import('node:http');
async function get(p) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, len: b.length, body: b }));
    }).on('error', () => res({ code: 0, len: 0, body: '' }));
  });
}
check('GET /gs/ 返回首页', (await get('/gs/')).code === 200);
check('GET / 直接返回首页（独立域名入口）', (await get('/')).code === 200);
check('GET /game-core.js 根路径可取（独立域名入口）', (await get('/game-core.js')).code === 200);
check('GET /gs/game-core.js 可取', (await get('/gs/game-core.js')).code === 200);
check('GET /gs/net.js 可取', (await get('/gs/net.js')).code === 200);
check('GET /gs 重定向到 /gs/', (await get('/gs')).code === 301);
check('路径穿越被拒绝', [403, 404].includes((await get('/gs/../srv/server.js')).code));
check('healthz 正常', (await get('/healthz')).code === 200);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
host.close(); guest2.close();
srv.kill();
process.exit(failures ? 1 : 0);
