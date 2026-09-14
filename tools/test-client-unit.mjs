// Unit tests for the two client/core bugs found in browser testing.
// Loads world-data.js + game-core.js + net.js inside a vm context with a
// minimal DOM stub, then exercises the real functions.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (n, c, x) => { if (c) console.log('  PASS  ' + n); else { failures++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

/* ---- 最小 DOM 桩：net.js 只在加载时注册事件监听 ---- */
const noop = () => {};
const stubEl = () => ({
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, appendChild: noop, insertBefore: noop,
  style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  focus: noop, select: noop, setSelectionRange: noop, scrollTop: 0, scrollHeight: 0,
});
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener: noop, getElementById: stubEl, createElement: stubEl, querySelector: () => null, querySelectorAll: () => [] },
  location: { search: '', pathname: '/gs/', protocol: 'http:', host: 'localhost' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  WebSocket: function () { this.readyState = 0; this.send = noop; this.close = noop; },
  URLSearchParams,
  performance: { now: () => Date.now() },
  requestAnimationFrame: noop,
  confirm: () => false,
  alert: noop,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.noop = noop;
const ctx = vm.createContext(sandbox);

console.log('\n=== 客户端/内核 针对性单测 ===\n');

vm.runInContext(read('web/world-data.js'), ctx, { filename: 'world-data.js' });
vm.runInContext(read('web/game-core.js'), ctx, { filename: 'game-core.js' });
vm.runInContext(read('web/net.js'), ctx, { filename: 'net.js' });

/* 顶层 return 非法，统一包一层函数 */
const run = (code) => vm.runInContext(`(function(){ ${code} })()`, ctx, { filename: 'test' });

/* ---- 建世界 ---- */
run('resetWorld(); buildWorld();');
check('世界构建成功', run('return countries.length===177 && provinces.length>1900'), run('return [countries.length, provinces.length]'));

/* ================= bug 1：存档必须保留军队 id ================= */
console.log('\n-- bug 1: 军队 id 在快照中保留 --');
const ids = run(`
  armies = [
    {id:42, owner:1, prov:2, str:5000, path:[], prog:0},
    {id:77, owner:1, prov:3, str:3000, path:[], prog:0, isNavy:1},
    {id:105, owner:5, prov:9, str:8000, path:[], prog:0},
  ];
  nextArmy = 106;
  const snap = makeSaveData();
  applySaveData(snap);
  return armies.map(a=>a.id);
`);
check('读档后军队 id 不变', JSON.stringify(ids) === '[42,77,105]', ids);
check('nextArmy 不冲突', run('return nextArmy>=106'), run('return nextArmy'));
check('海军标记保留', run('return armies.find(a=>a.id===77).isNavy===1'));

/* 联机场景：服务端下发增量时用 id 匹配，id 必须一一对应 */
const match = run(`
  armies = [{id:42,owner:1,prov:2,str:5000,path:[],prog:0}];
  const before = armies.length;
  mpApplyArmies([[42,1,7,4800,3,0,0,0,[7,8],null,8]], []);
  return {before, after: armies.length, id: armies[0].id, prov: armies[0].prov, path: armies[0].path};
`);
check('增量按 id 就地更新，不产生副本', match.before === 1 && match.after === 1 && match.id === 42, match);
check('增量写入了新的省份与路径', match.prov === 7 && JSON.stringify(match.path) === '[7,8]', match);

/* ================= bug 2：军队增量不能清空列表 ================= */
console.log('\n-- bug 2: 增量合并不清空军队 --');
const merged = run(`
  armies = [
    {id:1,owner:1,prov:2,str:5000,path:[],prog:0},
    {id:2,owner:1,prov:3,str:5000,path:[],prog:0},
    {id:3,owner:9,prov:4,str:5000,path:[],prog:0},
  ];
  mpApplyArmies([[2,1,5,4900,1,0,0,0,null,null,5]], []);   // 只有 2 号变了
  return armies.map(a=>a.id).sort((x,y)=>x-y);
`);
check('未变更的军队仍在（1、3 未被清掉）', JSON.stringify(merged) === '[1,2,3]', merged);

const removed = run(`
  armies = [{id:1,owner:1,prov:2,str:5000,path:[],prog:0},{id:2,owner:1,prov:3,str:5000,path:[],prog:0}];
  selectedArmy = 2;
  mpApplyArmies([], [2]);
  return {ids: armies.map(a=>a.id), sel: selectedArmy};
`);
check('被移除的军队会删除', JSON.stringify(removed.ids) === '[1]', removed);
check('选中被删除的军队时清空选择', removed.sel === 0, removed);

const dup = run(`
  armies = [{id:5,owner:1,prov:2,str:5000,path:[],prog:0}];
  mpApplyArmies([[5,1,9,5000,0,0,0,0,[],null,0],[6,1,9,5000,0,0,0,0,[],null,0]], []);
  const seen = new Set(armies.map(a=>a.id));
  return {n: armies.length, uniq: seen.size};
`);
check('不会产生重复 id', dup.n === 2 && dup.uniq === 2, dup);

/* ================= bug 3：开局后大厅不再弹出 ================= */
console.log('\n-- bug 3: 开局后忽略大厅广播 --');
const lobbyGuard = run(`
  MP.inGame = true;
  const before = document.getElementById('lobby');
  mpHandle({t:'lobby', room:'1234', you:1, hostKey:1, host:true, started:true,
            players:[{k:1,name:'a',country:140}]});
  return MP.players.length;
`);
check('开局后仍会更新玩家列表', lobbyGuard === 1, lobbyGuard);
check('开局后不再切回大厅界面', run('return MP.inGame===true'));

/* ================= bug 4：加入已开局房间时带 rejoin ================= */
console.log('\n-- bug 4: 重连标记 --');
let sentMsgs = [];
sandbox.WebSocket = function () {
  this.readyState = 1;
  this.send = (s) => sentMsgs.push(JSON.parse(s));
  this.close = noop;
};
run('MP.ws = new WebSocket("ws://x/gs/ws"); MP.name="guest";');
run(`document.getElementById = (id)=>({value: id==='lb-code'?'4321':'guest', classList:{add:noop,remove:noop,toggle:noop,contains:()=>false}, style:{}, textContent:'', innerHTML:'', addEventListener:noop});`);
run('mpJoin();');
const joinMsg = sentMsgs.find(m => m.t === 'join');
check('加入房间会自动带 rejoin 标记（同名可接回原局）', joinMsg && joinMsg.rejoin === true, joinMsg);

/* ================= 回归：core 仍可完整跑一局 ================= */
console.log('\n-- 回归：内核仍能正常模拟 --');
const sim = run(`
  resetWorld(); buildWorld();
  setHumans([44,140]);
  const logs=[];
  UI.log = (t,c,f)=>logs.push(f);
  for(let i=0;i<800;i++) tickDay();
  return {day: dayCount, armies: armies.length, wars: wars.length, alive: countries.filter(c=>c&&c.alive).length};
`);
check('模拟 800 天无异常', sim.day === 800 && sim.armies > 0, sim);

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
process.exit(failures ? 1 : 0);
