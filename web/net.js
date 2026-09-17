'use strict';
/* =====================================================================
   王朝纪元 · 1444 — 联机客户端
   大厅（创建/加入房间）→ 选国 → 服务端权威模拟 → 增量同步
   ===================================================================== */

/* 画面重绘信号：军队位置一变就自增，渲染层据此判断"画面要不要重画"。
   放在 net.js 是因为它先于 client.js 加载。 */
let _armyVer = 0;

const MP = {
  online: false,      // 是否处于联机对局
  ws: null,
  myId: 0,            // 我的国家 id
  playerKey: 0,       // 我在房间中的玩家编号
  room: '',
  host: false,
  name: '',
  joined: false,      // 已进入房间（大厅）
  inGame: false,
  players: [],        // [{k,name,country}]
  taken: {},          // countryId -> playerName
  reconnect: false,
  lastMsg: 0,
};

/* ---------------- WebSocket 地址 ---------------- */
function wsURL() {
  const q = new URLSearchParams(location.search);
  if (q.get('ws')) return q.get('ws');
  const base = location.pathname.replace(/[^/]*$/, ''); // '/gs/' 或 '/'
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws';
}

/* ---------------- 浮动提示 ----------------
   原来服务端的报错只写进 #lb-msg（在大厅里），开局后大厅是隐藏的，
   于是任何指令失败都毫无反馈 —— 点按钮像坏了一样。这里补一个游戏内可见的提示。 */
let _toastEl = null, _toastTimer = 0;
function mpToast(text) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.id = 'gs-toast';
    _toastEl.style.cssText = 'position:absolute;left:50%;top:58px;transform:translateX(-50%);z-index:80;' +
      'background:rgba(64,22,22,.96);border:1px solid #a0503a;color:#ffc0b0;padding:9px 18px;border-radius:4px;' +
      'font-size:13px;max-width:72vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = text;
  _toastEl.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toastEl.style.opacity = '0'; }, 2800);
}

/* ---------------- DOM 助手 ---------------- */
const $id = (i) => document.getElementById(i);
function lbMsg(text, cls) {
  const el = $id('lb-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = cls || '';
}
function lbShow(stage) {
  const map = { entry: 'lobby-entry', room: 'lobby-room' };
  for (const k in map) $id(map[k]).classList.toggle('hidden', k !== stage);
  $id('lb-chat-wrap').classList.toggle('hidden', stage !== 'room');
}

/* ---------------- 连接 ---------------- */
function mpConnect(onOpen) {
  if (MP.ws && MP.ws.readyState <= 1) { onOpen && onOpen(); return; }
  let ws;
  try { ws = new WebSocket(wsURL()); }
  catch (e) { lbMsg('无法连接服务器：' + e.message, 'err'); return; }
  MP.ws = ws;
  ws.onopen = () => { MP.lastMsg = Date.now(); onOpen && onOpen(); };
  ws.onclose = () => {
    if (MP.inGame || MP.joined) lbMsg('与服务器的连接已断开，正在重连……', 'err');
    setTimeout(() => { if (MP.joined || MP.inGame) mpConnect(() => mpResume()); }, 1500);
  };
  ws.onerror = () => { lbMsg('连接服务器失败（' + wsURL() + '）', 'err'); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    MP.lastMsg = Date.now();
    MP.deltaBytes = (MP.deltaBytes || 0) + (ev.data.length || 0);
    mpHandle(m);
  };
}
function mpSend(obj) {
  if (MP.ws && MP.ws.readyState === 1) MP.ws.send(JSON.stringify(obj));
}

/* ---------------- 大厅交互 ---------------- */
function mpName() {
  const v = ($id('lb-name').value || '').trim();
  if (v) { try { localStorage.setItem('gs_name', v); } catch (e) {} }
  return v || '无名君主';
}
function mpCreate() {
  const name = mpName();
  MP.name = name; MP.reconnect = false;
  const mapId = (typeof currentMap !== 'undefined' && currentMap) ? currentMap.id : 0;
  lbMsg(mapId ? '正在创建房间（地图：' + currentMap.name + '）……' : '正在创建房间……');
  mpConnect(() => mpSend({ t: 'create', name, mapId }));
}
function mpJoin() {
  const code = ($id('lb-code').value || '').trim();
  if (!/^\d{4,6}$/.test(code)) { lbMsg('请输入 4~6 位数字房间号', 'err'); return; }
  const name = mpName();
  MP.name = name; MP.reconnect = true;
  lbMsg('正在加入房间 ' + code + ' ……');
  /* rejoin:true 时服务端会先把断线的同名玩家接回来；没有匹配再按新玩家处理 */
  mpConnect(() => mpSend({ t: 'join', name, room: code, rejoin: true }));
}
/* 断线后自动回到原房间 */
function mpResume() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('gs_session') || 'null'); } catch (e) {}
  if (!s || !s.room) return;
  MP.name = s.name; MP.reconnect = true;
  mpSend({ t: 'join', name: s.name, room: s.room, rejoin: true });
}
function mpSolo() {
  MP.online = false;
  showOnlyModal('selectmodal');
  renderSelectList('');
  refreshStartLoadBtn();
}
function mpPick(cid) {
  if (!MP.joined) return;
  mpSend({ t: 'pick', country: cid });
}
function mpStart() { mpSend({ t: 'start' }); }
function mpLeave() {
  mpSend({ t: 'leave' });
  try { sessionStorage.removeItem('gs_session'); } catch (e) {}
  location.reload();
}

/* ---------------- 服务端消息 ---------------- */
function mpHandle(m) {
  switch (m.t) {
    case 'lobby': mpRenderLobby(m); break;
    case 'error':
      // 开局后要大张旗鼓地提示，否则玩家只会觉得"点了没反应"
      if (MP.inGame || (typeof started !== 'undefined' && started)) {
        mpToast(m.msg);
        pushLog('⚠ ' + m.msg, 'war', player);
      } else {
        lbMsg(m.msg, 'err');
      }
      if (m.fatal) { MP.joined = false; MP.inGame = false; lbShow('entry'); }
      break;
    case 'begin': mpBegin(m); break;
    case 'delta': mpDelta(m); break;
    case 'chat': mpChat(m); break;
    case 'defeat': mpDefeat(m); break;
    case 'end': mpEnded(m); break;
  }
}

/* ---------------- 自定义地图：本地世界对齐 ----------------
   房间可能用的是一张自定义剧本，而客户端本地世界是按官方地图建的。
   国家编号、省份归属都会对不上，所以进房/开局前必须先把本地世界
   重建成和服务端一模一样的那一张。
   返回 true 表示世界被重建过（调用方需要重画地图与标签）。 */
function mpSyncMap(pack) {
  const wantHash = (pack && pack.scenario) ? String(pack.hash || '') : '';
  if ((MP.mapHash || '') === wantHash) return false;
  if (!pack || !pack.scenario) {
    resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
    MP.mapHash = ''; MP.mapName = '';
  } else {
    const err = buildWorldFromScenario(pack.scenario);
    if (err) { mpToast('地图载入失败：' + err); return false; }
    MP.mapHash = wantHash; MP.mapName = pack.name || '';
  }
  labelsDirty = true;
  return true;
}

function mpRenderLobby(m) {
  MP.joined = true; MP.room = m.room; MP.host = !!m.host;
  MP.playerKey = m.you; MP.players = m.players || [];
  MP.taken = {};
  for (const p of MP.players) if (p.country) MP.taken[p.country] = p.name;

  // 先把本地世界对齐到房间用的那张地图，否则下面的国家列表全是错的
  if (mpSyncMap(m.map)) {
    recolorAll(); rebuildLabels();
    if (typeof updateMapBadge === 'function') updateMapBadge();
  }

  try { sessionStorage.setItem('gs_session', JSON.stringify({ room: m.room, name: MP.name })); } catch (e) {}

  if (MP.inGame) { mpTopbarBadge(); return; }   // 已开局：别把大厅再弹出来
  if (typeof showOnlyModal === 'function') showOnlyModal('lobby'); else $id('lobby').classList.remove('hidden');
  lbShow('room');
  lbMsg('');
  $id('lb-roomcode').textContent = m.room;

  const me = MP.players.find(p => p.k === MP.playerKey) || {};
  let h = '';
  for (const p of MP.players) {
    const c = p.country ? countries[p.country] : null;
    h += `<div class="c-row">
      <span class="cd" style="background:${c ? `rgb(${c.color.map(v => v | 0)})` : '#333'}"></span>
      <span class="cn">${escHtml(p.name)}${p.k === MP.playerKey ? '<span class="hint">（你）</span>' : ''}${p.k === m.hostKey ? ' 👑' : ''}</span>
      <span class="cs">${c ? escHtml(c.name) + ' · ' + c.provList.length + '省' : '未选国家'}</span>
    </div>`;
  }
  $id('lb-players').innerHTML = h;

  const ready = MP.players.filter(p => p.country).length;
  let act = '';
  if (MP.host) {
    act = `<button class="act" data-act="lb-start" ${ready >= 1 ? '' : 'disabled'}>开始游戏（${ready}/${MP.players.length} 已选国）</button>`;
  } else {
    act = `<span class="hint">等待房主开始游戏……（${ready}/${MP.players.length} 已选国）</span>`;
  }
  act += ` <button class="act" data-act="lb-leave" style="background:#4a2222;border-color:#8a4040;color:#ffb0b0">离开房间</button>`;
  act += ` <span class="hint">把房间号 <b style="color:#ffd080">${m.room}</b> 发给朋友即可加入</span>`;
  $id('lb-actions').innerHTML = act;

  renderLobbyCountries('');
}

function renderLobbyCountries(q) {
  q = q || '';
  const list = [...countries].filter(c => c && c.alive)
    .filter(c => !q || c.name.includes(q) || c.enName.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => totalDev(b) - totalDev(a));
  const me = MP.players.find(p => p.k === MP.playerKey) || {};
  $id('lb-countries').innerHTML = list.map(c => {
    const owner = MP.taken[c.id];
    const mine = me.country === c.id;
    return `<div class="c-row${mine ? ' diplo-open' : ''}" data-act="lb-pick" data-v="${c.id}"
        style="${owner && !mine ? 'opacity:.42' : ''}">
      <span class="cd" style="background:rgb(${c.color.map(v => v | 0)})"></span>
      <span class="cn">${escHtml(c.name)}</span>
      <span class="cs">${owner ? escHtml(owner) + ' 已选' : c.provList.length + '省 · 发展度' + totalDev(c)}</span>
    </div>`;
  }).join('') || '<div class="slot-empty">没有匹配的国家</div>';
}

function mpChat(m) {
  const box = $id('lb-chat');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'lb-chat-line';
  d.innerHTML = `<b>${escHtml(m.from)}</b>：${escHtml(m.text)}`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 开局 ---------------- */
function mpBegin(m) {
  MP.online = true; MP.inGame = true;
  MP.myId = m.you;
  player = m.you;
  setHumans(m.humans || []);

  // 重连场景：整页刷新过，本地还是官方地图，必须按 begin 带来的地图包重建
  mpSyncMap(m.map);

  applySnapshot(m.snapshot);
  showOnlyModal(null);              // 开局：所有弹窗（大厅/选国/地图大厅）都收掉
  started = true;
  paused = !!m.paused;
  speed = m.speed || 2;

  $id('topbar').classList.remove('hidden');
  $id('modebar').classList.remove('hidden');
  $id('sidepanel').classList.remove('hidden');
  $id('logpanel').classList.remove('hidden');
  const cap = countries[player] && provinces[countries[player].capital];
  if (cap) { cam.x = cap.cx; cam.y = cap.cy; cam.z = 3; }
  renderSpeeds(); updateTopbar(); refreshPanel(); renderLog();
  mpTopbarBadge();
  pushLog(`进入联机对局：你是 ${countries[player].name}（房间 ${MP.room}）`, 'gold', player);
  renderLog();
  if (typeof mpChatLine === 'function') { /* noop */ }
}
function mpTopbarBadge() {
  let el = $id('tb-room');
  if (!el) {
    el = document.createElement('span');
    el.id = 'tb-room';
    el.className = 'stat';
    el.style.cssText = 'color:#ffd080;cursor:pointer';
    el.title = '点击离开房间';
    el.onclick = () => { if (confirm('确定离开房间并返回大厅？')) mpLeave(); };
    $id('topbar').insertBefore(el, $id('tb-date'));
  }
  el.textContent = `🏠 房间 ${MP.room}`;
  let who = $id('tb-who');
  if (!who) {
    who = document.createElement('span');
    who.id = 'tb-who';
    who.className = 'stat';
    $id('topbar').insertBefore(who, $id('tb-date'));
  }
  const names = MP.players.filter(p => p.country).map(p => p.name + '·' + (countries[p.country] ? countries[p.country].name : '?'));
  who.textContent = '👥 ' + (names.join('，') || '—');
  who.title = names.join('\n');
}

/* ---------------- 快照 / 增量 ---------------- */
function applySnapshot(d) {
  if (typeof grantMapCancel === 'function') grantMapCancel();   // 换局：退出分封地图
  applySaveData(d);
  const st = getState();
  // 服务端的 pendingOffers 通过快照/增量单独同步
  rebuildAllProvLists();
  recolorAll(); rebuildLabels(); updateSelOverlay();
}
/* 整体重建省份归属（只在载入快照/读档时用；增量走 mpDelta 里的局部更新） */
function rebuildAllProvLists() {
  for (let c = 1; c < countries.length; c++) if (countries[c]) countries[c].provList = [];
  for (let i = 1; i < provinces.length; i++) {
    const p = provinces[i];
    if (p.pix.length && countries[p.owner]) countries[p.owner].provList.push(i);
  }
  for (let c = 1; c < countries.length; c++) {
    const cc = countries[c];
    if (!cc) continue;
    if (cc.provList.length === 0) cc.alive = false;
    recomputeCap(cc);
  }
  labelsDirty = true;
}

function mpDelta(m) {
  const d = m.d;
  if (!d) return;
  MP.deltaCount = (MP.deltaCount || 0) + 1;
  const _dt0 = performance.now();
  // 实测两次增量的间隔，插值窗口跟着它走（服务端改了节拍也不用改代码）
  if (MP.lastDeltaAt) {
    const iv = _dt0 - MP.lastDeltaAt;
    if (iv > 15 && iv < 500) MP.deltaMs = MP.deltaMs ? MP.deltaMs * 0.85 + iv * 0.15 : iv;
  }
  MP.lastDeltaAt = _dt0;
  /* 顺序很重要：新国家必须"先建出来"再处理省份归属。
     否则下面的 pr 找不到 countries[newOwner]，那个省就不会被加进新国家的 provList，
     国家标签质心算不出来（lx=0），名字要刷新页面才会出现。 */
  const hadNewCountries = !!d.cn;
  if (d.cn) {
    // 服务端新建的国家（玩家自建的附庸）：客户端也要在本地建出来
    for (const r of d.cn) {
      const id = r[0];
      if (countries[id]) continue;
      while (countries.length < id) countries.push(null);
      countries[id] = {
        id, featId: 'CUSTOM', name: r[1], enName: r[1],
        color: (r[2] || [180, 180, 180]).slice(), capital: r[3] || 0,
        provList: [], alive: true, gold: 0, mp: 0, mpCap: 0, forceLimit: 0,
        overlord: 0, allies: [], ruler: '', lx: 0, ly: 0,
      };
      labelsDirty = true;
    }
    // 让外交列表等界面立刻显示出这个新国家
    if (typeof markPanelDirty === 'function') markPanelDirty();
  }
  if (d.pr) {
    // 只改动涉及的两个国家的省份列表，别每次遍历全部 2007 个省份
    let gainedFirstProv = false;
    for (const row of d.pr) {
      const p = provinces[row[0]];
      if (!p) continue;
      const oldOwner = p.owner, newOwner = row[1];
      if (oldOwner !== newOwner) {
        // 与服务端 transferProvince 一致：记录故土，「复国之机」靠它
        if (oldOwner > 0 && countries[oldOwner]) {
          if (!p.former) p.former = [];
          if (!p.former.includes(oldOwner)) p.former.push(oldOwner);
        }
        const oc = countries[oldOwner], nc = countries[newOwner];
        if (oc) {
          const k = oc.provList.indexOf(p.id);
          if (k >= 0) oc.provList.splice(k, 1);
          if (oc.provList.length === 0) { oc.alive = false; labelsDirty = true; }
          recomputeCap(oc);
        }
        if (nc) {
          // 这个国家之前一省都没有（新建/刚复国）：拿到第一块地就要重算标签
          const wasEmpty = nc.provList.length === 0;
          nc.provList.push(p.id); nc.alive = true; recomputeCap(nc);
          if (wasEmpty) gainedFirstProv = true;
        }
      }
      p.owner = newOwner; p.controller = row[2]; p.siege = row[3];
    }
    if (hadNewCountries || gainedFirstProv) {
      // 领土已经就位，立刻重算标签位置，新国家的名字当场就能显示
      labelsDirty = true;
      if (typeof rebuildLabels === 'function') rebuildLabels();
    }
  }
  if (d.ct) {
    let campsDirty = false;
    for (const row of d.ct) {
      const c = countries[row[0]];
      if (!c) continue;
      c.gold = row[1]; c.mp = row[2];
      const alive = !!row[3];
      if (c.alive !== alive) { c.alive = alive; labelsDirty = true; campsDirty = true; }
      const ov = row[4] || 0;
      if ((c.overlord || 0) !== ov) { c.overlord = ov; campsDirty = true; }
      // 国体（附庸/傀儡）：只影响外交配色与叛乱倾向，不动阵营
      const sj = row[5] || 0;
      if ((c.subject || 0) !== sj) { c.subject = sj; campsDirty = true; }
    }
    /* 联机时客户端不执行任何指令，所以 invalidateCamps 不会被自动调用；
       宗主关系一变就必须在这里手动失效，否则"我方阵营"永远停留在旧值 ——
       表现为附庸占领的省份不出现在割地列表里、附庸关系看着不对。 */
    if (campsDirty) {
      if (typeof invalidateCamps === 'function') invalidateCamps();
      // 外交模式下宗主/国体一变，地图配色就得跟着变
      if (mapMode === 'rel') recolorAll();
      markPanelDirty();
    }
  }
  if (d.dev) {
    for (const row of d.dev) {
      const p = provinces[row[0]];
      if (!p) continue;
      p.tax = row[1]; p.prod = row[2]; p.man = row[3];
    }
  }
  if (d.rcAdd || d.rcDel) {
    // 差量更新：新增 [id,owner,prov,str,isNavy,startDay,totalDays]，以及被移除的 id
    if (d.rcDel) {
      const gone = new Set(d.rcDel);
      recruits = recruits.filter(r => !gone.has(r.id));
    }
    if (d.rcAdd) for (const r of d.rcAdd) {
      recruits.push({
        id: r[0], owner: r[1], prov: r[2], str: r[3],
        isNavy: r[4] ? 1 : 0, start: r[5], total: r[6],
        days: Math.max(0, r[6] - (dayCount - r[5])),
      });
    }
  }
  if (d.aw !== undefined) mpApplyArmies(d.ar || [], d.ax || []);
  if (d.wr !== undefined) { wars = d.wr || []; }
  // 战况伤亡的小增量（下标对应 wars）
  if (d.cas) for (const row of d.cas) { const w = wars[row[0]]; if (w) { w.casA = row[1]; w.casD = row[2]; } }
  if (d.tr !== undefined) { truces = d.tr || {}; }
  if (d.day !== undefined) {
    dayCount = d.day; cal = { y: d.cy, m: d.cm, d: d.cd };
    if (typeof clockSync === 'function') clockSync(d.day, d.cy, d.cm, d.cd);
    // 征兵剩余天数由"起始日/总天数 + 当前日期"推出来，服务端不必每帧重发
    for (let i = 0; i < recruits.length; i++) {
      const r = recruits[i];
      if (r.start !== undefined) r.days = Math.max(0, r.total - (dayCount - r.start));
    }
  }

  if (d.pr) {
    // 改动的省份多时整体重绘更划算（省掉逐省 setPx 的开销）
    if (d.pr.length > 12) recolorAll();
    else for (const row of d.pr) recolorProvAndNbrs(row[0]);
  }
  /* 国名 / 旗色改动（改国号、属国改色）：套用后立刻重算标签，名字当场就能看到 */
  if (d.cp) {
    let colorChanged = false;
    for (const row of d.cp) {
      const c = countries[row[0]];
      if (!c) continue;
      if (typeof row[1] === 'string' && row[1]) { c.name = row[1]; c.enName = row[1]; labelsDirty = true; }
      if (Array.isArray(row[2]) && row[2].length >= 3) { c.color = row[2].slice(0, 3); colorChanged = true; }
    }
    if (colorChanged) recolorAll();
    if (labelsDirty && typeof rebuildLabels === 'function') rebuildLabels();
    markPanelDirty();
  }
  /* 盟约（allies）增量：结盟/断盟时服务端会发变动过的国家。
     没有这一段的话客户端永远停留在开局快照的盟友表上——
     表现为"盟友在地图上不是蓝色、也找不到断盟按钮"。 */
  if (d.al) {
    for (const row of d.al) {
      const c = countries[row[0]];
      if (!c) continue;
      c.allies = (row[1] || []).slice();
    }
    // 阵营（campOf）把盟友算在内，必须失效重算
    if (typeof invalidateCamps === 'function') invalidateCamps();
    if (mapMode === 'rel') recolorAll();
    // 结盟/断盟很罕见，直接强刷侧栏，别等指纹比对
    if (typeof forcePanelRefresh === 'function') forcePanelRefresh(); else markPanelDirty();
  }
  if (d.dev && mapMode === 'dev') recolorAll();
  if (d.lg) {
    // 服务端按发生顺序推来，最新的要排在最前面
    logEntries = d.lg.slice().reverse().concat(logEntries).slice(0, 140);
    renderLog();
  }
  let clockChanged = false;
  if (d.pa !== undefined && d.pa !== paused) { paused = d.pa; clockChanged = true; }
  if (d.sp !== undefined && d.sp !== speed) { speed = d.sp; clockChanged = true; }
  if (d.players) { MP.players = d.players; mpTopbarBadge(); }
  if (d.of !== undefined) { mpApplyOffers(d.of, d.so); }

  // 侧栏/顶栏不再每个增量都重建：交给 uiTick 按状态指纹 + 节流决定
  if (clockChanged) { renderSpeeds(); forcePanelRefresh(); }
  else markPanelDirty();
  MP.lastDeltaMs = performance.now() - _dt0;
}

/* 军队：服务端发来改动项；ax 是被移除的军队 id 列表。
   这里是"按 id 合并"，绝不清空——快照里的军队必须保留，否则会丢军队。 */
function mpApplyArmies(changed, removed) {
  const now = performance.now();
  const byId = new Map(armies.map(a => [a.id, a]));
  if (removed) for (const id of removed) byId.delete(id);
  for (const row of changed) {
    const id = row[0], owner = row[1], prov = row[2], str = row[3], prog = row[4];
    let a = byId.get(id);
    if (!a) {
      // 只可能是完整行（新军队一定是长行）
      a = { id, owner, prov, str, path: [], prog, progSrv: prog, progPrev: prog, progAt: now };
      byId.set(id, a);
    }
    const provChanged = a.prov !== prov;
    a.owner = owner; a.prov = prov; a.str = str;

    // 插值基准：换省时直接归位（否则会从新省往回倒着走），否则从当前显示值续上
    if (provChanged || a.progSrv === undefined) { a.prog = prog; a.progPrev = prog; }
    else a.progPrev = a.prog;
    a.progSrv = prog; a.progAt = now;

    if (row.length <= 5) continue;      // 短行：只有位置/兵力/进度，其余字段保持不变

    const isNavy = row[5], navIdx = row[6], attrit = row[7], path = row[8], navPath = row[9], dst = row[10];
    a.isNavy = isNavy ? 1 : 0;
    a.attrit = attrit || 0;
    a.dstProv = dst || 0;

    const ni = navIdx || 0;
    if (a.navIdxSrv === undefined || provChanged) { a.navIdx = ni; a.navIdxPrev = ni; a.navIdxF = ni; }
    else a.navIdxPrev = (a.navIdxF !== undefined ? a.navIdxF : a.navIdx);
    a.navIdxSrv = ni; a.navIdx = ni; a.navAt = now;

    if (path !== null && path !== undefined) a.path = path;
    if (navPath !== null && navPath !== undefined) a.navPath = navPath;
    if (!a.isNavy) { a.navPath = null; a.dstProv = 0; }
    a._opt = undefined;      // 服务端已确认，撤掉乐观显示
  }
  armies = [...byId.values()];
  if (removed && selectedArmy && removed.includes(selectedArmy)) selectedArmy = 0;
  _armyVer++;
}
/* 行军平滑插值
   服务端每 130ms 才推一次；这里在两次推送之间按时间线性过渡，
   否则画面就是每 130ms 跳一格（肉眼看着就是一卡一卡的）。 */
const MP_DELTA_MS_DEFAULT = 80;
function mpAnimateArmies() {
  if (!MP.online) return;
  const now = performance.now();
  // 插值窗口 = 实测推送间隔 × 1.08，刚好在下一次推送前走完，既不抖也不拖
  const win = (MP.deltaMs ? MP.deltaMs * 1.08 : MP_DELTA_MS_DEFAULT);
  let moved = false;
  for (const a of armies) {
    // 步兵：在上一帧的显示值与服务端最新值之间过渡
    if (a.progSrv !== undefined && a.progPrev !== undefined) {
      const k = Math.min(1, (now - a.progAt) / win);
      const np = a.progPrev + (a.progSrv - a.progPrev) * k;
      if (np !== a.prog) { a.prog = np; moved = true; }
    }
    // 海军：沿像素路径推进，用浮点索引
    if (a.navIdxSrv !== undefined && a.navIdxPrev !== undefined) {
      const k = Math.min(1, (now - a.navAt) / win);
      a.navIdxF = a.navIdxPrev + (a.navIdxSrv - a.navIdxPrev) * k;
    }
    if (a._opt && now - a._opt > 1200) {
      moved = true;
      a._opt = undefined;
      if (a.isNavy) { a.navPath = null; a.navIdx = 0; a.navIdxF = 0; a.dstProv = 0; }
      else { a.path = []; a.prog = 0; a.progSrv = 0; a.progPrev = 0; }
    }
  }
  if (moved) _armyVer++;   // 通知渲染层：画面需要重画
}
function mpApplyOffers(of, so) {
  // of: { 接收方cid: {enemy,transfers,releases,expire,indep,vassalize,human} }
  const mine = of[player];
  if (mine) {
    const w = wars.find(w => (w.a === player && w.d === mine.enemy) || (w.d === player && w.a === mine.enemy));
    if (w) pendingOffers[player] = {
      war: w, enemy: mine.enemy,
      transfers: mine.transfers || [],
      releases: mine.releases || [], expire: mine.expire,
      indep: !!mine.indep, vassalize: !!mine.vassalize, human: !!mine.human,
    };
  } else {
    delete pendingOffers[player];
  }
  // so: { 提案方cid: {to,transfers,...} } —— 我自己递交出去的那份
  MP.sentOffer = (so && so[player]) || null;
}
function mpDefeat(m) {
  paused = true;
  $id('defeat-text').textContent = `${countries[m.country].name} 于公元${cal.y}年失去全部疆土。史官合上了这一页。`;
  if (typeof showOnlyModal === 'function') showOnlyModal('defeatmodal'); else $id('defeatmodal').classList.remove('hidden');
}
function mpEnded(m) {
  MP.inGame = false;
  const box = $id('defeat-text');
  if (typeof showOnlyModal === 'function') showOnlyModal('defeatmodal'); else $id('defeatmodal').classList.remove('hidden');
  box.textContent = m.reason || '对局结束';
}

/* ---------------- 指令发送 ---------------- */
function mpCmd(o) {
  if (!MP.online) return false;
  o.t = 'cmd';
  mpSend(o);
  return true;
}

/* ---------------- 大厅事件绑定 ---------------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  switch (act) {
    case 'lb-create': mpCreate(); break;
    case 'lb-join': mpJoin(); break;
    case 'lb-solo': mpSolo(); break;
    case 'lb-pick': mpPick(+v); break;
    case 'lb-start': mpStart(); break;
    case 'lb-leave': if (confirm('确定离开房间？')) mpLeave(); break;
    case 'lb-chat-send': {
      const inp = $id('lb-chat-input');
      const text = (inp.value || '').trim();
      if (text) { mpSend({ t: 'chat', text }); inp.value = ''; }
      break;
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'lb-chat-input' && e.key === 'Enter') {
    e.preventDefault();
    const inp = e.target; const text = (inp.value || '').trim();
    if (text) { mpSend({ t: 'chat', text }); inp.value = ''; }
    return;
  }
  if (e.target && (e.target.id === 'lb-name' || e.target.id === 'lb-code') && e.key === 'Enter') {
    e.preventDefault();
    if (e.target.id === 'lb-name') mpCreate(); else mpJoin();
    return;
  }
  if (e.target && e.target.id === 'lb-search') return;
});
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'lb-search') renderLobbyCountries(e.target.value);
});
