// 验证 PvP 和谈必须双方同意
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
  URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false, prompt: () => 'X',
  noop, addEventListener: noop, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

/* ---- 用桩件模拟 server.js 的 Room 决策逻辑（与源码逐条对应） ---- */
const srv = read('srv/server.js');

console.log('\n=== PvP 和谈：必须双方同意 ===\n');

/* ================= 1. 源码级：对人类对手一律走提案 ================= */
console.log('-- 1. 对人类对手走提案而非立即缔和 --');
check('peace 命令有 PvP 分支', srv.includes('if (core.isHuman(enemy)) {') && srv.includes('this.proposePeace(me, enemy, w, demands.map'));
check('white（白色和平）有 PvP 分支', /case 'white'[\s\S]{0,600}isHuman\(enemy\)[\s\S]{0,300}proposePeace/.test(srv));
check('ask（屈膝求和）有 PvP 分支', /case 'ask'[\s\S]{0,1400}isHuman\(enemy\)[\s\S]{0,300}proposePeace/.test(srv));
check('pvassal（附庸化）有 PvP 分支', /case 'pvassal'[\s\S]{0,900}isHuman\(enemy\)[\s\S]{0,300}proposePeace/.test(srv));
check('pindep（要求独立）有 PvP 分支', /case 'pindep'[\s\S]{0,600}isHuman\(enemy\)[\s\S]{0,300}proposePeace/.test(srv));
check('提案有有效期与去重', srv.includes('你已有一份和约提案在等待对方回应') && srv.includes('const expire = st.dayCount + 180'));
check('被拒绝后提案方可以重新提案', srv.includes('for (const k in this.sentOffers) if (this.sentOffers[k].to === me) delete this.sentOffers[k];'));
check('接受时才真正执行 makePeace', /case 'offer'[\s\S]{0,1600}core\.makePeace\(w, transfers, true, rels\)/.test(srv));
check('拒绝会通知提案方', srv.includes('对方拒绝了你的和约提案'));

/* ================= 2. 逻辑级：提案/接受/拒绝三条路径 ================= */
console.log('\n-- 2. 提案 → 接受 / 拒绝 --');
const logic = run(`
  resetWorld(); buildWorld();
  const st=getState();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const A=cs[0].id, B=cs[1].id;
  player=A; setHumans([A,B]);                    // 双方都是真人
  declareWar(A,B); invalidateCamps();
  const w=st.wars.find(x=>x&&((x.a===A&&x.d===B)||(x.d===A&&x.a===B)));
  const pid=countries[B].provList.find(i=>provinces[i].pix.length);
  // 模拟服务端 proposePeace
  const sentOffers={};
  function proposePeace(from,to,war,transfers,releases,extra){
    if(sentOffers[from]) throw new Error('dup');
    const offer={war,enemy:from,transfers:transfers||[],releases:releases||[],expire:st.dayCount+180,human:true,
                 indep:!!(extra&&extra.indep),vassalize:!!(extra&&extra.vassalize)};
    st.pendingOffers[to]=offer;
    sentOffers[from]={to,transfers:offer.transfers,releases:offer.releases,expire:offer.expire,
                      indep:offer.indep,vassalize:offer.vassalize};
  }
  proposePeace(A,B,w,[{pid,to:A}],[]);
  const warStillOn = atWar(A,B);
  const ownerBefore = provinces[pid].owner;
  const offerForB = st.pendingOffers[B];
  const sentByA = sentOffers[A];
  const warNow=()=>getState().wars.some(x=>x&&((x.a===A&&x.d===B)||(x.d===A&&x.a===B)));
  // 拒绝（与服务端一致：同时清掉提案方的"已递交"记录，让它能重新提）
  delete st.pendingOffers[B];
  for(const k in sentOffers) if(sentOffers[k].to===B) delete sentOffers[k];
  const afterReject = { war: warNow(), owner: provinces[pid].owner, canRepropose: !sentOffers[A] };
  // 重新提案并接受
  proposePeace(A,B,w,[{pid,to:A}],[]);
  const o2=st.pendingOffers[B];
  delete st.pendingOffers[B];
  makePeace(o2.war, o2.transfers, true, []);
  // 注意：makePeace 会整体替换 wars 数组，必须重新取状态
  const afterAccept = { war: warNow(), owner: provinces[pid].owner, truce: truceBetween(A,B) };
  return { A,B, warStillOn, ownerBefore, offerForB: !!offerForB, transfers: offerForB?offerForB.transfers:null,
           sentByA: !!sentByA, afterReject, afterAccept };
`);
check('递交提案后战争仍在继续（没有立即缔和）', logic.warStillOn === true, logic);
check('提案里带着具体条件', logic.offerForB === true && Array.isArray(logic.transfers) && logic.transfers.length === 1, logic);
check('提案方能看到自己发出的提案', logic.sentByA === true, logic);
check('对方拒绝后：战争继续、领土不变', logic.afterReject.war === true && logic.afterReject.owner === logic.ownerBefore, logic);
check('对方拒绝后：提案方可以重新提条件', logic.afterReject.canRepropose === true, logic);
check('对方接受后：战争结束、领土按条件变更、进入停战', logic.afterAccept.war === false && logic.afterAccept.owner === logic.A && logic.afterAccept.truce === true, logic);

/* ================= 3. 客户端要给出「接受/拒绝」入口 ================= */
console.log('\n-- 3. 界面 --');
const cli = read('web/client.js');
check('战争页有「接受条件（结束战争）」按钮', cli.includes('接受条件（结束战争）'));
check('战争页有「拒绝」按钮', cli.includes('✘ 拒绝'));
check('对人类对手按钮标注「需对方同意」', cli.includes('递交和约条件（需对方同意）'));
check('显示已递交的提案与有效期', cli.includes('我朝已递交的条件（等待对方回应）'));
check('附庸化/屈膝求和也标注需同意', cli.includes('需对方同意') && cli.includes('·需同意'));

/* ================= 4. 界面渲染实际生效 ================= */
console.log('\n-- 4. 界面渲染 --');
const ui = run(`
  resetWorld(); buildWorld();
  const cs=countries.filter(c=>c&&c.alive).sort((a,b)=>totalDev(b)-totalDev(a));
  const A=cs[0].id, B=cs[1].id;
  player=A; setHumans([A,B]); started=true; MP.online=true; uiTab='war';
  declareWar(A,B); invalidateCamps();
  const w=wars.find(x=>x&&((x.a===A&&x.d===B)||(x.d===A&&x.a===B)));
  // 模拟收到对方发来的提案（其中包含我方割让一省）
  const pid=countries[A].provList.find(i=>provinces[i].pix.length);
  pendingOffers[A]={war:w, enemy:B, transfers:[{pid,to:B}], releases:[], expire:dayCount+180, human:true};
  MP.sentOffer={to:B, transfers:[{pid,to:A}], releases:[], expire:dayCount+180};
  refreshPanel();
  const h=document.getElementById('panel-body').innerHTML;
  // B 视角：应看到"接受条件"
  player=B; refreshPanel();
  const hB=document.getElementById('panel-body').innerHTML;
  return { hasHumanOffer:h.includes('需你同意'), hasAccept:h.includes('接受条件（结束战争）'),
           hasMySent:h.includes('我朝已递交的条件'), hasAcceptB:hB.includes('接受条件（结束战争）') };
`);
check('A 视角能看到对方向他提出的提案', ui.hasHumanOffer === true, ui);
check('A 视角有「接受条件（结束战争）」按钮', ui.hasAccept === true, ui);
check('A 视角能看到自己递交出去的提案', ui.hasMySent === true, ui);
check('B（提案方）视角不该出现"接受"按钮', ui.hasAcceptB === false, ui);

/* ================= 5. 回归：AI 和谈仍然是即时的 ================= */
console.log('\n-- 5. 回归 --');
const reg = run(`
  resetWorld(); buildWorld(); setHumans([140,44]);
  for(let i=0;i<1200;i++) tickDay();
  const st=getState();
  return { day:dayCount, wars:st.wars.length, armies:st.armies.length,
           aiOffersUseTransfers: Object.values(st.pendingOffers).every(o=>Array.isArray(o.transfers)) };
`);
check('模拟 1200 天无异常', reg.day === 1200 && reg.armies > 0, reg);
check('AI 提案也统一用 transfers 结构', reg.aiOffersUseTransfers === true, reg);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
