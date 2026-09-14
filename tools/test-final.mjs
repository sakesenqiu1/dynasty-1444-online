// 部署后最终验证：HTTPS 域名 + wss + 联机全流程 + 性能指标
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client as SSH } from 'ssh2';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS","GS_DOMAIN"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const IP = '${GS_HOST}';
const DOM = process.env.GS_DOMAIN || 'localhost';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); } };

/* 证书是 Let's Encrypt 公信证书，不需要关闭校验 */

console.log(`\n=== 最终验证 https://${DOM}/ ===\n`);

async function get(url) {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const body = r.status === 200 ? await r.text() : '';
    return { code: r.status, len: body.length, body, type: r.headers.get('content-type'), loc: r.headers.get('location') };
  } catch (e) { return { code: 0, err: e.message }; }
}

/* ---- HTTPS + 跳转 ---- */
const httpRoot = await get(`http://${DOM}/`);
check('HTTP 自动跳转到 HTTPS', httpRoot.code === 301 && /^https:/.test(httpRoot.loc || ''), `${httpRoot.code} ${httpRoot.loc}`);

const idx = await get(`https://${DOM}/`);
check('HTTPS 首页 200', idx.code === 200, idx.code + ' ' + (idx.err || ''));
check('首页含大厅', (idx.body || '').includes('lobby-entry'));

for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) {
  const r = await get(`https://${DOM}/${f}`);
  check(`HTTPS /${f} 200`, r.code === 200 && r.len > 3000, `${r.code} ${r.len}`);
}
const coreJs = await get(`https://${DOM}/game-core.js`);
const clientJs = await get(`https://${DOM}/client.js`);
const netJs = await get(`https://${DOM}/net.js`);

/* ---- 性能优化确实上线了 ---- */
check('客户端含标签层缓存 ensureLabels', clientJs.body.includes('ensureLabels'));
check('客户端含界面指纹 panelSignature', clientJs.body.includes('panelSignature'));
check('客户端含刷新节流 uiTick', clientJs.body.includes('function uiTick'));
check('客户端含性能面板（按 P 打开）', clientJs.body.includes('perf-hud'));
check('增量同步改为局部维护 provList', netJs.body.includes('只改动涉及的两个国家的省份列表'));
check('已修复标签层 dpr 缩放（国家名乱漂）', clientJs.body.includes('ctx.setTransform(1,0,0,1,0,0);') && clientJs.body.includes('ctx.drawImage(labelCv,0,0);'));
check('已修步行军插值', netJs.body.includes('MP_DELTA_MS') && netJs.body.includes('progPrev'));
check('已加入点击乐观反馈', clientJs.body.includes('a._opt=performance.now()'));
check('已加入游戏内时钟平滑外推', clientJs.body.includes('function clockTick') && clientJs.body.includes('clockSync'));

/* ---- IP 老地址仍然可用 ---- */
check('IP 入口 http://IP/gs/ 仍可用', (await get(`http://${IP}/gs/`)).code === 200);

/* ---- 服务器侧状态 ---- */
async function sshExec(cmd) {
  const c = new SSH();
  await new Promise((res, rej) => c.on('ready', res).on('error', rej)
    .connect({ host: IP, port: 22, username: 'root', password: process.env.GS_PASS, readyTimeout: 30000 }));
  const out = await new Promise((res) => {
    c.exec(cmd, (e, s) => { let o = ''; s.on('close', () => res(o)).on('data', d => o += d.toString()); s.stderr.on('data', d => o += d.toString()); });
  });
  c.end();
  return out;
}
console.log('  info  systemd:', (await sshExec('systemctl is-enabled gs-game; systemctl is-active gs-game')).trim().replace(/\n/g, ' / '));
console.log('  info  证书自动续期:', (await sshExec('crontab -l 2>/dev/null | grep -c acme.sh')).trim(), '条 cron');

/* ---- wss 全流程 ---- */
console.log('');
const wsUrl = `wss://${DOM}/ws`;
const a = new WebSocket(wsUrl, { perMessageDeflate: false, rejectUnauthorized: false });
const b = new WebSocket(wsUrl, { perMessageDeflate: false, rejectUnauthorized: false });
const ma = [], mb = [];
let openedA = false, openedB = false;
await Promise.all([
  new Promise(r => { a.on('open', () => { openedA = true; r(); }); a.on('error', () => r()); setTimeout(r, 10000); }),
  new Promise(r => { b.on('open', () => { openedB = true; r(); }); b.on('error', () => r()); setTimeout(r, 10000); }),
]);
check('wss:// 域名 WebSocket 握手成功', openedA && openedB, `${openedA}/${openedB}`);
if (!openedA || !openedB) { console.log('\n  无法建立 wss，后续跳过\n'); process.exit(1); }

a.on('message', d => ma.push(JSON.parse(d.toString())));
b.on('message', d => mb.push(JSON.parse(d.toString())));

a.send(JSON.stringify({ t: 'create', name: '验证A' }));
await sleep(1200);
const lobby = ma.find(m => m.t === 'lobby');
const room = lobby && lobby.room;
check('创建房间成功，房间号 ' + room, /^\d{4}$/.test(room || ''));
b.send(JSON.stringify({ t: 'join', name: '验证B', room }));
await sleep(1200);
check('第二个玩家加入', !!mb.find(m => m.t === 'lobby'));
a.send(JSON.stringify({ t: 'pick', country: 140 }));
b.send(JSON.stringify({ t: 'pick', country: 44 }));
await sleep(700);
a.send(JSON.stringify({ t: 'start' }));
await sleep(7000);
const beginA = ma.find(m => m.t === 'begin'), beginB = mb.find(m => m.t === 'begin');
check('双方进入对局', !!beginA && !!beginB);
check('国家分配正确', beginA && beginA.you === 140 && beginB && beginB.you === 44);
check('快照含全部省份', beginA && beginA.snapshot.prov.length > 1900);

/* ---- 性能：增量速率与体积（只统计这段窗口内的增量） ---- */
a.send(JSON.stringify({ t: 'cmd', c: 'speed', speed: 5 }));
await sleep(500);
const markA = ma.length, markB = mb.length, w0 = Date.now();
await sleep(6000);
const winMs = Date.now() - w0;
const winA = ma.slice(markA).filter(m => m.t === 'delta');
const winB = mb.slice(markB).filter(m => m.t === 'delta');
const bytes = winA.reduce((s, m) => s + JSON.stringify(m).length, 0);
const secs = winMs / 1000;
const avg = winA.length ? Math.round(bytes / winA.length) : 0;
console.log(`  info  增量 ${winA.length} 次 / ${secs.toFixed(1)}s = ${(winA.length / secs).toFixed(1)}/s，平均 ${avg} 字节，约 ${(bytes / secs / 1024).toFixed(1)} KB/s`);
check('增量频率符合 65ms 节拍（<=14/s）', winA.length / secs <= 14, (winA.length / secs).toFixed(1));
check('两端增量数量一致', Math.abs(winA.length - winB.length) <= 2, `${winA.length} vs ${winB.length}`);
check('增量体积合理（<6KB/次）', avg < 6000, avg + 'B');
check('带宽占用低（<20KB/s）', bytes / secs / 1024 < 20, (bytes / secs / 1024).toFixed(1) + 'KB/s');

let dayA = 0, dayB = 0, matched = false;
for (let i = 0; i < 30; i++) {
  const x = ma.filter(m => m.t === 'delta'), y = mb.filter(m => m.t === 'delta');
  dayA = x.length ? x[x.length - 1].d.day : 0;
  dayB = y.length ? y[y.length - 1].d.day : 0;
  if (dayA > 0 && dayA === dayB) { matched = true; break; }
  await sleep(200);
}
check(`两端同步（第 ${dayA} 天）`, matched, `${dayA} vs ${dayB}`);

/* ---- 指令响应延迟 ---- */
const t0 = Date.now();
const before = ma.filter(m => m.t === 'delta').length;
a.send(JSON.stringify({ t: 'cmd', c: 'speed', speed: 4 }));
let latency = -1;
for (let i = 0; i < 60; i++) {
  if (ma.filter(m => m.t === 'delta').length > before) { latency = Date.now() - t0; break; }
  await sleep(10);
}
console.log(`  info  指令 -> 增量回包延迟: ${latency} ms`);
check('指令响应及时（<500ms）', latency >= 0 && latency < 500, latency + 'ms');

console.log('  info  服务端:', (await sshExec('curl -s http://127.0.0.1:7788/healthz')).trim());
console.log('  info  内存:', (await sshExec("systemctl show gs-game -p MemoryCurrent --value | awk '{printf \"%.1f MB\", $1/1024/1024}'")).trim());
console.log('  info  错误日志:', (await sshExec("grep -ciE 'error|exception' /var/log/gs-game.log || true")).trim(), '条');

a.send(JSON.stringify({ t: 'leave' }));
b.send(JSON.stringify({ t: 'leave' }));
a.close(); b.close();

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
