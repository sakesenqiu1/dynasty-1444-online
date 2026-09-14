// 验证：1) 故土记录 former 随存档/增量同步（复国之机能出来）
//       2) 在自己领土上建立自命名附庸国
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 260) : '')); } };

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
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop,
    focus: noop, select: noop, setSelectionRange: noop, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, getContext: ctx2d, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._h; }, set(v) { e._h = v; } });
  return e;
}
const els = {};
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, requestAnimationFrame: noop,
  document: {
    addEventListener: noop, getElementById: (i) => els[i] || (els[i] = mk('div')), createElement: (t) => mk(t),
    querySelector: () => null, querySelectorAll: () => [], body: { appendChild: noop }, hidden: false,
  },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'x' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false,
  prompt: () => '测试附庸国',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 故土同步 + 建立附庸国 验证 ===\n');

/* ================= 1. former 随存档往返 ================= */
console.log('-- 1. 故土记录 former 存档往返 --');
const t1 = run(`
  resetWorld(); buildWorld();
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id);
  const pid=A.provList.find(i=>provinces[i].pix.length);
  transferProvince(pid,B.id);
  const raw=provinces[pid].former;
  const snap=makeSaveData();
  // 模拟"客户端从快照重建"：清空后读档
  provinces[pid].former=undefined;
  applySaveData(JSON.parse(JSON.stringify(snap)));
  return { has:!!(provinces[pid].former&&provinces[pid].former.includes(A.id)), raw:raw, after:provinces[pid].former };
`);
check('transferProvince 会记录故土', Array.isArray(t1.raw) && t1.raw.length > 0, t1);
check('【修复】存档往返后故土记录仍在', t1.has === true, t1);

/* ================= 2. former 随增量同步 ================= */
console.log('\n-- 2. 故土记录随增量同步到客户端 --');
const t2 = run(`
  resetWorld(); buildWorld(); player=140; MP.online=true;
  const A=countries.find(c=>c&&c.alive&&c.provList.length>6);
  const B=countries.find(c=>c&&c.alive&&c.id!==A.id);
  const pid=A.provList.find(i=>provinces[i].pix.length);
  // 客户端本地不做 transferProvince，只收到一条 pr 增量
  provinces[pid].former=undefined;
  const before=!!(provinces[pid].former&&provinces[pid].former.includes(A.id));
  mpDelta({ d:{ pr:[[pid, B.id, B.id, 0]] } });
  const after=!!(provinces[pid].former&&provinces[pid].former.includes(A.id));
  return { A:A.id, B:B.id, pid, before, after };
`);
check('增量前客户端没有故土记录', t2.before === false, t2);
check('【修复】增量后客户端记录了故土', t2.after === true, t2);

/* ================= 3. 复国之机列表能列出亡国 ================= */
console.log('\n-- 3. 复国之机列表 --');
const t3 = run(`
  resetWorld(); buildWorld(); player=140; started=true; MP.online=true;
  uiTab='diplo'; diploFocus=0; uiSearch='';
  const me=countries[140];
  // 找一个邻国，把它所有省份夺过来 -> 它亡国
  const victim=countries.find(c=>c&&c.alive&&c.id!==140&&c.provList.length>0&&c.provList.length<6);
  for(const pid of [...victim.provList]) transferProvince(pid,140);
  const dead=!victim.alive;
  refreshPanel();
  const html=document.getElementById('diplo-list').innerHTML;
  return { dead, victimName:victim.name, hasSection:html.includes('复国之机'), listed:html.includes(victim.name) };
`);
check('受害者已亡国', t3.dead === true, t3);
check('【修复】外交页出现「复国之机」', t3.hasSection === true, t3);
check('亡国出现在复国列表里', t3.listed === true, t3);

/* ================= 4. 建立附庸国 ================= */
console.log('\n-- 4. 建立自命名附庸国 --');
const t4 = run(`
  resetWorld(); buildWorld(); player=140; started=true; MP.online=false; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nBefore=countries.length;
  const provBefore=me.provList.length;
  const nid=foundVassal(140,pid,'新罗马');
  const nc=countries[nid];
  return { nBefore, nid, nAfter:countries.length, name:nc?nc.name:null,
           overlord:nc?nc.overlord:null, alive:nc?nc.alive:null,
           owner:provinces[pid].owner, controller:provinces[pid].controller,
           capital:nc?nc.capital:null, color:nc?nc.color:null, ruler:nc?nc.ruler:null,
           provBefore, provAfter:me.provList.length, vassalProvs:nc?nc.provList.length:0,
           colorValid: nc? (nc.color.length===3 && nc.color.every(v=>v>=0&&v<=255)) : false,
           isHumanVassal: nc? campOf(140).has(nid) : false };
`);
check('国家数量 +1', t4.nAfter === t4.nBefore + 1, t4);
check('国家名字就是玩家输入的名字', t4.name === '新罗马', t4);
check('成为我的附庸（overlord 正确）', t4.overlord === 140, t4);
check('新国家存活且有首都', t4.alive === true && t4.capital > 0, t4);
check('所选省份已划归新国家', t4.owner === t4.nid && t4.controller === t4.nid && t4.vassalProvs === 1, t4);
check('宗主少了一个省', t4.provAfter === t4.provBefore - 1, t4);
check('新国家有合法颜色和君主名', t4.colorValid === true && !!t4.ruler, t4);
check('新附庸计入我方阵营', t4.isHumanVassal === true, t4);

/* ================= 5. 边界条件 ================= */
console.log('\n-- 5. 边界条件 --');
const t5 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const one=countries.find(c=>c&&c.alive&&c.provList.length===1);
  const r1 = one ? foundVassal(one.id, one.provList[0], 'X') : 'skip';
  const dead=countries.find(c=>c&&!c.alive);
  const r2 = dead ? foundVassal(dead.id, dead.provList[0]||1, 'Y') : 'skip';
  // 不是自己的省份
  const me=countries[140];
  const other=countries.find(c=>c&&c.alive&&c.id!==140);
  const r3=foundVassal(140, other.provList[0], 'Z');
  return { r1, r2, r3 };
`);
check('只有一省的国家不能再分封', t5.r1 === 0 || t5.r1 === 'skip', t5);
check('亡国不能分封', t5.r2 === 0 || t5.r2 === 'skip', t5);
check('不能拿别人的省建国', t5.r3 === 0, t5);

/* ================= 6. 新建国家能存档/读档 ================= */
console.log('\n-- 6. 自建附庸的存档往返 --');
const t6 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'北海国');
  const snap=makeSaveData();
  const desc={ name:a=>a };
  // 模拟客户端只有原始 177 国，从快照重建
  resetWorld(); buildWorld();
  applySaveData(JSON.parse(JSON.stringify(snap)));
  const nc=countries[nid];
  return { nid, exists:!!nc, name:nc?nc.name:null, ov:nc?nc.overlord:null,
           alive:nc?nc.alive:null, owner:provinces[pid].owner, color:nc?nc.color:null };
`);
check('读档后自建附庸仍然存在', t6.exists === true, t6);
check('名字/宗主/存活状态正确', t6.name === '北海国' && t6.ov === 140 && t6.alive === true, t6);
check('领土归属正确', t6.owner === t6.nid, t6);

/* ================= 7. 回归 ================= */
console.log('\n-- 7. 回归 --');
const t7 = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<1200;i++) tickDay();
  return { day:dayCount, armies:armies.length, wars:wars.length };
`);
check('模拟 1200 天无异常', t7.day === 1200 && t7.armies > 0, t7);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
