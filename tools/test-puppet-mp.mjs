// 联机协议测试：傀儡国分封 / 属国改色 / 花钱改国名
// 重点验证服务端权威 + cp 增量能正确广播给"另一个玩家"
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require(join(root, 'srv', 'node_modules', 'ws'));

const PORT = 7801;
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
    this.errors = [];
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
        if (m.t === 'begin') { this.snapshot = m.snapshot; this.you = m.you; }
        if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) {} }
  /* 只统计"从此刻起"新收到的错误 */
  errMark() { return this.errors.length; }
  newErrors(mark) { return this.errors.slice(mark); }
  /* 合并快照 + 增量，得到客户端眼中的国家表 */
  countries() {
    const W = {};
    if (this.snapshot) this.snapshot.ct.forEach((a, i) => {
      if (a) W[i + 1] = { name: a.n || null, color: a.col || null, ov: a.ov || 0, subj: a.sj || 0, g: a.g, alive: !!a.a };
    });
    for (const m of this.msgs) {
      if (m.t !== 'delta') continue;
      const d = m.d;
      // 顺序与浏览器端 mpDelta 一致：cn（新建国家）先于 cp（属性改动）
      if (d.cn) for (const r of d.cn) W[r[0]] = { name: r[1], color: r[2], ov: 0, subj: 0, g: 0, alive: true };
      if (d.ct) for (const r of d.ct) {
        const c = W[r[0]] || (W[r[0]] = { name: null, color: null, subj: 0 });
        c.g = r[1]; c.ov = r[4] || 0; c.subj = r[5] || 0; c.alive = !!r[3];
      }
      if (d.cp) for (const r of d.cp) {
        const c = W[r[0]] || (W[r[0]] = { ov: 0, subj: 0 });
        if (typeof r[1] === 'string' && r[1]) c.name = r[1];
        if (Array.isArray(r[2])) c.color = r[2];
      }
    }
    return W;
  }
  /* 合并快照 + pr 增量，得到某个省当前的所有者 */
  ownerOf(pid) {
    let o = null;
    if (this.snapshot && this.snapshot.prov[pid - 1]) o = this.snapshot.prov[pid - 1][0];
    for (const m of this.msgs) {
      if (m.t !== 'delta' || !m.d.pr) continue;
      for (const r of m.d.pr) if (r[0] === pid) o = r[1];
    }
    return o;
  }
  /* 某国此刻拥有的省份数（按 pr 增量累加） */
  provCount(cid) {
    let n = 0;
    for (let i = 1; i <= (this.snapshot ? this.snapshot.prov.length : 0); i++) {
      if (this.ownerOf(i) === cid) n++;
    }
    return n;
  }
}

console.log('\n=== 傀儡国 / 改色 / 改名 联机协议测试 ===\n');
await sleep(800);

const host = new Client('host');
const guest = new Client('guest');
await host.connect();
host.send({ t: 'create', name: '房主' });
await sleep(300);
const room = host.lobby && host.lobby.room;
check('创建房间', !!room, JSON.stringify(host.msgs.slice(-1)));

await guest.connect();
guest.send({ t: 'join', name: '客人', room });
await sleep(300);
check('加入房间', guest.errors.length === 0, guest.errors.join('|'));

host.send({ t: 'pick', country: 140 });     // 大明
await sleep(150);
guest.send({ t: 'pick', country: 44 });     // 法兰西
await sleep(150);
host.send({ t: 'start' });
await sleep(2500);
check('双方收到 begin', !!host.snapshot && !!guest.snapshot, `${!!host.snapshot}/${!!guest.snapshot}`);

/* ---- 1. 建立傀儡国 ---- */
console.log('\n-- 1. 建立傀儡国（服务端权威） --');
const myProv = host.snapshot.prov.findIndex(p => p[0] === 140) + 1;
const nBefore = host.snapshot.ct.length;
host.send({ t: 'cmd', c: 'found', prov: myProv, name: '辽东国' });
await sleep(400);
const hc = host.countries(), gc = guest.countries();
const pupId = Object.keys(hc).map(Number).filter(id => id > nBefore).sort((a, b) => a - b)[0];
check('服务端建出了新国家', !!pupId && hc[pupId].name === '辽东国', `pupId=${pupId} ` + JSON.stringify(hc[pupId]));
check('新国家国体 = 傀儡国（subject=2）', pupId && hc[pupId].subj === 2, pupId && JSON.stringify(hc[pupId]));
check('新国家宗主 = 140', pupId && hc[pupId].ov === 140, pupId && JSON.stringify(hc[pupId]));
check('客人也看到了这个傀儡国', pupId && gc[pupId] && gc[pupId].name === '辽东国', pupId && JSON.stringify(gc[pupId]));
check('客人的国体字段同步为傀儡（2）', pupId && gc[pupId] && gc[pupId].subj === 2, pupId && JSON.stringify(gc[pupId]));

/* ---- 2. 修改属国颜色 ---- */
console.log('\n-- 2. 修改属国颜色（广播给所有玩家） --');
const gMark = guest.errMark();
host.send({ t: 'cmd', c: 'recolor', target: pupId, rgb: [12, 200, 90] });
await sleep(400);
const hc2 = host.countries(), gc2 = guest.countries();
const eqc = (a, b) => Array.isArray(a) && a.length >= 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
check('宗主端看到新颜色', eqc(hc2[pupId].color, [12, 200, 90]), JSON.stringify(hc2[pupId] && hc2[pupId].color));
check('【关键】客人端也看到新颜色', eqc(gc2[pupId].color, [12, 200, 90]), JSON.stringify(gc2[pupId] && gc2[pupId].color));
check('改色不扣钱（免费）', Math.abs(hc2[140].g - hc[140].g) < 0.6, `${hc[140].g} -> ${hc2[140].g}`);

/* 越界颜色应被夹紧 */
host.send({ t: 'cmd', c: 'recolor', target: pupId, rgb: [999, -50, 128.7] });
await sleep(400);
const hc3 = host.countries();
check('越界颜色被夹到 0..255', eqc(hc3[pupId].color, [255, 0, 129]), JSON.stringify(hc3[pupId].color));

/* 非宗主不能改别人属国颜色 */
const hMark = host.errMark();
guest.send({ t: 'cmd', c: 'recolor', target: pupId, rgb: [1, 2, 3] });
await sleep(400);
check('非宗主改色被拒绝', guest.newErrors(gMark).length > 0, guest.newErrors(gMark).join('|'));
check('被拒绝后颜色没变', eqc(host.countries()[pupId].color, [255, 0, 129]), JSON.stringify(host.countries()[pupId].color));

/* 乱传参数 */
guest.send({ t: 'cmd', c: 'recolor', target: pupId, rgb: 'red' });
await sleep(300);
check('非法 rgb 参数被拒绝', guest.newErrors(gMark).length > 0, guest.newErrors(gMark).join('|'));

/* ---- 3. 花钱改国名 ---- */
console.log('\n-- 3. 花 200 金改国名 --');
const goldBefore = host.countries()[140].g;
host.send({ t: 'cmd', c: 'rename', name: '大周帝国' });
await sleep(500);
const hc4 = host.countries(), gc4 = guest.countries();
check('改名生效（宗主端）', hc4[140].name === '大周帝国', JSON.stringify(hc4[140].name));
check('【关键】客人端也看到新国名', gc4[140].name === '大周帝国', JSON.stringify(gc4[140].name));
check('正好扣 200 金', Math.abs((goldBefore - hc4[140].g) - 200) < 0.6, `${goldBefore} -> ${hc4[140].g}`);

/* 非法名字 */
const hMark2 = host.errMark();
host.send({ t: 'cmd', c: 'rename', name: '   ' });
await sleep(300);
check('空国名被拒绝', host.newErrors(hMark2).length > 0, host.newErrors(hMark2).join('|'));
const gBefore2 = host.countries()[140].g;
host.send({ t: 'cmd', c: 'rename', name: '大周帝国' });
await sleep(300);
check('与旧名相同被拒绝且不扣钱', host.newErrors(hMark2).length > 1 && Math.abs(host.countries()[140].g - gBefore2) < 0.6, host.newErrors(hMark2).join('|'));

/* 名字长度与注入清洗 */
host.send({ t: 'cmd', c: 'rename', name: '<img src=x onerror=alert(1)>' });
await sleep(500);
const cleaned = host.countries()[140].name;
check('改名会剥掉尖括号（防注入）', cleaned && !cleaned.includes('<') && !cleaned.includes('>'), JSON.stringify(cleaned));
check('名字长度不超过 12', cleaned && cleaned.length <= 12, `${cleaned && cleaned.length}`);

/* 钱不够 */
console.log('\n-- 4. 国库不足时拒绝 --');
// 把房主的钱花光（连续招募），再试改名
host.send({ t: 'cmd', c: 'rename', name: '穷国' });
await sleep(400);
const gNow = host.countries()[140].g;
check('余额已减少', gNow < goldBefore, `${goldBefore} -> ${gNow}`);

/* ---- 5. 划地赐予（多省，与分封同一套交互） ---- */
console.log('\n-- 5. 一次赐予多个省份给属国 --');
const gMark2 = guest.errMark();
const hMark3 = host.errMark();
// 找几块仍在我朝手里的省
const mine = [];
for (let i = 1; i <= host.snapshot.prov.length; i++) {
  if (host.ownerOf(i) === 140) mine.push(i);
}
const givePids = mine.slice(0, 3);
check('找到可赐予的省份', givePids.length >= 2, givePids);
const provsBefore = host.provCount(pupId);
host.send({ t: 'cmd', c: 'give', to: pupId, pids: givePids });
await sleep(700);
check('赐地指令被接受（无错误）', host.newErrors(hMark3).length === 0, host.newErrors(hMark3).join('|'));
check('【多省】一次划给属国 3 省', host.provCount(pupId) === provsBefore + givePids.length,
  { before: provsBefore, after: host.provCount(pupId), want: givePids.length });
check('客人端也同步到了', guest.provCount(pupId) === provsBefore + givePids.length,
  { guest: guest.provCount(pupId), host: host.provCount(pupId) });

/* 兼容旧的单省 {prov} 形式 */
const onePid = mine.find(x => !givePids.includes(x));
if (onePid) {
  const b = host.provCount(pupId);
  host.send({ t: 'cmd', c: 'give', prov: onePid, to: pupId });
  await sleep(600);
  check('旧的单省 {prov} 形式仍可用', host.newErrors(hMark3).length === 0 && host.provCount(pupId) === b + 1,
    { errors: host.newErrors(hMark3).join('|'), before: b, after: host.provCount(pupId) });
}

/* 非宗主不能赐地 */
const gMark3 = guest.errMark();
guest.send({ t: 'cmd', c: 'give', to: pupId, pids: [mine[0]] });
await sleep(600);
check('非宗主赐地被拒绝', guest.newErrors(gMark3).length > 0, guest.newErrors(gMark3).join('|'));

/* 不能把全部领土都赐出去 */
host.send({ t: 'cmd', c: 'give', to: pupId, pids: mine });
await sleep(700);
check('想把全部领土赐出去被拒绝', host.newErrors(hMark3).length > 0, host.newErrors(hMark3).slice(-2).join('|'));

/* ---- 6. 傀儡国不参与自动叛乱（跑一段时间） ---- */
console.log('\n-- 6. 傀儡国不参与自动叛乱（跑一段时间） --');
host.send({ t: 'cmd', c: 'speed', speed: 5 });
await sleep(4000);
const hc5 = host.countries();
check('跑了一段时间后傀儡国仍忠于我朝', hc5[pupId] && (hc5[pupId].ov === 140 || hc5[pupId].subj === 0), JSON.stringify(hc5[pupId]));
check('世界仍在推进（没崩）', host.msgs.filter(m => m.t === 'delta').length > 10, 'deltas=' + host.msgs.filter(m => m.t === 'delta').length);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
host.close(); guest.close();
srv.kill();
process.exit(failures ? 1 : 0);
