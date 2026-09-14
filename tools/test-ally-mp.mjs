// 盟约同步协议测试
// 回归两个线上 bug：1) 盟友在外交地图上不变蓝  2) 找不到「断盟」按钮
// 根因都是服务端从不把 allies 随增量下发，客户端永远停在开局快照的盟友表上。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const PORT = 7803;
const BASE = '/gs';
const URL = `ws://127.0.0.1:${PORT}${BASE}/ws`;

// 玩家的两个国家：140 大明、6 哈萨克诸部。
// 这两个接壤且国力相近，服务端结盟裁决的接受率是 0.60（不会像大明 vs 法兰西那样恒被拒）。
const ME = 140, ALLY = 6;

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
  constructor(label) { this.label = label; this.msgs = []; this.snapshot = null; this.you = 0; this.errors = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        if (m.t === 'lobby') this.lobby = m;
        if (m.t === 'begin') { this.snapshot = m.snapshot; this.you = m.you; }
        if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) {} }
  errMark() { return this.errors.length; }
  newErrors(k) { return this.errors.slice(k); }
  /* 累计所有 al 增量（只看 fromIdx 之后新到的消息） */
  alRows(fromIdx = 0) { return this.msgs.slice(fromIdx).filter(m => m.t === 'delta' && m.d.al).flatMap(m => m.d.al); }
  alFrames(fromIdx = 0) { return this.msgs.slice(fromIdx).filter(m => m.t === 'delta' && m.d.al).length; }
  /* 合并快照 + al 增量，得到客户端眼中的盟约表 */
  allianceOf(cid) {
    let arr = [];
    if (this.snapshot) {
      const r = this.snapshot.ct[cid - 1];
      if (r) arr = (r.al || []).slice();
    }
    for (const m of this.msgs) {
      if (m.t !== 'delta' || !m.d.al) continue;
      for (const row of m.d.al) if (row[0] === cid) arr = (row[1] || []).slice();
    }
    return arr;
  }
}

console.log('\n=== 盟约同步协议测试 ===\n');
await sleep(800);

const host = new Client('host');
const guest = new Client('guest');
await host.connect();
host.send({ t: 'create', name: '房主' });
await sleep(300);
const room = host.lobby && host.lobby.room;
await guest.connect();
guest.send({ t: 'join', name: '客人', room });
await sleep(300);
host.send({ t: 'pick', country: ME });
await sleep(150);
guest.send({ t: 'pick', country: ALLY });
await sleep(150);
host.send({ t: 'start' });
await sleep(2500);
check('双方进入对局', !!host.snapshot && !!guest.snapshot, `${!!host.snapshot}/${!!guest.snapshot}`);

/* 快照里本来就带 allies，先确认基线 */
const snapAlly = (host.snapshot.ct[ME - 1] || {}).al || [];
check('开局快照里带 allies 字段', Array.isArray(snapAlly), JSON.stringify(host.snapshot.ct[ME - 1]));
check('开局双方不是盟友', !snapAlly.includes(ALLY), JSON.stringify(snapAlly));

/* ---- 1. 结盟（服务端有概率拒绝，重试到成功） ---- */
console.log('\n-- 1. 结盟后双方都收到 al 增量 --');
let ok = false, tries = 0;
for (; tries < 15 && !ok; tries++) {
  const mark = host.msgs.length;
  host.send({ t: 'cmd', c: 'ally', target: ALLY });
  await sleep(400);
  const rows = host.alRows(mark).filter(r => r[0] === ME);
  if (rows.length && (rows[rows.length - 1][1] || []).includes(ALLY)) ok = true;
}
check('结盟成功（重试 ' + tries + ' 次）', ok === true, host.errors.slice(-3).join('|'));

const hAllies = host.allianceOf(ME);
const gAllies = guest.allianceOf(ALLY);
check('【核心】房主端 allies 含对方', hAllies.includes(ALLY), JSON.stringify(hAllies));
check('【核心】客人端 allies 含对方', gAllies.includes(ME), JSON.stringify(gAllies));
check('客人收到了 al 增量', guest.msgs.some(m => m.t === 'delta' && m.d.al), 'no al frame');

/* ---- 2. al 只在变化帧下发，不是每帧都发 ---- */
console.log('\n-- 2. al 不重复下发（性能） --');
const alBefore = host.alFrames();
await sleep(3000);
const alAfter = host.alFrames();
check('3 秒内没有再发多余的 al 帧', alAfter === alBefore, `${alBefore} -> ${alAfter}`);
check('同期普通增量照常在跑', host.msgs.filter(m => m.t === 'delta').length > 5,
  'deltas=' + host.msgs.filter(m => m.t === 'delta').length);

/* ---- 3. 断盟 ---- */
console.log('\n-- 3. 断盟广播 --');
const gMark = guest.msgs.length;
host.send({ t: 'cmd', c: 'unally', target: ALLY });
await sleep(700);
const hAfter = host.allianceOf(ME);
const gAfter = guest.allianceOf(ALLY);
check('【核心】房主端盟约已解除', !hAfter.includes(ALLY), JSON.stringify(hAfter));
check('【核心】客人端盟约也已解除', !gAfter.includes(ME), JSON.stringify(gAfter));
check('双方都收到了断盟的 al 增量',
  host.alRows().some(r => r[0] === ME && (r[1] || []).length === 0) &&
  guest.alRows(gMark).some(r => r[0] === ALLY && (r[1] || []).length === 0),
  JSON.stringify({ h: host.alRows().slice(-2), g: guest.alRows(gMark).slice(-2) }));

/* ---- 4. 边界 ---- */
console.log('\n-- 4. 边界 --');
const hMark2 = host.errMark();
host.send({ t: 'cmd', c: 'unally', target: ALLY });
await sleep(500);
check('对非盟友断盟不报错（幂等）', host.newErrors(hMark2).length === 0, host.newErrors(hMark2).join('|'));

/* 重新结盟，再由「客人」那一侧主动断盟——盟约是双向的，两边都该能断 */
let ok2 = false;
for (let i = 0; i < 15 && !ok2; i++) {
  host.send({ t: 'cmd', c: 'ally', target: ALLY });
  await sleep(400);
  if (host.allianceOf(ME).includes(ALLY)) ok2 = true;
}
check('重新结盟成功', ok2 === true, host.errors.slice(-2).join('|'));
if (ok2) {
  guest.send({ t: 'cmd', c: 'unally', target: ME });
  await sleep(700);
  check('由客人一侧断盟同样生效（双向）', !host.allianceOf(ME).includes(ALLY),
    JSON.stringify(host.allianceOf(ME)));
  check('客人端也确实断开了', !guest.allianceOf(ALLY).includes(ME),
    JSON.stringify(guest.allianceOf(ALLY)));
}

/* ---- 5. 世界仍稳定 ---- */
console.log('\n-- 5. 稳定性 --');
host.send({ t: 'cmd', c: 'speed', speed: 5 });
await sleep(3000);
check('世界仍在推进', host.msgs.filter(m => m.t === 'delta').length > 10,
  'deltas=' + host.msgs.filter(m => m.t === 'delta').length);
const realErrs = host.newErrors(0).filter(e => !/缔约|已是盟友|无法缔盟/.test(e));
check('无致命错误', realErrs.length === 0, realErrs.join('|'));

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
host.close(); guest.close();
srv.kill();
process.exit(failures ? 1 : 0);
