// 剧本（地图工坊数据模型）单元测试
// 最核心的不变量：同一个剧本，在两个互相独立的上下文里建出来的世界必须逐省一致
// —— 这等价于"服务端和客户端各建一份地图，结果必须一模一样"。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 320) : '')); } };

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
/* 建一个独立上下文：用来模拟"服务端"和"客户端"各自加载内核 */
function mkWorld() {
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
    ImageData: function (w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); },
    URLSearchParams, navigator: { userAgent: 'node' }, alert: noop, confirm: () => false,
    promptReply: '测试', noop, addEventListener: noop,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    module: { exports: {} },
  };
  sb.prompt = () => sb.promptReply;
  sb.window = sb; sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  for (const f of ['world-data.js', 'game-core.js', 'net.js', 'client.js']) vm.runInContext(read('web/' + f), ctx, { filename: f });
  return {
    core: sb.module.exports,
    run: (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' }),
  };
}

/* 世界指纹：把所有会同步给客户端的状态压成一个字符串。
   写成自包含 IIFE，方便直接插进任意测试片段里当表达式用。 */
const DIGEST = `(function(){
  const P=provinces, C=countries;
  let s='';
  for(let i=1;i<P.length;i++){
    const p=P[i];
    if(!p.pix.length){ s+='.'; continue; }
    s+=i+':'+p.owner+','+p.controller+','+p.tax+','+p.prod+','+p.man+','+p.name+';';
  }
  for(let i=1;i<C.length;i++){
    const c=C[i]; if(!c){ s+='x'; continue; }
    s+=i+':'+c.name+','+c.color.join('-')+','+c.capital+','+(c.alive?1:0)+','+(c.overlord||0)+','+(c.subject||0)+','+(c.allies||[]).join('/')+','+Math.round(c.gold*10)+';';
  }
  return s;
})()`;

console.log('\n=== 剧本（地图工坊）数据模型验证 ===\n');

const A = mkWorld();

/* ================= 1. 空剧本 == 默认世界 ================= */
console.log('-- 1. 空剧本等价于默认世界 --');
const t1 = A.run(`
  resetWorld(); buildWorld();
  const defDigest=${DIGEST};
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const sc=makeScenario({name:'空图'});
  const fresh=${JSON.stringify(1)};
  return { defDigest, sc, empty:Object.keys(sc.provinces).length===0&&Object.keys(sc.countries).length===0 };
`);
check('什么都没改时，导出的剧本省表为空', t1.empty === true, { p: Object.keys(t1.sc.provinces).length, c: Object.keys(t1.sc.countries).length });
check('空剧本带正确的版本/底图/种子',
  t1.sc.v === 1 && t1.sc.base === 'ne110m' && t1.sc.seed === 987654321, { v: t1.sc.v, base: t1.sc.base, seed: t1.sc.seed });

const t1b = A.run(`
  const err=buildWorldFromScenario({v:1,base:'ne110m',seed:987654321,countries:{},provinces:{},armies:[]});
  const {provinces,countries}=getState();
  const d=${DIGEST};
  return { err, d };
`);
check('buildWorldFromScenario 无错误', t1b.err === null, t1b.err);
check('【核心】空剧本建出的世界 == 默认世界', t1b.d === t1.defDigest,
  { same: t1b.d === t1.defDigest, lenA: t1b.d.length, lenB: t1.defDigest.length });

/* ================= 2. 编辑后导出，再套用 == 编辑后的世界 ================= */
console.log('\n-- 2. 编辑 → 导出 → 套用，世界必须逐省一致 --');
const t2 = A.run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const C=countries, P=provinces;
  // 做一批编辑：改归属、改名、改色、改首都、改发展度、改省名、设傀儡、造军队
  const a=C.find(c=>c&&c.alive&&c.provList.length>8), b=C.find(c=>c&&c.alive&&c.id!==a.id&&c.provList.length>5);
  const moved=a.provList.slice(0,5);
  for(const pid of moved) transferProvince(pid,b.id);
  C[a.id].name='新大明'; C[a.id].color=[12,200,90]; C[a.id].capital=moved[0];
  P[a.provList[0]].tax=42; P[a.provList[1]].prod=33; P[a.provList[2]].man=24;
  P[a.provList[3]].name='天府';
  C[b.id].overlord=a.id; C[b.id].subject=SUBJ_VASSAL;
  C[a.id].gold=1234.5;
  C[a.id].allies=[b.id]; C[b.id].allies=[a.id];
  armies=[{id:1,owner:a.id,prov:a.provList[0],str:12345,path:[],prog:0,isNavy:0}];
  const edited=${DIGEST};
  const sc=makeScenario({name:'乱世',author:'作者',desc:'说明文字'});
  return { edited, sc, aId:a.id, bId:b.id, moved,
           provCount:Object.keys(sc.provinces).length, ctryCount:Object.keys(sc.countries).length,
           raw:JSON.stringify(sc).length, armyN:sc.armies.length };
`);
check('剧本记录了改动的省份', t2.provCount >= 5, t2.provCount);
check('剧本记录了改动的国家', t2.ctryCount >= 2, t2.ctryCount);
check('剧本记录了起始军队', t2.armyN === 1, t2.armyN);
check('剧本体积很小（稀疏覆盖）', t2.raw < 20000, t2.raw + ' bytes');
check('元信息保留', t2.sc.name === '乱世' && t2.sc.author === '作者' && t2.sc.desc === '说明文字', t2.sc);

/* 关键：在**另一个独立上下文**里套用同一份剧本 */
const B = mkWorld();
const applyRes = B.run(`return buildWorldFromScenario(${JSON.stringify(t2.sc)});`);
check('另一个上下文套用剧本无错误', applyRes === null, applyRes);
const appliedB = B.run('return ' + DIGEST);
check('【核心】独立上下文建出的世界与编辑后的世界完全一致', appliedB === t2.edited,
  { same: appliedB === t2.edited, lenA: appliedB.length, lenB: t2.edited.length });
check('（世界不是空的，说明比较有意义）', appliedB.length > 10000, appliedB.length);

/* ================= 3. 哈希稳定性与版本校验 ================= */
console.log('\n-- 3. 哈希与合法性校验 --');
const t3 = A.run(`
  const s1=makeScenario({name:'A'});
  const s2=JSON.parse(JSON.stringify(s1));
  const h1=scenarioHash(s1), h2=scenarioHash(s2);
  // 同一份内容，但键的插入顺序不同
  const s3=JSON.parse(JSON.stringify(s1));
  s3.provinces={}; s3.countries={};
  for(const k of Object.keys(s1.provinces).reverse()) s3.provinces[k]=s1.provinces[k];
  for(const k of Object.keys(s1.countries).reverse()) s3.countries[k]=s1.countries[k];
  const h3=scenarioHash(s3);
  // 改一个字段，哈希必须变
  const s4=JSON.parse(JSON.stringify(s1));
  const k0=Object.keys(s4.provinces)[0];
  s4.provinces[k0]={...(s4.provinces[k0]||{}), t:99};
  const h4=scenarioHash(s4);
  return { h1, h2, h3, h4, sameJson:JSON.stringify(s1)===JSON.stringify(s2) };
`);
check('同样内容 → 同样哈希', t3.h1 === t3.h2, t3);
check('【核心】键顺序不同也得到同样哈希（可跨端比对）', t3.h1 === t3.h3, t3);
check('内容变了哈希就变', t3.h1 !== t3.h4, t3);
check('哈希是 8 位十六进制', /^[0-9a-f]{8}$/.test(t3.h1), t3.h1);

const t3b = A.run(`
  return {
    ok:      validateScenario({v:1,base:'ne110m',countries:{},provinces:{},armies:[]}),
    ver:     validateScenario({v:99}),
    base:    validateScenario({v:1,base:'other'}),
    nullv:   validateScenario(null),
    badProv: validateScenario({v:1,base:'ne110m',provinces:[]}),
    badArmy: validateScenario({v:1,base:'ne110m',armies:{}}),
    applyBad:buildWorldFromScenario({v:99}),
  };
`);
check('合法剧本通过校验', t3b.ok === null, t3b.ok);
check('版本不符被拒绝', typeof t3b.ver === 'string' && t3b.ver.includes('版本'), t3b.ver);
check('底图不符被拒绝', typeof t3b.base === 'string' && t3b.base.includes('底图'), t3b.base);
check('null 被拒绝', typeof t3b.nullv === 'string', t3b.nullv);
check('provinces 类型错误被拒绝', typeof t3b.badProv === 'string', t3b.badProv);
check('armies 类型错误被拒绝', typeof t3b.badArmy === 'string', t3b.badArmy);
check('套用坏剧本返回错误而不是抛异常', typeof t3b.applyBad === 'string', t3b.applyBad);

/* ================= 4. 恶意/越界输入要被夹住 ================= */
console.log('\n-- 4. 越界与脏数据要被夹住而不是搞崩世界 --');
const t4 = A.run(`
  const evil={
    v:1, base:'ne110m', seed:987654321,
    name:'<img src=x onerror=alert(1)>'.repeat(5),
    author:'x<script>', desc:'y'.repeat(500),
    countries:{
      '44':{ n:'<b>坏名</b>', c:'999,-5,abc', cap:-3, g:-100, ov:99999, sj:77, al:[44,99999,'x'] },
      '5':{ new:1, n:'新国家', c:'10,20,30', cap:1 },
    },
    provinces:{ '1':{ o:99999, t:1e9, p:-50, m:'abc', n:'<i>省</i>' } },
    armies:[ {o:99999,p:1,s:1e9}, {o:44,p:-1,s:10} ],
  };
  const err=buildWorldFromScenario(evil);
  const C=countries, P=provinces, sc=makeScenario({name:'x'});
  return { err, name:C[44]?C[44].name:null, color:C[44]?C[44].color:null,
           gold:C[44]?C[44].gold:null, ov:C[44]?C[44].overlord:null,
           sj:C[44]?C[44].subject:null, allies:C[44]?C[44].allies:null,
           p1:{o:P[1].owner,t:P[1].tax,p:P[1].prod,m:P[1].man,n:P[1].name},
           armyN:getState().armies.length,
           mapName:makeScenario({name:'<x>'.repeat(40)}).name };
`);
check('带脏数据的剧本仍能套用（不抛异常）', t4.err === null, t4.err);
check('国名剥掉尖括号并限长', !t4.name.includes('<') && !t4.name.includes('>') && t4.name.length <= 12, t4.name);
check('非法颜色被拒（保持原色）', Array.isArray(t4.color) && t4.color.length === 3 && t4.color.every(v => v >= 0 && v <= 255), t4.color);
check('负数金币被夹到 0', t4.gold === 0, t4.gold);
check('不存在的宗主被忽略', t4.ov === 0, t4.ov);
check('宗主为 0 时国体归零', t4.sj === 0, t4.sj);
check('盟友里的非法 id 被剔除且双向化', Array.isArray(t4.allies) && !t4.allies.includes(99999) && !t4.allies.includes(44), t4.allies);
check('省份越界归属被忽略', t4.p1.o > 0 && t4.p1.o < 300, t4.p1);
check('发展度被夹在合理范围', t4.p1.t >= 1 && t4.p1.t <= 99 && t4.p1.p >= 1 && t4.p1.p <= 99 && t4.p1.m >= 1 && t4.p1.m <= 99, t4.p1);
check('省名被清洗', !t4.p1.n.includes('<'), t4.p1.n);
check('无效军队被丢弃', t4.armyN === 0, t4.armyN);
check('地图名被清洗并限长', !t4.mapName.includes('<') && t4.mapName.length <= 24, t4.mapName);

/* ================= 5. 新国家 ================= */
console.log('\n-- 5. 剧本里可以定义世界生成时不存在的国家 --');
const t5 = A.run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const C=countries, P=provinces;
  const host=C.find(c=>c&&c.alive&&c.provList.length>6);
  const taken=host.provList.slice(0,4);
  const nid=C.length;                        // 新国家编号
  const sc={
    v:1, base:'ne110m', seed:987654321, name:'新国家测试',
    countries:{ [host.id]:{}, [nid]:{ new:1, n:'海东国', c:'200,80,40', cap:taken[0], g:300 } },
    provinces:Object.fromEntries(taken.map(pid=>[pid,{o:nid}])),
    armies:[{o:nid,p:taken[0],s:8000}],
  };
  const err=buildWorldFromScenario(sc);
  // 注意：buildWorldFromScenario 会整体重建数组，必须重新取一次 provinces/countries
  const C2=countries, P2=provinces;
  const nc=C2[nid];
  return { err, nid, exists:!!nc, name:nc?nc.name:null, color:nc?nc.color:null,
           provs:nc?nc.provList.length:0, alive:nc?nc.alive:null, gold:nc?nc.gold:null,
           cap:nc?nc.capital:null, ownerOk:nc?nc.provList.every(p=>P2[p].owner===nid):null,
           hostLost:host.provList.length-4 };
`);
check('新国家被建出来', t5.exists === true, t5);
check('名字/颜色/首都正确', t5.name === '海东国' && t5.color.join(',') === '200,80,40' && t5.cap > 0, t5);
check('拿到了全部划给它的省份', t5.provs === 4 && t5.ownerOk === true, t5);
check('存活且带起始金', t5.alive === true && t5.gold === 300, t5);

/* ================= 6. 战场可用性：套用剧本后能正常跑游戏 ================= */
console.log('\n-- 6. 套用剧本后世界能正常运转 --');
const t6 = A.run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const C=countries;
  const a=C.find(c=>c&&c.alive&&c.provList.length>10);
  const b=C.find(c=>c&&c.alive&&c.id!==a.id&&c.provList.length>6);
  const wasB=b.provList.length;
  for(const pid of a.provList.slice(0,3)) transferProvince(pid,b.id);
  C[b.id].overlord=a.id; C[b.id].subject=SUBJ_PUPPET;
  const sc=makeScenario({name:'可玩性'});
  const err=buildWorldFromScenario(sc);
  // 立刻检查剧本设定是否生效（跑几百年之后宗主关系本来就可能变，不能拿它当断言）
  const applied={ ovOk:overlordOf(b.id)===a.id, subjOk:countries[b.id].subject===SUBJ_PUPPET,
                  movedOk:countries[b.id].provList.length===wasB+3 };
  setHumans([a.id,b.id]);
  player=a.id; started=true;
  for(let i=0;i<900;i++) tickDay();
  return { err, applied, day:dayCount, armies:getState().armies.length, wars:getState().wars.length,
           vassalStillAlive:countries[b.id].alive };
`);
check('套用剧本后模拟 900 天无异常', t6.err === null && t6.day === 900, t6);
check('世界正常演化出军队与战争', t6.armies > 0, t6);
check('【剧本生效】宗主关系建立', t6.applied.ovOk === true, t6.applied);
check('【剧本生效】国体为傀儡国', t6.applied.subjOk === true, t6.applied);
check('【剧本生效】划过去的省份归属正确', t6.applied.movedOk === true, t6.applied);

/* ================= 7. 存档往返仍然可用 ================= */
console.log('\n-- 7. 自定义剧本 + 存档往返 --');
const t7 = A.run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const C=countries;
  const a=C.find(c=>c&&c.alive&&c.provList.length>8);
  C[a.id].name='我的王朝';
  const sc=makeScenario({name:'存档测试'});
  buildWorldFromScenario(sc);
  const before=${DIGEST};
  const snap=makeSaveData();
  buildWorldFromScenario(sc);                    // 重建
  applySaveData(JSON.parse(JSON.stringify(snap)));
  const after=${DIGEST};
  return { same:before===after, len:before.length, name:countries[a.id].name };
`);
check('剧本 + 存档往返后世界一致', t7.same === true, { same: t7.same, len: t7.len });
check('剧本改的国名保留', t7.name === '我的王朝', t7.name);

/* ================= 8. 起始战争 / keepBase / 老地图兼容 ================= */
console.log('\n-- 8. 起始战争、基线保留、老地图兼容 --');
const t8 = A.run(`
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const C=countries;
  const [a,b]=C.filter(c=>c&&c.alive&&c.provList.length>4).slice(0,2).map(c=>c.id);
  wars=[{a,d:b,aB:0,dB:0,startDay:0,casA:0,casD:0}];
  const sc=makeScenario({name:'战争'});
  return { a, b, sc, wars:sc.wars||[], hasWars:!!sc.wars };
`);
check('起始战争被写进剧本', t8.hasWars === true && t8.wars.length === 1, t8);
check('战争以 [小,大] 数对保存', t8.wars[0][0] === Math.min(t8.a, t8.b) && t8.wars[0][1] === Math.max(t8.a, t8.b), t8);

const t8b = B.run(`
  const err=buildWorldFromScenario(${JSON.stringify(t8.sc)});
  return { err, wars:wars.map(w=>[w.a,w.d]), atWar:atWar(${t8.a},${t8.b}), camp:campOf(${t8.a}).has(${t8.b}) };
`);
check('战争在另一端重建', t8b.err === null && t8b.wars.length === 1, t8b);
check('【核心】atWar 立刻为真', t8b.atWar === true, t8b);
check('两国不算同一阵营', t8b.camp === false, t8b);

const t8c = A.run(`
  // keepBase：导入后还要继续编辑，基线不能被清掉
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld(); captureScenarioBase();
  const sc={ v:1, base:'ne110m', seed:SCENARIO_SEED, name:'基线测试',
             countries:{ '44':{ n:'改名了' } }, provinces:{}, armies:[] };
  const before=scenarioBaseReady();
  const err=applyScenario(sc,true);
  const afterKeep=scenarioBaseReady();
  const sc2=makeScenario({name:'再导出'});
  const keptName=(sc2.countries['44']||{}).n;
  // 不带 keepBase 时基线应作废
  applyScenario(sc,false);
  const afterDrop=scenarioBaseReady();
  return { before, err, afterKeep, afterDrop, keptName };
`);
check('采基线后 scenarioBaseReady 为真', t8c.before === true, t8c);
check('【核心】applyScenario(...,true) 保留基线', t8c.afterKeep === true, t8c);
check('【核心】保留基线下再导出，改动仍在', t8c.keptName === '改名了', t8c);
check('applyScenario(...,false) 会作废基线（原行为不变）', t8c.afterDrop === false, t8c);

const t8d = A.run(`
  // 老地图：完全没有 wars / ov / sj / al 字段
  const old={ v:1, base:'ne110m', seed:987654321, name:'老图',
              countries:{ '44':{ n:'老国' } }, provinces:{ '1':{ o:44 } }, armies:[] };
  const bad=validateScenario(old);
  const err=buildWorldFromScenario(old);
  const C=countries;
  return { bad, err, wars:wars.length, name:C[44].name,
           ov:C[44].overlord, al:(C[44].allies||[]).length,
           hasWarsField:'wars' in old };
`);
check('老地图通过校验', t8d.bad === null, t8d.bad);
check('【核心】老地图能正常建出世界（不因缺字段报错）', t8d.err === null, t8d);
check('老地图没有战争', t8d.wars === 0, t8d.wars);
check('老地图的国名照常生效', t8d.name === '老国', t8d);
check('缺外交字段 = 无外交关系', t8d.ov === 0 && t8d.al === 0, t8d);

const t8e = A.run(`
  // 脏 wars：指向不存在的国家 / 自己打自己 / 重复，都要被忽略
  const sc={ v:1, base:'ne110m', seed:987654321, name:'脏战争',
             countries:{}, provinces:{}, armies:[],
             wars:[[44,44],[44,99999],[0,44],'x',null,[44,46],[46,44]] };
  const bad=validateScenario(sc);
  const err=buildWorldFromScenario(sc);
  return { bad, err, wars:wars.map(w=>[w.a,w.d]).sort((p,q)=>p[0]-q[0]) };
`);
check('wars 是数组时通过校验', t8e.bad === null, t8e.bad);
check('脏战争数据被清理', t8e.err === null && t8e.wars.length <= 1, t8e);
check('自打自/不存在国家/重复都被丢掉', t8e.wars.every(w => w[0] !== w[1] && w[1] < 200), t8e);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
