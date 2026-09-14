// 抖动测试：直接量"增量到达间隔"，这就是玩家感受到的卡顿
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
const DOM = process.env.GS_DOMAIN || 'localhost';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); } };

async function sshExec(cmd) {
  const c = new SSH();
  await new Promise((res, rej) => c.on('ready', res).on('error', rej)
    .connect({ host: HOST, port: 22, username: 'root', password: process.env.GS_PASS, readyTimeout: 30000 }));
  const out = await new Promise((res) => {
    c.exec(cmd, (e, s) => { let o = ''; s.on('close', () => res(o)).on('data', d => o += d.toString()); s.stderr.on('data', d => o += d.toString()); });
  });
  c.end();
  return out;
}

console.log('\n=== 增量抖动测试（速度 5 档 = 40 天/秒）===\n');

const ws = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
const wsb = new WebSocket(`wss://${DOM}/ws`, { perMessageDeflate: false });
await Promise.all([
  new Promise(r => { ws.on('open', r); ws.on('error', r); }),
  new Promise(r => { wsb.on('open', r); wsb.on('error', r); }),
]);
const msgs = [];
ws.on('message', d => msgs.push({ t: Date.now(), m: JSON.parse(d.toString()) }));

ws.send(JSON.stringify({ t: 'create', name: '抖动A' }));
await sleep(1000);
const room = (msgs.find(x => x.m.t === 'lobby') || { m: {} }).m.room;
wsb.send(JSON.stringify({ t: 'join', name: '抖动B', room }));
await sleep(1000);
ws.send(JSON.stringify({ t: 'pick', country: 140 }));
wsb.send(JSON.stringify({ t: 'pick', country: 44 }));
await sleep(600);
ws.send(JSON.stringify({ t: 'start' }));
console.log('  开局中……（建世界）');
await sleep(8000);

ws.send(JSON.stringify({ t: 'cmd', c: 'speed', speed: 5 }));
await sleep(1500);
console.log('  以 40 天/秒 运行 45 秒，期间会经过约 60 个游戏月……\n');

const t0 = Date.now();
const mark = msgs.length;
await sleep(45000);
const win = msgs.slice(mark).filter(x => x.m.t === 'delta');
const elapsed = (Date.now() - t0) / 1000;

/* 相邻增量的时间间隔 */
const gaps = [];
for (let i = 1; i < win.length; i++) gaps.push(win[i].t - win[i - 1].t);
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.floor(gaps.length * p)] || 0;
const avg = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);

const days = win.length ? win[win.length - 1].m.d.day - win[0].m.d.day : 0;
console.log(`  收到增量 ${win.length} 次 / ${elapsed.toFixed(0)}s = ${(win.length / elapsed).toFixed(1)}/s`);
console.log(`  游戏内推进 ${days} 天（约 ${(days / 30).toFixed(0)} 个游戏月）`);
console.log(`  增量间隔  平均 ${avg.toFixed(0)} ms   p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  最大 ${gaps[gaps.length - 1]} ms`);

/* 带宽估算 */
const bytes = win.reduce((s, x) => s + JSON.stringify(x.m).length, 0);
console.log(`  带宽      约 ${(bytes / elapsed / 1024).toFixed(1)} KB/s（平均每帧 ${Math.round(bytes / win.length)} 字节）`);

check('平均间隔接近 65ms 节拍', avg > 55 && avg < 130, avg.toFixed(0) + 'ms');
check('p90 间隔 < 140ms（更新足够连续）', q(0.9) < 140, q(0.9) + 'ms');
check('带宽 < 30 KB/s', bytes / elapsed / 1024 < 30, (bytes / elapsed / 1024).toFixed(1) + 'KB/s');
check('p99 间隔 < 250ms（没有明显停顿）', q(0.99) < 250, q(0.99) + 'ms');
check('最大间隔 < 400ms', (gaps[gaps.length - 1] || 0) < 400, (gaps[gaps.length - 1] || 0) + 'ms');

/* 服务端自身的帧耗时 */
const h = JSON.parse(await sshExec('curl -s http://127.0.0.1:7788/healthz'));
console.log(`\n  服务端 healthz: tickMs=${h.tickMs}  tickAvgMs=${h.tickAvgMs}  tickMaxMs=${h.tickMaxMs}  slowTicks=${h.slowTicks} (帧预算 50ms)`);
check('服务端平均帧耗时 < 5ms', h.tickAvgMs < 5, h.tickAvgMs + 'ms');
check('服务端最坏帧 < 50ms（不丢帧）', h.tickMaxMs < 50, h.tickMaxMs + 'ms');
// 月度结算会把整个世界的外交 AI 跑一遍，偶发一两次接近预算是正常的
check('慢帧不超过 3 次', h.slowTicks <= 3, h.slowTicks + ' 次');

const log = await sshExec('wc -l < /var/log/gs-game.log');
console.log(`  日志总行数: ${log.trim()}（含历史运行记录）`);

ws.send(JSON.stringify({ t: 'leave' })); wsb.send(JSON.stringify({ t: 'leave' }));
ws.close(); wsb.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
