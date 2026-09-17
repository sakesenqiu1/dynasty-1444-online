'use strict';
/* =====================================================================
   地图工坊 —— 服务端地图仓库
   ---------------------------------------------------------------------
   · 存储：纯文件系统（服务器没有数据库）
       maps/index.json      索引与元信息（含审核状态）
       maps/data/<id>.json  剧本本体
     写入一律"先写临时文件再 rename"，避免半个文件把索引写坏。
   · 状态：pending（待审）→ approved（已上线）/ rejected（已拒绝）
   · 管理员：密码取自环境变量 MAP_ADMIN_PASS。
     **没配就整体关闭审核接口**（fail closed），绝不留默认口令。
     登录后签一个带过期时间的 HMAC 令牌，不需要 session 存储。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.MAPS_DIR || path.join(__dirname, 'maps');
const DATA_SUB = path.join(DATA_DIR, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const INDEX_VERSION = 1;
const MAX_BODY = 1024 * 1024;        // 单张地图上限 1MB（实测剧本通常只有几 KB）
const MAX_MAPS = 500;                // 索引条目上限
const MAX_PENDING = 60;              // 待审队列上限，防止被灌爆
const TOKEN_TTL_MS = 12 * 3600 * 1000;

/* 提交频率限制：每个 IP 每小时最多 6 次 */
const RATE_WINDOW_MS = 3600 * 1000;
const RATE_MAX = 6;

function nowIso() { return new Date().toISOString(); }

function createMapStore(core, opts) {
  opts = opts || {};
  const adminPass = opts.adminPass !== undefined ? opts.adminPass : (process.env.MAP_ADMIN_PASS || '');
  const log = opts.log || (() => {});

  let index = { v: INDEX_VERSION, seq: 0, maps: {} };
  const rate = new Map();            // ip -> { n, resetAt }

  /* ---------------- 持久化 ---------------- */
  function ensureDirs() {
    fs.mkdirSync(DATA_SUB, { recursive: true });
  }
  function load() {
    try {
      ensureDirs();
      const raw = fs.readFileSync(INDEX_FILE, 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.maps && typeof j.maps === 'object') {
        index = { v: INDEX_VERSION, seq: Number(j.seq) || 0, maps: j.maps };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('地图索引读取失败，按空索引启动: ' + e.message);
    }
    return index;
  }
  /* 原子写：先写 .tmp 再 rename，断电也不会留下半个 JSON */
  function writeAtomic(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  function saveIndex() {
    ensureDirs();
    writeAtomic(INDEX_FILE, JSON.stringify(index));
  }
  function dataFile(id) { return path.join(DATA_SUB, id + '.json'); }

  function makeId() {
    index.seq = (index.seq || 0) + 1;
    // 序号 + 随机后缀：既单调递增（便于排查），又不可枚举
    return 'm' + index.seq.toString(36) + crypto.randomBytes(3).toString('hex');
  }

  /* ---------------- 限流 ---------------- */
  function rateOk(ip) {
    const now = Date.now();
    let r = rate.get(ip);
    if (!r || now > r.resetAt) { r = { n: 0, resetAt: now + RATE_WINDOW_MS }; rate.set(ip, r); }
    r.n++;
    if (rate.size > 4096) for (const [k, v] of rate) if (now > v.resetAt) rate.delete(k);
    return r.n <= RATE_MAX;
  }

  /* ---------------- 查询 ---------------- */
  function approvedCount() {
    let n = 0;
    for (const k in index.maps) if (index.maps[k].status === 'approved') n++;
    return n;
  }
  function pendingCount() {
    let n = 0;
    for (const k in index.maps) if (index.maps[k].status === 'pending') n++;
    return n;
  }
  /* 大厅列表：只给已通过的，且不含剧本本体（几 KB 一份，列表里没必要带） */
  function listApproved() {
    const out = [];
    for (const k in index.maps) {
      const m = index.maps[k];
      if (m.status !== 'approved') continue;
      out.push({ id: m.id, name: m.name, author: m.author, desc: m.desc,
                 hash: m.hash, size: m.size, createdAt: m.createdAt, plays: m.plays || 0,
                 countries: m.countries || 0, provinces: m.provinces || 0 });
    }
    out.sort((a, b) => (b.plays || 0) - (a.plays || 0) || (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }
  function listPending() {
    const out = [];
    for (const k in index.maps) {
      const m = index.maps[k];
      if (m.status !== 'pending') continue;
      out.push({ id: m.id, name: m.name, author: m.author, desc: m.desc, hash: m.hash,
                 size: m.size, createdAt: m.createdAt, ip: m.ip, countries: m.countries || 0,
                 provinces: m.provinces || 0 });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out;
  }
  function readData(id) {
    try { return JSON.parse(fs.readFileSync(dataFile(id), 'utf8')); }
    catch (e) { return null; }
  }
  /* 大厅取图：只有已审核通过的才能被公开读取 */
  function getApproved(id) {
    const m = index.maps[id];
    if (!m || m.status !== 'approved') return null;
    const scenario = readData(id);
    if (!scenario) return null;
    return { meta: pubMeta(m), scenario };
  }
  /* 管理端取图：任何状态都能看（用于预览待审地图） */
  function getAny(id) {
    const m = index.maps[id];
    if (!m) return null;
    const scenario = readData(id);
    if (!scenario) return null;
    return { meta: pubMeta(m), status: m.status, note: m.note || '', scenario };
  }
  function pubMeta(m) {
    return { id: m.id, name: m.name, author: m.author, desc: m.desc, hash: m.hash,
             size: m.size, createdAt: m.createdAt, reviewedAt: m.reviewedAt || null,
             plays: m.plays || 0, status: m.status };
  }

  /* ---------------- 提交 ---------------- */
  /* 返回 {ok:true, id} 或 {ok:false, err} */
  function submit(meta, scenario, ip) {
    if (!rateOk(ip)) return { ok: false, err: '提交过于频繁，请稍后再试' };
    if (pendingCount() >= MAX_PENDING) return { ok: false, err: '待审队列已满，请稍后再提交' };
    if (Object.keys(index.maps).length >= MAX_MAPS) return { ok: false, err: '地图数量已达上限' };

    const bad = core.validateScenario(scenario);
    if (bad) return { ok: false, err: bad };

    const text = JSON.stringify(scenario);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return { ok: false, err: '地图文件过大' };

    const name = core.sanitizeMapText((meta && meta.name) || scenario.name, core.MAP_NAME_MAX);
    if (!name) return { ok: false, err: '请填写地图名称' };
    const author = core.sanitizeMapText((meta && meta.author) || scenario.author, core.MAP_AUTHOR_MAX);
    const desc = core.sanitizeMapText((meta && meta.desc) || scenario.desc, core.MAP_DESC_MAX);
    const hash = core.scenarioHash(scenario);

    // 同一份内容重复提交直接复用（避免刷屏）
    for (const k in index.maps) {
      const m = index.maps[k];
      if (m.hash === hash && m.status !== 'rejected') {
        return { ok: false, err: '这张地图已经提交过了（' + (m.status === 'approved' ? '已上线' : '待审核') + '）' };
      }
    }

    const id = makeId();
    ensureDirs();
    writeAtomic(dataFile(id), text);
    index.maps[id] = {
      id, name, author, desc, hash,
      size: Buffer.byteLength(text, 'utf8'),
      status: 'pending',
      createdAt: nowIso(), reviewedAt: null, note: '', plays: 0,
      countries: Object.keys(scenario.countries || {}).length,
      provinces: Object.keys(scenario.provinces || {}).length,
      ip: String(ip || '').slice(0, 64),
    };
    saveIndex();
    log(`[maps] submitted ${id} "${name}" by ${author || '匿名'} (${index.maps[id].size}B)`);
    return { ok: true, id, hash };
  }

  /* ---------------- 审核 ---------------- */
  function review(id, action, note) {
    const m = index.maps[id];
    if (!m) return { ok: false, err: '找不到这张地图' };
    if (action === 'approve') {
      if (!fs.existsSync(dataFile(id))) return { ok: false, err: '地图文件缺失' };
      m.status = 'approved';
    } else if (action === 'reject') {
      m.status = 'rejected';
    } else if (action === 'pending') {
      m.status = 'pending';
    } else {
      return { ok: false, err: '未知操作' };
    }
    m.reviewedAt = nowIso();
    m.note = core.sanitizeMapText(note || '', 200);
    saveIndex();
    log(`[maps] ${id} -> ${m.status}${m.note ? ' (' + m.note + ')' : ''}`);
    return { ok: true, status: m.status };
  }
  function remove(id) {
    if (!index.maps[id]) return { ok: false, err: '找不到这张地图' };
    delete index.maps[id];
    try { fs.unlinkSync(dataFile(id)); } catch (e) { /* 文件可能已不在 */ }
    saveIndex();
    log(`[maps] removed ${id}`);
    return { ok: true };
  }
  function bumpPlays(id) {
    const m = index.maps[id];
    if (!m || m.status !== 'approved') return false;
    m.plays = (m.plays || 0) + 1;
    saveIndex();
    return true;
  }

  /* ---------------- 管理员鉴权 ---------------- */
  function adminEnabled() { return adminPass.length >= 6; }
  function sign(v) {
    return crypto.createHmac('sha256', adminPass).update(String(v)).digest('hex').slice(0, 32);
  }
  const loginFails = new Map();      // ip -> { n, resetAt }
  function login(ip, password) {
    if (!adminEnabled()) return { ok: false, err: '管理接口未启用（服务端未设置 MAP_ADMIN_PASS）' };
    const now = Date.now();
    let f = loginFails.get(ip);
    if (!f || now > f.resetAt) { f = { n: 0, resetAt: now + 10 * 60 * 1000 }; loginFails.set(ip, f); }
    if (f.n >= 8) return { ok: false, err: '尝试次数过多，请十分钟后再试' };
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(adminPass);
    const same = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!same) { f.n++; return { ok: false, err: '密码错误' }; }
    f.n = 0;
    const exp = now + TOKEN_TTL_MS;
    return { ok: true, token: exp + '.' + sign(exp), expiresAt: exp };
  }
  function checkToken(token) {
    if (!adminEnabled()) return false;
    const s = String(token || '');
    const i = s.indexOf('.');
    if (i <= 0) return false;
    const exp = Number(s.slice(0, i));
    if (!isFinite(exp) || exp < Date.now()) return false;
    const got = s.slice(i + 1);
    const want = sign(exp);
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }

  function stats() {
    return { total: Object.keys(index.maps).length, approved: approvedCount(),
             pending: pendingCount(), dir: DATA_DIR, adminEnabled: adminEnabled() };
  }

  load();
  return { load, saveIndex, listApproved, listPending, getApproved, getAny, submit, review,
           remove, bumpPlays, login, checkToken, adminEnabled, stats, MAX_BODY,
           _index: () => index };
}

module.exports = { createMapStore, DATA_DIR, MAX_BODY };
