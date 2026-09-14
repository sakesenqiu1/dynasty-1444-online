// Concurrency + resource check against the live deployment.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client as SSH } from 'ssh2';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS","GS_DOMAIN"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const HOST = process.env.GS_HOST || '127.0.0.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function health() {
  const r = await fetch(`http://${HOST}/healthz`);
  return (await r.text()).trim();
}
async function sshExec(cmd) {
  const c = new SSH();
  await new Promise((res, rej) => c.on('ready', res).on('error', rej)
    .connect({ host: HOST, port: 22, username: 'root', password: process.env.GS_PASS, readyTimeout: 30000 }));
  const out = await new Promise((res) => {
    c.exec(cmd, (e, s) => {
      let o = '';
      s.on('close', () => res(o)).on('data', d => o += d.toString());
      s.stderr.on('data', d => o += d.toString());
    });
  });
  c.end();
  return out;
}

console.log('\n=== 运行状态与并发检查 ===\n');
console.log('初始 healthz:', await health());
console.log('systemd:', (await sshExec('systemctl is-enabled gs-game; systemctl is-active gs-game')).trim().replace(/\n/g, ' / '));
console.log('内存:', (await sshExec("systemctl show gs-game -p MemoryCurrent --value | awk '{printf \"%.1f MB\\n\", $1/1024/1024}'")).trim());

/* 开 4 个房间，每个 2 人并开局 */
const rooms = [];
for (let n = 0; n < 4; n++) {
  const a = new WebSocket(`ws://${HOST}/gs/ws`, { perMessageDeflate: false });
  const b = new WebSocket(`ws://${HOST}/gs/ws`, { perMessageDeflate: false });
  const ma = [], mb = [];
  await Promise.all([
    new Promise(r => { a.on('open', r); a.on('error', r); }),
    new Promise(r => { b.on('open', r); b.on('error', r); }),
  ]);
  a.on('message', d => ma.push(JSON.parse(d.toString())));
  b.on('message', d => mb.push(JSON.parse(d.toString())));
  a.send(JSON.stringify({ t: 'create', name: 'R' + n + 'A' }));
  await sleep(500);
  const code = (ma.find(m => m.t === 'lobby') || {}).room;
  b.send(JSON.stringify({ t: 'join', name: 'R' + n + 'B', room: code }));
  await sleep(500);
  a.send(JSON.stringify({ t: 'pick', country: 140 }));
  b.send(JSON.stringify({ t: 'pick', country: 44 }));
  await sleep(500);
  a.send(JSON.stringify({ t: 'start' }));
  rooms.push({ code, a, b, ma, mb, n });
  console.log(`  房间 ${code} 已开局`);
}
await sleep(7000);
for (const r of rooms) r.a.send(JSON.stringify({ t: 'cmd', c: 'speed', speed: 5 }));
await sleep(6000);

let okRooms = 0, daySkew = 0;
for (const r of rooms) {
  const d = r.ma.filter(m => m.t === 'delta');
  const d2 = r.mb.filter(m => m.t === 'delta');
  const day1 = d.length ? d[d.length - 1].d.day : 0;
  const day2 = d2.length ? d2[d2.length - 1].d.day : 0;
  const ok = d.length > 5 && d2.length > 5 && day1 > 0 && day1 === day2;
  if (ok) okRooms++;
  if (day1 !== day2) daySkew++;
  console.log(`  房间 ${r.code}: 房主增量 ${d.length} / 客人增量 ${d2.length} / 第 ${day1} 天 vs ${day2} 天  ${ok ? 'OK' : '异常'}`);
}

console.log('\nhealthz（4 局同时运行）:', await health());
console.log('内存:', (await sshExec("systemctl show gs-game -p MemoryCurrent --value | awk '{printf \"%.1f MB\\n\", $1/1024/1024}'")).trim());
console.log('CPU 时间:', (await sshExec("systemctl show gs-game -p CPUUsageNSec --value | awk '{printf \"%.1f s\\n\", $1/1e9}'")).trim());
console.log('日志尾部:', (await sshExec('tail -3 /var/log/gs-game.log')).trim());
console.log('错误日志:', (await sshExec("grep -ciE 'error|exception|throw' /var/log/gs-game.log || true")).trim(), '条匹配');

for (const r of rooms) { r.a.send(JSON.stringify({ t: 'leave' })); r.b.send(JSON.stringify({ t: 'leave' })); r.a.close(); r.b.close(); }
await sleep(1500);
console.log('\n清理后 healthz:', await health());
console.log(`\n=== ${okRooms === 4 && daySkew === 0 ? '并发检查通过：4 局同时运行，两端完全同步 ✅' : '并发检查有问题 ❌'} ===\n`);
process.exit(okRooms === 4 && daySkew === 0 ? 0 : 1);
