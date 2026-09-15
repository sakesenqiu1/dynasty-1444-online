// 验证本次新增的四项功能：
//   1) 玩家分封出来的国家国体 = 傀儡国，叛乱倾向只有附庸国的 0.05
//   2) 外交配色：自己/盟友=蓝，附庸=浅紫，傀儡=深紫，他国属国不再特别表示
//   3) 可以修改自己属国的颜色
//   4) 可以花钱（200金）修改自己国家的名字
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); } };

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
  // 浏览器全局：割地/分封地图的高亮层要 new ImageData(COLS,ROWS)
  ImageData: function (w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); },
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false,
  promptReply: '新国号',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.prompt = () => sb.promptReply;      // 测试里改 sb.promptReply 即可控制输入
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

console.log('\n=== 傀儡国 / 外交配色 / 改色 / 改名 验证 ===\n');

/* ================= 1. 傀儡国国体 ================= */
console.log('-- 1. 分封出来的国家是傀儡国 --');
const t1 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'新罗马');
  const nc=countries[nid];
  return { nid, subj:nc.subject, ov:overlordOf(nid), subject:subjectOf(nid),
           isPup:isPuppet(nid), V:SUBJ_VASSAL, P:SUBJ_PUPPET, mul:PUPPET_REBEL_MUL };
`);
check('foundVassal 产出的是傀儡国（subject=2）', t1.subj === 2, t1);
check('subjectOf 也认它是傀儡', t1.subject === 2 && t1.isPup === true, t1);
check('宗主关系仍然正确', t1.ov === 140, t1);
check('叛乱倾向倍率常量 = 0.05', t1.mul === 0.05, t1);

/* ================= 2. 叛乱倾向 0.05 倍 ================= */
console.log('\n-- 2. 傀儡国叛乱倾向只有附庸国的 5% --');
const t2 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'傀儡');
  const pupChance=rebelChanceOf(nid);
  countries[nid].subject=SUBJ_VASSAL;          // 临时当普通附庸
  const vasChance=rebelChanceOf(nid);
  countries[nid].subject=0;                    // 独立国
  const indepChance=rebelChanceOf(nid);
  countries[nid].subject=SUBJ_PUPPET;
  return { pupChance, vasChance, indepChance, ratio:vasChance/pupChance };
`);
check('附庸国叛乱概率 = 0.04', Math.abs(t2.vasChance - 0.04) < 1e-12, t2);
check('傀儡国叛乱概率 = 0.002', Math.abs(t2.pupChance - 0.002) < 1e-12, t2);
check('比值正好是 20 倍（即 0.05）', Math.abs(t2.ratio - 20) < 1e-9, t2);

/* ================= 3. 其它途径产生的仍是普通附庸国 ================= */
console.log('\n-- 3. 复国 / 战争附庸化 = 普通附庸国 --');
const t3 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  // 战争附庸化（必须选一个与我国接壤的国家，否则 vassalize 会因不可达而放弃）
  const me=countries[140];
  const foe=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&countriesAdjacent(140,c.id));
  declareWar(140,foe.id);
  const w=wars.find(x=>(x.a===140&&x.d===foe.id)||(x.d===140&&x.a===foe.id));
  // 直接把战争分数堆够，走 vassalize
  w.aB=99999; w.dB=0;
  const before=foe.alive;
  vassalize(140,foe.id);
  const subjAfter=countries[foe.id].subject;
  const ovAfter=overlordOf(foe.id);
  return { foeId:foe.id, before, ovAfter, subjAfter, V:SUBJ_VASSAL };
`);
check('战争附庸化后成为附庸国（subject=1）', t3.subjAfter === 1, t3);
check('宗主关系正确', t3.ovAfter === 140, t3);

const t3b = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  // 复国：先灭掉一个国家，再于故土复国
  const victim=countries.find(c=>c&&c.alive&&c.id!==140&&c.provList.length>0&&c.provList.length<5);
  const name=victim.name, vid=victim.id;
  for(const pid of [...victim.provList]) transferProvince(pid,140);
  const dead=!countries[vid].alive;
  reviveNation(vid);
  return { vid, name, dead, alive:countries[vid].alive, subj:countries[vid].subject, ov:overlordOf(vid) };
`);
check('复国成功（走的是 reviveNation）', t3b.dead === true && t3b.alive === true, t3b);
check('复国产生的是普通附庸国（subject=1）', t3b.subj === 1, t3b);
check('复国后宗主是我朝', t3b.ov === 140, t3b);

/* ================= 4. 释放/独立后国体归零 ================= */
console.log('\n-- 4. 解除 / 独立 / 吞并后国体清零 --');
const t4 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'测试国');
  const a=countries[nid].subject;
  releaseVassal(nid);
  const b={ov:overlordOf(nid), subj:countries[nid].subject, subjectOf:subjectOf(nid)};
  // 再分封一个傀儡，然后吞并它
  const pid2=countries[140].provList.find(i=>provinces[i].pix.length);
  const nid2=foundVassal(140,pid2,'二号国');
  countries[140].gold=99999;
  annexVassal(nid2);
  const c={alive:countries[nid2].alive, subj:countries[nid2].subject};
  return { a, b, c };
`);
check('刚分封时 subject=2', t4.a === 2, t4);
check('解除附庸后 overlord=0 且 subject=0', t4.b.ov === 0 && t4.b.subj === 0, t4);
check('解除后 subjectOf 返回 0（独立国）', t4.b.subjectOf === 0, t4);
check('被吞并后 subject 清零', t4.c.alive === false && t4.c.subj === 0, t4);

/* ================= 5. 存档往返保留国体 ================= */
console.log('\n-- 5. 国体随存档往返 --');
const t5 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]);
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'存档傀儡');
  const snap=makeSaveData();
  const raw=snap.ct[nid-1];
  resetWorld(); buildWorld();
  applySaveData(JSON.parse(JSON.stringify(snap)));
  return { nid, rawSj:raw?raw.sj:null, subj:countries[nid]?countries[nid].subject:null,
           isPup:isPuppet(nid), ov:overlordOf(nid) };
`);
check('存档里带了 sj 字段', t5.rawSj === 2, t5);
check('读档后仍是傀儡国', t5.subj === 2 && t5.isPup === true, t5);
check('读档后宗主关系正确', t5.ov === 140, t5);

/* ================= 6. 外交配色 ================= */
console.log('\n-- 6. 外交配色规则 --');
const t6 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  const me=countries[140];
  // 造一个傀儡和一个附庸
  const p1=me.provList.find(i=>provinces[i].pix.length);
  const pup=foundVassal(140,p1,'傀儡国');
  const p2=countries[140].provList.find(i=>provinces[i].pix.length);
  const vasNid=foundVassal(140,p2,'附庸国');
  countries[vasNid].subject=SUBJ_VASSAL;
  // 盟友
  const allyC=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==pup&&c.id!==vasNid&&!c.overlord);
  me.allies=[allyC.id]; allyC.allies=[140];
  // 他国的属国
  const other=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==allyC.id&&!c.overlord&&c.provList.length>3);
  const otherSub=countries.find(c=>c&&c.alive&&c.id!==other.id&&c.id!==140&&c.id!==pup&&c.id!==vasNid&&c.id!==allyC.id&&!c.overlord);
  otherSub.overlord=other.id; otherSub.subject=SUBJ_VASSAL;
  return {
    self:relColorOf(140), vassal:relColorOf(vasNid), puppet:relColorOf(pup),
    ally:relColorOf(allyC.id), otherSub:relColorOf(otherSub.id),
    neutral:REL_COL.neutral, blue:REL_COL.self, lpurple:REL_COL.vassal, dpurple:REL_COL.puppet,
    // 面板色点：中立国回落到本国旗色
    otherSubDot:relDotColor(otherSub.id), otherSubOwn:countries[otherSub.id].color.slice(),
    ids:{pup, vasNid, ally:allyC.id, otherSub:otherSub.id},
  };
`);
const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
check('自己 = 蓝色', eq(t6.self, t6.blue), t6);
check('盟友 = 蓝色', eq(t6.ally, t6.blue), t6);
check('我方附庸 = 浅紫', eq(t6.vassal, t6.lpurple), t6);
check('我方傀儡 = 深紫', eq(t6.puppet, t6.dpurple), t6);
check('浅紫与深紫确实不同', !eq(t6.lpurple, t6.dpurple), t6);
check('深紫比浅紫暗（亮度更低）', (t6.dpurple[0] + t6.dpurple[1] + t6.dpurple[2]) < (t6.lpurple[0] + t6.lpurple[1] + t6.lpurple[2]), t6);
check('【新规则】他国属国不再特别表示（回落到中立/本国旗色）', eq(t6.otherSub, t6.neutral) && eq(t6.otherSubDot, t6.otherSubOwn), t6);

/* ================= 7. 徽章区分傀儡 ================= */
console.log('\n-- 7. 外交徽章区分附庸/傀儡 --');
const t7 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false;
  const me=countries[140];
  const p1=me.provList.find(i=>provinces[i].pix.length);
  const pup=foundVassal(140,p1,'甲');
  const p2=countries[140].provList.find(i=>provinces[i].pix.length);
  const vas=foundVassal(140,p2,'乙');
  countries[vas].subject=SUBJ_VASSAL;
  return { pup:relationBadge(pup), vas:relationBadge(vas) };
`);
check('傀儡显示「我朝傀儡」', t7.pup.includes('我朝傀儡'), t7);
check('附庸显示「我朝附庸」', t7.vas.includes('我朝附庸') && !t7.vas.includes('傀儡'), t7);

/* ================= 8. 改属国颜色 ================= */
console.log('\n-- 8. 修改属国颜色 --');
const t8 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const p1=me.provList.find(i=>provinces[i].pix.length);
  const pup=foundVassal(140,p1,'染色国');
  const before=countries[pup].color.slice();
  setVassalColor(pup,[12,200,90]);
  const after=countries[pup].color.slice();
  // 非法输入
  const rBad=setCountryColor(pup,[999,-5,'x']);
  const rBad2=setCountryColor(pup,null);
  const afterBad=countries[pup].color.slice();
  // 越界值应被夹到 0..255
  setCountryColor(pup,[300,-20,128.6]);
  const clamped=countries[pup].color.slice();
  // 不能改别人家的属国
  const other=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>2);
  const otherSub=countries.find(c=>c&&c.alive&&c.id!==140&&c.id!==other.id&&!c.overlord);
  otherSub.overlord=other.id; otherSub.subject=SUBJ_VASSAL;
  const otherBefore=countries[otherSub.id].color.slice();
  setVassalColor(otherSub.id,[1,2,3]);
  const otherAfter=countries[otherSub.id].color.slice();
  return { before, after, rBad, rBad2, afterBad, clamped,
           otherBefore, otherAfter, pup };
`);
check('改色生效', eq(t8.after, [12, 200, 90]), t8);
check('null / 缺字段被拒绝', t8.rBad === false && t8.rBad2 === false, t8);
check('非法输入不改变原色', eq(t8.afterBad, [12, 200, 90]), t8);
check('越界值被夹到 0..255 并取整', eq(t8.clamped, [255, 0, 129]), t8);
check('不能修改他国属国的颜色', eq(t8.otherAfter, t8.otherBefore), t8);

/* ================= 9. 调色板 UI ================= */
console.log('\n-- 9. 调色板 UI --');
const t9 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const p1=me.provList.find(i=>provinces[i].pix.length);
  const pup=foundVassal(140,p1,'调色国');
  const html=colorPickerHTML(pup);
  // 打开调色板 → 外交列表里应出现色块
  uiTab='diplo'; diploFocus=0; diploColorFor=0; uiSearch='';
  refreshPanel();
  const closed=document.getElementById('diplo-list').innerHTML.includes('class="sw');
  toggleVassalColor(pup);
  refreshPanel();
  const opened=document.getElementById('diplo-list').innerHTML;
  toggleVassalColor(pup);
  refreshPanel();
  const reclosed=document.getElementById('diplo-list').innerHTML.includes('class="sw');
  return { hasSwatches:html.includes('class="swatches"'), swCount:(html.match(/class="sw[" ]/g)||[]).length,
           hasRandom:html.includes('vcolor-random'), closed, opened:(opened.match(/class="sw[" ]/g)||[]).length>0,
           reclosed, pickerFor:diploColorFor };
`);
check('调色板 HTML 含色块容器', t9.hasSwatches === true, t9);
check('调色板有 36 个色块', t9.swCount === 36, t9);
check('调色板有随机按钮', t9.hasRandom === true, t9);
check('未点击时不显示调色板', t9.closed === false, t9);
check('点击「改色」后调色板出现', t9.opened === true, t9);
check('再点一次收起', t9.reclosed === false && t9.pickerFor === 0, t9);

/* ================= 10. 花钱改国名 ================= */
console.log('\n-- 10. 花 200 金改国名 --');
const t10 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  me.gold=1000;
  const oldName=me.name, goldBefore=me.gold;
  promptReply='大周帝国';
  renameSelf();
  const afterName=me.name, goldAfter=me.gold;
  // 钱不够
  me.gold=10;
  promptReply='没钱改个屁';
  renameSelf();
  const poorName=me.name, poorGold=me.gold;
  // 和旧名相同不扣钱
  me.gold=1000;
  promptReply='大周帝国';
  renameSelf();
  const sameGold=me.gold;
  // 超长名字截断
  me.gold=1000;
  promptReply='一二三四五六七八九十十一十二十三';
  renameSelf();
  const longName=me.name;
  // 尖括号与控制字符被清洗
  me.gold=1000;
  promptReply='<b>坏名\\u0007字</b>';
  renameSelf();
  const dirtyName=me.name;
  return { oldName, afterName, goldBefore, goldAfter, cost:RENAME_COST,
           poorName, poorGold, sameGold, longName, dirtyName, max:RENAME_MAX };
`);
check('改名前金 1000', t10.goldBefore === 1000, t10);
check('改名成功', t10.afterName === '大周帝国', t10);
check('正好扣 200 金', t10.goldAfter === 800, t10);
check('RENAME_COST = 200', t10.cost === 200, t10);
check('国库不足时改名失败且不扣钱', t10.poorName === '大周帝国' && t10.poorGold === 10, t10);
check('与旧名相同不扣钱', t10.sameGold === 1000, t10);
check('超长名字被截到 12 字', t10.longName.length === 12, t10);
check('尖括号/控制字符被清洗掉', t10.dirtyName === 'b坏名字/b', t10);

/* ================= 11. 名称清洗函数 ================= */
console.log('\n-- 11. sanitizeCountryName --');
const t11 = run(`
  return {
    trim: sanitizeCountryName('  大明  '),
    empty: sanitizeCountryName('   '),
    nullv: sanitizeCountryName(null),
    script: sanitizeCountryName('<script>alert(1)</script>'),
    long: sanitizeCountryName('甲'.repeat(30)).length,
  };
`);
check('首尾空格被去掉', t11.trim === '大明', t11);
check('空白串返回空', t11.empty === '' && t11.nullv === '', t11);
check('HTML 标签被剥掉（防注入）', !t11.script.includes('<') && !t11.script.includes('>'), t11);
check('长度截到 12', t11.long === 12, t11);

/* ================= 12. 盟约随增量同步（联机 bug 回归） ================= */
console.log('\n-- 12. 盟约 al 增量（盟友变蓝 + 可断盟） --');
const tAlliance = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140,44]); MP.online=true; started=true;
  const ally=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>2);
  const before={ allied:isAllied(140,ally.id), color:relColorOf(ally.id).slice(),
                 badge:relationBadge(ally.id) };
  // 服务端只下发一条 al 增量（联机时本地从不执行 formAlliance）
  mpDelta({ d:{ al:[[140,[ally.id]],[ally.id,[140]]] } });
  const after={ allied:isAllied(140,ally.id), color:relColorOf(ally.id).slice(),
                badge:relationBadge(ally.id), allies:countries[140].allies.slice() };
  uiTab='diplo'; diploFocus=0; diploColorFor=0; uiSearch='';
  refreshPanel();
  const hasUnally=document.getElementById('diplo-list').innerHTML.includes('diplo-unally');
  // 再下发一条"断盟"增量
  mpDelta({ d:{ al:[[140,[]],[ally.id,[]]] } });
  const broken={ allied:isAllied(140,ally.id), color:relColorOf(ally.id).slice() };
  refreshPanel();
  const hasAllyBtnAfterBreak=document.getElementById('diplo-list').innerHTML.includes('diplo-ally');
  return { allyId:ally.id, before, after, hasUnally, broken, hasAllyBtnAfterBreak,
           blue:REL_COL.self };
`);
check('增量到达前：不是盟友', tAlliance.before.allied === false, tAlliance);
check('增量到达前：地图不是蓝色', !eq(tAlliance.before.color, tAlliance.blue), tAlliance);
check('【修复】收到 al 增量后成为盟友', tAlliance.after.allied === true, tAlliance);
check('【修复】盟友在地图上显示为蓝色', eq(tAlliance.after.color, tAlliance.blue), tAlliance);
check('【修复】外交面板出现「断盟」按钮', tAlliance.hasUnally === true, tAlliance);
check('盟友徽章不再是「和平」', !tAlliance.after.badge.includes('和平'), tAlliance.after.badge);
check('收到断盟增量后不再是盟友', tAlliance.broken.allied === false, tAlliance);
check('断盟后颜色不再是蓝色', !eq(tAlliance.broken.color, tAlliance.blue), tAlliance);
check('断盟后按钮变回「结盟」', tAlliance.hasAllyBtnAfterBreak === true, tAlliance);

/* ================= 13. 分封地图（一次划地建国） ================= */
console.log('\n-- 13. 分封地图：一次划出整片封地 --');
const tGrant = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const start=me.provList.find(i=>provinces[i].pix.length);
  const mineBefore=me.provList.length;

  grantMapBegin(start,'辽东国');
  const began={ on:grantMap.on, n:grantMap.pids.size, cap:grantMap.capital, name:grantMap.name };
  const bar=document.getElementById('grantbar');
  bar.innerHTML=''; updateGrantBar();
  const barOn=bar.innerHTML;

  // 别人的省份不能划进来
  const foreign=countries.find(c=>c&&c.alive&&c.id!==140&&!c.overlord&&c.provList.length>0);
  const foreignPid=foreign.provList.find(i=>provinces[i].pix.length);
  const beforeN=grantMap.pids.size;
  grantMapToggle(foreignPid);
  const rejectedForeign=grantMap.pids.size===beforeN;

  grantMapAbsorb();
  const selected=grantMap.pids.size;
  const pids=[...grantMap.pids];

  const nBefore=countries.length;
  grantMapConfirm();
  const nid=nBefore;
  const nc=countries[nid];
  const after={
    on:grantMap.on, n:countries.length,
    name:nc?nc.name:null, ov:nc?nc.overlord:null, subj:nc?nc.subject:null,
    provs:nc?nc.provList.length:0,
    capIsSelected:nc?pids.includes(nc.capital):false,
    mineAfter:countries[140].provList.length,
    formerHasOverlord:nc?nc.provList.some(pid=>provinces[pid].former&&provinces[pid].former.includes(140)):null,
    ownerOk:nc?nc.provList.every(pid=>provinces[pid].owner===nid&&provinces[pid].controller===nid):null,
  };
  return { mineBefore, nBefore, began, barOn, rejectedForeign, selected, after,
           barHasConfirm:barOn.includes('grant-confirm'), barHasAbsorb:barOn.includes('grant-absorb'),
           barHasName:barOn.includes('辽东国') };
`);
check('进入分封地图，首省已选中', tGrant.began.on === true && tGrant.began.n === 1 && tGrant.began.name === '辽东国', tGrant.began);
check('操作条显示国名', tGrant.barHasName === true, String(tGrant.barOn).slice(0, 160));
check('操作条有「确认分封」与「纳入接壤省」', tGrant.barHasConfirm && tGrant.barHasAbsorb, String(tGrant.barOn).slice(0, 160));
check('拒绝选入他国省份', tGrant.rejectedForeign === true, tGrant);
check('「纳入接壤省」扩展了封地', tGrant.selected > 1, tGrant.selected);
check('确认后退出地图模式', tGrant.after.on === false, tGrant.after);
check('只新建了一个国家', tGrant.after.n === tGrant.nBefore + 1, { after: tGrant.after.n, before: tGrant.nBefore });
check('新国家名字正确', tGrant.after.name === '辽东国', tGrant.after);
check('新国家是傀儡国', tGrant.after.subj === 2, tGrant.after);
check('封地省份数 = 选中数', tGrant.after.provs === tGrant.selected, tGrant.after);
check('首府在所选范围内', tGrant.after.capIsSelected === true, tGrant.after);
check('所有封地都归新国家所有并控制', tGrant.after.ownerOk === true, tGrant.after);
check('宗主少掉对应省数', tGrant.after.mineAfter === tGrant.mineBefore - tGrant.selected, tGrant.after);
check('封地 former 不残留宗主（不会被当成故土）', tGrant.after.formerHasOverlord === false, tGrant.after);

console.log('\n-- 13b. 不能把全部领土都封出去 --');
const tGrant2 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const start=me.provList.find(i=>provinces[i].pix.length);
  const total=me.provList.length;
  grantMapBegin(start,'贪心国');
  for(const pid of [...me.provList]) grantMapToggle(pid);
  const selected=grantMap.pids.size;
  const nBefore=countries.length;
  grantMapConfirm();
  return { total, selected, nBefore, nAfter:countries.length, on:grantMap.on,
           mineLeft:countries[140].provList.length };
`);
check('无法选走最后一个省', tGrant2.selected === tGrant2.total - 1, tGrant2);
check('确认后我国至少还剩一省', tGrant2.mineLeft >= 1, tGrant2);

console.log('\n-- 13c. 取消 / 清空 / 空选区 --');
const tGrant3 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const start=me.provList.find(i=>provinces[i].pix.length);
  const nBefore=countries.length;
  grantMapBegin(start,'取消国');
  grantMapAbsorb();
  const n1=grantMap.pids.size;
  grantMapCancel();
  const cancelled={ on:grantMap.on, n:grantMap.pids.size, created:countries.length-nBefore };
  grantMapBegin(start,'清空国');
  grantMapAbsorb();
  grantMap.pids.clear(); grantMap.capital=0; updateGrantBar();
  const cleared={ on:grantMap.on, n:grantMap.pids.size };
  grantMapConfirm();
  const emptyConfirm={ created:countries.length-nBefore };
  const stillOn=grantMap.on;
  grantMapCancel();
  return { n1, cancelled, cleared, emptyConfirm, stillOn };
`);
check('扩展出了多个省', tGrant3.n1 > 1, tGrant3.n1);
check('取消后退出且不建国', tGrant3.cancelled.on === false && tGrant3.cancelled.n === 0 && tGrant3.cancelled.created === 0, tGrant3.cancelled);
check('清空后选区为空但仍在分封模式', tGrant3.cleared.on === true && tGrant3.cleared.n === 0, tGrant3.cleared);
check('空选区确认不会建国', tGrant3.emptyConfirm.created === 0 && tGrant3.stillOn === true, tGrant3);

console.log('\n-- 13d. 地图点击路由 --');
const tGrant4 = run(`
  resetWorld(); buildWorld(); player=140; setHumans([140]); MP.online=false; started=true;
  const me=countries[140];
  const start=me.provList.find(i=>provinces[i].pix.length);
  const other=me.provList.find(i=>i!==start&&provinces[i].pix.length&&provinces[i].nbrs.includes(start))
            ?? me.provList.find(i=>i!==start&&provinces[i].pix.length);
  grantMapBegin(start,'点击国');
  const before=grantMap.pids.size;
  const handled=grantMapToggle(other);
  const after=grantMap.pids.size;
  const handledAgain=grantMapToggle(other);
  const afterAgain=grantMap.pids.size;
  grantMapCancel();
  const offMode=grantMapToggle(other);
  return { before, after, afterAgain, handled, handledAgain, offMode };
`);
check('点击可选省份会加入封地', tGrant4.handled === true && tGrant4.after === tGrant4.before + 1, tGrant4);
check('再点一次会移出', tGrant4.handledAgain === true && tGrant4.afterAgain === tGrant4.before, tGrant4);
check('退出分封模式后不再拦截地图点击', tGrant4.offMode === false, tGrant4);

/* ================= 14. 回归：模拟长跑 ================= */
console.log('\n-- 14. 回归 --');
const t12 = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  player=140;
  const me=countries[140];
  const pid=me.provList.find(i=>provinces[i].pix.length);
  const nid=foundVassal(140,pid,'长跑傀儡');
  for(let i=0;i<1500;i++) tickDay();
  return { day:dayCount, alive:countries[nid]?countries[nid].alive:false,
           armies:armies.length, wars:wars.length, puppets:countries.filter(c=>c&&c.alive&&isPuppet(c.id)).length };
`);
check('模拟 1500 天无异常', t12.day === 1500 && t12.armies > 0, t12);
check('傀儡国机制不破坏世界运转', typeof t12.puppets === 'number', t12);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
