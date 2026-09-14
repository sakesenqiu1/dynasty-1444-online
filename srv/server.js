'use strict';
/* =====================================================================
   王朝纪元 · 1444 — 联机服务端
   · 静态资源 + WebSocket（同一端口）
   · 每个房间一个独立的世界实例（服务端权威模拟）
   · 客户端只发送指令，服务端推进时间并下发增量
   ===================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { PerformanceObserver, monitorEventLoopDelay } = require('perf_hooks');

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = (process.env.BASE || '/gs').replace(/\/$/, '');
const WEB_DIR = path.join(__dirname, '..', 'web');
const SPEEDS = [2, 5, 10, 20, 40];          // 天/秒（与客户端的 1~5 档一致）
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 12);   // 每局约 45MB 常驻内存
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 1200); // 超过则拒绝开新局，避免 OOM
const MAX_PLAYERS = 8;
const BROADCAST_MS = 65;                     // 增量下发间隔（世界每秒更新约 15 次）
const TICK_MS = 50;
const ROOM_IDLE_MS = 5 * 60 * 1000;          // 无人在线的房间保留时长（够断线重连）

/* ---------- 世界数据（所有房间共享同一份只读拓扑） ---------- */
const WORLD_DATA = require(path.join(WEB_DIR, 'world-data.js'));
globalThis.WORLD_DATA = WORLD_DATA;

/* 每个房间需要一份独立的模拟状态：清掉 require 缓存即可拿到全新实例 */
const CORE_PATH = require.resolve(path.join(WEB_DIR, 'game-core.js'));
function newCore() {
  delete require.cache[CORE_PATH];
  return require(CORE_PATH);
}

/* =====================================================================
   运行时观测：GC 停顿 + 事件循环延迟
   服务端一旦"卡一下"，这两个指标会直接告诉我们是垃圾回收、还是别的原因。
   ===================================================================== */
const gc = { count: 0, totalMs: 0, maxMs: 0, recentMs: 0, recentAt: 0, kinds: {} };
try {
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.count++;
      gc.totalMs += e.duration;
      if (e.duration > gc.maxMs) gc.maxMs = e.duration;
      const now = Date.now();
      if (now - gc.recentAt > 10000) { gc.recentAt = now; gc.recentMs = 0; }
      gc.recentMs += e.duration;
      const k = e.detail && e.detail.kind !== undefined ? e.detail.kind : '?';
      gc.kinds[k] = (gc.kinds[k] || 0) + 1;
    }
  });
  obs.observe({ entryTypes: ['gc'] });
} catch (e) { console.warn('GC 观测不可用:', e.message); }

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

/* =====================================================================
   房间
   ===================================================================== */
class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();     // key -> {key,name,country,ws,alive}
    this.nextKey = 1;
    this.hostKey = 0;
    this.started = false;
    this.paused = true;
    this.speed = 2;
    this.acc = 0;
    this.emptySince = Date.now();
    this.core = null;
    this.baseline = null;         // 上次广播的状态基线
    this.pendingLogs = [];
    this.forceFullArmy = false;
    this.chat = [];
    this.finished = false;
    this.immBroadcast = false;   // 玩家下指令后立刻推一帧，点击手感不用等下一个周期
    this.forceArmy = null;       // 这些军队下一帧必须重发（配合客户端的乐观显示）；用到才建
    this.sentOffers = {};        // 我（各人类玩家）已递交、等待对方回应的和约提案
  }

  /* -------- 玩家管理 -------- */
  addPlayer(name, ws, rejoin) {
    const clean = String(name || '').slice(0, 12).replace(/[\u0000-\u001f<>]/g, '').trim() || '无名君主';
    if (rejoin) {
      for (const p of this.players.values()) {
        if (p.name === clean && (!p.ws || p.ws.readyState > 1)) {
          p.ws = ws; p.alive = true;
          return p;
        }
      }
    }
    if (this.players.size >= MAX_PLAYERS) throw new Error('房间已满（最多 ' + MAX_PLAYERS + ' 人）');
    if (this.started) throw new Error('这局已经开始，无法中途加入');
    const key = this.nextKey++;
    const p = { key, name: clean, country: 0, ws, alive: true };
    this.players.set(key, p);
    if (!this.hostKey) this.hostKey = key;
    return p;
  }
  removePlayer(key) {
    const p = this.players.get(key);
    if (!p) return;
    this.players.delete(key);
    if (this.hostKey === key) {
      const rest = [...this.players.keys()];
      this.hostKey = rest.length ? rest[0] : 0;
    }
    if (this.players.size === 0) this.emptySince = Date.now();
  }
  forEachSocket(fn) {
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) fn(p.ws, p);
  }
  sendTo(key, obj) {
    const p = this.players.get(key);
    if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }
  broadcast(obj, exceptKey) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (exceptKey && p.key === exceptKey) continue;
      if (p.ws && p.ws.readyState === 1) { try { p.ws.send(s); } catch (e) {} }
    }
  }

  /* -------- 大厅 -------- */
  lobbyPayload(you) {
    return {
      t: 'lobby', room: this.code, you, hostKey: this.hostKey,
      host: you === this.hostKey, started: this.started,
      players: [...this.players.values()].map(p => ({ k: p.key, name: p.name, country: p.country })),
    };
  }
  broadcastLobby() { this.forEachSocket((ws, p) => { try { ws.send(JSON.stringify(this.lobbyPayload(p.key))); } catch (e) {} }); }

  /* -------- 开局 -------- */
  start(byKey) {
    if (this.started) throw new Error('已经开始了');
    if (byKey !== this.hostKey) throw new Error('只有房主可以开始游戏');
    const picked = [...this.players.values()].filter(p => p.country);
    if (!picked.length) throw new Error('至少要有一名玩家选择国家');
    const rssMb = process.memoryUsage().rss / 1048576;
    if (rssMb > MAX_RSS_MB) throw new Error('服务器当前繁忙（内存吃紧），请稍后再开新局');

    this.core = newCore();
    const core = this.core;
    core.resetWorld();
    core.buildWorld();
    core.UI.log = (text, cls, forCid) => {
      this.pendingLogs.push({ t: text, cls: cls || '', d: core.fmtDate(), f: forCid | 0 });
      if (this.pendingLogs.length > 400) this.pendingLogs.shift();
    };
    core.UI.defeat = (cid) => {
      for (const p of this.players.values()) if (p.country === cid) this.sendTo(p.key, { t: 'defeat', country: cid });
    };
    core.setHumans(picked.map(p => p.country));
    core.paused = true;
    this.paused = true;
    this.speed = 2;
    this.acc = 0;
    this.baseline = null;
    this.forceFullArmy = true;
    this.pendingLogs = [];
    this.started = true;

    for (const p of picked) {
      this.sendTo(p.key, {
        t: 'begin', you: p.country, humans: picked.map(x => x.country),
        paused: this.paused, speed: this.speed,
        snapshot: core.makeSaveData(),
        offers: this.offersPayload(),
      });
    }
    this.broadcastLobby();
    console.log(`[room ${this.code}] started: ${picked.map(p => `${p.name}=${this.core.countries()[p.country].name}`).join(', ')}`);
  }

  /* ---------- PvP 和约提案 ----------
     对人类对手不能"谁先提谁说了算"：提出只是递交条件，
     必须对方在自己的战争页点「接受条件」才真正结束战争。 */
  proposePeace(from, to, war, transfers, releases, extra) {
    const st = this.core.getState();
    if (this.sentOffers[from]) throw new Error('你已有一份和约提案在等待对方回应');
    if (st.pendingOffers[to]) throw new Error('对方手上已有一份待决的提案，请稍后再试');
    const expire = st.dayCount + 180;   // 半年内有效
    const offer = {
      war, enemy: from,
      transfers: transfers || [], releases: releases || [],
      expire, human: true,
      indep: !!(extra && extra.indep),
      vassalize: !!(extra && extra.vassalize),
    };
    st.pendingOffers[to] = offer;
    this.sentOffers[from] = {
      to, transfers: offer.transfers, releases: offer.releases, expire,
      indep: offer.indep, vassalize: offer.vassalize,
    };
    const C = this.core.countries();
    this.core.pushLog(`📜 ${C[from].name} 向 ${C[to].name} 递交和约条件，等待回应`, 'gold', 0);
  }

  offersPayload() {
    if (!this.core) return {};
    const out = {};
    const st = this.core.getState();
    for (const k in st.pendingOffers) {
      const o = st.pendingOffers[k];
      out[k] = {
        enemy: o.enemy,
        transfers: o.transfers || (o.demands || []).map(pid => ({ pid, to: o.enemy })),
        releases: o.releases || [], expire: o.expire,
        indep: !!o.indep, vassalize: !!o.vassalize, human: !!o.human,
      };
    }
    return out;
  }

  /* -------- 指令 -------- */
  command(p, m) {
    if (!this.started || !this.core) throw new Error('对局尚未开始');
    const core = this.core;
    const me = p.country;
    if (!me || !core.countries()[me] || !core.countries()[me].alive) throw new Error('你已经没有可指挥的国家了');
    const st = core.getState();

    switch (m.c) {
      case 'pause': this.paused = !!m.paused; break;
      case 'speed': this.speed = Math.max(1, Math.min(5, +m.speed || 2)); this.paused = false; break;

      case 'path': {
        const a = st.armies.find(x => x.id === +m.army);
        if (!a || a.owner !== me) throw new Error('不是你的军队');
        const pid = +m.to;
        const p2 = st.provinces[pid];
        if (!p2 || !p2.pix.length) throw new Error('无效的目标省份');
        if (a.isNavy) {
          const np = core.findNavalPath(a.prov, pid);
          if (!np) throw new Error(p2.coastPix.length ? '无法找到通往该省的海路' : '目标省没有海岸线，无法派遣舰队');
          a.navPath = np; a.navIdx = 0; a.dstProv = pid; a.path = []; a.prog = 0;
        } else {
          const pathArr = core.findPath(a.prov, pid);
          if (!pathArr) throw new Error('无法找到通往该省的陆路');
          a.path = pathArr; a.prog = 0;
        }
        if (!this.forceArmy) this.forceArmy = new Set();
        this.forceArmy.add(a.id);   // 无论路径是否变化，都要回一帧确认
        break;
      }
      case 'cancel': {
        const a = st.armies.find(x => x.id === +m.army);
        if (!a || a.owner !== me) throw new Error('不是你的军队');
        if (a.isNavy) { a.navPath = null; a.navIdx = 0; a.dstProv = 0; }
        else { a.path = []; a.prog = 0; }
        if (!this.forceArmy) this.forceArmy = new Set();
        this.forceArmy.add(a.id);
        break;
      }
      case 'disband': {
        const id = +m.army;
        const a = st.armies.find(x => x.id === id);
        if (!a || a.owner !== me) throw new Error('不是你的军队');
        st.armies.splice(st.armies.indexOf(a), 1);
        break;
      }
      case 'develop': {
        const prov = st.provinces[+m.prov];
        const c = st.countries[me];
        if (!prov || prov.owner !== me) throw new Error('只能发展本国省份');
        const cost = 40 + (prov.tax + prov.prod + prov.man) * 8;
        if (c.gold < cost) throw new Error('国库不足');
        c.gold -= cost;
        const r = Math.floor(Math.random() * 3); // 服务端随机：玩家无法预测
        if (r === 0) prov.tax++; else if (r === 1) prov.prod++; else prov.man++;
        core.recomputeCap(c);
        core.pushLog(`${prov.name} 得到发展（发展度 ${prov.tax + prov.prod + prov.man}）`, 'gold', me);
        break;
      }
      case 'recruit': {
        const prov = st.provinces[+m.prov];
        const c = st.countries[me];
        if (!prov || prov.controller !== me) throw new Error('该省不在你的控制下');
        if (c.gold < 25 || c.mp < 5000) throw new Error('需要 25 金与 5000 人力');
        c.gold -= 25; c.mp -= 5000;
        core.addRecruit(me, prov.id, 5000, false);
        core.pushLog(`${prov.name} 开始征兵，约 ${Math.round(core.RECRUIT_DAYS / 30)} 个月后成军`, 'gold', me);
        break;
      }
      case 'navy': {
        const prov = st.provinces[+m.prov];
        const c = st.countries[me];
        if (!prov || !prov.coastPix || !prov.coastPix.length) throw new Error('该省没有海岸');
        if (prov.controller !== me) throw new Error('该省不在你的控制下');
        if (c.gold < 35 || c.mp < 4000) throw new Error('需要 35 金与 4000 人力');
        c.gold -= 35; c.mp -= 4000;
        core.addRecruit(me, prov.id, 4000, true);
        core.pushLog(`${prov.name} 开始组建舰队，约 ${Math.round(core.NAVY_DAYS / 30)} 个月后下水`, 'gold', me);
        break;
      }
      case 'war': {
        const t = +m.target;
        if (core.overlordOf(t)) throw new Error('附庸国不可直接宣战，请向宗主宣战');
        if (core.atWar(me, t) || core.truceBetween(me, t)) throw new Error('已处于战争或停战状态');
        core.declareWar(me, t);
        break;
      }
      case 'ally': {
        const t = +m.target;
        if (core.overlordOf(me) || core.overlordOf(t)) throw new Error('附庸不得另行缔结盟约');
        if (core.isAllied(me, t)) throw new Error('双方已是盟友');
        if (core.atWar(me, t) || core.truceBetween(me, t)) throw new Error('无法缔盟');
        if (core.inWar(me) || core.inWar(t)) throw new Error('缔约双方均须无战事在身');
        // 由服务端裁决对方是否接受
        let acc = 0.3;
        if (core.countriesAdjacent(me, t)) acc += 0.3;
        const myS = core.countryStrength(me) + core.totalDev(st.countries[me]) * 8;
        const tS = core.countryStrength(t) + core.totalDev(st.countries[t]) * 8;
        const r = myS / (tS + 1);
        if (r > 2.2) acc -= 0.35; else if (r > 1.4) acc -= 0.1; else if (r < 0.55) acc -= 0.15;
        if ((st.countries[t].allies || []).length) acc -= 0.15;
        if (Math.random() < acc) core.formAlliance(me, t);
        else core.pushLog(`${st.countries[t].name} 婉拒了结盟提议`, 'war', me);
        break;
      }
      case 'unally': core.breakAlliance(me, +m.target, '我朝主动解除'); break;

      case 'vassalize': {
        const t = +m.target;
        const tc = st.countries[t];
        if (!tc || !tc.alive || core.overlordOf(me) || core.overlordOf(t)) throw new Error('无法册封');
        if (tc.provList.length > 3) throw new Error('该国太大，无法和平册封');
        if (core.atWar(me, t) || core.inWar(t) || core.inWar(me)) throw new Error('双方均须无战事在身');
        if (!core.vassalReachable(me, t)) throw new Error('两国既不接壤亦非近海');
        const cost = Math.round(60 + core.totalDev(tc) * 2);
        if (st.countries[me].gold < cost) throw new Error('国库不足');
        st.countries[me].gold -= cost;
        tc.overlord = me;
        tc.subject = core.SUBJ_VASSAL;      // 花钱册封 = 普通附庸国
        core.clearAllAlliances(t);
        st.truces[core.truceKey(me, t)] = st.dayCount + 3650;
        core.pushLog(`👑 ${tc.name} 接受册封，岁贡三成，为我藩篱`, 'gold', me);
        core.rebuildLabels();
        break;
      }
      case 'annex': {
        const t = +m.target;
        const tc = st.countries[t];
        if (!tc || core.overlordOf(t) !== me) throw new Error('对方不是你的附庸');
        // 原版规则：附庸处于交战状态（含随宗主参战）时不可吞并
        if (core.inWar(t)) throw new Error('附庸处于交战状态，须先结束所有战事才能吞并');
        const cost = Math.round(core.totalDev(tc) * 4);
        if (st.countries[me].gold < cost) throw new Error('国库不足');
        st.countries[me].gold -= cost;
        // 被吞并国的附庸转奉我为宗主（沿用其原有国体：傀儡仍是傀儡）
        const inherited = st.countries.filter(vc => vc && vc.alive && vc.overlord === t);
        for (const vc of inherited) vc.overlord = me;
        for (const pid of [...tc.provList]) core.transferProvince(pid, me);
        tc.overlord = 0;
        tc.subject = 0;
        core.pushLog(`👑 ${tc.name} 王祚断绝，疆土尽入我朝`, 'gold', me);
        for (const vc of inherited) core.pushLog(`👑 ${vc.name} 转奉我朝为主，为我藩属`, 'gold', me);
        break;
      }
      case 'release': {
        const t = +m.target;
        const tc = st.countries[t];
        if (!tc || core.overlordOf(t) !== me) throw new Error('对方不是你的附庸');
        tc.overlord = 0;
        tc.subject = 0;
        st.truces[core.truceKey(me, t)] = st.dayCount + 1825;
        core.pushLog(`${tc.name} 重获独立，与我朝约定五年之好`, '', me);
        break;
      }
      case 'give': {
        const prov = st.provinces[+m.prov], vid = +m.to;
        if (!prov || prov.owner !== me || prov.controller !== me) throw new Error('该省不在你的实际控制下');
        if (core.overlordOf(vid) !== me) throw new Error('对方不是你的附庸');
        if (st.countries[me].provList.length <= 1) throw new Error('仅剩一省，不可拱手让人');
        core.transferProvince(prov.id, vid);
        core.pushLog(`👑 ${prov.name} 赐予 ${st.countries[vid].name}，以为藩屏`, 'gold', me);
        break;
      }
      case 'found': {
        const name = String(m.name || '').trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, 12);
        if (!name) throw new Error('请给新的附庸国起个名字');
        if (core.overlordOf(me)) throw new Error('附庸之身不可另立藩属');
        const pv = st.provinces[+m.prov];
        if (!pv || !pv.pix.length) throw new Error('无效的省份');
        if (pv.owner !== me || pv.controller !== me) throw new Error('只能在自己实际控制的领土上建国');
        if (st.countries[me].provList.length <= 1) throw new Error('仅剩一省，不可再分封');
        if (st.countries.length >= 240) throw new Error('世界上的国家已经太多了');
        const nid = core.foundVassal(me, pv.id, name);
        if (!nid) throw new Error('建立附庸国失败');
        core.pushLog(`👳 ${name} 于 ${pv.name} 立国，奉 ${st.countries[me].name} 为宗主`, 'gold', 0);
        break;
      }
      case 'rename': {
        const c = st.countries[me];
        if (!c || !c.alive) throw new Error('我国已亡');
        const name = core.sanitizeCountryName(m.name);
        if (!name) throw new Error('国号不能为空');
        if (name === c.name) throw new Error('新国号与旧国号相同');
        if (c.gold < core.RENAME_COST) throw new Error(`国库不足，改易国号需 ${core.RENAME_COST} 金（现有 ${Math.round(c.gold)}）`);
        c.gold -= core.RENAME_COST;
        const oldName = c.name;
        core.setCountryName(me, name);
        core.pushLog(`✏ ${oldName} 改国号为「${name}」`, 'gold', 0);
        break;
      }
      /* 属国改色：免费纯外观，但要宗主身份 + 颜色参数合法 */
      case 'recolor': {
        const t = +m.target;
        const tc = st.countries[t];
        if (!tc || !tc.alive) throw new Error('该国已不存在');
        if (core.overlordOf(t) !== me) throw new Error('只能修改我国属国的颜色');
        if (!Array.isArray(m.rgb) || m.rgb.length < 3) throw new Error('颜色参数不合法');
        if (!core.setCountryColor(t, m.rgb)) throw new Error('颜色参数不合法');
        core.pushLog(`🎨 ${tc.name} 的旗色由 ${st.countries[me].name} 改易`, '', me);
        break;
      }

      case 'revive': {
        const t = +m.target;
        const tc = st.countries[t];
        if (!tc || tc.alive) throw new Error('该国尚存');
        if (core.overlordOf(me)) throw new Error('附庸之身不可另立藩属');
        if (core.inWar(me)) throw new Error('战事期间不宜复国');
        const provs = [];
        for (let i = 1; i < st.provinces.length; i++) {
          const pv = st.provinces[i];
          if (pv.pix.length && pv.owner === me && pv.controller === me && pv.former && pv.former.includes(t)) provs.push(i);
        }
        if (!provs.length) throw new Error('没有可复国的故土');
        const chosen = provs.filter(i => st.provinces[i].former[st.provinces[i].former.length - 1] === t);
        const use = chosen.length ? chosen : provs;
        for (const pid of use) core.transferProvince(pid, t);
        tc.alive = true;
        tc.overlord = me;
        tc.subject = core.SUBJ_VASSAL;      // 于故土复国 = 普通附庸国
        st.truces[core.truceKey(me, t)] = st.dayCount + 1825;
        core.pushLog(`👑 ${tc.name} 依我朝扶持，于故土复国，奉我为宗主（${use.length}省）`, 'gold', me);
        break;
      }

      case 'peace': {
        const enemy = +m.enemy;
        const w = st.wars.find(x => (x.a === me && x.d === enemy) || (x.d === me && x.a === enemy));
        if (!w) throw new Error('与该国并无战事');
        const demands = (m.demands || []).map(Number).filter(x => x > 0);
        const releases = (m.releases || []).map(Number).filter(x => x > 0).filter(cid => core.overlordOf(cid) === enemy);
        if (!demands.length && !releases.length) throw new Error('未选择任何条件');
        const s = core.warScore(w);
        const mine = w.a === me ? s.a : s.d;
        let cost = 0;
        for (const pid of demands) cost += core.peaceCost(st.provinces[pid]);
        for (const cid of releases) cost += core.releaseCost(st.countries[cid]);
        const takenSet = new Set(demands);
        for (const pid of demands) if (!core.canDemandProvince(pid, me, enemy, takenSet)) throw new Error(`${st.provinces[pid].name} 不与我国接壤亦非海岸，无法割取`);
        if (!(cost <= mine * 0.95 + 0.01)) throw new Error('战争分数不足，对方拒绝');
        if (core.isHuman(enemy)) {
          // 对人类对手：只是递交条件，等对方接受
          this.proposePeace(me, enemy, w, demands.map(pid => ({ pid, to: me })), releases);
        } else {
          core.makePeace(w, demands.map(pid => ({ pid, to: me })), true, releases);
        }
        break;
      }
      case 'white': {
        const enemy = +m.enemy;
        const w = st.wars.find(x => (x.a === me && x.d === enemy) || (x.d === me && x.a === enemy));
        if (!w) throw new Error('与该国并无战事');
        if (core.isHuman(enemy)) {
          // 白色和平同样要对方点头
          this.proposePeace(me, enemy, w, [], []);
          break;
        }
        const s = core.warScore(w);
        const theirs = w.a === me ? s.d : s.a;
        const months = (st.dayCount - w.startDay) / 30;
        if (!(theirs < 70 || months > 60)) throw new Error('敌方拒绝白色和平');
        core.makePeace(w, [], true);
        break;
      }
      case 'ask': {
        const enemy = +m.enemy;
        const w = st.wars.find(x => (x.a === me && x.d === enemy) || (x.d === me && x.a === enemy));
        if (!w) throw new Error('与该国并无战事');
        const s = core.warScore(w);
        const theirs = w.a === me ? s.d : s.a;
        if (theirs > 85) throw new Error('敌方胃口太大，谈判破裂');
        const transfers = []; let cost = 0; const taken = new Set();
        const cands = [];
        for (let i = 1; i < st.provinces.length; i++) {
          const pv = st.provinces[i];
          if (pv.pix.length && (pv.owner === me || core.overlordOf(pv.owner) === me) && pv.controller === enemy) cands.push(i);
        }
        let added = true;
        while (added) {
          added = false;
          for (const pid of cands) {
            if (taken.has(pid)) continue;
            if (cost + core.peaceCost(st.provinces[pid]) > theirs * 0.85) continue;
            if (core.canDemandProvince(pid, enemy, me, taken)) {
              transfers.push({ pid, to: enemy }); taken.add(pid); cost += core.peaceCost(st.provinces[pid]); added = true;
            }
          }
        }
        if (core.isHuman(enemy)) {
          // 屈膝求和：把割让条件递过去，由对方定夺
          this.proposePeace(me, enemy, w, transfers, []);
          break;
        }
        core.pushLog(`屈辱的和约：割让 ${transfers.length} 个省份`, 'war', me);
        core.makePeace(w, transfers, true);
        break;
      }
      case 'offer': {
        const o = st.pendingOffers[me];
        if (!o) throw new Error('没有待决的提案');
        const w = o.war;
        const proposer = o.enemy;
        if (!m.accept) {
          delete st.pendingOffers[me];
          // 被拒绝后提案方要能重新提条件，否则得干等到提案过期
          for (const k in this.sentOffers) if (this.sentOffers[k].to === me) delete this.sentOffers[k];
          if (core.isHuman(proposer)) core.pushLog('对方拒绝了你的和约提案', 'war', proposer);
          core.pushLog(o.human ? '我方拒绝了对面的和约条件' : '我们拒绝了敌方的条件', '', me);
          break;
        }
        const transfers = o.transfers || (o.demands || []).map(pid => ({ pid, to: proposer }));
        delete st.pendingOffers[me];
        if (o.vassalize) {
          // 接受附庸化：由对方吞我为附庸
          core.vassalize(proposer, me);
          break;
        }
        if (o.indep) { st.countries[proposer].overlord = 0; st.countries[proposer].subject = 0; }
        const rels = (o.releases || []).filter(cid => core.overlordOf(cid) === me);
        core.makePeace(w, transfers, true, rels);
        break;
      }
      case 'pvassal': {
        const enemy = +m.enemy;
        const w = st.wars.find(x => x && ((x.a === me && x.d === enemy) || (x.d === me && x.a === enemy)));
        if (!w) throw new Error('与该国并无战事');
        const s = core.warScore(w);
        const mine = w.a === me ? s.a : s.d;
        if (mine < 60) throw new Error('战争分数不足60');
        if (core.occRatio(me, enemy) < 0.5) throw new Error('占领比例不足50%');
        if (core.overlordOf(enemy)) throw new Error('该国已是他人附庸');
        if (!core.vassalReachable(me, enemy)) throw new Error('两国既不接壤亦非近海');
        if (core.isHuman(enemy)) {
          // 附庸化等于亡国，必须对方自己同意
          this.proposePeace(me, enemy, w, [], [], { vassalize: true });
          break;
        }
        core.vassalize(me, enemy);
        break;
      }
      case 'pindep': {
        const enemy = +m.enemy;
        const w = st.wars.find(x => x && ((x.a === me && x.d === enemy) || (x.d === me && x.a === enemy)));
        if (!w) throw new Error('与该国并无战事');
        if (core.overlordOf(me) !== enemy) throw new Error('对方并非我国宗主');
        const s = core.warScore(w);
        const mine = w.a === me ? s.a : s.d;
        if (mine < 30) throw new Error('战争分数不足30');
        if (core.isHuman(enemy)) {
          // 要求宗主承认独立：同样要对方接受
          this.proposePeace(me, enemy, w, [], [], { indep: true });
          break;
        }
        st.countries[me].overlord = 0;
        st.countries[me].subject = 0;
        core.pushLog(`🎌 ${st.countries[me].name} 赢得独立战争，脱离 ${st.countries[enemy].name} 自立！`, 'gold', me);
        core.makePeace(w, [], true);
        break;
      }
      default: throw new Error('未知指令：' + m.c);
    }
  }

  /* -------- 时间推进 -------- */
  tick(dtMs) {
    if (!this.started || this.paused || !this.core) return;
    const live = [...this.players.values()].some(p => p.country && this.core.countries()[p.country] && this.core.countries()[p.country].alive);
    if (!live) { this.paused = true; return; }
    /* 掉帧后不要试图把落下的天数一次性补完：
       那会让这一帧更慢，下一帧 dt 更大、要补的更多，直接形成"越卡越补、越补越卡"的恶性循环。
       这里最多补两个 tick 的量，多出来的直接丢掉 —— 游戏内时间略微变慢，肉眼无感。 */
    const dt = Math.min(dtMs, TICK_MS * 2);
    this.acc += (dt / 1000) * SPEEDS[this.speed - 1];
    let steps = Math.floor(this.acc);
    this.acc -= steps;
    const maxSteps = Math.ceil(SPEEDS[this.speed - 1] * (TICK_MS * 2) / 1000) + 1;
    if (steps > maxSteps) steps = maxSteps;
    for (let i = 0; i < steps; i++) this.core.tickDay();
  }

  /* -------- 增量下发 -------- */
  /* 基线记录"上一次广播出去的值"，只发改动过的字段；值都是绝对值，重复应用无副作用 */
  buildDelta(forceFull) {
    const st = this.core.getState();
    /* 基线容器只在第一帧创建，之后原地更新。
       这里刻意避免"每次广播重建 2000 个省状态数组 + 139 国 + 130 军队对象"——
       在 8 次/秒 × 多房间下那是每秒几万个垃圾对象，
       GC 停顿会直接表现为玩家感觉到的"卡一下"，内存也会一路涨。 */
    const base = this.baseline || (this.baseline = {
      prov: new Map(), dev: new Map(), ct: new Map(), army: new Map(), warsSig: null, truceSig: null,
      countryMeta: null,
    });
    const prov = base.prov, dev = base.dev, ct = base.ct, army = base.army;
    const forced = this.forceArmy;
    this.forceArmy = null;
    const pr = [], devOut = [], ctOut = [], ar = [], ax = [];

    for (let i = 1; i < st.provinces.length; i++) {
      const p = st.provinces[i];
      if (!p.pix.length) continue;
      // 归属+控制者+围城进度打包成一个整数：8 位所有者 | 8 位控制者 | 8 位围城
      const siege = p.siege > 255 ? 255 : (p.siege | 0);
      const packed = (p.owner << 16) | (p.controller << 8) | siege;
      if (prov.get(i) !== packed) {
        prov.set(i, packed);
        pr.push([i, p.owner, p.controller, Math.round(p.siege * 10) / 10]);
      }
      const dk = p.tax + p.prod * 1000 + p.man * 1e6;
      if (dev.get(i) !== dk) { dev.set(i, dk); devOut.push([i, p.tax, p.prod, p.man]); }
    }

    for (let i = 1; i < st.countries.length; i++) {
      const c = st.countries[i];
      if (!c) continue;
      const g = Math.round(c.gold * 10) / 10, mp = Math.round(c.mp), al = c.alive ? 1 : 0,
            ov = c.overlord || 0, sj = c.subject || 0;
      let row = ct.get(i);
      if (row === undefined) { row = [0, 0, 0, 0, 0]; ct.set(i, row); }   // 只在第一帧分配
      if (row[0] !== g || row[1] !== mp || row[2] !== al || row[3] !== ov || row[4] !== sj) {
        row[0] = g; row[1] = mp; row[2] = al; row[3] = ov; row[4] = sj;
        ctOut.push([i, g, mp, al, ov, sj]);
      }
    }

    const gen = (this._armyGen = (this._armyGen || 0) + 1);
    for (const a of st.armies) {
      const pathSig = a.path && a.path.length ? a.path.join(',') : '';
      const navRef = a.navPath || null;
      const str = Math.round(a.str), prog = Math.round(a.prog * 10) / 10;
      const isNavy = a.isNavy ? 1 : 0, navIdx = a.navIdx || 0, attrit = Math.round(a.attrit || 0);
      const dst = a.path && a.path.length ? a.path[a.path.length - 1] : 0;
      let o = army.get(a.id);
      const isNew = o === undefined;
      if (isNew) {
        o = { owner: 0, prov: 0, str: 0, prog: 0, isNavy: 0, navIdx: 0, attrit: 0, pathSig: '', navRef: null, dst: -1, gen: 0 };
        army.set(a.id, o);
      }
      const forcedThis = !!(forced && forced.has(a.id));
      const changed = forceFull || forcedThis || isNew || o.owner !== a.owner || o.prov !== a.prov ||
        o.str !== str || o.prog !== prog || o.isNavy !== isNavy ||
        o.navIdx !== navIdx || o.attrit !== attrit ||
        o.pathSig !== pathSig || o.navRef !== navRef || o.dst !== dst;
      if (changed) {
        /* 绝大多数帧里军队只是"位置/兵力/行军进度"变了，路径等字段没动。
           这种情况只发 5 个字段（客户端按行长度区分），能省掉一多半字节。 */
        const shortOk = !isNew && !forcedThis && !forceFull &&
          o.isNavy === isNavy && o.navIdx === navIdx && o.attrit === attrit &&
          o.pathSig === pathSig && o.navRef === navRef && o.dst === dst;
        if (shortOk) {
          ar.push([a.id, a.owner, a.prov, str, prog]);
        } else {
          const pathOut = (forceFull || isNew || o.pathSig !== pathSig || forcedThis) ? (a.path || []).slice() : null;
          const navOut = (forceFull || isNew || o.navRef !== navRef || forcedThis) ? (a.navPath || null) : null;
          ar.push([a.id, a.owner, a.prov, str, prog, isNavy, navIdx, attrit, pathOut, navOut, dst]);
        }
      }
      o.owner = a.owner; o.prov = a.prov; o.str = str; o.prog = prog;
      o.isNavy = isNavy; o.navIdx = navIdx; o.attrit = attrit;
      o.pathSig = pathSig; o.navRef = navRef; o.dst = dst; o.gen = gen;
    }
    const stale = [];
    army.forEach((o, id) => { if (o.gen !== gen) stale.push(id); });
    for (let i = 0; i < stale.length; i++) { army.delete(stale[i]); ax.push(stale[i]); }

    // 签名用字符串拼接，避免 st.wars.map(...) 每次都造一批嵌套数组
    // 结构签名不含伤亡：伤亡每天都在变，放进签名会导致整份战争列表被反复重发
    let warsSig = '';
    for (let i = 0; i < st.wars.length; i++) {
      const w = st.wars[i];
      warsSig += w.a + ',' + w.d + ',' + w.aB + ',' + w.dB + ',' +
        (w.joinOf === undefined ? -1 : w.joinOf) + ';';
    }
    // 伤亡单独走一个小数组，只发改动过的
    let casOut = null;
    const curCas = [];
    for (let i = 0; i < st.wars.length; i++) {
      const w = st.wars[i];
      const ca = Math.round(w.casA || 0), cd = Math.round(w.casD || 0);
      curCas.push([ca, cd]);
      const old = base.cas ? base.cas[i] : null;
      if (!old || old[0] !== ca || old[1] !== cd) (casOut || (casOut = [])).push([i, ca, cd]);
    }
    base.cas = curCas;
    let truceSig = '';
    for (const k in st.truces) truceSig += k + '=' + st.truces[k] + ';';

    /* 征兵队列：只发"新增/移除"的差量，且只带"起始日 + 总天数"，
       剩余天数由客户端用当前日期自己算。在征几十条时这一项原本占了增量的一半以上。 */
    const curRec = new Set();
    let rcAdd = null, rcDel = null;
    for (let i = 0; i < st.recruits.length; i++) {
      const r = st.recruits[i];
      curRec.add(r.id);
      if (!base.recIds || !base.recIds.has(r.id)) {
        (rcAdd || (rcAdd = [])).push([r.id, r.owner, r.prov, r.str, r.isNavy ? 1 : 0, r.start, r.total]);
      }
    }
    if (base.recIds) for (const id of base.recIds) if (!curRec.has(id)) (rcDel || (rcDel = [])).push(id);
    base.recIds = curRec;

    const delta = {
      day: st.dayCount, cy: st.cal.y, cm: st.cal.m, cd: st.cal.d,
      pa: this.paused, sp: this.speed,
      of: this.offersPayload(),
    };
    if (pr.length) delta.pr = pr;
    if (devOut.length) delta.dev = devOut;
    if (ctOut.length) delta.ct = ctOut;
    if (ar.length || ax.length) { delta.aw = 1; if (ar.length) delta.ar = ar; if (ax.length) delta.ax = ax; }
    // 已递交、等待回应的和约提案：过期或战争结束就撤掉
    for (const k in this.sentOffers) {
      const o = this.sentOffers[k];
      const stillFighting = st.wars.some(x => (x.a === +k && x.d === o.to) || (x.d === +k && x.a === o.to));
      if (o.expire < st.dayCount || !stillFighting) delete this.sentOffers[k];
    }
    const so = {};
    for (const k in this.sentOffers) {
      const o = this.sentOffers[k];
      so[k] = { to: o.to, transfers: o.transfers, releases: o.releases, expire: o.expire,
                indep: o.indep, vassalize: o.vassalize };
    }
    delta.so = so;

    if (rcAdd) delta.rcAdd = rcAdd;
    if (rcDel) delta.rcDel = rcDel;
    /* 新出现的国家（玩家自建的附庸）：把描述发下去，让客户端在本地也建出来。
       客户端的世界是本地按种子生成的，不认识编号更大的国家。 */
    if (base.countryCount === undefined) base.countryCount = st.countries.length;
    if (st.countries.length > base.countryCount) {
      const cn = [];
      for (let i = base.countryCount; i < st.countries.length; i++) {
        const c = st.countries[i];
        if (c) cn.push([i, c.name, c.color, c.capital]);
      }
      if (cn.length) delta.cn = cn;
      base.countryCount = st.countries.length;
    }
    /* 国名 / 旗色的改动（改国号、改属国颜色）：只在变动的那一帧发一次。
       第一帧只建基线不发——玩家加入时本来就会收到整份世界快照。 */
    if (!base.countryMeta) {
      base.countryMeta = new Map();
      for (let i = 1; i < st.countries.length; i++) {
        const c = st.countries[i];
        if (c) base.countryMeta.set(i, c.name + '\u0001' + (c.color ? c.color.join(',') : ''));
      }
    } else {
      let cpOut = null;
      for (let i = 1; i < st.countries.length; i++) {
        const c = st.countries[i];
        if (!c) continue;
        const sig = c.name + '\u0001' + (c.color ? c.color.join(',') : '');
        if (base.countryMeta.get(i) === sig) continue;
        base.countryMeta.set(i, sig);
        (cpOut || (cpOut = [])).push([i, c.name, c.color ? c.color.slice() : null]);
      }
      if (cpOut) delta.cp = cpOut;
    }
    if (this.pendingLogs.length) delta.lg = this.pendingLogs.splice(0);
    if (casOut) delta.cas = casOut;
    if (base.warsSig === null || warsSig !== base.warsSig || truceSig !== base.truceSig) {
      delta.wr = st.wars.map(w => ({ ...w }));
      delta.tr = { ...st.truces };
      base.warsSig = warsSig;
      base.truceSig = truceSig;
      base.cas = null;      // 战争结构变了，伤亡下标要整份重发一次
    }
    return delta;
  }

  broadcastDelta(forceFull) {
    if (!this.started || !this.core) return;
    void 0;
    /* 有人中途加入（或断线重连）时，必须整份重发一次军队数据 ——
       否则那个客户端拿不到行军路径、海军航线、远征损耗这些"不常变"的字段。 */
    const wantFull = forceFull || this.forceFullArmy;
    this.forceFullArmy = false;
    let d;
    try { d = this.buildDelta(wantFull); } catch (e) { console.error('[delta]', e); return; }
    // 玩家名册只在真的变了才发（平时每帧都带，纯浪费）
    const players = [...this.players.values()].filter(p => p.country).map(p => ({ k: p.key, name: p.name, country: p.country }));
    const psig = players.map(p => p.k + ':' + p.name + ':' + p.country).join('|');
    const payload = (psig !== this._playersSig) ? Object.assign({ players }, d) : d;
    this._playersSig = psig;
    this.broadcast({ t: 'delta', d: payload });
  }

  destroy() {
    if (this.core) {
      this.core.UI.log = function () {};
      this.core.UI.defeat = function () {};
    }
    this.players.clear();
    this.core = null;
    this.baseline = null;
  }
}

/* =====================================================================
   HTTP 静态服务
   ===================================================================== */
/* 内容签名：文件很小，直接按内容算，改一个字节 ETag 就变 */
function statTag(buf) {
  let h = 2166136261;
  const step = buf.length > 65536 ? 97 : 7;
  for (let i = 0; i < buf.length; i += step) { h ^= buf[i]; h = Math.imul(h, 16777619); }
  h ^= buf.length; h = Math.imul(h, 16777619);
  return (h >>> 0).toString(16);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  // 支持两种入口：
  //   http://${GS_HOST}/gs/...   IP 站点下的子路径
  //   http://mapgame.域名/...        独立域名，直接挂在根路径上
  if (urlPath === BASE) { res.writeHead(301, { Location: BASE + '/' }); return res.end(); }
  let rel;
  if (urlPath.startsWith(BASE + '/')) rel = urlPath.slice(BASE.length + 1);
  else if (urlPath.startsWith('/')) rel = urlPath.slice(1);
  else { res.writeHead(404); return res.end('not found'); }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const full = path.join(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  const ext = path.extname(full).toLowerCase();
  if (!MIME[ext]) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // 用 ETag + no-cache：浏览器每次都发一次校验请求，没改动就 304（几十字节），
    // 改了立刻拿到新文件 —— 避免部署后玩家还在跑旧代码。
    const etag = '"' + data.length.toString(16) + '-' + statTag(data) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  if (p === '/healthz' || p === BASE + '/healthz') {
    const players = [...rooms.values()].reduce((a, r) => a + r.players.size, 0);
    const live = [...rooms.values()].filter(r => r.started).length;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({
      ok: true, rooms: rooms.size, liveRooms: live, players,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      uptimeSec: Math.round(process.uptime()), day: Date.now(),
      tickMs: Math.round(tickStats.last * 100) / 100,
      tickAvgMs: tickStats.samples ? Math.round(tickStats.sum / tickStats.samples * 100) / 100 : 0,
      tickMaxMs: Math.round(tickStats.max * 100) / 100,
      slowTicks: tickStats.slow,
      // GC：count 次数 / totalMs 累计停顿 / maxMs 单次最长 / recentMs 最近 10 秒停顿
      gc: { count: gc.count, totalMs: Math.round(gc.totalMs), maxMs: Math.round(gc.maxMs * 10) / 10, recentMs: Math.round(gc.recentMs) },
      // 事件循环延迟（毫秒）：p99 和 max 直接反映"卡一下"的严重程度
      loop: {
        mean: Math.round(loopDelay.mean / 1e5) / 10,
        p99: Math.round(loopDelay.percentile(99) / 1e5) / 10,
        max: Math.round(loopDelay.max / 1e5) / 10,
      },
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    }) + '\n');
  }
  serveStatic(req, res);
});

/* =====================================================================
   WebSocket
   ===================================================================== */
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
/* 两个入口各自的 WebSocket 路径都要接受 */
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p === BASE + '/ws' || p === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
const rooms = new Map();

function makeCode() {
  for (let i = 0; i < 400; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerKey = 0;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  const fail = (msg, fatal) => { try { ws.send(JSON.stringify({ t: 'error', msg, fatal: !!fatal })); } catch (e) {} };

  ws.on('message', (raw) => {
    /* 简易限流 */
    const now = Date.now();
    if (now - ws.msgWindow > 1000) { ws.msgWindow = now; ws.msgCount = 0; }
    if (++ws.msgCount > 60) return;
    if (raw.length > 8192) return;

    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    try {
      switch (m.t) {
        case 'create': {
          if (ws.roomCode) throw new Error('你已在一个房间中');
          if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
          const code = makeCode();
          if (!code) throw new Error('无法分配房间号');
          const room = new Room(code);
          rooms.set(code, room);
          const p = room.addPlayer(m.name, ws, false);
          ws.roomCode = code; ws.playerKey = p.key;
          ws.send(JSON.stringify(room.lobbyPayload(p.key)));
          console.log(`[room ${code}] created by ${p.name} (rooms=${rooms.size})`);
          break;
        }
        case 'join': {
          const code = String(m.room || '').trim();
          const room = rooms.get(code);
          if (!room) throw new Error('房间 ' + code + ' 不存在（请确认房间号，或让房主重新创建）');
          const p = room.addPlayer(m.name, ws, !!m.rejoin);
          ws.roomCode = code; ws.playerKey = p.key;
          ws.send(JSON.stringify(room.lobbyPayload(p.key)));
          if (room.started && p.country) {
            const core = room.core;
            ws.send(JSON.stringify({
              t: 'begin', you: p.country,
              humans: [...core.humans()],
              paused: room.paused, speed: room.speed,
              snapshot: core.makeSaveData(), offers: room.offersPayload(),
            }));
            room.forceFullArmy = true;
          }
          room.broadcastLobby();
          console.log(`[room ${code}] ${p.name} joined (n=${room.players.size})`);
          break;
        }
        case 'leave': {
          const room = rooms.get(ws.roomCode);
          if (room) { room.removePlayer(ws.playerKey); room.broadcastLobby(); }
          ws.roomCode = null; ws.playerKey = 0;
          break;
        }
        case 'pick': {
          const room = rooms.get(ws.roomCode);
          if (!room) throw new Error('尚未加入房间');
          const p = room.players.get(ws.playerKey);
          if (!p) throw new Error('尚未加入房间');
          if (room.started) throw new Error('对局已开始，无法更换国家');
          const cid = +m.country;
          if (!cid) throw new Error('无效的国家');
          for (const q of room.players.values()) if (q.key !== p.key && q.country === cid) throw new Error('该国已被 ' + q.name + ' 选择');
          p.country = cid;
          room.broadcastLobby();
          break;
        }
        case 'start': {
          const room = rooms.get(ws.roomCode);
          if (!room) throw new Error('尚未加入房间');
          room.start(ws.playerKey);
          break;
        }
        case 'cmd': {
          const room = rooms.get(ws.roomCode);
          if (!room) throw new Error('尚未加入房间');
          const p = room.players.get(ws.playerKey);
          if (!p) throw new Error('尚未加入房间');
          room.command(p, m);
          room.immBroadcast = true;
          // 指令可能改动宗主关系/存活状态，阵营缓存必须失效
          if (room.core && room.core.invalidateCamps) room.core.invalidateCamps();
          break;
        }
        case 'chat': {
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          const p = room.players.get(ws.playerKey);
          if (!p) return;
          const text = String(m.text || '').slice(0, 160).replace(/[\u0000-\u001f]/g, ' ').trim();
          if (!text) return;
          room.broadcast({ t: 'chat', from: p.name, text });
          break;
        }
      }
    } catch (e) {
      fail(e.message || String(e));
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = room.players.get(ws.playerKey);
    if (p && p.ws === ws) {
      p.ws = null;                 // 保留座位以便断线重连
      console.log(`[room ${room.code}] ${p.name} disconnected`);
    }
    room.broadcastLobby();
  });
});

/* =====================================================================
   主循环：推进所有房间 + 广播增量
   ===================================================================== */
/* 主循环：推进所有房间。这里顺带统计"这一帧跑了多久"，
   服务端一旦有周期性卡顿（比如月度结算太重），healthz 里的 tickMax 会直接暴露。 */
const tickStats = { last: 0, max: 0, maxAt: 0, slow: 0, samples: 0, sum: 0 };
let lastTick = Date.now();
let lastBroadcast = 0;
setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick; lastTick = now;
  const t0 = process.hrtime.bigint();
  for (const room of rooms.values()) room.tick(dt);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  tickStats.last = ms;
  tickStats.samples++;
  tickStats.sum += ms;
  if (ms > tickStats.max) { tickStats.max = ms; tickStats.maxAt = Date.now(); }
  if (ms > 40) {
    tickStats.slow++;
    if (tickStats.slow <= 20) console.warn(`[slow tick] ${ms.toFixed(1)} ms (帧预算 ${TICK_MS} ms)`);
  }
  // 每 5 分钟把峰值清零，方便观察"最近还卡不卡"
  if (Date.now() - tickStats.maxAt > 300000 && tickStats.max > 0) { tickStats.max = 0; tickStats.slow = 0; tickStats.samples = 0; tickStats.sum = 0; }
  // 事件循环延迟直方图每 5 分钟重置一次，方便看"最近还卡不卡"
  if (Date.now() % 300000 < TICK_MS) loopDelay.reset();
}, TICK_MS);

setInterval(() => {
  const now = Date.now();
  const due = now - lastBroadcast >= BROADCAST_MS;
  if (due) lastBroadcast = now;
  for (const room of rooms.values()) {
    if (!room.started) continue;
    if (!due && !room.immBroadcast) continue;
    room.immBroadcast = false;
    try { room.broadcastDelta(false); } catch (e) { console.error('[broadcast]', e); }
  }
}, 40);

/* 回收空房间 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = [...room.players.values()].some(p => p.ws && p.ws.readyState === 1);
    if (!connected && now - room.emptySince > ROOM_IDLE_MS) {
      room.destroy(); rooms.delete(code);
      console.log(`[room ${code}] recycled (rooms=${rooms.size})`);
    }
  }
}, 60000);

/* 心跳 */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`王朝纪元 · 1444 联机服务已启动：http://${HOST}:${PORT}${BASE}/`);
  console.log(`WebSocket: ws://${HOST}:${PORT}${BASE}/ws`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down…');
    for (const room of rooms.values()) room.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
