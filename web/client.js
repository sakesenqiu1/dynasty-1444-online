'use strict';
/* =====================================================================
   王朝纪元 · 1444 — 客户端（渲染、界面、输入、联网）
   ===================================================================== */

/* ---------- 存档（多槽，浏览器本地） ---------- */
const SLOT_PREFIX='GS_SLOT_';   // 网页版 localStorage key 前缀
function hostSaveAvailable(){
  return !!(window.chrome && window.chrome.webview && window.chrome.webview.hostObjects && window.chrome.webview.hostObjects.__host);
}
function escSlotName(name){
  return String(name||'未命名存档').trim().replace(/[\\/:*?"<>|\r\n\t]/g,'_').slice(0,40)||'未命名存档';
}
function nowStr(){
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function slotTimeLabel(o){ return (o&&o.t)?o.t:''; }
async function _migrateLegacy(){
  // 网页版旧单档 → 槽位（只要有旧档就迁成"自动存档"，同名则覆盖）
  try{
    const old=localStorage.getItem(SAVE_KEY);
    if(!old) return;
    localStorage.setItem(SLOT_PREFIX+escSlotName('自动存档'), JSON.stringify({t:nowStr(),d:JSON.parse(old)}));
    localStorage.removeItem(SAVE_KEY);
  }catch(e){}
}
// 列出全部存档槽 → [{n:名字, t:时间}]（时间新的在前）
async function listSlots(){
  if(hostSaveAvailable()){
    try{ const s=await window.chrome.webview.hostObjects.__host.ListSaves(); return JSON.parse(s||'[]'); }catch(e){ return []; }
  }
  await _migrateLegacy();
  const out=[];
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k&&k.startsWith(SLOT_PREFIX)){
      try{
        const o=JSON.parse(localStorage.getItem(k)||'null');
        out.push({n:k.slice(SLOT_PREFIX.length), t:(o&&o.t)||''});
      }catch(e){}
    }
  }
  out.sort((a,b)=>(b.t||'').localeCompare(a.t||''));
  return out;
}
// 保存一档：data 为游戏数据对象；同名覆盖。返回 true/false
async function writeSlot(name, data){
  const body=JSON.stringify({t:nowStr(), d:data});
  if(hostSaveAvailable()){
    try{ await window.chrome.webview.hostObjects.__host.SaveSlot(body, escSlotName(name)); return true; }catch(e){ return false; }
  }
  try{ localStorage.setItem(SLOT_PREFIX+escSlotName(name), body); return true; }catch(e){ return false; }
}
// 读取一档 → 游戏数据对象；无档返回 null
async function readSlot(name){
  if(hostSaveAvailable()){
    try{
      const s=await window.chrome.webview.hostObjects.__host.LoadSlot(escSlotName(name));
      if(!s) return null;
      const o=JSON.parse(s); return o&&o.d?o.d:o;
    }catch(e){ return null; }
  }
  try{
    const raw=localStorage.getItem(SLOT_PREFIX+escSlotName(name));
    if(!raw) return null;
    const o=JSON.parse(raw); return o&&o.d?o.d:o;
  }catch(e){ return null; }
}
// 删除一档
async function deleteSlot(name){
  if(hostSaveAvailable()){
    try{ await window.chrome.webview.hostObjects.__host.DeleteSlot(escSlotName(name)); }catch(e){}
    return;
  }
  try{ localStorage.removeItem(SLOT_PREFIX+escSlotName(name)); }catch(e){}
}
// 存档弹窗当前模式
let slotMode='save';           // 'save' | 'load'
function escHtml(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}



/* =====================================================================
   二、渲染
   ===================================================================== */
const mapCv=document.getElementById('map');
const ctx=mapCv.getContext('2d');
let dpr=1, cw=0, ch=0;
const provCv=document.createElement('canvas'); provCv.width=COLS; provCv.height=ROWS;
const pctx=provCv.getContext('2d');
let imgData=pctx.createImageData(COLS,ROWS);
/* 海洋像素也要有颜色：地图层必须是「完全不透明」的一整块。
   否则一旦某帧不填海，旧画面就会从透明海域透出来（拖动时表现为无数残影重叠）。 */
(function initSea(){
  const d=imgData.data;
  const r=parseInt(SEA.slice(1,3),16), g=parseInt(SEA.slice(3,5),16), b=parseInt(SEA.slice(5,7),16);
  for(let i=0;i<d.length;i+=4){ d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255; }
})();
const selCv=document.createElement('canvas'); selCv.width=COLS; selCv.height=ROWS;
const sctx=selCv.getContext('2d');
let selData=sctx.createImageData(COLS,ROWS);
let imgDirty=true, selDirty=true;
/* 重绘调度状态：必须在 applyRenderScale / resize 之前声明 */
let _frameKey='', _lastRealRender=0, _labelHasContent=false;

/* ---------- 标签层缓存 ----------
   国家名/省名是静态的，但原来每帧都用 strokeText+fillText 重画上百个文字，
   这是最大的每帧开销。改成画到离屏 canvas，只在相机或标签数据变化时重画。 */
const labelCv=document.createElement('canvas');
const lctx=labelCv.getContext('2d');
let labelKey='', labelEpoch=0;
/* rebuildLabels 会改变国家标签坐标，包一层让它自动让缓存失效 */
const _rebuildLabelsCore=rebuildLabels;
rebuildLabels=function(){ _rebuildLabelsCore.apply(null,arguments); labelEpoch++; };

/* ---------- 界面刷新节流 ----------
   联机时服务端每 130ms 推一次增量。原来每次都重建整个侧栏 DOM
   （外交页是 ~70KB HTML），8 次/秒足以让页面卡死。
   改成：按"状态指纹"判断是否真的需要重绘，并且最多 3 次/秒。 */
let _panelSig=null, _panelAt=0, _labelsAt=0, _panelDirty=false;
function markPanelDirty(){ _panelDirty=true; }
function forcePanelRefresh(){ _panelSig=null; _panelDirty=false; if(started) refreshPanel(); }
/* ---------- 游戏内时钟平滑外推 ----------
   服务端每 130ms 才推一次，日期文字本来是一跳一跳的。
   这里按当前速度在两次推送之间把日期往前"补"，让时钟连续走动。
   只按 0.9 倍速度外推、且只前进不后退，所以永远不会超过服务端再往回跳。 */
let _clkDay=-1, _clkY=1444, _clkM=10, _clkD=11, _clkAt=0, _clkShownAt=0, _clkShown='';
function advDate(y,m,d,n){
  for(let i=0;i<n;i++){
    d++;
    const L=m===1?((y%4===0&&y%100!==0)||y%400===0?29:28):CAL_M[m];
    if(d>L){ d=1; m++; if(m>11){ m=0; y++; } }
  }
  return [y,m,d];
}
function clockSync(day,y,m,d){
  _clkDay=day; _clkY=y; _clkM=m; _clkD=d; _clkAt=performance.now();
}
function clockTick(now){
  if(!MP.online || _clkDay<0) return;
  if(now-_clkShownAt<110) return;
  _clkShownAt=now;
  let extra=0;
  if(!paused){
    const dps=SPEEDS[speed-1]||2;
    // 只外推一个推送周期内的量，且留 10% 余量，避免超前于服务端
    extra=Math.min(Math.ceil(dps*0.15), Math.floor((now-_clkAt)/1000*dps*0.9));
    if(extra<0) extra=0;
  }
  const [y,m,d]=advDate(_clkY,_clkM,_clkD,extra);
  const txt=`${y}年${m+1}月${d}日`;
  if(txt!==_clkShown){ _clkShown=txt; const el=$('tb-date'); if(el) el.textContent=txt; }
}

function uiTick(t){
  // 重算标签要遍历全部陆地像素（约 25 万），节流到 ~2.6Hz
  if(labelsDirty && t-_labelsAt>380){ _labelsAt=t; rebuildLabels(); }
  if(!MP.online) return;
  clockTick(t);
  // 侧栏最多约 3.3 次/秒；这期间没有增量就完全跳过（不重建、不算指纹）
  if(!_panelDirty || t-_panelAt<300) return;
  _panelAt=t; _panelDirty=false;
  const sig=panelSignature();
  if(sig!==_panelSig){ _panelSig=sig; refreshPanel(); }
}
/* 侧栏显示的内容的廉价指纹：没变就不重绘 */
function panelSignature(){
  let s=uiTab+'|'+(player|0)+'|';
  const c=countries[player];
  if(c) s+=Math.round(c.gold*10)+','+Math.round(c.mp)+','+Math.round(c.income*100)+','+c.provList.length+','+(c.alive?1:0)+',';
  if(uiTab==='diplo'){
    s+=uiSearch+'|'+diploFocus+'|'+diploColorFor+'|'+wars.length+'|';
    for(let i=1;i<countries.length;i++){
      const q=countries[i]; if(!q){ s+=','; continue; }
      // 名字/颜色/国体都进指纹：别人改名或改属国颜色后本端要能立刻跟上
      s+=q.alive?(q.provList.length+'.'+(q.overlord||0)+'.'+(q.allies||[]).length+'.'+Math.round(q.gold)
        +'.'+(q.subject||0)+'.'+q.name+'.'+(q.color?q.color.join('-'):'')):'x';
      s+=',';
    }
  } else if(uiTab==='war'){
    for(const w of wars){
      if(!w||typeof w.a!=='number') continue;
      if(w.a===player||w.d===player) s+=w.a+'-'+w.d+'-'+w.aB+'-'+w.dB+'-'+Math.round(w.casA||0)+'-'+Math.round(w.casD||0)+';';
    }
    if(pendingOffer) s+='O'+pendingOffer.enemy+'-'+((pendingOffer.transfers||[]).length)+'-'+((pendingOffer.releases||[]).length);
    if(typeof MP!=='undefined'&&MP.sentOffer) s+='S'+MP.sentOffer.to+'-'+((MP.sentOffer.transfers||[]).length);
  } else {
    s+=selectedProv+'|'+selectedArmy+'|'+battleProvs.size+'|';
    const a=armies.find(x=>x.id===selectedArmy);
    if(a) s+=Math.round(a.str)+','+a.prov+','+(a.path?a.path.length:0)+','+(a.navPath?a.navPath.length:0)+','+Math.round(a.attrit||0)+','+(a.isNavy?1:0)+',';
    const p=provinces[selectedProv];
    if(p) s+=p.owner+','+p.controller+','+p.tax+','+p.prod+','+p.man+','+Math.round(p.siege)+',';
    // 列强榜随任何国家的开发度变化
    for(let i=1;i<countries.length;i++){ const q=countries[i]; if(q&&q.alive) s+=q.id+':'+totalDev(q)+';'; }
  }
  return s;
}

/* ---------- 性能监视（按 P 或 ?perf=1 打开） ---------- */
let perfHud=false, _fpsN=0, _fpsAt=0, _fps=0, _renderMs=0, _labelMs=0, _deltaMs=0, _panelDraws=0, _labelDraws=0, _visArmies=0;
let _msFill=0, _msPut=0, _msBlit=0, _msArmy=0, _redraws=0, _skips=0, _scaleAt=0;
/* 渲染持续偏慢就自动降分辨率，流畅了再升回去 */
function tuneRenderScale(t){
  if(t-_scaleAt<2000) return;
  if(document.hidden) return;                 // 后台标签页 rAF 被节流，不能当依据
  _scaleAt=t;
  const maxS=maxRenderScale();
  const cur = renderScale>0 ? renderScale : maxS;
  // 帧间隔 >21ms（不足 ~48fps）说明这台机器吃力，降档；接近垂直同步就升回去
  if(_frameMs>21 && cur>0.62){ renderScale=Math.max(0.6, cur-0.25); applyRenderScale(); }
  else if(_frameMs<17.6 && cur<maxS-0.01){ renderScale=Math.min(maxS, cur+0.25); applyRenderScale(); }
}
function drawPerf(t){
  _fpsN++;
  if(t-_fpsAt>=500){ _fps=Math.round(_fpsN*1000/(t-_fpsAt)); _fpsN=0; _fpsAt=t; }
  let el=document.getElementById('perf-hud');
  if(!el){
    el=document.createElement('div');
    el.id='perf-hud';
    el.style.cssText='position:absolute;left:8px;top:52px;z-index:60;background:rgba(0,0,0,.78);border:1px solid #6b5b33;color:#c9a959;font:11px/1.6 Consolas,monospace;padding:6px 10px;border-radius:3px;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
  }
  _deltaMs=_deltaMs*0.9+((MP.lastDeltaMs)||0)*0.1;
  const net=MP.online
    ? ('房间 '+MP.room+'  增量 '+(_dps.toFixed(1))+'/s  '+(_kbps.toFixed(1))+' KB/s')
    : '单机模式';
  el.textContent=[
    'FPS        '+_fps+'    帧间隔 '+_frameMs.toFixed(1)+' ms',
    '重绘       '+_redraws+' / 跳过 '+_skips,
    '渲染总     '+_renderMs.toFixed(1)+' ms',
    '  底色     '+_msFill.toFixed(1)+' ms',
    '  贴图     '+_msPut.toFixed(1)+' ms',
    '  地图     '+_msBlit.toFixed(1)+' ms',
    '  军队     '+_msArmy.toFixed(1)+' ms',
    '  文字     '+_labelMs.toFixed(1)+' ms',
    '渲染分辨率 '+dpr.toFixed(2)+'  (设备 '+(window.devicePixelRatio||1).toFixed(2)+')',
    '增量处理   '+_deltaMs.toFixed(1)+' ms',
    '军队可见   '+_visArmies+' / '+armies.length,
    '侧栏重画   '+_panelDraws+' 次',
    net,
    '(按 P 关闭)',
  ].join(String.fromCharCode(10));
}

/* 每秒增量速率 */
let _dps=0, _kbps=0, _rateAt=0, _dCount=0, _dBytes=0;
function perfRates(t){
  if(t-_rateAt<1000) return;
  const dt=(t-_rateAt)/1000;
  _dps=((MP.deltaCount||0)-_dCount)/dt;
  _kbps=(((MP.deltaBytes||0)-_dBytes)/1024)/dt;
  _dCount=MP.deltaCount||0; _dBytes=MP.deltaBytes||0; _rateAt=t;
}

const cam={x:720,y:360,z:1};
/* ---------- 渲染分辨率 ----------
   画布后备分辨率不一定等于设备像素比：4K 屏 / 集显 / 软件渲染的机器上，
   按设备像素比铺满全屏会非常慢。renderScale=0 表示跟随设备（上限 2），
   一旦实测渲染持续偏慢就自动往下调，流畅了再升回去（对玩家透明）。 */
let renderScale=0;
function maxRenderScale(){ return Math.min(window.devicePixelRatio||1, 2); }
function applyRenderScale(){
  const s = renderScale>0 ? renderScale : maxRenderScale();
  dpr = s;
  mapCv.width = Math.max(1, Math.round(cw*s));
  mapCv.height = Math.max(1, Math.round(ch*s));
  mapCv.style.width = cw+'px'; mapCv.style.height = ch+'px';
  labelKey='';                 // 标签层分辨率变了，缓存作废
  _frameKey='';                // 强制重画一帧
}
function resize(){
  cw=window.innerWidth; ch=window.innerHeight;
  applyRenderScale();
}
window.addEventListener('resize',resize); resize();
function w2s(x,y){ return [(x-cam.x)*cam.z+cw/2,(y-cam.y)*cam.z+ch/2]; }
function s2w(x,y){ return [(x-cw/2)/cam.z+cam.x,(y-ch/2)/cam.z+cam.y]; }

/* 外交配色（地图外交模式与外交面板共用同一套）
   我朝与盟友同为蓝色；我方附庸浅紫、我方傀儡深紫；
   其余国家（含他国的附庸/傀儡）一律中立色，不作特别表示。 */
const REL_COL={
  self:   [88,132,198],    // 我朝 / 盟友
  vassal: [186,140,238],   // 我方附庸国：浅紫
  puppet: [104,58,168],    // 我方傀儡国：深紫
  war:    [198,74,62],
  truce:  [204,156,74],
  neutral:[106,114,102],
};
function relColorOf(cid){
  if(cid===player) return REL_COL.self;
  const ov=overlordOf(cid);
  if(ov===player) return isPuppet(cid)?REL_COL.puppet:REL_COL.vassal;
  if(atWar(player,cid)) return REL_COL.war;
  if(isAllied(player,cid)) return REL_COL.self;
  if(truceBetween(player,cid)) return REL_COL.truce;
  return REL_COL.neutral;
}
/* 外交面板里的色点：有关系时用外交关系色，中立国仍用本国旗色（保留辨识度） */
function relDotColor(cid){
  const rc=relColorOf(cid);
  if(rc===REL_COL.neutral){ const c=countries[cid]; return c&&c.color?c.color:REL_COL.neutral; }
  return rc;
}
function heat(t){
  t=clamp(t,0,1);
  if(t<0.5){ const u=t*2; return [lerp(70,225,u),lerp(150,205,u),lerp(95,80,u)]; }
  const u=(t-0.5)*2; return [lerp(225,208,u),lerp(205,75,u),lerp(80,55,u)];
}
function provFill(p){
  if(mapMode==='dev'){ return heat((p.tax+p.prod+p.man-3)/17); }
  if(mapMode==='rel'){
    if(!player) return [110,112,105];
    const r=relColorOf(p.controller);
    return [r[0]*p.varF,r[1]*p.varF,r[2]*p.varF];
  }
  // political：被占领省份保持原主颜色，斜条在 recolorProvince 中叠加
  const c=countries[p.owner]||countries[p.controller];
  return [c.color[0]*p.varF,c.color[1]*p.varF,c.color[2]*p.varF];
}
function setPx(idx,r,g,b){ const o=idx*4, d=imgData.data; d[o]=r|0; d[o+1]=g|0; d[o+2]=b|0; d[o+3]=255; }

/* ---------- 脏矩形 ----------
   原来只要有一个省变色，渲染时就把整幅 1440×720（约 4MB）重新 putImageData，
   这是客户端最稳定的一处周期性卡顿。改成只回写真正改动过的那一小块。
   recolorProvince 写入的像素全部属于该省自己，所以用省份包围盒即可。 */
let imgBox=null;                 // null = 整幅
function provBB(p){
  if(p._bb) return p._bb;
  let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for(const px of p.pix){
    const r=(px/COLS)|0, c=px%COLS;
    if(c<x0)x0=c; if(c>x1)x1=c; if(r<y0)y0=r; if(r>y1)y1=r;
  }
  p._bb=[x0,y0,x1,y1];
  return p._bb;
}
function expandBox(bb){
  if(!imgBox){ imgBox=[bb[0],bb[1],bb[2],bb[3]]; return; }
  if(bb[0]<imgBox[0])imgBox[0]=bb[0];
  if(bb[1]<imgBox[1])imgBox[1]=bb[1];
  if(bb[2]>imgBox[2])imgBox[2]=bb[2];
  if(bb[3]>imgBox[3])imgBox[3]=bb[3];
}
function recolorProvince(pid){
  const p=provinces[pid]; if(!p||!p.pix.length) return;
  expandBox(provBB(p));
  const f=provFill(p);
  const occupied=p.controller!==p.owner&&countries[p.controller];
  const oc=occupied?countries[p.controller]:null;
  const of=oc?[oc.color[0]*p.varF,oc.color[1]*p.varF,oc.color[2]*p.varF]:null;
  // 斜条：占领区保持原主底色 + 占领方颜色斜条（每隔3像素交替）
  for(const idx of p.pix){
    if(occupied){
      const r=Math.floor(idx/COLS), c=idx%COLS;
      if((r+c)%6<3) setPx(idx,f[0],f[1],f[2]);
      else setPx(idx,of[0],of[1],of[2]);
    } else setPx(idx,f[0],f[1],f[2]);
  }
  for(const idx of p.coastPix){
    if(occupied){
      const r=Math.floor(idx/COLS), c=idx%COLS;
      if((r+c)%6<3) setPx(idx,f[0]*0.5,f[1]*0.5,f[2]*0.5);
      else setPx(idx,of[0]*0.5,of[1]*0.5,of[2]*0.5);
    } else setPx(idx,f[0]*0.5,f[1]*0.5,f[2]*0.5);
  }
  for(const [q,arr] of p.borderPix){
    const qp=provinces[q];
    const strong=qp&&qp.controller!==p.controller;
    for(const idx of arr){
      if(strong) setPx(idx,24,22,20);
      else setPx(idx,f[0]*0.8,f[1]*0.8,f[2]*0.8);
    }
  }
  imgDirty=true;
}
function recolorProvAndNbrs(pid){
  recolorProvince(pid);
  const p=provinces[pid];
  if(p) for(const q of p.nbrs) recolorProvince(q);
}
function recolorAll(){ for(let i=1;i<provinces.length;i++) recolorProvince(i); imgDirty=true; imgBox=null; }

function updateSelOverlay(){
  selData=new ImageData(COLS,ROWS);
  if(selectedProv>0){
    const p=provinces[selectedProv];
    const d=selData.data;
    for(const idx of p.pix){ const o=idx*4; d[o]=255;d[o+1]=255;d[o+2]=255;d[o+3]=60; }
    const edge=(arr)=>{ for(const idx of arr){ const o=idx*4; d[o]=255;d[o+1]=255;d[o+2]=255;d[o+3]=230; } };
    edge(p.coastPix);
    for(const [,arr] of p.borderPix) edge(arr);
  }
  selDirty=true;
}

/* —— 割地地图模式：在地图上点选和约割地省份 —— */
const cedeCv=document.createElement('canvas'); cedeCv.width=COLS; cedeCv.height=ROWS;
const cctx=cedeCv.getContext('2d');
let cedeData=cctx.createImageData(COLS,ROWS);
let cedeDirty=false;
let cedeMap={on:false,enemy:0};
/* ---------- 划地模式（分封新傀儡国 / 给已有属国赐地，共用同一套地图交互） ----------
   原来的流程是「先点一省建国，再一个省一个省按『赐地』」，划一片封地要点几十次。
   现在两种用途都走地图：点「🏳 划地分封」或「🎁 划地赐予」→ 进地图模式 →
   在自己实际控制的省份上随便点选（金色=已选，亮金=首府，淡绿=可以接着选），
   最后一次性落地。mode='found' 建立新傀儡国，mode='give' 把地划给已有属国。 */
let grantMap={on:false,pids:new Set(),capital:0,name:'',mode:'found',target:0};
function grantMapCanPick(pid){
  const p=provinces[pid];
  if(!p||!p.pix.length) return false;
  return p.owner===player&&p.controller===player;
}
// 重画割地/分封高亮：金色=可割或已选，红色=已选，灰色=暂不可达（须在面板渲染后调用）
function paintCedeOverlay(){
  cedeData=new ImageData(COLS,ROWS);
  const d=cedeData.data;
  const paint=(pid,col)=>{
    const p=provinces[pid]; if(!p) return;
    for(const idx of p.pix){ const o=idx*4; d[o]=col[0]; d[o+1]=col[1]; d[o+2]=col[2]; d[o+3]=col[3]; }
  };
  if(cedeMap.on){
    document.querySelectorAll(`.demand[data-enemy="${cedeMap.enemy}"]`).forEach(cb=>{
      const col=cb.checked?[255,80,60,170]:(cb.disabled?[110,110,110,70]:[255,200,80,120]);
      paint(+cb.value,col);
    });
  } else if(grantMap.on){
    /* 只画"已选省份 + 与已选相邻且可选的省份"。
       把自己的全部领土都铺一遍在 2000 省的地图上要写上百万像素，没必要：
       玩家本来就是一格格往外扩，淡绿提示下一格能选哪儿就够了。 */
    const near=new Set();
    for(const pid of grantMap.pids){
      const p=provinces[pid]; if(!p) continue;
      paint(pid, (grantMap.mode==='found'&&pid===grantMap.capital)?[255,235,130,205]:[255,170,45,175]);
      for(const q of p.nbrs) if(!grantMap.pids.has(q)&&grantMapCanPick(q)) near.add(q);
    }
    for(const q of near) paint(q,[120,225,140,62]);
  }
  cedeDirty=true;
}
/* 底部操作条：只重画这一条，不整块刷新侧栏（侧栏有 180 个国家，很贵） */
function updateGrantBar(){
  const bar=$('grantbar'); if(!bar) return;
  if(!grantMap.on){ bar.classList.add('hidden'); bar.innerHTML=''; return; }
  const n=grantMap.pids.size;
  const me=countries[player];
  const left=me?me.provList.length-n:0;
  const isFound=grantMap.mode==='found';
  const capName=grantMap.capital&&provinces[grantMap.capital]?provinces[grantMap.capital].name:'—';
  const noLeft=left<=0;
  bar.classList.remove('hidden');
  bar.innerHTML=`<b style="color:#ffd890">${isFound?'🏳 分封':'🎁 赐地给'}《${escHtml(grantMap.name)}》</b>
    <span class="hint">已选 <b style="color:#ffd070">${n}</b> 省${isFound?` · 首府 <b style="color:#ffe9b0">${escHtml(capName)}</b>`:''} · 我国余 ${left} 省</span>
    <button class="act" data-act="grant-absorb" title="把与已选疆土接壤、且仍在我国实际控制下的省份全部纳入">＋纳入接壤省</button>
    <button class="act" data-act="grant-clear" title="清空已选">清空</button>
    <button class="act" style="background:#2a2440;border-color:#6a5a9a;color:#d0b0ff" data-act="grant-confirm" ${n&&!noLeft?'':'disabled'} title="${noLeft?'至少要为我国保留一个省份':(isFound?'一次划地建立傀儡国':'一次把这些省份划给该属国')}">✔ ${isFound?'确认分封':'确认赐地'}（${n}省）</button>
    <button class="act" data-act="grant-cancel">取消</button>
    <span class="hint" style="margin-left:6px">点地图上的省份可加入/移出；点已选省份可取消该省</span>`;
}
/* 「纳入接壤省」：从已选疆土出发做一次 BFS，把连成一片的本国省份一次收进来 */
function grantMapAbsorb(){
  if(!grantMap.on||!grantMap.pids.size) return;
  const me=countries[player];
  const add=new Set();
  const seen=new Set(grantMap.pids);
  const q=[...grantMap.pids];
  for(let h=0;h<q.length;h++){
    const p=provinces[q[h]]; if(!p) continue;
    for(const nb of p.nbrs){
      if(seen.has(nb)) continue;
      seen.add(nb);
      if(!grantMapCanPick(nb)) continue;
      if(me.provList.length-grantMap.pids.size-add.size<=1) break;   // 给我国留一省
      add.add(nb); q.push(nb);
    }
  }
  for(const pid of add) grantMap.pids.add(pid);
  paintCedeOverlay(); updateGrantBar();
  pushLog(add.size?`纳入 ${add.size} 个接壤省份`:'没有可纳入的接壤省份','');
}
function grantMapToggle(pid){
  if(!grantMap.on) return false;
  if(grantMap.pids.has(pid)){
    grantMap.pids.delete(pid);
    if(grantMap.capital===pid) grantMap.capital=grantMap.pids.size?[...grantMap.pids][0]:0;
    paintCedeOverlay(); updateGrantBar();
    return true;
  }
  if(!grantMapCanPick(pid)) return false;
  const me=countries[player];
  if(me.provList.length<=grantMap.pids.size+1){
    pushLog('至少要为我国保留一个省份','war');
    return true;
  }
  grantMap.pids.add(pid);
  if(!grantMap.capital) grantMap.capital=pid;
  paintCedeOverlay(); updateGrantBar();
  return true;
}
function grantMapBegin(pid,name){
  grantMap={on:true,pids:new Set([pid]),capital:pid,name,mode:'found',target:0};
  cedeMap.on=false; cedeMap.enemy=0;
  paintCedeOverlay(); updateGrantBar();
  pushLog(`🏳 分封《${name}》：在地图上点选要封出去的省份（可点「＋纳入接壤省」整片划），选好后点「确认分封」`,'gold');
}
/* 划地赐予已有属国：与分封同一套交互，只是落地时把地转给已存在的国家 */
function grantMapBeginGive(pid,targetId){
  const t=countries[targetId];
  if(!t||!t.alive){ pushLog('请先选择一个属国','war'); return; }
  if(overlordOf(targetId)!==player){ pushLog(`《${t.name}》不是我国属国`,'war'); return; }
  const p=provinces[pid];
  if(!p||p.owner!==player||p.controller!==player){ pushLog('只能划出你自己实际控制的省份','war'); return; }
  if(countries[player].provList.length<=1){ pushLog('至少要为我国保留一个省份','war'); return; }
  grantMap={on:true,pids:new Set([pid]),capital:0,name:t.name,mode:'give',target:targetId};
  cedeMap.on=false; cedeMap.enemy=0;
  paintCedeOverlay(); updateGrantBar();
  pushLog(`🎁 划地赐予《${t.name}》：在地图上点选要划过去的省份（可点「＋纳入接壤省」整片划），选好后点「确认赐地」`,'gold');
}
function grantMapCancel(){
  grantMap={on:false,pids:new Set(),capital:0,name:'',mode:'found',target:0};
  paintCedeOverlay(); updateGrantBar();
}
function grantMapConfirm(){
  if(!grantMap.on) return;
  const pids=[...grantMap.pids];
  if(!pids.length){ pushLog('还没有选择任何省份','war'); return; }
  const me=countries[player];
  if(!me||me.provList.length<=pids.length){ pushLog('至少要为我国保留一个省份','war'); return; }

  /* ---- 赐地给已有属国 ---- */
  if(grantMap.mode==='give'){
    const vid=grantMap.target, t=countries[vid];
    if(!t||!t.alive||overlordOf(vid)!==player){ pushLog('对方已不是我国属国','war'); grantMapCancel(); return; }
    if(MP.online){ mpCmd({c:'give',to:vid,pids}); grantMapCancel(); return; }
    let n=0;
    for(const pid of pids){
      const p=provinces[pid];
      if(p&&p.pix.length&&p.owner===player&&p.controller===player){ transferProvince(pid,vid); n++; }
    }
    if(!n){ pushLog('所选省份都不在我国实际控制之下','war'); return; }
    pushLog(`👑 ${n} 省赐予 ${t.name}，以为藩屏`,'gold',me);
    grantMapCancel();
    labelsDirty=true; recolorAll(); refreshPanel();
    return;
  }

  /* ---- 建立新的傀儡国 ---- */
  const name=grantMap.name;
  const cap=grantMap.capital&&grantMap.pids.has(grantMap.capital)?grantMap.capital:pids[0];
  if(MP.online){
    mpCmd({c:'found',prov:cap,name,pids});
    grantMapCancel();
    return;
  }
  const capName=provinces[cap].name;
  const nid=foundVassal(player,cap,name,pids.filter(x=>x!==cap));
  if(!nid){ pushLog('分封失败（封地须在你实际控制之下，且须为我国保留至少一省）','war'); return; }
  pushLog(`👳 ${name} 于 ${capName} 立国，奉我朝为宗主（${pids.length}省）`,'gold',0);
  grantMapCancel();
  labelsDirty=true; recolorAll(); refreshPanel();
}
function toggleCedeMap(enemy){
  if(cedeMap.on&&cedeMap.enemy===enemy){ cedeMap.on=false; cedeMap.enemy=0; }
  else { cedeMap.on=true; cedeMap.enemy=enemy; grantMapCancel(); }  // 两种地图模式互斥
  refreshPanel(); // warTab 重渲染 → updateDemandUI → paintCedeOverlay
}
// 地图点击落在割地候选省上：切换勾选（不刷新面板，保留所有勾选状态）
function cedeMapClick(pid){
  if(!cedeMap.on) return false;
  const cb=document.querySelector(`.demand[value="${pid}"][data-enemy="${cedeMap.enemy}"]`);
  if(cb&&!cb.disabled){
    cb.checked=!cb.checked;
    updateDemandUI();
    return true;
  }
  return false;
}

/* ---------- 只在画面真的变化时才重画 ----------
   原来不管有没有变化，每帧都固定重画 3 遍全屏（海面底色 + 地图 + 标签层）。
   暂停 / 静止时这些全是白干的，在弱显卡或高分屏上单帧能到几百毫秒。
   这里给所有会影响画面的输入算一个指纹，指纹没变就直接沿用上一帧。 */
/* 征兵进度的廉价指纹：剩余天数一变就要重画进度环 */
function recruitSig(){
  if(!recruits||!recruits.length) return '0';
  let s=recruits.length*1000003;
  for(let i=0;i<recruits.length;i++) s+=recruits[i].days*7+recruits[i].prov;
  return String(s);
}
function needsRender(t){
  const k = cam.x.toFixed(3)+'|'+cam.y.toFixed(3)+'|'+cam.z.toFixed(4)+'|'+cw+'|'+ch+'|'+dpr+'|'+
    labelEpoch+'|'+selectedProv+'|'+selectedArmy+'|'+mapMode+'|'+_armyVer+'|'+recruitSig()+'|'+
    ((imgDirty?1:0)|(selDirty?2:0)|(cedeMap.on?(cedeDirty?4:0):(grantMap.on?(cedeDirty?4:0):8)));
  if(k!==_frameKey){ _frameKey=k; return true; }
  // 兜底：浏览器在后台可能丢弃画布内容，最多 3 秒强制重画一次
  if(t-_lastRealRender>3000){ _lastRealRender=t; return true; }
  return false;
}
// 切回前台时强制重画（后台期间画布可能被浏览器回收）
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ _frameKey=''; } });

function render(t){
  if(!needsRender(t||0)){ _skips++; return; }
  _redraws++; _lastRealRender=t||0;
  let _t=performance.now();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  // 地图铺满整屏时不用填海；否则只填四条边，省掉一次全屏填充
  {
    const mw=COLS*cam.z, mh=ROWS*cam.z;
    const mx=(cw/2-cam.x*cam.z), my=(ch/2-cam.y*cam.z);
    if(mx>0||my>0||mx+mw<cw||my+mh<ch){
      ctx.fillStyle=SEA;
      if(my>0) ctx.fillRect(0,0,cw,my);
      if(my+mh<ch) ctx.fillRect(0,my+mh,cw,ch-(my+mh));
      if(mx>0) ctx.fillRect(0,Math.max(0,my),mx,Math.min(ch,my+mh)-Math.max(0,my));
      if(mx+mw<cw) ctx.fillRect(mx+mw,Math.max(0,my),cw-(mx+mw),Math.min(ch,my+mh)-Math.max(0,my));
    }
  }
  _msFill=_msFill*0.85+(performance.now()-_t)*0.15; _t=performance.now();
  // 地图层
  if(imgDirty){
    // 只回写脏矩形；没有脏矩形（或面积过半）才整幅回写
    if(imgBox && imgBox[2]>=imgBox[0] && imgBox[3]>=imgBox[1]){
      const bx=imgBox[0], by=imgBox[1], bw=imgBox[2]-bx+1, bh=imgBox[3]-by+1;
      if(bw*bh < COLS*ROWS*0.5) pctx.putImageData(imgData,0,0,bx,by,bw,bh);
      else pctx.putImageData(imgData,0,0);
    } else pctx.putImageData(imgData,0,0);
    imgDirty=false; imgBox=null;
  }
  if(selDirty){ sctx.putImageData(selData,0,0); selDirty=false; }
  _msPut=_msPut*0.85+(performance.now()-_t)*0.15; _t=performance.now();
  const tx=(cw/2-cam.x*cam.z)*dpr, ty=(ch/2-cam.y*cam.z)*dpr;
  ctx.setTransform(cam.z*dpr,0,0,cam.z*dpr,tx,ty);
  ctx.imageSmoothingEnabled=cam.z<1.6;
  ctx.drawImage(provCv,0,0);
  if(cedeMap.on||grantMap.on){ if(cedeDirty){ cctx.putImageData(cedeData,0,0); cedeDirty=false; } ctx.drawImage(cedeCv,0,0); }
  if(selectedProv>0) ctx.drawImage(selCv,0,0);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  _msBlit=_msBlit*0.85+(performance.now()-_t)*0.15; _t=performance.now();
  // 纬线（细微）
  if(cam.z>5){
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    for(let lat=-60;lat<=75;lat+=15){
      const [,sy]=w2s(0,(90-lat)/0.25); if(sy>0&&sy<ch){ ctx.beginPath();ctx.moveTo(0,sy);ctx.lineTo(cw,sy);ctx.stroke(); }
    }
  }
  drawSiegeBars();
  drawRecruits();
  drawArmies();
  _msArmy=_msArmy*0.85+(performance.now()-_t)*0.15; _t=performance.now();
  ensureLabels();
  // labelCv 是设备像素尺寸的画布：必须用单位变换 1:1 贴上去，
  // 再乘一次 dpr 会让所有标签坐标被放大 dpr 倍（屏幕有缩放时名字会散开）
  // 文字层为空（没画出任何国名/省名）就整块跳过，省一次全屏合成
  if(_labelHasContent){
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(labelCv,0,0);
  }
  _labelMs=_labelMs*0.85+(performance.now()-_t)*0.15;
}

/* 只有相机或标签数据变了才重画文字层 */
function ensureLabels(){
  const key=cam.x.toFixed(2)+'|'+cam.y.toFixed(2)+'|'+cam.z.toFixed(4)+'|'+cw+'|'+ch+'|'+dpr+'|'+labelEpoch;
  if(key===labelKey) return;
  labelKey=key; _labelDraws++;
  _labelHasContent=false;
  const w=Math.max(1,Math.floor(cw*dpr)), h=Math.max(1,Math.floor(ch*dpr));
  if(labelCv.width!==w||labelCv.height!==h){ labelCv.width=w; labelCv.height=h; }
  lctx.setTransform(dpr,0,0,dpr,0,0);
  lctx.clearRect(0,0,cw,ch);
  drawLabels();
}
function drawLabels(){
  lctx.textAlign='center';
  if(cam.z<3.6){
    lctx.font='600 12px "Microsoft YaHei",sans-serif';
    lctx.lineWidth=3; lctx.strokeStyle='rgba(0,0,0,0.75)'; lctx.fillStyle='#f0e6cf';
    for(let c=1;c<countries.length;c++){
      const cc=countries[c]; if(!cc||!cc.alive||!cc.lx) continue;
      const [sx,sy]=w2s(cc.lx,cc.ly);
      if(sx<-60||sx>cw+60||sy<0||sy>ch) continue;
      _labelHasContent=true;
      lctx.strokeText(cc.name,sx,sy); lctx.fillText(cc.name,sx,sy);
    }
  } else {
    lctx.font='10px "Microsoft YaHei",sans-serif';
    lctx.lineWidth=2; lctx.strokeStyle='rgba(0,0,0,0.6)'; lctx.fillStyle='rgba(235,225,200,0.8)';
    const [wx0,wy0]=s2w(0,0),[wx1,wy1]=s2w(cw,ch);
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i]; if(!p||!p.pix.length) continue;
      if(p.cx<wx0||p.cx>wx1||p.cy<wy0||p.cy>wy1) continue;
      const [sx,sy]=w2s(p.cx,p.cy+7);
      _labelHasContent=true;
      lctx.strokeText(p.name,sx,sy); lctx.fillText(p.name,sx,sy);
    }
  }
  lctx.textAlign='left';
}

function armyPos(a){
  if(a.isNavy&&a.navPath&&a.navPath.length){
    const raw=(a.navIdxF!==undefined?a.navIdxF:a.navIdx)||0;
    const i=Math.min(Math.max(0,Math.round(raw)),a.navPath.length-1);
    const px=a.navPath[i];
    const r=(px/COLS)|0, c=px%COLS;
    return [c+0.5, r+0.5]; // 像素中心 = 屏幕"世界坐标"
  }
  if(a.path.length){
    const f=provinces[a.prov], t=provinces[a.path[0]];
    const t2=clamp(a.prog/HOP,0,1);
    return [lerp(f.cx,t.cx,t2),lerp(f.cy,t.cy,t2)];
  }
  const p=provinces[a.prov]; return [p.cx,p.cy];
}
/* 征兵中的省份：画一个进度环 + 剩余月数，方便直观看到哪里在集结 */
function drawRecruits(){
  if(!recruits||!recruits.length) return;
  if(cam.z<1.1) return;
  ctx.textAlign='center';
  for(const r of recruits){
    const p=provinces[r.prov]; if(!p||!p.pix.length) continue;
    const [sx,sy]=w2s(p.cx,p.cy);
    if(sx<-30||sx>cw+30||sy<-30||sy>ch+30) continue;
    const c=countries[r.owner];
    const col=c?c.color:[200,200,200];
    const k=clamp(1-r.days/Math.max(1,r.total),0,1);
    ctx.beginPath(); ctx.arc(sx,sy,10,0,Math.PI*2);
    ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.25)'; ctx.lineWidth=3; ctx.stroke();
    ctx.beginPath(); ctx.arc(sx,sy,10,-Math.PI/2,-Math.PI/2+Math.PI*2*k);
    ctx.strokeStyle=`rgb(${col[0]|0},${col[1]|0},${col[2]|0})`; ctx.lineWidth=3; ctx.stroke();
    ctx.fillStyle='#f0e6cf'; ctx.font='700 9px "Microsoft YaHei",sans-serif';
    ctx.fillText(String(Math.max(1,Math.ceil(r.days/30))),sx,sy+3);
  }
  ctx.textAlign='left';
}
function drawArmies(){
  const c0=countries[player];
  // 选中军队路径
  const sa=armies.find(a=>a.id===selectedArmy);
  if(sa&&sa.owner===player){
    if(sa.isNavy&&sa.navPath&&sa.navPath.length){
      // 海路虚线（沿像素路径）
      ctx.strokeStyle='rgba(120,200,255,0.9)'; ctx.lineWidth=1.8; ctx.setLineDash([5,4]);
      ctx.beginPath();
      let [px,py]=w2s(...armyPos(sa)); ctx.moveTo(px,py);
      for(let i=sa.navIdx;i<sa.navPath.length;i++){
        const pix=sa.navPath[i], r=(pix/COLS)|0, c=pix%COLS;
        const [x,y]=w2s(c+0.5,r+0.5); ctx.lineTo(x,y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    } else if(sa.path.length){
      ctx.strokeStyle='rgba(255,215,120,0.85)'; ctx.lineWidth=2; ctx.setLineDash([6,5]);
      ctx.beginPath();
      let [px,py]=w2s(...armyPos(sa)); ctx.moveTo(px,py);
      for(const pid of sa.path){ const p=provinces[pid]; const [x,y]=w2s(p.cx,p.cy); ctx.lineTo(x,y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // 先剔除视野外的军队；文字描边（strokeText）非常贵，
  // 视野里军队太多或缩得太小时就不画兵力数字，否则光这一项每帧就要几十毫秒
  const vis=[];
  for(const a of armies){
    const [wx,wy]=armyPos(a);
    const [sx,sy]=w2s(wx,wy);
    if(sx<-30||sx>cw+30||sy<-30||sy>ch+30) continue;
    vis.push([a,sx,sy]);
  }
  _visArmies=vis.length;
  const showStr = vis.length<=60 || cam.z>=1.4;
  for(const [a,sx,sy] of vis){
    const s=13;
    if(a.isNavy){
      // 海军小船：蓝色填充 + 三角帆
      const ownCol = a.owner===player ? '#88c8ff' : (countries[a.owner].color.map(v=>Math.min(255,v+40)|0));
      ctx.fillStyle = a.owner===player ? '#246b9a' : `rgb(${ownCol[0]|0},${ownCol[1]|0},${ownCol[2]|0})`;
      ctx.beginPath(); ctx.moveTo(sx-7,sy-5); ctx.lineTo(sx+7,sy-5); ctx.lineTo(sx,sy+5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = a.owner===player ? '#aae0ff' : '#1a1a1a'; ctx.lineWidth = a.id===selectedArmy?2.5:1.4;
      ctx.stroke();
      // 船桅
      ctx.beginPath(); ctx.moveTo(sx,sy-5); ctx.lineTo(sx,sy-9); ctx.stroke();
      if(showStr){
        ctx.fillStyle='#cce8ff'; ctx.strokeStyle='#000'; ctx.lineWidth=2.5;
        ctx.font='700 9px sans-serif'; ctx.textAlign='center';
        const t=fmtK(a.str);
        ctx.strokeText(t,sx,sy-12); ctx.fillText(t,sx,sy-12);
      }
    } else {
      const col=countries[a.owner].color;
      ctx.fillStyle=`rgb(${col[0]|0},${col[1]|0},${col[2]|0})`;
      ctx.strokeStyle= a.owner===player?'#ffe9b0':'#1a1a1a';
      ctx.lineWidth= a.id===selectedArmy?2.5:1.5;
      ctx.fillRect(sx-s/2,sy-s/2,s,s); ctx.strokeRect(sx-s/2,sy-s/2,s,s);
      if(showStr){
        ctx.fillStyle='#fff'; ctx.strokeStyle='#000'; ctx.lineWidth=2.5;
        ctx.font='700 9px sans-serif'; ctx.textAlign='center';
        const t=fmtK(a.str);
        ctx.strokeText(t,sx,sy+3); ctx.fillText(t,sx,sy+3);
      }
    }
    if(battleProvs.has(a.prov)){
      ctx.strokeStyle='#ff5040'; ctx.lineWidth=2.5;
      ctx.beginPath(); ctx.moveTo(sx-s/2-4,sy-s/2-4); ctx.lineTo(sx+s/2+4,sy+s/2+4);
      ctx.moveTo(sx+s/2+4,sy-s/2-4); ctx.lineTo(sx-s/2-4,sy+s/2+4); ctx.stroke();
    }
  }
  ctx.textAlign='left';
}
function drawSiegeBars(){
  if(cam.z<2.5) return;
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(p.siege>0&&p.pix.length){
      const [sx,sy]=w2s(p.cx,p.cy);
      if(sx<0||sx>cw||sy<0||sy>ch) continue;
      ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(sx-11,sy+9,22,4);
      ctx.fillStyle='#e8b050'; ctx.fillRect(sx-10,sy+10,20*clamp(p.siege/100,0,1),2);
    }
  }
}

/* ---------- 战败 ---------- */
function showDefeat(cid){
  paused=true;
  const c=countries[cid||player];
  document.getElementById('defeat-text').textContent=`${c?c.name:''} 于公元${cal.y}年失去全部疆土。史官合上了这一页。`;
  document.getElementById('defeatmodal').classList.remove('hidden');
}

/* =====================================================================
   四、UI
   ===================================================================== */
const $=id=>document.getElementById(id);
/* 只显示公开消息（f=0）与我自己的私密消息（f=我的国家 id） */
function renderLog(){
  const me=player|0;
  $('log-body').innerHTML=logEntries
    .filter(e=>!e.f||e.f===me)
    .map(e=>`<div class="le ${e.cls}">${e.d} · ${e.t}</div>`).join('');
}
/* 核心通过 UI 钩子回调界面；服务端加载核心时这些钩子是空实现 */
UI.log      = ()=>renderLog();
UI.panel    = ()=>refreshPanel();
UI.topbar   = ()=>updateTopbar();
UI.recolorNbrs = (pid)=>recolorProvAndNbrs(pid);
UI.cedeReset   = ()=>{ cedeMap.on=false; cedeMap.enemy=0; if(grantMap.on) grantMapCancel(); };
UI.defeat      = (cid)=>{ if(!MP.online) showDefeat(cid); };

/* 核心按国家保存和约提案；本机视角 = pendingOffers[player] */
Object.defineProperty(window,'pendingOffer',{
  configurable:true,
  get(){ return (typeof pendingOffers!=='undefined'&&pendingOffers[player])||null; },
  set(v){ if(typeof pendingOffers==='undefined') return;
          if(v) pendingOffers[player]=v; else delete pendingOffers[player]; }
});

function updateTopbar(){
  if(!player) return;
  const c=countries[player];
  const oc=countries[player];
  let owned=0;
  for(const pid of oc.provList) if(provinces[pid].controller===player) owned++;
  const str=countryStrength(player);
  $('tb-country').innerHTML=`<span class="chip" style="background:rgb(${c.color.map(v=>v|0)})"></span><b>${c.name}</b>`;
  $('tb-ruler').innerHTML=`统治者 <b>${c.ruler}</b> · ${c.provList.length}省(${owned}控)`;
  $('tb-gold').innerHTML=`国库 <b style="color:${c.gold<10?'#ff9080':'#ffd080'}">${c.gold.toFixed(1)}</b> (${c.income>=0?'+':''}${c.income.toFixed(2)}/月)`;
  $('tb-mp').innerHTML=`人力 <b>${fmtK(c.mp)}/${fmtK(c.mpCap)}</b>`;
  $('tb-fl').innerHTML=`军力 <b>${fmtK(str)}/${fmtK(c.forceLimit)}</b>`;
  $('tb-date').textContent=fmtDate();
  $('btn-pause').textContent=paused?'▶ 继续':'⏸ 暂停';
}

/* =====================================================================
   地图编辑器（剧本编辑）
   ---------------------------------------------------------------------
   编辑的是一份"剧本"：只记录相对默认世界改了哪些省/国，所以几 KB 而已。
   · 完成后「下载」得到一份 .json 存到本地
   · 想让别人玩，得走「提交审核 → 管理员通过 → 地图大厅」
   编辑期间世界不推进（paused=true），也不会触发任何 AI。
   ===================================================================== */
let editMode={on:false,tool:'select',brush:0,sel:0,undo:[],name:'',author:'',desc:'',dirty:0,busy:false};
const EDIT_MAX_UNDO=200;

const EDIT_TOOLS=[
  {k:'select',label:'🔍 选择',  tip:'点省份 → 在右侧编辑它的归属/发展度/省名'},
  {k:'paint', label:'🖌 涂地',  tip:'点省份 → 立刻归入当前画笔国家'},
  {k:'pick',  label:'💧 吸色',  tip:'点省份 → 把它的归属国设为当前画笔'},
  {k:'capital',label:'🏛 定都', tip:'点省份 → 设为当前画笔国家的首都'},
];

function editBrushCountry(){ return countries[editMode.brush]||null; }
function editRebuild(){
  for(let i=1;i<countries.length;i++) if(countries[i]) countries[i].provList=[];
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(p.pix.length&&countries[p.owner]) countries[p.owner].provList.push(i);
  }
  for(let i=1;i<countries.length;i++){
    const c=countries[i]; if(!c) continue;
    c.alive=c.provList.length>0;
    recomputeCap(c);
    // 首都没了（或者被划走了）就换一个最大的省
    if(c.alive&&(!c.capital||!c.provList.includes(c.capital))){
      let best=c.provList[0], bl=-1;
      for(const pid of c.provList){ const L=provinces[pid].pix.length; if(L>bl){bl=L; best=pid;} }
      c.capital=best;
    }
    if(!c.alive) c.capital=0;
  }
  invalidateCamps();
  labelsDirty=true;
  rebuildLabels();
  recolorAll();
}
/* ---- 撤销栈：每次改动前先快照受影响的省/国 ---- */
function editSnapProv(pid){
  const p=provinces[pid];
  return {t:'p',id:pid,o:{owner:p.owner,tax:p.tax,prod:p.prod,man:p.man,name:p.name}};
}
function editSnapCountry(cid){
  const c=countries[cid]; if(!c) return null;
  return {t:'c',id:cid,o:{name:c.name,color:c.color.slice(),capital:c.capital,gold:c.gold}};
}
function editSnapArmies(){
  return {t:'a',o:armies.map(a=>({o:a.owner,p:a.prov,s:a.str,n:a.isNavy?1:0}))};
}
/* 一次用户操作可能同时改动多个省/国（涂地会同时影响原主、新主、该省），
   撤销必须把它们当成**一步**整体回滚，否则撤一次只回滚其中一个。 */
function editPushGroup(items){
  const list=(items||[]).filter(Boolean);
  if(!list.length) return;
  editMode.undo.push({t:'g',items:list});
  if(editMode.undo.length>EDIT_MAX_UNDO) editMode.undo.shift();
  editMode.dirty++;
}
function editApplySnap(s){
  if(s.t==='p'){ const p=provinces[s.id]; if(p) Object.assign(p,s.o); }
  else if(s.t==='c'){ const c=countries[s.id]; if(c){ c.name=s.o.name; c.enName=s.o.name; c.color=s.o.color.slice(); c.capital=s.o.capital; c.gold=s.o.gold; } }
  else if(s.t==='a'){
    armies=s.o.map((a,i)=>({id:i+1,owner:a.o,prov:a.p,str:a.s,path:[],prog:0,isNavy:a.n}));
    nextArmy=armies.length+1;
  }
}
function editUndo(){
  const s=editMode.undo.pop();
  if(!s){ pushLog('没有可撤销的操作了'); return; }
  // 按相反顺序回滚：后面的快照可能依赖前面的状态
  const items=(s.t==='g')?s.items.slice().reverse():[s];
  for(const it of items) editApplySnap(it);
  editRebuild(); editRefresh();
  pushLog('↩ 已撤销一步');
}

/* ---- 编辑动作 ---- */
function editPaint(pid){
  const p=provinces[pid]; if(!p||!p.pix.length) return;
  const cid=editMode.brush;
  if(!countries[cid]) return;
  if(p.owner===cid){ pushLog(`${p.name} 已经属于 ${countries[cid].name}`); return; }
  editPushGroup([editSnapProv(pid), editSnapCountry(p.owner), editSnapCountry(cid)]);
  p.owner=cid; p.controller=cid; p.siege=0;
  editRebuild(); editRefresh();
}
function editSetCapital(pid){
  const c=editBrushCountry(); const p=provinces[pid];
  if(!c||!p||!p.pix.length) return;
  if(p.owner!==c.id){ pushLog('首都必须在自己的领土上','war'); return; }
  editPushGroup([editSnapCountry(c.id)]);
  c.capital=pid;
  editRebuild(); editRefresh();
}
function editSetOwner(pid,cid){
  const p=provinces[pid], c=countries[cid];
  if(!p||!c) return;
  editPushGroup([editSnapProv(pid), editSnapCountry(p.owner), editSnapCountry(cid)]);
  p.owner=cid; p.controller=cid; p.siege=0;
  editRebuild(); editRefresh();
}
function editSetDev(pid,field,val){
  const p=provinces[pid]; if(!p) return;
  const v=Math.max(1,Math.min(99,Math.round(+val||1)));
  if(p[field]===v) return;
  editPushGroup([editSnapProv(pid)]);
  p[field]=v;
  const c=countries[p.owner]; if(c) recomputeCap(c);
  recolorAll(); editRefresh();
  if(mapMode==='dev') recolorAll();
}
function editSetProvName(pid,name){
  const p=provinces[pid]; if(!p) return;
  const nm=sanitizeCountryName(name);
  if(!nm){ pushLog('省名不能为空','war'); return; }
  editPushGroup([editSnapProv(pid)]);
  p.name=nm;
  labelsDirty=true; rebuildLabels(); editRefresh();
}
function editSetCountryName(cid,name){
  const c=countries[cid]; if(!c) return;
  const nm=sanitizeCountryName(name);
  if(!nm){ pushLog('国名不能为空','war'); return; }
  editPushGroup([editSnapCountry(cid)]);
  c.name=nm; c.enName=nm;
  labelsDirty=true; rebuildLabels(); editRefresh();
}
function editSetCountryColor(cid,rgb){
  const c=countries[cid]; if(!c) return;
  if(!Array.isArray(rgb)||rgb.length<3) return;
  const nums=rgb.slice(0,3).map(Number);
  if(!nums.every(v=>isFinite(v))) return;      // 含非数字 → 整体拒绝，别算出 NaN 颜色
  editPushGroup([editSnapCountry(cid)]);
  c.color=nums.map(v=>Math.max(0,Math.min(255,Math.round(v))));
  recolorAll(); editRefresh();
}
function editAddArmy(pid,str,navy){
  const p=provinces[pid]; if(!p||!p.pix.length) return;
  const cid=editMode.brush;
  if(!countries[cid]) return;
  const s=Math.max(100,Math.min(200000,Math.round(+str||5000)));
  editPushGroup([editSnapArmies()]);
  armies.push({id:nextArmy++, owner:cid, prov:pid, str:s, path:[], prog:0, isNavy:navy?1:0});
  editRefresh();
  pushLog(`⚔ 在 ${p.name} 为 ${countries[cid].name} 放置了 ${s} 人的起始军队`);
}
function editClearArmies(){
  if(!armies.length){ pushLog('当前没有起始军队'); return; }
  editPushGroup([editSnapArmies()]);
  armies=[]; nextArmy=1;
  editRefresh();
  pushLog('已清空全部起始军队');
}
/* 把当前画笔国家整块吞掉：它所有省份划给画笔（用于"删掉某个国家"） */
function editAbsorb(cid){
  const c=countries[cid]; if(!c||!c.provList.length) return;
  const to=editMode.brush;
  if(to===cid) return;
  const items=[editSnapCountry(cid), editSnapCountry(to)];
  for(const pid of [...c.provList]){
    items.push(editSnapProv(pid));            // 必须在改动该省之前取快照
    const p=provinces[pid]; p.owner=to; p.controller=to; p.siege=0;
  }
  editPushGroup(items);
  editRebuild(); editRefresh();
  pushLog(`${c.name} 的全部领土已划归 ${countries[to].name}`);
}

/* ---- 地图交互 ---- */
function editMapClick(pid){
  const p=provinces[pid];
  if(!p||!p.pix.length) return true;         // 编辑模式下点海面什么都不做
  selectedProv=pid;
  const t=editMode.tool;
  if(t==='paint') editPaint(pid);
  else if(t==='pick'){ editMode.brush=p.owner||editMode.brush; updateEditBar(); editRefresh(); }
  else if(t==='capital') editSetCapital(pid);
  else editRefresh();
  return true;
}

/* ---- 顶部工具条 ---- */
function updateEditBar(){
  const bar=$('editbar'); if(!bar) return;
  if(!editMode.on){ bar.classList.add('hidden'); bar.innerHTML=''; return; }
  bar.classList.remove('hidden');
  const b=editBrushCountry();
  const tools=EDIT_TOOLS.map(t=>
    `<button class="act${editMode.tool===t.k?' on':''}" data-act="edit-tool" data-v="${t.k}" title="${t.html||t.tip||''}">${t.label}</button>`).join('');
  const total=Object.keys(makeScenarioQuiet().provinces).length;
  const ctotal=Object.keys(makeScenarioQuiet().countries).length;
  bar.innerHTML=`
    <b style="color:#ffd890;white-space:nowrap">🗺 地图编辑器</b>
    <button class="act" data-act="edit-info" title="填写地图名称、作者与简介">📝 ${escHtml(editMode.name||'未命名地图')}</button>
    <span class="sep2"></span>
    ${tools}
    <span class="sep2"></span>
    <span class="hint" style="white-space:nowrap">画笔：</span>
    <span class="cd" style="display:inline-block;width:12px;height:12px;background:rgb(${b?b.color.map(v=>v|0).join(','):'120,120,120'});border:1px solid #000"></span>
    <select id="edit-brush" title="选择要涂成哪个国家">${editBrushOptions()}</select>
    <span class="sep2"></span>
    <button class="act" data-act="edit-undo" title="撤销上一步">↩ 撤销</button>
    <button class="act" data-act="edit-clear-armies" title="清空全部起始军队">🧹 清空军队</button>
    <span class="sep2"></span>
    <span class="hint" style="white-space:nowrap">已改 ${total} 省 / ${ctotal} 国</span>
    <button class="act" style="background:#1c3320;border-color:#509060;color:#a8e0b0" data-act="edit-download" title="把这张地图保存成 .json 下载到本地">⬇ 下载</button>
    <button class="act" style="background:#2a2440;border-color:#6a5a9a;color:#d0b0ff" data-act="edit-submit" title="提交给管理员审核，通过后会出现在地图大厅">📤 提交审核</button>
    <button class="act" data-act="edit-exit" title="放弃编辑并返回">✕ 退出</button>`;
  const sel=$('edit-brush');
  if(sel) sel.value=String(editMode.brush);
}
/* 结算当前改动量（不产生副作用；makeScenario 只读不写） */
function makeScenarioQuiet(){
  try{ return makeScenario({name:editMode.name, author:editMode.author, desc:editMode.desc}); }
  catch(e){ return {countries:{},provinces:{},armies:[]}; }
}
function editBrushOptions(){
  const list=[...countries].filter(c=>c).sort((a,b)=>{
    if(a.alive!==b.alive) return a.alive?-1:1;
    if(a.provList.length!==b.provList.length) return b.provList.length-a.provList.length;
    return a.name.localeCompare(b.name);
  });
  return list.map(c=>`<option value="${c.id}"${c.id===editMode.brush?' selected':''}>${escHtml(c.name)}（${c.provList.length}省${c.alive?'':',已亡'}）</option>`).join('');
}

/* ---- 右侧编辑面板 ---- */
function editPanel(){
  let h=`<div class="ehint">点地图上的省份来编辑。当前工具：<b>${(EDIT_TOOLS.find(t=>t.k===editMode.tool)||{}).label||''}</b></div>`;
  const p=selectedProv>0?provinces[selectedProv]:null;
  if(p&&p.pix.length){
    const ow=countries[p.owner];
    h+=`<div class="sep"></div><h3>${escHtml(p.name)}</h3>
      <div class="row"><span>当前归属</span>
        <span class="cd" style="display:inline-block;width:11px;height:11px;background:rgb(${ow?ow.color.map(v=>v|0).join(','):'120,120,120'});border:1px solid #000;vertical-align:middle"></span>
        ${ow?escHtml(ow.name):'无主'}</div>
      <div><button class="act" data-act="edit-paint-here" data-v="${p.id}" title="把该省划给当前画笔国家">🖌 划给画笔国家</button>
           <button class="act" data-act="edit-capital-here" data-v="${p.id}" title="设为画笔国家的首都">🏛 设为画笔首都</button></div>
      <div class="sep"></div>
      <h4>发展度</h4>
      <div class="row"><span>税基</span><input class="ednum" type="number" min="1" max="99" value="${p.tax}" data-act="edit-dev" data-f="tax" data-v="${p.id}"></div>
      <div class="row"><span>生产</span><input class="ednum" type="number" min="1" max="99" value="${p.prod}" data-act="edit-dev" data-f="prod" data-v="${p.id}"></div>
      <div class="row"><span>兵源</span><input class="ednum" type="number" min="1" max="99" value="${p.man}" data-act="edit-dev" data-f="man" data-v="${p.id}"></div>
      <h4>省名</h4>
      <div class="row"><input id="edit-pname" type="text" maxlength="12" value="${escHtml(p.name)}" style="flex:1"><button class="act" data-act="edit-pname-set" data-v="${p.id}">改名</button></div>
      <div class="sep"></div>
      <h4>起始军队</h4>
      <div class="row"><span>兵力</span><input class="ednum" id="edit-army-str" type="number" min="100" max="200000" step="500" value="5000">
        <button class="act" data-act="edit-army-add" data-v="${p.id}">⚔ 放置陆军</button>
        <button class="act" data-act="edit-army-add-navy" data-v="${p.id}" title="需要海岸省份">⛵ 放置舰队</button></div>
      <div class="hint">放在该省的军队会归当前画笔国家所有。</div>`;
  } else {
    h+=`<div class="sep"></div><p class="hint">还没有选中省份。左键点地图上任一省份开始编辑。</p>`;
  }
  /* 画笔国家编辑 */
  const b=editBrushCountry();
  if(b){
    h+=`<div class="sep"></div><h3>画笔国家 · ${escHtml(b.name)}</h3>
      <div class="row"><span>国名</span><input id="edit-cname" type="text" maxlength="12" value="${escHtml(b.name)}" style="flex:1"><button class="act" data-act="edit-cname-set">改名</button></div>
      <div class="row"><span>旗色</span></div>
      <div class="swatches" style="max-width:100%">${
        (()=>{ let sw=''; for(const L of [0.36,0.5,0.64]) for(let i=0;i<12;i++){
          const rgb=hsl(i/12,0.58,L).map(v=>Math.round(v));
          const sel=b.color.every((v,k)=>Math.abs(v-rgb[k])<3);
          sw+=`<button class="sw${sel?' sel':''}" data-act="edit-ccolor" data-v="${b.id}" data-rgb="${rgb.join(',')}" style="background:rgb(${rgb.join(',')})"></button>`;
        } return sw; })()
      }</div>
      <div class="row"><span>首都</span>${b.capital?escHtml(provinces[b.capital].name):'—'} · 共 ${b.provList.length} 省</div>
      <div><button class="act danger" data-act="edit-absorb" data-v="${b.id}" title="把该国其余省份全部划给…（慎用）">⚠ 该国并入他国</button></div>
      <div class="hint">「该国并入他国」会把它的全部领土交给当前选中的另一个国家，用来删掉不想要的国家。</div>`;
  }
  return h;
}

function editRefresh(){ updateEditBar(); if(editMode.on) refreshPanel(); }

/* ---- 进入 / 退出 ---- */
function openEditor(){
  MP.online=false;
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
  captureScenarioBase();
  player=0; started=true; paused=true; speed=2;
  selectedProv=0; selectedArmy=0;
  const first=countries.find(c=>c&&c.alive&&c.provList.length>4);
  editMode={on:true,tool:'select',brush:first?first.id:1,sel:0,undo:[],name:'未命名地图',author:'',desc:'',dirty:0,busy:false};
  $('selectmodal').classList.add('hidden');
  $('topbar').classList.remove('hidden');
  $('modebar').classList.remove('hidden');
  $('sidepanel').classList.remove('hidden');
  $('logpanel').classList.remove('hidden');
  setMode('political');
  updateTopbar(); updateEditBar(); recolorAll(); rebuildLabels(); refreshPanel(); renderLog();
  pushLog('🗺 已进入地图编辑器。左键点省份选中，「涂地」工具下点击即划归画笔国家；完成后「⬇ 下载」保存到本地，或「📤 提交审核」上线。','gold');
}
function closeEditor(){
  editMode.on=false;
  updateEditBar();
  $('topbar').classList.add('hidden');
  $('modebar').classList.add('hidden');
  $('sidepanel').classList.add('hidden');
  $('logpanel').classList.add('hidden');
  started=false; player=0;
  $('selectmodal').classList.remove('hidden');
  refreshStartLoadBtn();
  renderSelectList('');
}

/* ---- 地图信息 ---- */
function editInfoDialog(){
  const nm=prompt('地图名称（最多 24 字）：', editMode.name==='未命名地图'?'':editMode.name);
  if(nm===null) return;
  const au=prompt('作者署名（最多 16 字，可留空）：', editMode.author||'');
  if(au===null) return;
  const de=prompt('一句话简介（最多 160 字，可留空）：', editMode.desc||'');
  if(de===null) return;
  editMode.name=sanitizeMapText(nm,MAP_NAME_MAX)||'未命名地图';
  editMode.author=sanitizeMapText(au,MAP_AUTHOR_MAX);
  editMode.desc=sanitizeMapText(de,MAP_DESC_MAX);
  editRefresh();
}
/* ---- 下载到本地 ---- */
function editDownload(){
  const sc=makeScenario({name:editMode.name,author:editMode.author,desc:editMode.desc});
  const text=JSON.stringify(sc);
  const fn=(sanitizeMapText(editMode.name,MAP_NAME_MAX)||'map').replace(/[\\/:*?"<>|\s]+/g,'_')+'.dynasty-map.json';
  try{
    const blob=new Blob([text],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=fn;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },0);
    pushLog(`⬇ 已下载「${editMode.name}」（${text.length} 字节）到本地`,'gold');
  }catch(e){ pushLog('浏览器不允许直接下载，已把内容打印到日志','war'); pushLog(text); }
}
/* ---- 提交审核 ---- */
async function editSubmit(){
  if(editMode.busy) return;
  const sc=makeScenario({name:editMode.name,author:editMode.author,desc:editMode.desc});
  if(!Object.keys(sc.provinces).length&&!Object.keys(sc.countries).length){
    pushLog('这张地图还没有任何改动，先编辑一下再提交','war'); return;
  }
  if(editMode.name==='未命名地图'||!editMode.name){
    pushLog('请先点「📝 未命名地图」填写地图名称','war'); editInfoDialog(); return;
  }
  editMode.busy=true;
  pushLog('正在提交，请稍候……');
  try{
    // 独立域名挂在根路径、IP 站点挂在 /gs/ 下，两种入口都要能取到 API
    const base=(location.pathname.replace(/[^/]*$/,'')||'/').replace(/\/$/,'');
    const r=await fetch(base+'/api/maps',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({meta:{name:editMode.name,author:editMode.author,desc:editMode.desc},scenario:sc}),
    });
    const j=await r.json().catch(()=>({ok:false,err:'服务器返回了无法解析的内容'}));
    if(j.ok){
      pushLog(`📤 提交成功！编号 ${j.id}，等待管理员审核。通过后会出现在「地图大厅」。`,'gold');
    } else {
      pushLog('提交失败：'+(j.err||('HTTP '+r.status)),'war');
    }
  }catch(e){
    pushLog('提交失败：'+e.message,'war');
  }
  editMode.busy=false;
}

/* =====================================================================
   地图大厅
   ---------------------------------------------------------------------
   列出管理员审核通过的自定义地图。选中一张 → 拉取剧本 → 在本地建出世界 →
   回到选国界面。之后无论是单人开局还是联机开房，用的都是这张地图。
   ===================================================================== */
let hallMaps=[], hallFilter='', hallLoading=false;
/* 当前选用的自定义地图；null = 官方默认世界 */
let currentMap=null;

function apiBase(){
  return (location.pathname.replace(/[^/]*$/,'')||'/').replace(/\/$/,'');
}
async function apiGet(path){
  const r=await fetch(apiBase()+path,{headers:{'Accept':'application/json'}});
  const j=await r.json().catch(()=>null);
  if(!j) throw new Error('服务器返回了无法解析的内容（HTTP '+r.status+'）');
  return j;
}

async function openMapHall(){
  $('selectmodal').classList.add('hidden');
  $('hallmodal').classList.remove('hidden');
  $('hall-list').innerHTML='<p class="hint">正在读取地图列表……</p>';
  try{
    const j=await apiGet('/api/maps');
    hallMaps=(j&&j.maps)||[];
  }catch(e){
    hallMaps=[];
    $('hall-list').innerHTML=`<p class="hint" style="color:#ff9080">读取失败：${escHtml(e.message)}</p>`;
    return;
  }
  renderHallList();
}
function closeMapHall(){
  $('hallmodal').classList.add('hidden');
  $('selectmodal').classList.remove('hidden');
}
function renderHallList(){
  const q=hallFilter.trim().toLowerCase();
  const list=hallMaps.filter(m=>!q||(m.name||'').toLowerCase().includes(q)||(m.author||'').toLowerCase().includes(q));
  let h=`<div class="c-row" data-act="hall-official" title="回到原始的世界地图">
    <span class="cd" style="background:linear-gradient(90deg,#4a7a4a,#3a5a8a)"></span>
    <span class="cn"><b>官方地图</b> <span class="badge peace">默认</span></span>
    <span class="cs">Natural Earth 110m · 2007 省 / 177 国</span>
  </div>`;
  if(!list.length){
    h+=`<p class="hint" style="margin-top:10px">${hallMaps.length?'没有匹配的地图。':'还没有人提交过地图。你可以用「🛠 地图编辑器」做一张，然后提交审核。'}</p>`;
  }
  for(const m of list){
    const kb=(m.size/1024).toFixed(1);
    const dt=(m.createdAt||'').slice(0,10);
    h+=`<div class="c-row" data-act="hall-pick" data-v="${m.id}" title="作者：${escHtml(m.author||'匿名')}">
      <span class="cd" style="background:#6a5a9a"></span>
      <span class="cn"><b>${escHtml(m.name)}</b> <span class="hint">by ${escHtml(m.author||'匿名')}</span></span>
      <span class="cs">${m.provinces||0} 省改动 · ${kb}KB · ▶${m.plays||0} · ${dt}</span>
    </div>
    ${m.desc?`<div class="hint" style="margin:-4px 0 6px 25px">${escHtml(m.desc)}</div>`:''}`;
  }
  $('hall-list').innerHTML=h;
}
/* 选用官方默认地图 */
function useOfficialMap(){
  currentMap=null;
  closeMapHall();
  resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
  renderSelectList('');
  updateMapBadge();
}
async function pickHallMap(id){
  if(hallLoading) return;
  hallLoading=true;
  $('hall-list').innerHTML='<p class="hint">正在下载地图……</p>';
  try{
    const j=await apiGet('/api/maps/'+encodeURIComponent(id));
    if(!j.ok) throw new Error(j.err||'取图失败');
    const err=buildWorldFromScenario(j.scenario);
    if(err) throw new Error(err);
    currentMap={id, name:j.meta.name, author:j.meta.author, hash:j.meta.hash, scenario:j.scenario};
    closeMapHall();
    renderSelectList('');
    updateMapBadge();
    pushLog(`🗺 已选用地图《${j.meta.name}》（${j.meta.author||'匿名'}）· 共 ${Object.keys(j.scenario.provinces||{}).length} 处省份改动`,'gold');
    // 记一次游玩
    fetch(apiBase()+'/api/maps/'+encodeURIComponent(id)+'/play',{method:'POST'}).catch(()=>{});
  }catch(e){
    $('hall-list').innerHTML=`<p class="hint" style="color:#ff9080">加载失败：${escHtml(e.message)}</p>`;
  }
  hallLoading=false;
}
/* 选国界面顶部显示当前用的哪张地图 */
function updateMapBadge(){
  const el=$('map-badge'); if(!el) return;
  if(currentMap){
    el.innerHTML=`🗺 当前地图：<b style="color:#d0b0ff">${escHtml(currentMap.name)}</b> <span class="hint">by ${escHtml(currentMap.author||'匿名')}</span>
      <button class="act" style="margin-left:8px;padding:2px 8px;font-size:11px" data-act="map-hall">换一张</button>`;
    el.style.display='';
  } else {
    el.innerHTML=`🗺 当前地图：<b>官方地图</b>
      <button class="act" style="margin-left:8px;padding:2px 8px;font-size:11px" data-act="map-hall">地图大厅</button>`;
    el.style.display='';
  }
}

/* =====================================================================
   地图审核后台（管理员）
   ---------------------------------------------------------------------
   入口在开始页；口令由服务端 MAP_ADMIN_PASS 决定，没配就整体不可用。
   预览直接复用游戏自己的渲染：把剧本套到背景世界再画出来，
   比任何文字描述都直观。审完「返回列表」会恢复原来的地图。
   ===================================================================== */
let adminTok='', adminTab='pending', adminPvId='', adminRestore=null;

function openAdmin(){
  $('lobby').classList.add('hidden');
  $('adminmodal').classList.remove('hidden');
  $('admin-msg').textContent='';
  // 会话内已登录就直接进主界面
  if(adminTok&&window.sessionStorage){
    $('admin-login').classList.add('hidden');
    $('admin-main').classList.remove('hidden');
    loadAdminList();
  } else {
    $('admin-login').classList.remove('hidden');
    $('admin-main').classList.add('hidden');
  }
  $('admin-preview').classList.add('hidden');
}
function closeAdmin(){
  if(adminPvId) adminStopPreview();
  $('adminmodal').classList.add('hidden');
  $('lobby').classList.remove('hidden');
}
async function adminLogin(){
  const pass=$('admin-pass')?$('admin-pass').value:'';
  $('admin-msg').textContent='正在登录……';
  try{
    const r=await fetch(apiBase()+'/api/admin/login',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});
    const j=await r.json().catch(()=>null);
    if(!j||!j.ok){ $('admin-msg').textContent=(j&&j.err)||'登录失败'; return; }
    adminTok=j.token;
    try{ sessionStorage.setItem('gs_admin_tok',adminTok); }catch(e){}
    $('admin-msg').textContent='';
    $('admin-login').classList.add('hidden');
    $('admin-main').classList.remove('hidden');
    loadAdminList();
  }catch(e){ $('admin-msg').textContent='登录失败：'+e.message; }
}
function adminLogout(){
  adminTok='';
  try{ sessionStorage.removeItem('gs_admin_tok'); }catch(e){}
  $('admin-main').classList.add('hidden');
  $('admin-login').classList.remove('hidden');
}
function adminHeaders(){ return {'Content-Type':'application/json','x-admin-token':adminTok}; }
async function loadAdminList(){
  $('admin-list').innerHTML='<p class="hint">读取中……</p>';
  try{
    const r=await fetch(apiBase()+'/api/admin/maps?status='+encodeURIComponent(adminTab),{headers:adminHeaders()});
    const j=await r.json().catch(()=>null);
    if(!j||!j.ok){ $('admin-list').innerHTML=`<p class="hint" style="color:#ff9080">${escHtml((j&&j.err)||'读取失败')}</p>`; return; }
    const st=j.stats||{};
    $('admin-stats').textContent=`共 ${st.total||0} 张 · 待审 ${st.pending||0} · 已上线 ${st.approved||0}`;
    const list=j.maps||[];
    if(!list.length){ $('admin-list').innerHTML='<p class="hint">这里还没有地图。</p>'; return; }
    $('admin-list').innerHTML=list.map(m=>{
      const kb=(m.size/1024).toFixed(1), dt=(m.createdAt||'').replace('T',' ').slice(0,16);
      return `<div class="c-row" data-act="admin-preview" data-v="${m.id}" title="点击预览这张地图">
        <span class="cd" style="background:#6a5a9a"></span>
        <span class="cn"><b>${escHtml(m.name)}</b> <span class="hint">by ${escHtml(m.author||'匿名')}</span></span>
        <span class="cs">${m.provinces||0} 省改动 · ${m.countries||0} 国改动 · ${kb}KB · ${dt} · ▶${m.plays||0}</span>
      </div>
      ${m.desc?`<div class="hint" style="margin:-4px 0 6px 25px">${escHtml(m.desc)}</div>`:''}`;
    }).join('');
  }catch(e){ $('admin-list').innerHTML=`<p class="hint" style="color:#ff9080">${escHtml(e.message)}</p>`; }
}
/* 预览：把这张地图套到背景世界并画出来 */
async function adminPreview(id){
  if(adminRestore===null) adminRestore=currentMap;   // 记住原来用的地图
  $('admin-list').innerHTML='<p class="hint">正在载入地图……</p>';
  let j=null;
  try{
    const r=await fetch(apiBase()+'/api/admin/maps/'+encodeURIComponent(id),{headers:adminHeaders()});
    j=await r.json().catch(()=>null);
  }catch(e){}
  if(!j||!j.ok){ $('admin-list').innerHTML=`<p class="hint" style="color:#ff9080">${escHtml((j&&j.err)||'载入失败')}</p>`; return; }
  const err=buildWorldFromScenario(j.scenario);
  if(err){ $('admin-list').innerHTML=`<p class="hint" style="color:#ff9080">这张地图无法载入：${escHtml(err)}</p>`; return; }
  adminPvId=id;
  $('admin-main').classList.add('hidden');
  $('admin-preview').classList.remove('hidden');
  $('adminmodal').classList.add('hidden');       // 让出屏幕看图
  const m=j.meta;
  $('admin-pv-name').textContent=`${m.name}${m.author?'（'+m.author+'）':''}`;
  $('admin-pv-info').innerHTML=`状态 <b>${j.status}</b> · ${Object.keys(j.scenario.provinces||{}).length} 省改动 · ${Object.keys(j.scenario.countries||{}).length} 国改动 · 编号 ${m.id} · 哈希 ${m.hash}
    ${j.note?`<br>上次审核备注：${escHtml(j.note)}`:''}`;
  recolorAll(); rebuildLabels();
  const alive=countries.filter(c=>c&&c.alive);
  let big=alive.slice().sort((a,b)=>totalDev(b)-totalDev(a))[0];
  if(big&&provinces[big.capital]){ cam.x=provinces[big.capital].cx; cam.y=provinces[big.capital].cy; cam.z=2; }
  pushLog(`🔎 正在预览地图《${m.name}》—— 审完后点「返回列表」恢复`,'gold');
}
/* 预览结束：恢复原来的地图 */
function adminStopPreview(){
  if(adminRestore===null) adminRestore=null;
  if(adminRestore&&adminRestore.scenario){
    buildWorldFromScenario(adminRestore.scenario);
    currentMap=adminRestore;
  } else {
    resetWorld(); setSeed(SCENARIO_SEED); buildWorld();
    currentMap=null;
  }
  adminRestore=null;
  adminPvId='';
  recolorAll(); rebuildLabels(); updateMapBadge();
  $('admin-preview').classList.add('hidden');
  $('admin-main').classList.remove('hidden');
  $('adminmodal').classList.remove('hidden');
  loadAdminList();
}
async function adminReview(action){
  if(!adminPvId) return;
  const note=action==='reject'?(prompt('拒绝理由（会展示给提交者，可留空）：','')||''):'';
  try{
    const r=await fetch(apiBase()+'/api/admin/review',{
      method:'POST',headers:adminHeaders(),body:JSON.stringify({id:adminPvId,action,note})});
    const j=await r.json().catch(()=>null);
    if(!j||!j.ok){ alert((j&&j.err)||'操作失败'); return; }
    pushLog(action==='approve'?`✅ 地图已通过审核并上线`:`❌ 地图已被拒绝`,'gold');
    adminStopPreview();
  }catch(e){ alert('操作失败：'+e.message); }
}
async function adminDelete(){
  if(!adminPvId) return;
  if(!confirm('确定要永久删除这张地图吗？（不可恢复）')) return;
  try{
    const r=await fetch(apiBase()+'/api/admin/delete',{
      method:'POST',headers:adminHeaders(),body:JSON.stringify({id:adminPvId})});
    const j=await r.json().catch(()=>null);
    if(!j||!j.ok){ alert((j&&j.err)||'删除失败'); return; }
    pushLog('🗑 地图已删除','war');
    adminStopPreview();
  }catch(e){ alert('删除失败：'+e.message); }
}

function refreshPanel(){
  if(!started) return;
  _panelDraws++;
  _panelSig=panelSignature();   // 记录本次渲染对应的状态指纹
  const b=$('panel-body');
  if(editMode.on){ b.innerHTML=editPanel(); updateTopbar(); return; }
  if(uiTab==='info') b.innerHTML=infoTab();
  else if(uiTab==='diplo'){
    if(_imeComposing){
      // IME 组字中：只更新列表，不销毁 input（保持 IME 连续）
      renderDiploList();
    } else {
      b.innerHTML=`<input type="text" id="diplo-search" placeholder="搜索国家（支持中文）……">
        <p class="hint">宣战无理由惩罚（本作简化）。停战期内无法宣战。附庸需两国接壤；战时附庸需占领≥50%+60分，和平册封限小国。<b style="color:#d0b0ff">点击国家行可查看其宗主国/附庸国（附庸以紫色高亮）</b>。</p>
        <div id="diplo-list"></div>`;
      const s=$('diplo-search');
      if(s){s.value=uiSearch; s.focus();s.setSelectionRange(s.value.length,s.value.length);}
      renderDiploList();
    }
  } else { b.innerHTML=warTab(); if(uiTab==='war') updateDemandUI(); }
  updateTopbar();
}

function renderDiploList(){
  const box=$('diplo-list'); if(!box) return;
  const list=[...countries].filter(c=>c&&c.alive&&c.id!==player)
    .filter(c=>!uiSearch||c.name.includes(uiSearch)||c.enName.toLowerCase().includes(uiSearch.toLowerCase()))
    .sort((a,b)=>totalDev(b)-totalDev(a));
  let h='';
  const me=countries[player];
  for(const c of list){
    const ov=overlordOf(c.id);
    const isMine=ov===player;
    // 色点：我方属国浅紫/深紫、盟友蓝、交战红、停战橙；中立国用本国旗色
    const dotCol=relDotColor(c.id);
    // 附庸国不可直接宣战（要打就打宗主）；宗主附庸关系另见徽章
    const canWar=!ov&&!atWar(player,c.id)&&!truceBetween(player,c.id);
    const isAlly=isAllied(player,c.id);
    // 结盟：双方均非附庸、无战事、无停战（共同防御之约）
    const canAlly=!isAlly&&!ov&&!isMine&&!overlordOf(player)&&!atWar(player,c.id)&&!truceBetween(player,c.id)&&!inWar(c.id)&&!inWar(player);
    // 册封附庸：≤3省、双方均无战事、非他人附庸、接壤或近海（玩家自己是附庸时不可册封）
    const canDipV=!overlordOf(player)&&!ov&&!isMine&&c.provList.length<=3&&!atWar(player,c.id)&&!inWar(c.id)&&!inWar(player)&&vassalReachable(player,c.id);
    const dipCost=Math.round(60+totalDev(c)*2);
    let btns='';
    if(isMine){
      const annCost=Math.round(totalDev(c)*4);
      // 原版规则：附庸处于交战状态（含随宗主参战）时不可吞并
      const atWar=inWar(c.id);
      const noGold=me.gold<annCost;
      const canAnn=!atWar&&!noGold;
      const why=noGold
        ? `国库不足（需 ${annCost} 金，现有 ${Math.round(me.gold)}）`
        : (atWar?'附庸处于交战状态（含随你参战），须先结束所有战事':'吞并附庸全部疆土');
      btns+=`<button class="act" style="margin:0" data-act="annex-vassal" data-v="${c.id}" ${canAnn?'':'disabled'} title="${why}">吞并(${annCost}金)${canAnn?'':' ⚠'}</button> `;
      btns+=`<button class="act" style="margin:0" data-act="release-vassal" data-v="${c.id}" title="放其独立，约定五年之好">解除</button>`;
      btns+=` <button class="act" style="margin:0" data-act="vassal-color" data-v="${c.id}" title="修改该国在地图上的颜色（免费，全体玩家可见）">🎨 改色</button>`;
    } else if(canDipV){
      btns+=`<button class="act" style="margin:0" data-act="diplo-vassal" data-v="${c.id}" ${me.gold>=dipCost?'':'disabled'} title="岁贡三成收入，随我参战">册封(${dipCost}金)</button>`;
    }
    if(isAlly) btns+=` <button class="act" style="margin:0;background:#1c3320;border-color:#509060;color:#a8e0b0" data-act="diplo-unally" data-v="${c.id}" title="解除盟约">断盟</button>`;
    else if(canAlly) btns+=` <button class="act" style="margin:0;background:#1c3320;border-color:#509060;color:#a8e0b0" data-act="diplo-ally" data-v="${c.id}" title="共同防御：任一方被宣战，另一方参战">结盟</button>`;
    if(canWar) btns+=` <button class="act" style="margin:0" data-act="declare" data-v="${c.id}">宣战</button>`;
    const open=diploFocus===c.id||diploColorFor===c.id;
    h+=`<div class="c-row${ov?' vassal':''}${isMine?' my':''}${open?' diplo-open':''}" data-act="diplo-info" data-v="${c.id}" title="${ov?`附庸国，点击查看宗主 ${countries[ov].name}`:'点击查看其附庸'}">
      <span class="cd" style="background:rgb(${dotCol.map(v=>v|0)})"></span>
      <span class="cn">${c.name} ${relationBadge(c.id)}</span>
      <span class="cs">${c.provList.length}省 · 军力${fmtK(countryStrength(c.id))}</span>
      ${btns}
    </div>`;
    if(open){
      let d='';
      if(diploColorFor===c.id) d+=colorPickerHTML(c.id);
      if(ov){ // 点击属国 → 显示宗主国是谁
        const oc=countries[ov];
        d+=`<div class="row2"><span class="lbl">宗主国：</span><span class="cd" style="display:inline-block;width:11px;height:11px;background:rgb(${relDotColor(oc.id).map(v=>v|0)});border:1px solid #000;vertical-align:middle"></span><b>${oc.name}</b>${relationBadge(ov)}${ov===player?`<span class="hint">（我朝${isPuppet(c.id)?'傀儡':'附庸'}）</span>`:'<span class="hint">（其疆土需向宗主宣战方可夺取）</span>'}${ov!==player?`<button class="act" data-act="diplo-focus" data-v="${ov}" title="跳转到宗主国">查看宗主</button>`:''}</div>`;
      }
      // 点击宗主国（或有属国的国家）→ 显示其所有属国（附庸与傀儡分开列）
      const vas=countries.filter(x=>x&&x.alive&&x.overlord===c.id);
      if(vas.length){
        const vs=vas.filter(x=>!isPuppet(x.id)), ps=vas.filter(x=>isPuppet(x.id));
        const part=[];
        if(vs.length) part.push(`<span class="lbl">附庸国（${vs.length}）：</span>`+
          vs.map(x=>`<button class="act" data-act="diplo-focus" data-v="${x.id}" title="查看 ${x.name}（附庸国）">${x.name}</button>`).join(' '));
        if(ps.length) part.push(`<span class="lbl" style="color:#c9a6ff">傀儡国（${ps.length}）：</span>`+
          ps.map(x=>`<button class="act" style="border-color:#7a4ec0;color:#c9a6ff" data-act="diplo-focus" data-v="${x.id}" title="查看 ${x.name}（傀儡国，叛乱倾向仅 5%）">${x.name}</button>`).join(' '));
        d+=`<div class="row2" style="display:block">${part.join('</div><div class="row2" style="display:block">')}</div>`;
      } else if(!ov){
        d+=`<div class="row2"><span class="lbl">附属国：</span><span class="hint">无</span></div>`;
      }
      // 我方属国：显示国体 + 改色入口
      if(isMine){
        d+=`<div class="row2"><span class="lbl">国体：</span><b style="color:${isPuppet(c.id)?'#c9a6ff':'#d0b0ff'}">${isPuppet(c.id)?'傀儡国':'附庸国'}</b>
          <span class="hint">（${isPuppet(c.id)?'叛乱倾向仅为附庸国的 5%':'叛乱倾向正常'}）</span>
          <button class="act" data-act="vassal-color" data-v="${c.id}" title="修改该国在地图上的颜色">🎨 修改颜色</button></div>`;
      }
      // 盟友列表
      const als=(c.allies||[]).filter(x=>countries[x]&&countries[x].alive&&x!==player);
      if(als.length){
        d+=`<div class="row2"><span class="lbl">盟友（${als.length}）：</span>${als.map(x=>`<button class="act" data-act="diplo-focus" data-v="${x}" title="查看 ${countries[x].name}">${countries[x].name}</button>`).join(' ')}<span class="hint">（共同防御）</span></div>`;
      } else if(!ov){
        d+=`<div class="row2"><span class="lbl">盟友：</span><span class="hint">无</span></div>`;
      }
      if(!d) d=`<div class="row2"><span class="lbl">该国家既无宗主，也没有属国。</span></div>`;
      h+=`<div class="diplo-detail">${d}</div>`;
    }
  }
  // 复国之机：已亡国家 whose 故土（former 记录）现由我朝持有并控制
  if(!overlordOf(player)){
    const revMap=new Map();
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(!p.pix.length||p.owner!==player||p.controller!==player||!p.former) continue;
      for(const fo of p.former){
        const fc=countries[fo];
        if(fc&&!fc.alive) revMap.set(fo,(revMap.get(fo)||0)+1);
      }
    }
    if(revMap.size){
      h+=`<div class="sep"></div><h4>复国之机（于故土重建亡国，立为我朝附庸）</h4>`;
      for(const [cid,cnt] of revMap){
        const dc=countries[cid];
        h+=`<div class="c-row" data-act="diplo-info" data-v="0" style="opacity:0.9">
          <span class="cd" style="background:rgb(${dc.color.map(v=>v|0)});filter:saturate(0.4)"></span>
          <span class="cn">${dc.name} <span class="hint">（已亡国）</span></span>
          <span class="cs">故土${cnt}省在我朝</span>
          <button class="act" style="margin:0" data-act="revive-nation" data-v="${cid}" title="在其故土重建其国（原址原土），奉我为宗主">复国</button>
        </div>`;
      }
    }
  }
  box.innerHTML=h;
}

/* ---------- 属国改色盘 ----------
   36 个预设色（12 色相 × 3 档明度），另加「随机」。
   改色免费、纯外观，但要经服务端广播给所有玩家。 */
function colorPickerHTML(cid){
  const c=countries[cid]; if(!c) return '';
  const cur=c.color||[180,180,180];
  const near=(rgb)=>Math.abs(rgb[0]-cur[0])<3&&Math.abs(rgb[1]-cur[1])<3&&Math.abs(rgb[2]-cur[2])<3;
  let sw='';
  for(const L of [0.36,0.5,0.64]){
    for(let i=0;i<12;i++){
      const rgb=hsl(i/12,0.58,L).map(v=>Math.round(v));
      sw+=`<button class="sw${near(rgb)?' sel':''}" data-act="vcolor-set" data-v="${cid}" data-rgb="${rgb.join(',')}" style="background:rgb(${rgb.join(',')})" title="rgb(${rgb.join(',')})"></button>`;
    }
  }
  return `<div class="row2" style="display:block">
    <span class="lbl">修改 ${c.name} 的颜色：</span>
    <div class="swatches">${sw}</div>
    <div style="margin-top:6px;display:flex;gap:5px;align-items:center">
      <button class="act" data-act="vcolor-random" data-v="${cid}" title="随机挑一个颜色">🎲 随机</button>
      <button class="act" data-act="vcolor-close" title="收起调色板">收起</button>
      <span class="hint">当前 <span style="display:inline-block;width:11px;height:11px;background:rgb(${cur.map(v=>v|0)});border:1px solid #000;vertical-align:middle"></span> rgb(${cur.map(v=>v|0).join(',')}) · 免费，所有玩家立刻可见</span>
    </div>
  </div>`;
}
function infoTab(){
  let h='';
  const a=armies.find(x=>x.id===selectedArmy);
  if(a){
    const loc=provinces[a.prov];
    const inBattle=battleProvs.has(a.prov);
    let status;
    if(a.isNavy){
      if(a.navPath&&a.navPath.length){
        const tgt=a.dstProv?provinces[a.dstProv].name:'海上';
        status=`<span style="color:#88c8ff">航行中 → ${tgt}</span>`;
      } else {
        status = inBattle?'<span style="color:#ff9080">接舷战中</span>':(provinces[a.prov].controller!==a.owner&&atWar(a.owner,provinces[a.prov].controller)?'封锁/攻港中':'停泊');
      }
    } else {
      status = inBattle?'<span style="color:#ff9080">交战中</span>': a.path.length?`行军 → ${provinces[a.dstProv||a.path[a.path.length-1]].name}`:(provinces[a.prov].controller!==a.owner&&atWar(a.owner,provinces[a.prov].controller)?'围城中':'驻扎');
      if(a.attrit>0&&!inBattle) status+=` <span style="color:#ffb060" title="距本土阵营${a.attrit>=13?'陆路不通（补给断绝）':a.attrit+'跳'}：每月减员${a.isNavy?'约'+Math.round(Math.min(0.08,0.008+(a.attrit-1)*0.005)*100)+'%':'约'+Math.round(Math.min(0.20,0.015+(a.attrit-1)*0.012)*100)+'%'}">· 远征补给线 ${a.attrit>=13?'已断绝':'延伸'+a.attrit+'跳（减员中）'}</span>`;
    }
    if(a.isNavy&&a.attrit>0&&!inBattle&&!(a.navPath&&a.navPath.length))
      status+=' <span style="color:#ffb060" title="远离本土海域，每月减员">· 远洋巡航（减员中）</span>';
    h+=`<h3>${a.isNavy?'<span style="color:#88c8ff">⛵ 舰队</span>':'⚔ 军团'} #${a.id}</h3>
      <div class="row"><span>兵力</span><b>${Math.round(a.str)} 人</b></div>
      <div class="row"><span>所属</span>${countries[a.owner].name}</div>
      <div class="row"><span>位置</span>${loc.name}</div>
      <div class="row"><span>状态</span>${status}</div>`;
    if(a.owner===player) h+=`<div><button class="act danger" data-act="disband" data-v="${a.id}">解散${a.isNavy?'舰队':'军团'}</button></div>`;
    h+=`<p class="hint">${a.isNavy?'选中后点击地图任意海岸省份下达航行令，右键取消。':'选中后点击地图任意省份下达行军令，右键取消。'}</p><div class="sep"></div>`;
  }
  if(selectedProv>0){
    const p=provinces[selectedProv];
    const oc=countries[p.controller],ow=countries[p.owner];
    const devCost=40+devOf(p)*8;
    h+=`<h3>${p.name}</h3>
      <div class="row"><span>所有者</span>${ow?ow.name:'—'}</div>
      <div class="row"><span>控制者</span>${oc&&oc!==ow?`<span style="color:#ff9080">${oc.name}（占领）</span>`:(oc?oc.name:'—')}</div>
      <div class="row"><span>发展度</span><b>${devOf(p)}</b>（税${p.tax} 产${p.prod} 兵${p.man}）</div>
      <div class="row"><span>月收入</span>${((p.tax+p.prod)*0.05).toFixed(2)} 金</div>`;
    if(p.siege>0) h+=`<div class="row"><span>围城进度</span><b>${Math.floor(p.siege)}%</b></div>`;
    if(p.owner===player){
      const c=countries[player];
      h+=`<div>
        <button class="act" data-act="develop" data-v="${p.id}" ${c.gold<devCost?'disabled':''}>发展省份（${devCost}金）</button>`;
      const canRec=p.controller===player&&c.gold>=25&&c.mp>=5000&&!armies.some(x=>x.owner!==player&&x.prov===p.id);
      h+=`<button class="act" data-act="recruit" data-v="${p.id}" ${canRec?'':'disabled'} title="集结期 ${Math.round(RECRUIT_DAYS/30)} 个月，期间该省易主则中止并退款">招募军团（25金+5k人力 · ${Math.round(RECRUIT_DAYS/30)}个月成军）</button></div>`;
      {
        const myRec=recruits.filter(r=>r.prov===p.id&&r.owner===player);
        if(myRec.length){
          const soon=Math.min(...myRec.map(r=>r.days));
          h+=`<div class="hint" style="color:#ffd080">⚔ 征兵中：${myRec.length} 支 · 最快 ${Math.ceil(soon/30)} 个月后成军</div>`;
        }
      }
      // 海军招募（仅本方海岸省）
      const isCoast=p.coastPix&&p.coastPix.length>0;
      const canNavyRec=isCoast&&p.controller===player&&c.gold>=35&&c.mp>=4000;
      h+=`<div>
        <button class="act" style="background:#1a2c3e;border-color:#5080b0;color:#aae0ff" data-act="recruit-navy" data-v="${p.id}" ${canNavyRec?'':'disabled'} ${isCoast?`title="组建周期 ${Math.round(NAVY_DAYS/30)} 个月"`:'title="该省无海岸"'} >${isCoast?`组建舰队（35金+4k人力 · ${Math.round(NAVY_DAYS/30)}个月下水）`:'该省无海岸'}</button>
      </div>`;
      // 划地分封：进地图模式一次性圈出整片封地，再建立傀儡国
      if(!overlordOf(player)&&c.provList.length>1&&p.controller===player){
        h+=`<div><button class="act" style="background:#2a2440;border-color:#6a5a9a;color:#d0b0ff" data-act="found-vassal" data-v="${p.id}" title="进入「分封地图」：以该省为首府，在地图上连续点选要封出去的省份（可点「＋纳入接壤省」整片划），最后一次性建立傀儡国。傀儡国叛乱倾向只有附庸国的 5%">🏳 划地分封（建立傀儡国）</button></div>`;
      }
      // 划地赐予属国：与「划地分封」同一套地图交互，一次划一整片
      const myVass=countries.filter(x=>x&&x.alive&&x.overlord===player);
      if(myVass.length){
        const canGive=p.controller===player&&c.provList.length>1;
        h+=`<div style="margin-top:4px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <span class="hint" style="white-space:nowrap">赐地给属国：</span>
          <select id="give-sel" style="background:#1c2430;color:#d8d0c0;border:1px solid #607080;border-radius:3px;padding:2px 4px;font-size:12px;max-width:150px">
            ${myVass.map(x=>`<option value="${x.id}">${x.name}（${x.provList.length}省）</option>`).join('')}
          </select>
          <button class="act" data-act="give-vassal" data-v="${p.id}" ${canGive?'':'disabled'} title="进入划地模式：在地图上连续点选要划给该属国的省份（可点「＋纳入接壤省」整片划），最后一次性赐地">🗺 划地赐予</button>
        </div>`;
      }
    }
    h+=`<div class="sep"></div>`;
  }
  // 国家概览 + 排名
  if(player){
    const c=countries[player];
    h+=`<h3>${c.name} · 王国概览</h3>
      <div><button class="act" data-act="rename-self" ${c.gold<RENAME_COST?'disabled':''} title="${c.gold<RENAME_COST?`国库不足（需 ${RENAME_COST} 金，现有 ${Math.round(c.gold)}）`:`花费 ${RENAME_COST} 金，改易国号（最多 ${RENAME_MAX} 字），全体玩家立刻可见`}">✏ 修改国名（${RENAME_COST}金）</button></div>
      <div class="row"><span>发展度总和</span><b>${totalDev(c)}</b></div>
      <div class="row"><span>省份</span>${c.provList.length}</div>`;
    {
      const myVass=countries.filter(x=>x&&x.alive&&x.overlord===player);
      if(myVass.length){
        const tr=myVass.reduce((a,x)=>a+Math.max(0,x.income)*0.3,0);
        h+=`<div class="row"><span>附庸（${myVass.length}）</span>${myVass.map(x=>x.name).join('、')}</div>
            <div class="row"><span>岁贡收入</span><b style="color:#ffd890">+${tr.toFixed(2)} 金/月</b></div>`;
      }
    }
    h+=`<div class="row"><span>陆军</span>${armies.filter(x=>x.owner===player&&!x.isNavy).length}</div>
    <div class="row"><span>海军</span>${armies.filter(x=>x.owner===player&&x.isNavy).length}</div>
      <div class="row"><span>人力池</span>${fmtK(c.mp)} / ${fmtK(c.mpCap)}</div>
      <div class="sep"></div><h4>列强榜（发展度）</h4>`;
    // 开发度只算一次、只排一次（原来排了两遍，而 totalDev 每次都要遍历该省列表）
    const ranked=[...countries].filter(x=>x&&x.alive)
      .map(x=>[x,totalDev(x)])
      .sort((a,b)=>b[1]-a[1]);
    const rank=ranked.slice(0,10);
    rank.forEach(([cc,dv],i)=>{
      h+=`<div class="row"><span>${i+1}. ${cc.name}${cc.id===player?'（你）':''}</span><b>${dv}</b></div>`;
    });
    const myRank=ranked.findIndex(x=>x[0].id===player)+1;
    h+=`<p class="hint">当前世界排名：第 ${myRank} 位</p>`;
  }
  if(!a&&selectedProv<=0&&!player) h+=`<p class="hint">点击地图选择省份或军队。</p>`;
  return h;
}

function relationBadge(cid){
  if(cid===player) return '<span class="badge self">本国</span>';
  // 交战中优先：造反的附庸不能再显示成"我朝附庸"
  if(atWar(player,cid)) return '<span class="badge war">交战中</span>';
  if(overlordOf(cid)===player){
    return isPuppet(cid)
      ? '<span class="badge vassal" style="background:#2a1a48;border-color:#7a4ec0;color:#c9a6ff">我朝傀儡</span>'
      : '<span class="badge vassal">我朝附庸</span>';
  }
  if(overlordOf(player)===cid) return '<span class="badge suz">宗主</span>';
  if(isAllied(player,cid)) return '<span class="badge ally">盟友</span>';
  if(truceBetween(player,cid)){
    const t=truces[truceKey(player,cid)];
    return `<span class="badge truce">停战</span>`;
  }
  return '<span class="badge peace">和平</span>';
}
function warTab(){
  let h='';
  const myWars=wars.filter(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&(w.a===player||w.d===player));
  if(!myWars.length) h+=`<p class="hint">目前没有战事。可前往外交页宣战。</p>`;
  for(const w of myWars){
    const enemy=w.a===player?w.d:w.a;
    const s=warScore(w);
    const mine=w.a===player?s.a:s.d, theirs=w.a===player?s.d:s.a;
    const months=Math.floor((dayCount-w.startDay)/30);
    const tBonus=Math.min(50,months*0.5);
    const eVass=vassalsAllOf(enemy).filter(x=>x.id!==player); // 敌方全部附庸（含附庸的附庸，均随阵营参战）
    const indepWar=overlordOf(w.a)===w.d; // 附庸（w.a）反抗宗主（w.d）的独立战争
    const myCas=w.a===player?(w.casA||0):(w.casD||0), eCas=w.a===player?(w.casD||0):(w.casA||0);
    const jAllies=wars.filter(x=>x&&typeof x.joinOf==='number'&&wars[x.joinOf]===w).map(x=>x.d);
    const jMine=w.d===player?jAllies:[], jEnemy=w.a===player?jAllies:[];
    h+=`<h3>对 ${countries[enemy].name} 的战争${indepWar?' <span class="badge vassal">独立战争</span>':''}</h3>
      <div class="row"><span>持续时间</span>${Math.floor(months/12)}年${months%12}月</div>
      <div class="row"><span>战争分数</span><b style="color:${mine>=theirs?'#a8d890':'#ff9080'}">${mine.toFixed(0)} : ${theirs.toFixed(0)}</b></div>
      <div class="row"><span>累计伤亡</span><b style="color:#ff9080">${Math.round(myCas).toLocaleString()}</b> : <b style="color:#ff9080">${Math.round(eCas).toLocaleString()}</b> <span class="hint">（含会战、溃散与远征损耗）</span></div>
      <div class="row"><span>时间加成</span><span class="hint">优势方 +${tBonus.toFixed(0)}（每2月+1，上限50，久战催和）</span></div>
      ${indepWar?`<div class="row"><span>战争性质</span><b style="color:#d0a0ff">${w.a===player?'我们谋求脱离宗主独立':'附庸叛乱'}</b></div>`:''}
      ${eVass.length?`<div class="row"><span>敌方附庸</span>${eVass.map(x=>x.name).join('、')}<span class="hint">（均随宗主参战）</span></div>`:''}
      ${jMine.length?`<div class="row"><span>我方盟友参战</span>${jMine.map(id=>countries[id].name).join('、')}</div>`:''}
      ${jEnemy.length?`<div class="row"><span>敌方盟友参战</span>${jEnemy.map(id=>countries[id].name).join('、')}</div>`:''}
      <div class="warbar">
        <div class="fill" style="right:50%;width:${(mine/2).toFixed(1)}%;background:#7a9a5a"></div>
        <div class="fill" style="left:50%;width:${(theirs/2).toFixed(1)}%;background:#a05a4a"></div>
      </div>`;
    // 我方占领的敌省（含敌方附庸的省份）
    const occ=[];
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(p.pix.length&&(p.owner===enemy||campOf(p.owner).has(enemy))&&(p.controller===player||campOf(p.controller).has(player))) occ.push(i);
    }
    const ratio=occRatio(player,enemy);
    const adjOk=vassalReachable(player,enemy);
    h+=`<div class="row"><span>占领比例</span><b style="color:${ratio>=0.5?'#a8d890':'#ff9080'}">${(ratio*100).toFixed(0)}%</b> <span class="hint">（附庸需≥50%）</span></div>
      <div class="row"><span>册封可达</span><b style="color:${adjOk?'#a8d890':'#ff9080'}">${countriesAdjacent(player,enemy)?'接壤':'近海'}</b> <span class="hint">（附庸需接壤或近海岛屿）</span></div>`;
    if(occ.length){
      h+=`<h4>索要省份（战争分数 ${mine.toFixed(0)} 可用 · 仅可割海岸或接壤省份，附庸占领亦可索要）</h4>
        ${cedeMap.on&&cedeMap.enemy===enemy?`<p class="hint" style="color:#ffc880">🗺 割地地图已开启：<b style="color:#ffd070">金色</b>=可割 · <b style="color:#ff9070">红色</b>=已选 · 灰色=暂不可达。点击地图高亮省份即选中/取消，右侧列表同步。</p>`:''}`;
      for(const pid of occ){
        const p=provinces[pid];
        const coast=p.coastPix&&p.coastPix.length;
        h+=`<label class="ck"><span>${p.name}${overlordOf(p.owner)===enemy?`<span class="hint">（${countries[p.owner].name}）</span>`:''} <span class="hint">（发展度${devOf(p)}${coast?'·海岸':''}）</span></span><span><input class="demand" type="checkbox" value="${pid}" data-enemy="${enemy}" onchange="updateDemandUI()"> ${peaceCost(p).toFixed(0)}分</span></label>`;
      }
    }
    // 要求释放附庸：敌方有附庸时可要求其放独立（独立战争时其附庸不含玩家自己）
    if(eVass.length){
      h+=`<h4>要求释放附庸（战争分数 ${mine.toFixed(0)} 可用 · 释放后疆土归附庸国自己）</h4>`;
      for(const vc of eVass){
        h+=`<label class="ck"><span>${vc.name} <span class="hint">（${vc.provList.length}省 · 发展度${totalDev(vc)}）</span></span><span><input class="demand-rel" type="checkbox" value="${vc.id}" data-enemy="${enemy}"> ${releaseCost(vc).toFixed(0)}分</span></label>`;
      }
    }
    // 附庸化：需60分 + 占领≥50% + 接壤或近海（独立战争不可附庸化宗主）
    const isHumanEnemy=humans.has(enemy);   // 人类对手：一切和谈都要对方点头
    const canVass=!indepWar&&!overlordOf(enemy)&&ratio>=0.5&&adjOk&&mine>=60;
    h+=`<div style="margin-top:8px">
      ${occ.length?`<button class="act" style="background:#3a2c1c;border-color:#a08040;color:#ffd890" data-act="cede-map" data-v="${enemy}" title="在地图上点选要割让的省份">${cedeMap.on&&cedeMap.enemy===enemy?'退出割地地图':'🗺 割地地图'}</button>`:''}
      <button class="act" data-act="peace-submit" data-v="${enemy}">${isHumanEnemy?'📜 递交和约条件（需对方同意）':'提出和约'}</button>
      <button class="act" data-act="peace-white" data-v="${enemy}">${isHumanEnemy?'提议白色和平（需对方同意）':'白色和平'}</button>
      ${canVass?`<button class="act" style="background:#3a2c1c;border-color:#a08040;color:#ffd890" data-act="peace-vassal" data-v="${enemy}" title="需60分+占领≥50%+接壤或近海${isHumanEnemy?'（对人类玩家需其本人同意）':''}">附庸化（60分）${isHumanEnemy?'·需同意':''}</button>`:''}
      ${indepWar&&w.a===player&&mine>=30?`<button class="act" style="background:#3a2c1c;border-color:#a08040;color:#ffd890" data-act="peace-indep" data-v="${enemy}" title="独立战争胜利：脱离宗主（30分），剩余分数可继续按普通模式割地">要求独立（30分）</button>`:''}
      ${mine<theirs-20?`<button class="act danger" data-act="peace-ask" data-v="${enemy}">屈膝求和${isHumanEnemy?'（需对方同意）':''}</button>`:''}
    </div>`;
    // 敌方条件
    // 对方（玩家或 AI）递交过来的条件：必须我点接受才生效
    if(pendingOffer&&pendingOffer.enemy===enemy){
      h+=`<div class="sep"></div><h4 style="color:#ff9080">${pendingOffer.human?'⚔ 对方的和约提案（需你同意）':'敌方使节的条件'}</h4>`;
      if(pendingOffer.vassalize){
        h+=`<p class="hint">${countries[enemy].name} 要求我国<b style="color:#d0b0ff">称臣为其附庸</b>（等于亡国）：</p>
          <div class="row"><span>成为 ${countries[enemy].name} 的附庸</span><span class="hint">—</span></div>`;
      } else if(pendingOffer.indep){
        h+=`<p class="hint">${countries[enemy].name} 要求我国承认其独立（30分）：</p>
          <div class="row"><span>承认 ${countries[enemy].name} 独立</span><span class="hint">30分</span></div>`;
      } else {
        const list=pendingOffer.transfers||[];
        if(!list.length) h+=`<p class="hint">${countries[enemy].name} 提议白色和平（双方就地停战）：</p>`;
        else {
          h+=`<p class="hint">${countries[enemy].name} 提出的条件：</p>`;
          for(const t of list){
            const pp=provinces[t.pid]; if(!pp) continue;
            h+=`<div class="row"><span>${pp.name}</span><span class="hint">${t.to===player?'我朝割让':'对方割让'} · ${peaceCost(pp).toFixed(0)}分</span></div>`;
          }
        }
        if(pendingOffer.releases&&pendingOffer.releases.length){
          h+=`<p class="hint">并要求我国释放附庸（其将重获独立）：</p>`;
          for(const cid of pendingOffer.releases){ const vc=countries[cid]; if(vc) h+=`<div class="row"><span>释放 ${vc.name}</span><span class="hint">${releaseCost(vc).toFixed(0)}分</span></div>`; }
        }
      }
      h+=`<div><button class="act" style="background:#2a4a2a;border-color:#4a8a50;color:#b0e8b0" data-act="offer-accept">✔ 接受条件（结束战争）</button><button class="act danger" data-act="offer-decline">✘ 拒绝</button></div>
        <p class="hint">有效期至 ${expireDate(pendingOffer.expire)}</p>`;
    }
    // 我递交出去、还没被回应的提案
    if(typeof MP!=='undefined'&&MP.sentOffer&&MP.sentOffer.to===enemy){
      const so=MP.sentOffer;
      h+=`<div class="sep"></div><h4 style="color:#ffd080">📜 我朝已递交的条件（等待对方回应）</h4>`;
      if(so.vassalize) h+=`<div class="row"><span>要求 ${countries[enemy].name} 称臣为附庸</span><span class="hint">—</span></div>`;
      else if(so.indep) h+=`<div class="row"><span>要求承认我朝独立</span><span class="hint">30分</span></div>`;
      else if(!(so.transfers||[]).length) h+=`<div class="row"><span>白色和平（就地停战）</span><span class="hint">—</span></div>`;
      else for(const t of so.transfers){ const pp=provinces[t.pid]; if(pp) h+=`<div class="row"><span>${pp.name}</span><span class="hint">${t.to===player?'归我朝':'归对方'} · ${peaceCost(pp).toFixed(0)}分</span></div>`; }
      h+=`<p class="hint">对方同意后才会生效 · 有效期至 ${expireDate(so.expire)}</p>`;
    }
    h+=`<div class="sep"></div>`;
  }
  // 世界其他战争
  const others=wars.filter(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&w.a!==player&&w.d!==player);
  if(others.length){
    h+=`<h4>世界各地战火</h4>`;
    for(const w of others){
      const s=warScore(w);
      h+=`<div class="row"><span>${countries[w.a].name} ⚔ ${countries[w.d].name}</span><span class="hint">${Math.floor((dayCount-w.startDay)/30)}月 · ${s.a.toFixed(0)}:${s.d.toFixed(0)}</span></div>`;
    }
  }
  return h;
}
function expireDate(dd){
  let y=1444,m=10,d=11;
  for(let i=0;i<dd;i++){ d++; const L=m===1?((y%4===0&&y%100!==0)||y%400===0?29:28):CAL_M[m]; if(d>L){d=1;m++;if(m>11){m=0;y++;}} }
  return `${y}年${m+1}月`;
}

/* ---------- 事件 ---------- */
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-act]');
  if(!el) return;
  const act=el.dataset.act, v=el.dataset.v;
  switch(act){
    case 'pause': if(MP.online){ mpCmd({c:'pause',paused:!paused}); break; } paused=!paused; updateTopbar(); break;
    case 'speed': if(MP.online){ mpCmd({c:'speed',speed:+v}); break; } speed=+v; paused=false; renderSpeeds(); updateTopbar(); break;
    case 'mode': setMode(v); break;
    case 'tab': uiTab=v; document.querySelectorAll('#panel-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.v===v)); refreshPanel(); break;
    case 'develop': doDevelop(+v); break;
    case 'recruit': doRecruit(+v); break;
    case 'recruit-navy': doRecruitNavy(+v); break;
    case 'disband': if(MP.online){ mpCmd({c:'disband',army:+v}); break; } armies=armies.filter(a=>a.id!==+v); if(selectedArmy===+v)selectedArmy=0; refreshPanel(); break;
    case 'declare': doDeclare(+v); break;
    case 'found-vassal': {
      const p=provinces[+v];
      if(!p||p.owner!==player||p.controller!==player){ pushLog('只能在你自己实际控制的省份上分封','war'); break; }
      if(countries[player].provList.length<=1){ pushLog('仅剩一省，不可再分封','war'); break; }
      if(overlordOf(player)){ pushLog('附庸之身不可另立藩属','war'); break; }
      const nm=prompt('给新傀儡国起个国名（最多 12 字）：','');
      if(nm===null) break;
      const name=sanitizeCountryName(nm);
      if(!name){ pushLog('国名不能为空','war'); break; }
      grantMapBegin(p.id,name);   // 进入分封地图，接着在图上圈地
      break;
    }
    case 'grant-confirm': grantMapConfirm(); break;
    case 'grant-cancel': grantMapCancel(); break;
    case 'grant-clear': grantMap.pids.clear(); grantMap.capital=0; paintCedeOverlay(); updateGrantBar(); break;
    case 'grant-absorb': grantMapAbsorb(); break;
    case 'peace-submit': peaceSubmit(+v); break;
    case 'cede-map': toggleCedeMap(+v); break;
    case 'diplo-ally': diploAlliance(+v); break;
    case 'diplo-unally': if(MP.online){ mpCmd({c:'unally',target:+v}); break; } breakAlliance(player,+v,'我朝主动解除'); break;
    case 'revive-nation': reviveNation(+v); break;
    case 'peace-white': peaceWhite(+v); break;
    case 'peace-vassal': peaceVassal(+v); break;
    case 'peace-indep': peaceIndep(+v); break;
    case 'diplo-vassal': diploVassal(+v); break;
    case 'annex-vassal': annexVassal(+v); break;
    case 'release-vassal': releaseVassal(+v); break;
    case 'give-vassal': { const sel=$('give-sel'); grantMapBeginGive(+v, sel?+sel.value:0); break; }
    case 'vassal-color': toggleVassalColor(+v); break;
    case 'vcolor-set': setVassalColor(+v, String(el.dataset.rgb||'').split(',').map(Number)); break;
    case 'vcolor-random': setVassalColor(+v, hsl(Math.random(),0.58,0.5).map(x=>Math.round(x))); break;
    case 'vcolor-close': diploColorFor=0; refreshPanel(); break;
    case 'rename-self': renameSelf(); break;
    /* ---- 地图编辑器 ---- */
    case 'open-editor': openEditor(); break;
    /* ---- 地图大厅 ---- */
    case 'map-hall': openMapHall(); break;
    case 'hall-close': closeMapHall(); break;
    case 'hall-official': useOfficialMap(); break;
    case 'hall-pick': pickHallMap(v); break;
    /* ---- 管理后台 ---- */
    case 'open-admin': openAdmin(); break;
    case 'admin-close': closeAdmin(); break;
    case 'admin-login': adminLogin(); break;
    case 'admin-logout': adminLogout(); break;
    case 'admin-tab': adminTab=v||'pending'; loadAdminList(); break;
    case 'admin-preview': adminPreview(v); break;
    case 'admin-pv-back': adminStopPreview(); break;
    case 'admin-pv-approve': adminReview('approve'); break;
    case 'admin-pv-reject': adminReview('reject'); break;
    case 'admin-pv-delete': adminDelete(); break;
    case 'edit-exit': {
      if(editMode.undo.length && !confirm('退出会丢失本次未下载的编辑，确定吗？')) break;
      closeEditor(); break;
    }
    case 'edit-tool': editMode.tool=v; updateEditBar(); refreshPanel(); break;
    case 'edit-info': editInfoDialog(); break;
    case 'edit-undo': editUndo(); break;
    case 'edit-download': editDownload(); break;
    case 'edit-submit': editSubmit(); break;
    case 'edit-clear-armies': editClearArmies(); break;
    case 'edit-paint-here': editPaint(+v); break;
    case 'edit-capital-here': editSetCapital(+v); break;
    case 'edit-pname-set': { const i=$('edit-pname'); if(i) editSetProvName(+v,i.value); break; }
    case 'edit-cname-set': { const i=$('edit-cname'); if(i) editSetCountryName(editMode.brush,i.value); break; }
    case 'edit-ccolor': editSetCountryColor(+v, String(el.dataset.rgb||'').split(',').map(Number)); break;
    case 'edit-absorb': editAbsorb(+v); break;
    case 'edit-army-add': { const i=$('edit-army-str'); editAddArmy(+v, i?i.value:5000, false); break; }
    case 'edit-army-add-navy': { const i=$('edit-army-str'); editAddArmy(+v, i?i.value:5000, true); break; }
    case 'diplo-info': diploFocus=diploFocus===+v?0:+v; refreshPanel(); break;
    case 'diplo-focus': diploFocus=+v; refreshPanel(); break;
    case 'peace-ask': peaceAsk(+v); break;
    case 'offer-accept': offerAccept(); break;
    case 'offer-decline': if(MP.online){ mpCmd({c:'offer',accept:false}); break; } pendingOffer=null; pushLog('我们拒绝了敌方的条件'); refreshPanel(); break;
    case 'save': openSlotModal('save'); break;
    case 'load': openSlotModal('load'); break;
    case 'slot-save': slotSaveNow(); break;
    case 'slot-pick': { // 保存模式：点击旧档 → 把名字填进输入框，再按保存即覆盖
      const inp=$('slot-name'); inp.value=v; inp.focus(); inp.select();
      pushLog(`已填入「${v}」——再点一次「保存」将覆盖此档`,'gold');
      break;
    }
    case 'slot-load': slotLoadByName(v); break;
    case 'slot-del': {
      const btn=el;
      if(btn.classList.contains('confirm')){
        btn.classList.remove('confirm'); btn.textContent='删除';
        slotDeleteByName(v);
      }else{
        document.querySelectorAll('.sl-del.confirm').forEach(b=>{ b.classList.remove('confirm'); b.textContent='删除'; });
        btn.classList.add('confirm'); btn.textContent='确认删除？';
        setTimeout(()=>{ btn.classList.remove('confirm'); btn.textContent='删除'; },3000);
      }
      break;
    }
    case 'slot-back': closeSlotModal(); break;
    case 'help': $('helpmodal').classList.remove('hidden'); break;
    case 'close-help': $('helpmodal').classList.add('hidden'); break;
    case 'start': startGame(+v); break;
    case 'random-start': {
      const alive=[...countries].filter(c=>c&&c.alive);
      startGame(alive[ri(alive.length)].id); break;
    }
    case 'restart': location.reload(); break;
  }
});
// IME 中文输入法组合状态（避免 input 事件打断输入法）
let _imeComposing=false;
document.addEventListener('compositionstart',()=>{_imeComposing=true;});
document.addEventListener('compositionend',e=>{_imeComposing=false;
  // 组合结束后再触发一次重渲染（确保最终值生效）
  if(e.target.id==='diplo-search'){ uiSearch=e.target.value; refreshPanel(); const s=$('diplo-search'); if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);} }
  else if(e.target.id==='sel-search'){ renderSelectList(e.target.value); }
});
document.addEventListener('input',e=>{
  if(_imeComposing) return; // IME 组字中：只更新变量，不重渲染
  if(e.target.id==='diplo-search'){ uiSearch=e.target.value; refreshPanel(); const s=$('diplo-search'); if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);} }
  if(e.target.id==='sel-search') renderSelectList(e.target.value);
  if(e.target.id==='hall-search'){ hallFilter=e.target.value; renderHallList(); }
});
/* 编辑器的数字输入（发展度 / 起始兵力）用 change，避免每敲一位就重画地图 */
document.addEventListener('change',e=>{
  const t=e.target;
  if(!t||!editMode.on) return;
  if(t.id==='edit-brush'){ editMode.brush=+t.value||editMode.brush; updateEditBar(); refreshPanel(); return; }
  if(t.dataset&&t.dataset.act==='edit-dev'){
    editSetDev(+t.dataset.v, t.dataset.f, t.value);
    updateEditBar();
  }
});

function doDevelop(pid){
  if(MP.online) return mpCmd({c:'develop',prov:pid});
  const p=provinces[pid], c=countries[player];
  const cost=40+devOf(p)*8;
  if(c.gold<cost) return;
  c.gold-=cost;
  const r=ri(3);
  if(r===0)p.tax++; else if(r===1)p.prod++; else p.man++;
  recomputeCap(c);
  pushLog(`${p.name} 得到发展（发展度 ${devOf(p)}）`,'gold');
  if(mapMode==='dev') recolorProvince(pid);
  refreshPanel();
}
function doRecruit(pid){
  if(MP.online) return mpCmd({c:'recruit',prov:pid});
  const c=countries[player], p=provinces[pid];
  if(c.gold<25||c.mp<5000||p.controller!==player) return;
  c.gold-=25; c.mp-=5000;
  addRecruit(player,pid,5000,false);
  pushLog(`${p.name} 开始征兵，约 ${Math.round(RECRUIT_DAYS/30)} 个月后成军`,'gold');
  refreshPanel();
}
function doRecruitNavy(pid){
  if(MP.online) return mpCmd({c:'navy',prov:pid});
  const c=countries[player], p=provinces[pid];
  if(!p.coastPix||!p.coastPix.length){ pushLog(`${p.name} 没有海岸，无法组建舰队`); return; }
  if(c.gold<35||c.mp<4000||p.controller!==player) return;
  c.gold-=35; c.mp-=4000;
  addRecruit(player,pid,4000,true);
  pushLog(`${p.name} 开始组建舰队，约 ${Math.round(NAVY_DAYS/30)} 个月后下水`,'gold');
  refreshPanel();
}
function doDeclare(cid){
  if(MP.online) return mpCmd({c:'war',target:cid});
  if(overlordOf(cid)){
    if(overlordOf(cid)===player) pushLog(`${countries[cid].name} 是我朝附庸，如要收回疆土请在外交页吞并`);
    else pushLog(`${countries[cid].name} 是 ${countries[overlordOf(cid)].name} 的附庸，应向其宗主宣战`);
    return;
  }
  if(atWar(player,cid)||truceBetween(player,cid)) return;
  declareWar(player,cid);
  uiTab='war';
  document.querySelectorAll('#panel-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.v==='war'));
  refreshPanel();
}
function peaceSubmit(enemy){
  if(MP.online){
    const checked=[...document.querySelectorAll('.demand:checked')].map(i=>+i.value);
    const rels=[...document.querySelectorAll('.demand-rel:checked')].map(i=>+i.value);
    return mpCmd({c:'peace',enemy,demands:checked,releases:rels});
  }
  const w=wars.find(w=>(w.a===player&&w.d===enemy)||(w.d===player&&w.a===enemy));
  if(!w) return;
  const checked=[...document.querySelectorAll('.demand:checked')].map(i=>+i.value);
  const rels=[...document.querySelectorAll('.demand-rel:checked')].map(i=>+i.value).filter(cid=>overlordOf(cid)===enemy);
  const s=warScore(w);
  const mine=w.a===player?s.a:s.d;
  let cost=0; for(const pid of checked) cost+=peaceCost(provinces[pid]);
  for(const cid of rels) cost+=releaseCost(countries[cid]);
  if(!checked.length&&!rels.length){ pushLog('未选择任何条件'); return; }
  // 验证割地合法性：每个省份必须可被割走（海岸/接壤/与已选省份接壤）
  const takenSet=new Set(checked);
  const invalid=checked.filter(pid=>!canDemandProvince(pid,player,enemy,takenSet));
  if(invalid.length){ pushLog(`${provinces[invalid[0]].name} 不与我国接壤亦非海岸，无法割取`,'war'); return; }
  if(cost<=mine*0.95+0.01){
    pushLog(`和约达成：我们获得了 ${checked.length} 个省份${rels.length?`，${rels.length} 个附庸重获独立`:''}`,'good');
    makePeace(w,checked.map(pid=>({pid,to:player})),true,rels);
  } else {
    pushLog('对方使节拂袖而去——战争分数不足','war');
  }
  refreshPanel();
}
function peaceWhite(enemy){
  if(MP.online) return mpCmd({c:'white',enemy});
  const w=wars.find(w=>(w.a===player&&w.d===enemy)||(w.d===player&&w.a===enemy));
  if(!w) return;
  const s=warScore(w);
  const theirs=w.a===player?s.d:s.a;
  const months=(dayCount-w.startDay)/30;
  if(theirs<70||months>60){ pushLog('双方均无意再战，白色和平缔结','good'); makePeace(w,[],true); }
  else pushLog('敌方自认胜券在握，拒绝白和','war');
  refreshPanel();
}
function peaceAsk(enemy){
  if(MP.online) return mpCmd({c:'ask',enemy});
  const w=wars.find(w=>(w.a===player&&w.d===enemy)||(w.d===player&&w.a===enemy));
  if(!w) return;
  const s=warScore(w);
  const theirs=w.a===player?s.d:s.a;
  if(theirs<=85){
    const transfers=[]; let cost=0;
    const taken=new Set();
    const cands=[];
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(p.pix.length&&(p.owner===player||overlordOf(p.owner)===player)&&p.controller===enemy) cands.push(i);
    }
    let added=true;
    while(added){
      added=false;
      for(const pid of cands){
        if(taken.has(pid)) continue;
        if(cost+peaceCost(provinces[pid])>theirs*0.85) continue;
        if(canDemandProvince(pid,enemy,player,taken)){
          transfers.push({pid,to:enemy}); taken.add(pid); cost+=peaceCost(provinces[pid]); added=true;
        }
      }
    }
    pushLog(`屈辱的和约：割让 ${transfers.length} 个省份`,'war');
    makePeace(w,transfers,true);
  } else pushLog('敌方胃口太大，谈判破裂','war');
  refreshPanel();
}
function offerAccept(){
  if(MP.online) return mpCmd({c:'offer',accept:true});
  if(!pendingOffer) return;
  const w=pendingOffer.war, enemy=pendingOffer.enemy;
  if(pendingOffer.indep){
    countries[enemy].overlord=0;
    countries[enemy].subject=0;
    pushLog(`🎌 ${countries[enemy].name} 重获独立！`,'gold');
  }
  const rels=(pendingOffer.releases||[]).filter(cid=>overlordOf(cid)===player);
  const transfers=pendingOffer.transfers||(pendingOffer.demands||[]).map(pid=>({pid,to:enemy}));
  if(rels.length) pushLog(`依约释放附庸：${rels.map(cid=>countries[cid].name).join('、')} 重获独立`,'');
  if(transfers.length) pushLog(`割地求和：${transfers.length} 个省份易主`,'war');
  else if(!rels.length&&!pendingOffer.indep) pushLog('和约缔结','good');
  makePeace(w,transfers,true,rels);
}
// 动态更新割地复选框：未勾选的省份如不满足接壤/海岸条件则禁用
function updateDemandUI(){
  const checked=new Set([...document.querySelectorAll('.demand:checked')].map(i=>+i.value));
  document.querySelectorAll('.demand').forEach(cb=>{
    const pid=+cb.value;
    const enemy=+cb.dataset.enemy;
    if(cb.checked){ cb.disabled=false; cb.closest('.ck').style.opacity='1'; }
    else {
      const ok=canDemandProvince(pid,player,enemy,checked);
      cb.disabled=!ok;
      cb.closest('.ck').style.opacity=ok?'1':'0.4';
    }
  });
  if(cedeMap.on) paintCedeOverlay(); // 割地地图：勾选变化后重画地图高亮
}

/* ---------- 附庸国机制 ---------- */
// 战争中强制附庸化（玩家按钮）：需60分 + 占领比例≥50% + 两国接壤
function peaceVassal(enemy){
  if(MP.online) return mpCmd({c:'pvassal',enemy});
  const w=wars.find(w=>w&&((w.a===player&&w.d===enemy)||(w.d===player&&w.a===enemy)));
  if(!w) return;
  const s=warScore(w);
  const mine=w.a===player?s.a:s.d;
  const t=countries[enemy];
  const ratio=occRatio(player,enemy);
  if(mine<60){ pushLog('战争分数不足60，无法附庸化','war'); return; }
  if(ratio<0.5){ pushLog(`占领比例不足50%（当前${(ratio*100).toFixed(0)}%），无法附庸化`,'war'); return; }
  if(overlordOf(enemy)){ pushLog(`${t.name} 已是他人附庸`,'war'); return; }
  if(!vassalReachable(player,enemy)){ pushLog(`${t.name} 与我朝既不接壤亦非近海，无法册封附庸`,'war'); return; }
  vassalize(player,enemy);
}
// 独立战争胜利：要求脱离宗主（消耗30分），剩余分数可继续按普通割地模式索要省份
function peaceIndep(enemy){
  if(MP.online) return mpCmd({c:'pindep',enemy});
  const w=wars.find(w=>w&&((w.a===player&&w.d===enemy)||(w.d===player&&w.a===enemy)));
  if(!w) return;
  if(overlordOf(player)!==enemy){ pushLog('对方并非我国宗主','war'); return; }
  const s=warScore(w);
  const mine=w.a===player?s.a:s.d;
  if(mine<30){ pushLog('战争分数不足30，宗主拒绝承认独立','war'); return; }
  const checked=[...document.querySelectorAll('.demand:checked')].map(i=>+i.value);
  const rels=[...document.querySelectorAll('.demand-rel:checked')].map(i=>+i.value).filter(cid=>overlordOf(cid)===enemy);
  const takenSet=new Set(checked);
  const invalid=checked.filter(pid=>!canDemandProvince(pid,player,enemy,takenSet));
  if(invalid.length){ pushLog(`${provinces[invalid[0]].name} 不与我国接壤亦非海岸，无法割取`,'war'); return; }
  let cost=30; for(const pid of checked) cost+=peaceCost(provinces[pid]);
  for(const cid of rels) cost+=releaseCost(countries[cid]);
  if(cost>mine*0.95+0.01){ pushLog('战争分数不足（独立30分+割地/释放附庸费用）','war'); return; }
  countries[player].overlord=0;
  countries[player].subject=0;
  pushLog(`🎌 ${countries[player].name} 赢得独立战争，脱离 ${countries[enemy].name} 自立！${checked.length?`并割让 ${checked.length} 个省份`:''}${rels.length?`，${rels.length} 个附庸同获自由`:''}`,'gold');
  makePeace(w,checked.map(pid=>({pid,to:player})),true,rels);
  labelsDirty=true;
  refreshPanel();
}
// 和平册封：小国收钱称臣（≤3省，双方均不在战争中，须接壤或近海）
function diploVassal(cid){
  if(MP.online) return mpCmd({c:'vassalize',target:cid});
  const t=countries[cid], me=countries[player];
  if(!t||!t.alive||overlordOf(player)||overlordOf(cid)||t.provList.length>3||atWar(player,cid)||inWar(cid)||inWar(player)) return;
  if(!vassalReachable(player,cid)){ pushLog(`${t.name} 与我朝既不接壤亦非近海，无法册封`,'war'); return; }
  const cost=Math.round(60+totalDev(t)*2);
  if(me.gold<cost){ pushLog('国库不足，无法册封','war'); return; }
  me.gold-=cost; t.overlord=player; t.subject=SUBJ_VASSAL;
  clearAllAlliances(cid); // 附庸不得另有盟约
  truces[truceKey(player,cid)]=dayCount+3650;
  pushLog(`👑 ${t.name} 接受册封，岁贡三成，为我藩篱`,'gold');
  labelsDirty=true; refreshPanel();
}
// 吞并附庸：花钱收疆土
function annexVassal(cid){
  if(MP.online) return mpCmd({c:'annex',target:cid});
  const t=countries[cid], me=countries[player];
  if(overlordOf(cid)!==player||inWar(cid)) return;
  const cost=Math.round(totalDev(t)*4);
  if(me.gold<cost){ pushLog('国库不足，无法吞并','war'); return; }
  me.gold-=cost;
  // 被吞并国的附庸转奉我为宗主（继承其整个藩属体系），须在转移省份前处理，
  // 否则最后一省移走会触发 checkDeath 把附庸放独立
  const inherited=countries.filter(vc=>vc&&vc.alive&&vc.overlord===cid);
  for(const vc of inherited) vc.overlord=player;   // 沿用各自原有国体
  for(const pid of [...t.provList]) transferProvince(pid,player);
  t.overlord=0; t.subject=0;
  pushLog(`👑 ${t.name} 王祚断绝，疆土尽入我朝`,'gold');
  for(const vc of inherited) pushLog(`👑 ${vc.name} 转奉我朝为主，为我藩属`,'gold');
  labelsDirty=true;
  refreshPanel();
}
// 解除附庸：放其独立，约定五年之好
function releaseVassal(cid){
  if(MP.online) return mpCmd({c:'release',target:cid});
  const t=countries[cid];
  if(overlordOf(cid)!==player) return;
  t.overlord=0; t.subject=0;
  truces[truceKey(player,cid)]=dayCount+1825;
  pushLog(`${t.name} 重获独立，与我朝约定五年之好`,'');
  labelsDirty=true; refreshPanel();
}
// 赠地给附庸：将我方省份赐予指定小弟（须实际控制该省；赠地后归附庸所有）
function giveProvinceToVassal(pid,vid){
  if(MP.online) return mpCmd({c:'give',prov:pid,to:vid});
  const p=provinces[pid];
  if(!p||!p.pix.length||p.owner!==player||p.controller!==player){ pushLog('该省不在我国实际控制之下，无法赐予','war'); return; }
  if(overlordOf(vid)!==player){ pushLog('对方并非我国附庸','war'); return; }
  if(countries[player].provList.length<=1){ pushLog('仅剩京畿一隅，不可拱手让人','war'); return; }
  const vc=countries[vid];
  transferProvince(pid,vid);
  pushLog(`👑 ${p.name} 赐予 ${vc.name}，以为藩屏`,'gold');
  labelsDirty=true; refreshPanel();
}
/* ---------- 属国改色（免费，纯外观；联机时经服务端广播） ---------- */
function toggleVassalColor(cid){
  diploColorFor = diploColorFor===cid ? 0 : cid;
  if(diploColorFor) diploFocus=cid;
  refreshPanel();
}
function setVassalColor(cid, rgb){
  if(MP.online) return mpCmd({c:'recolor',target:cid,rgb});
  const t=countries[cid];
  if(!t||!t.alive){ pushLog('该国已不存在','war'); return; }
  if(overlordOf(cid)!==player){ pushLog('只能修改我国属国的颜色','war'); return; }
  if(!setCountryColor(cid,rgb)){ pushLog('颜色不合法','war'); return; }
  recolorAll(); rebuildLabels();
  pushLog(`🎨 ${t.name} 的旗色已改为 rgb(${rgb.map(v=>v|0).join(',')})`,'');
  refreshPanel();
}
/* ---------- 修改自己的国名（RENAME_COST 金） ---------- */
function renameSelf(){
  const c=countries[player];
  if(!c||!c.alive) return;
  if(c.gold<RENAME_COST){ pushLog(`国库不足，改易国号需 ${RENAME_COST} 金（现有 ${Math.round(c.gold)}）`,'war'); return; }
  const raw=prompt(`改易国号（最多 ${RENAME_MAX} 字，需 ${RENAME_COST} 金）：`, c.name);
  if(raw===null) return;
  const name=sanitizeCountryName(raw);
  if(!name){ pushLog('国号不能为空','war'); return; }
  if(name===c.name){ pushLog('新国号与旧国号相同',''); return; }
  if(MP.online) return mpCmd({c:'rename',name});
  if(!setCountryName(player,name)){ pushLog('改易国号失败','war'); return; }
  c.gold-=RENAME_COST;
  rebuildLabels(); refreshPanel();
  pushLog(`✏ 国号已改为「${name}」（耗 ${RENAME_COST} 金）`,'gold');
}
// 外交结盟（玩家发起）：共同防御——盟友被宣战时我朝参战，反之亦然
function diploAlliance(cid){
  if(MP.online) return mpCmd({c:'ally',target:cid});
  const t=countries[cid], me=countries[player];
  if(!t||!t.alive||cid===player) return;
  if(overlordOf(player)||overlordOf(cid)){ pushLog('附庸不得另行缔结盟约','war'); return; }
  if(isAllied(player,cid)){ pushLog('双方已是盟友',''); return; }
  if(atWar(player,cid)){ pushLog('交战之中无法结盟','war'); return; }
  if(truceBetween(player,cid)){ pushLog('停战期内旧怨未消，难以缔盟','war'); return; }
  if(inWar(player)||inWar(cid)){ pushLog('缔约双方均须无战事在身','war'); return; }
  // 对方接受意愿：接壤更愿缔盟；过强遭忌惮、过弱怕被拖入战争
  let acc=0.3;
  if(countriesAdjacent(player,cid)) acc+=0.3;
  const myS=countryStrength(player)+totalDev(me)*8, tS=countryStrength(cid)+totalDev(t)*8;
  const r=myS/(tS+1);
  if(r>2.2) acc-=0.35;
  else if(r>1.4) acc-=0.1;
  else if(r<0.55) acc-=0.15;
  if((t.allies||[]).length) acc-=0.15;
  if(rnd()<acc) formAlliance(player,cid);
  else pushLog(`${t.name} 婉拒了结盟提议`,'war');
}
// 复国：把亡国的故土（former 记录、现由我朝持有并控制）重新放出，
// 重建其国于原址，并奉我为附庸
function reviveNation(cid){
  if(MP.online) return mpCmd({c:'revive',target:cid});
  const t=countries[cid], me=countries[player];
  if(!t||t.alive) return;
  if(overlordOf(player)){ pushLog('附庸之身不可另立藩属','war'); return; }
  if(inWar(player)){ pushLog('战事期间人心浮动，不宜复国','war'); return; }
  const provs=[];
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(p.pix.length&&p.owner===player&&p.controller===player&&p.former&&p.former.includes(cid)) provs.push(i);
  }
  if(!provs.length){ pushLog(`我国并无 ${t.name} 控制下的故土，无从复国`,'war'); return; }
  if(me.provList.length-provs.length<1){ pushLog('复国将使我朝无地可立，不可行','war'); return; }
  // 首都：其故土最大陆块上的最大省
  const own=new Set(provs);
  const seen=new Set(); let bestComp=null;
  for(const pid0 of provs){
    if(seen.has(pid0)) continue;
    const comp=[]; const q=[pid0]; let h=0; const cs2=new Set([pid0]);
    while(h<q.length){ const u=q[h++]; comp.push(u); for(const v of provinces[u].nbrs) if(own.has(v)&&!cs2.has(v)){cs2.add(v);q.push(v);} }
    for(const x of comp) seen.add(x);
    if(!bestComp||comp.length>bestComp.length) bestComp=comp;
  }
  let cap=bestComp[0], capLen=0;
  for(const pid of bestComp){ const L=provinces[pid].pix.length; if(L>capLen){capLen=L;cap=pid;} }
  t.alive=true;
  t.overlord=player;
  t.subject=SUBJ_VASSAL;      // 于故土复国 = 普通附庸国
  t.gold=Math.max(t.gold||0,25);
  t.mp=Math.max(t.mp||0,3000);
  t.allies=[];
  t.ruler=RULERS[ri(RULERS.length)]+ROMAN[ri(10)];
  for(const pid of provs) transferProvince(pid,cid);
  t.capital=cap;
  recomputeCap(t);
  truces[truceKey(player,cid)]=dayCount+1825;
  pushLog(`👑 ${t.name} 依我朝扶持，于故土复国，奉我为宗主（${provs.length}省）`,'gold');
  labelsDirty=true; refreshPanel();
}

function setMode(m){
  mapMode=m;
  document.querySelectorAll('#modebar button[data-act=mode]').forEach(b=>b.classList.toggle('active',b.dataset.v===m));
  recolorAll();
}
function renderSpeeds(){
  $('speeds').innerHTML=[1,2,3,4,5].map(i=>`<button data-act="speed" data-v="${i}" class="${!paused&&speed===i?'active':''}">${i}</button>`).join('');
}

/* ---------- 地图交互 ---------- */
let dragging=false, dragMoved=false, lx=0, ly=0;
mapCv.addEventListener('mousedown',e=>{ dragging=true; dragMoved=false; lx=e.clientX; ly=e.clientY; mapCv.classList.add('dragging'); });
window.addEventListener('mousemove',e=>{
  if(!dragging) return;
  const dx=e.clientX-lx, dy=e.clientY-ly;
  if(Math.abs(dx)+Math.abs(dy)>3) dragMoved=true;
  cam.x-=dx/cam.z; cam.y-=dy/cam.z;
  lx=e.clientX; ly=e.clientY;
});
window.addEventListener('mouseup',e=>{
  if(!dragging) return;
  dragging=false; mapCv.classList.remove('dragging');
  if(!dragMoved&&e.target===mapCv) handleClick(e.clientX,e.clientY);
});
mapCv.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY<0?1.18:1/1.18;
  const [wx,wy]=s2w(e.clientX,e.clientY);
  cam.z=clamp(cam.z*f,Math.min(cw/COLS,ch/ROWS)*0.75,24);
  const [wx2,wy2]=s2w(e.clientX,e.clientY);
  cam.x+=wx-wx2; cam.y+=wy-wy2;
},{passive:false});
mapCv.addEventListener('dblclick',e=>{
  const [wx,wy]=s2w(e.clientX,e.clientY);
  cam.x=wx; cam.y=wy;
});
mapCv.addEventListener('contextmenu',e=>{
  e.preventDefault();
  const a=armies.find(x=>x.id===selectedArmy);
  if(a&&a.owner===player){
    if(MP.online){
      a._opt=undefined;
      if(a.isNavy){ a.navPath=null; a.navIdx=0; a.navIdxF=0; a.dstProv=0; }
      else { a.path=[]; a.prog=0; }
      refreshPanel();
      mpCmd({c:'cancel',army:a.id});
      return;
    }
    if(a.isNavy&&a.navPath&&a.navPath.length){ a.navPath=null; a.navIdx=0; a.dstProv=0; refreshPanel(); }
    else if(a.path.length){ a.path=[]; a.prog=0; refreshPanel(); }
  }
});
function handleClick(sx,sy){
  if(!started) return;
  // 1) 军队拾取
  let best=null,bd=14;
  for(const a of armies){
    const [ax,ay]=w2s(...armyPos(a));
    const d=Math.hypot(ax-sx,ay-sy);
    if(d<bd){ bd=d; best=a; }
  }
  if(best){
    selectedArmy=best.id;
    selectedProv=best.prov;
    updateSelOverlay(); refreshPanel();
    return;
  }
  // 2) 省份拾取
  const [wx,wy]=s2w(sx,sy);
  const c=Math.floor(wx), r=Math.floor(wy);
  let pid=0;
  if(c>=0&&c<COLS&&r>=0&&r<ROWS) pid=provOf[r*COLS+c];
  if(pid){
    // 编辑器 / 割地 / 分封 三种地图模式优先拦下点击
    if(editMode.on){ editMapClick(pid); return; }
    if(grantMapToggle(pid)) return;
    if(cedeMapClick(pid)) return;
    const a=armies.find(x=>x.id===selectedArmy);
    if(a&&a.owner===player&&pid!==a.prov){
      if(MP.online){
        // 先用本地结果立刻画出行军路线（世界生成是确定性的，路径与服务端一致），
        // 等服务端那一帧增量回来再以它为准；未被确认的会在 1.2 秒后撤掉
        const np = a.isNavy ? findNavalPath(a.prov,pid) : findPath(a.prov,pid);
        if(np){
          if(a.isNavy){ a.navPath=np; a.navIdx=0; a.navIdxF=0; a.navIdxSrv=0; a.dstProv=pid; a.path=[]; a.prog=0; }
          else { a.path=np; a.prog=0; a.progSrv=0; a.dstProv=np[np.length-1]; }
          a._opt=performance.now();
        }
        mpCmd({c:'path',army:a.id,to:pid});
      } else if(a.isNavy){
        const np=findNavalPath(a.prov,pid);
        if(np){ a.navPath=np; a.navIdx=0; a.dstProv=pid; a.path=[]; a.prog=0; }
        else pushLog(provinces[pid].coastPix.length?'无法找到通往该省的海路（被冰封阻隔？）':'目标省没有海岸线，无法派遣舰队');
      } else {
        const path=findPath(a.prov,pid);
        if(path){ a.path=path; a.prog=0; }
        else pushLog('无法找到通往该省的陆路');
      }
    }
    selectedProv=pid;
    updateSelOverlay(); refreshPanel();
  } else {
    selectedProv=0; selectedArmy=0;
    updateSelOverlay(); refreshPanel();
  }
}
window.addEventListener('keydown',e=>{
  if(!started) return;
  if(e.code==='Space'){ e.preventDefault(); if(MP.online) mpCmd({c:'pause',paused:!paused}); else { paused=!paused; updateTopbar(); } }
  else if(e.key>='1'&&e.key<='5'){ if(MP.online) mpCmd({c:'speed',speed:+e.key}); else { speed=+e.key; paused=false; renderSpeeds(); updateTopbar(); } }
  else if(e.key==='p'||e.key==='P'){ perfHud=!perfHud; const el=document.getElementById('perf-hud'); if(!perfHud&&el) el.remove(); }
  else if(e.key==='m'||e.key==='M'){
    const modes=['political','dev','rel'];
    setMode(modes[(modes.indexOf(mapMode)+1)%3]);
  }
});

/* ---------- 存档（多槽；单机模式） ---------- */
// makeSaveData/applySaveData 在 game-core.js 中（服务端与客户端共用）
// 读档：套用核心状态后补齐界面
function loadSaveData(d){
  grantMapCancel();          // 读档/换局：退出分封地图，免得带着上一局的选区
  applySaveData(d);
  player=d.player||player;
  if(d.mapMode) setMode(d.mapMode);
  recolorAll(); rebuildLabels();
  selectedProv=0; selectedArmy=0; updateSelOverlay();
  if(!started){
    started=true;
    $('selectmodal').classList.add('hidden');
    $('topbar').classList.remove('hidden');
    $('modebar').classList.remove('hidden');
    $('sidepanel').classList.remove('hidden');
    $('logpanel').classList.remove('hidden');
    renderSpeeds(); updateTopbar();
  }
  const cap=countries[player].capital;
  cam.x=provinces[cap].cx; cam.y=provinces[cap].cy; cam.z=3;
  renderLog(); refreshPanel();
}
// 渲染存档列表（槽位 UI）
function slotRowHtml(s){
  const canOverwrite = slotMode==='save';
  const n=escHtml(s.n), act=canOverwrite?'slot-pick':'slot-load';
  return `<div class="slot-row" data-act="${act}" data-v="${n}">
    <span class="sl-name">${n}</span>
    <span class="sl-time">${escHtml(slotTimeLabel(s))}</span>
    <button class="sl-btn" data-act="${act}" data-v="${n}">${canOverwrite?'用此名':'读取'}</button>
    <button class="sl-del" data-act="slot-del" data-v="${n}">删除</button>
  </div>`;
}
async function renderSlotList(){
  const box=$('slot-list');
  let list=[];
  try{ list=await listSlots(); }catch(e){}
  if(!list.length){
    box.innerHTML='<div class="slot-empty">暂无存档<br><span style="font-size:11px;color:#6b5f48">（exe 版存档保存在程序旁的 saves 文件夹）</span></div>';
    return;
  }
  box.innerHTML=list.map(slotRowHtml).join('');
}
// 打开存档弹窗
async function openSlotModal(mode){
  slotMode=mode||'save';
  const saving = slotMode==='save';
  $('slot-title').textContent = saving?'保存进度':'读取进度';
  $('slot-sub').textContent = saving?'把当前纪元存成一个档位，可随时回来续玩。':'点击一个存档载入这段历史。';
  $('slot-save-area').classList.toggle('hidden', !saving);
  $('slot-hint-save').style.display = saving?'':'none';
  $('btn-start-load').style.display='none';
  if(saving) $('slot-name').value = fmtDate();
  $('slotmodal').classList.remove('hidden');
  await renderSlotList();
  if(saving){ const inp=$('slot-name'); inp.focus(); inp.select(); }
}
function closeSlotModal(){
  $('slotmodal').classList.add('hidden');
  // 若从选国界面打开过，回来后按有无存档决定是否显示读档入口
  refreshStartLoadBtn();
}
async function slotSaveNow(){
  const name=($('slot-name').value||'').trim();
  if(!name){ pushLog('请输入一个存档名字','war'); const inp=$('slot-name'); inp.focus(); return; }
  const ok=await writeSlot(name, makeSaveData());
  pushLog(ok?`已保存「${name}」（${fmtDate()}）`:'保存失败','gold');
  if(ok){ await renderSlotList(); const inp=$('slot-name'); inp.focus(); inp.select(); }
}
async function slotLoadByName(name){
  const d=await readSlot(name);
  if(!d){ pushLog('读取「'+name+'」失败','war'); return; }
  try{ loadSaveData(d); }catch(err){ pushLog('读档失败：'+err.message,'war'); return; }
  pushLog(`时光倒流——已载入「${name}」`,'gold');
  closeSlotModal();
}
async function slotDeleteByName(name){
  await deleteSlot(name);
  pushLog(`已删除存档「${name}」`,'war');
  await renderSlotList();
}
// 选国界面：有存档就显示"读取存档"入口
async function refreshStartLoadBtn(){
  try{
    const list=await listSlots();
    const has=list&&list.length>0;
    $('btn-start-load').style.display = has?'':'none';
  }catch(e){ $('btn-start-load').style.display='none'; }
}

/* ---------- 开局 ---------- */
function renderSelectList(q){
  q=q||'';
  const list=[...countries].filter(c=>c&&c.alive)
    .filter(c=>!q||c.name.includes(q)||c.enName.toLowerCase().includes(q.toLowerCase()))
    .sort((a,b)=>totalDev(b)-totalDev(a));
  $('sel-list').innerHTML=list.map(c=>
    `<div class="c-row" data-act="start" data-v="${c.id}">
      <span class="cd" style="background:rgb(${c.color.map(v=>v|0)})"></span>
      <span class="cn">${c.name}</span>
      <span class="cs">${c.provList.length}省 · 发展度${totalDev(c)}</span>
    </div>`).join('');
}
function startGame(cid){
  player=cid;
  started=true;
  paused=true;
  $('selectmodal').classList.add('hidden');
  $('topbar').classList.remove('hidden');
  $('modebar').classList.remove('hidden');
  $('sidepanel').classList.remove('hidden');
  $('logpanel').classList.remove('hidden');
  const c=countries[player];
  const cap=provinces[c.capital];
  cam.x=cap.cx; cam.y=cap.cy; cam.z=3;
  renderSpeeds(); updateTopbar(); refreshPanel();
  pushLog(`公元1444年，${c.ruler} 治下的 ${c.name} 踏入乱世。点击地图开始你的传奇。`,'gold');
  pushLog('提示：先在外交页物色邻邦，招募军团，然后宣战。空格开始/暂停时间。');
}

/* ---------- 主循环 ---------- */
let lastT=performance.now(), acc=0;
const SPEEDS=[2,5,10,20,40]; // 天/秒
let _frameMs=16.7;
function loop(t){
  const rawMs=t-lastT;
  // 真实帧间隔才是"机器跑不跑得动"的可靠信号；
  // 之前量的 render() JS 调用耗时在浏览器里恒为 0（光栅化是延后做的），自适应等于没生效
  if(rawMs>0&&rawMs<250) _frameMs=_frameMs*0.9+rawMs*0.1;
  const dt=Math.min(0.1,rawMs/1000); lastT=t;
  if(MP.online){
    // 联机：世界由服务端推进，本地只做行军插值让画面顺滑
    mpAnimateArmies();
    uiTick(t);
  } else if(started&&!paused){
    acc+=dt*SPEEDS[speed-1];
    let steps=Math.min(Math.floor(acc),80);
    acc-=steps;
    while(steps-->0) tickDay();
    uiTick(t);
    if(paused||cal.d===1) updateTopbar();
  } else {
    uiTick(t);
  }
  const _t0=performance.now();
  render(t);
  _renderMs=_renderMs*0.88+(performance.now()-_t0)*0.12;
  tuneRenderScale(t);
  perfRates(t);
  if(perfHud) drawPerf(t);
  requestAnimationFrame(loop);
}

/* ---------- 初始化 ---------- */
function setLoad(msg,pct){
  $('ld-msg').textContent=msg;
  if(pct!==undefined) $('ld-bar').style.width=pct+'%';
}
const tickAsync=()=>new Promise(r=>setTimeout(r,20));
(async function init(){
  try{
    setLoad('解析世界地图……',10); await tickAsync();
    const feats=decodeTopo(WORLD_DATA);
    setLoad('绘制大陆与海岸线……',30); await tickAsync();
    const {cidMap}=buildLand(feats);
    setLoad('划分行省边界……',55); await tickAsync();
    buildProvinces(cidMap,feats);
    setLoad('建立国家与王朝……',80); await tickAsync();
    buildCountries(cidMap,feats);
    setLoad('渲染世界……',95); await tickAsync();
    recolorAll();
    setLoad('完成！',100); await tickAsync();
    $('loading').classList.add('hidden');

    /* 昵称记忆 + 断线自动回房 */
    try{ const n=localStorage.getItem('gs_name'); if(n) $('lb-name').value=n; }catch(e){}
    let resumed=false;
    try{
      const s=JSON.parse(sessionStorage.getItem('gs_session')||'null');
      if(s&&s.room){
        $('lb-name').value=s.name||'';
        MP.name=s.name||'';
        lbMsg('正在回到房间 '+s.room+' ……');
        mpConnect(()=>mpResume());
        resumed=true;
      }
    }catch(e){}

    $('lobby').classList.remove('hidden');
    lbShow('entry');
    updateMapBadge();
    try{ const t=sessionStorage.getItem('gs_admin_tok'); if(t) adminTok=t; }catch(e){}
    try{ const q=new URLSearchParams(location.search);
      if(q.get('room')){ $('lb-code').value=q.get('room'); lbShow('entry'); }
      if(q.get('solo')!==null&&q.get('solo')!==undefined&&q.get('solo')!=='') mpSolo();
      if(q.get('perf')) perfHud=true;
      if(q.get('admin')) openAdmin();
    }catch(e){}
    if(!resumed) lbMsg('');
    requestAnimationFrame(loop);
  }catch(err){
    setLoad('加载失败',0);
    $('ld-err').textContent='错误：'+err.message+'（请尝试刷新页面）';
    console.error(err);
  }
})();
