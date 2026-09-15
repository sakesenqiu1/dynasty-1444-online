'use strict';
/* =====================================================================
   王朝纪元 · 1444 — 游戏核心（世界构建 + 规则模拟）
   浏览器与 Node 服务端共用同一份代码：不依赖 DOM。
   ===================================================================== */

/* ---------- 常量 ---------- */
/* ---------- 常量 ---------- */
const COLS=1440, ROWS=720, NPIX=COLS*ROWS;   // 0.25°/像素 等距圆柱投影
const SP=13;                                  // 省份种子间距（参考值，实际按 spAt(r) 取）
// 纬度变化的地块密度：中低纬度地块更小更多、高纬地块更大更少（极区密集不再扩张）
function spAt(r){
  const lat=Math.abs(90-(r+0.5)*0.25);        // 0=赤道, 90=极
  if(lat<35)  return 9;                       // 低纬：紧凑（~2.25° 一格）
  if(lat<55)  return 12;                      // 中纬：适中（~3°）
  if(lat<70)  return 17;                      // 高纬：宽松（~4.25°）
  return 24;                                  // 极区：稀疏（~6°，避免极地无穷细分）
}
const HOP=12;                                 // 行军一省天数
const SIEGE_DIV=3000;                         // 围城速率除数
const RECRUIT_DAYS=365;                       // 陆军集结周期（1 年）
const NAVY_DAYS=270;                          // 舰队组建周期（9 个月）
const SEA='#2a4260';
const CAL_M=[31,28,31,30,31,30,31,31,30,31,30,31];
const SAVE_KEY='dynasty1444_save_v1';

/* ---------- 存档介质：多存档槽（exe 版走宿主 saves\ 文件夹，网页版走 localStorage） ---------- */

/* ---------- 随机数与数学工具 ---------- */
let _seed=987654321;
function rnd(){ _seed=(_seed*1103515245+12345)&0x7fffffff; return _seed/0x7fffffff; }
function ri(n){ return Math.floor(rnd()*n); }
function hash32(x){ x=(x^61)^(x>>>16); x=(x+(x<<3))|0; x^=x>>>4; x=Math.imul(x,0x27d4eb2d); x^=x>>>15; return x>>>0; }
function lerp(a,b,t){ return a+(b-a)*t; }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function hsl(h,s,l){ const a=s*Math.min(l,1-l); const f=n=>{const k=(n+h*12)%12; return l-a*Math.max(-1,Math.min(k-3,Math.min(9-k,1)));}; return [f(0)*255,f(8)*255,f(4)*255]; }
function fmtK(v){ return v>=1000? (v/1000).toFixed(1)+'k' : Math.round(v)+''; }

const PROV_SYL=['布','兰','塔','诺','维','斯','拉','德','尔','格','罗','尼','亚','顿','堡','明','汉','威','萨','特','蒙','贝','里','弗','约','克','塞','安','东','奥','波','梅','琴','伦','巴','戈','卢','泽','杜','卡','马','普','提','辛','沃','丹','登','法','图','索'];
const RULERS=['腓特烈','威廉','亨利','理查','路易','查理','斐迪南','阿方索','瓦西里','伊凡','巴耶济德','穆罕默德','卡齐米日','西吉斯蒙德','瓦迪斯瓦夫','马克西米利安','恩里克','若昂','古斯塔夫','克里斯蒂安','斯蒂芬','马加什','拉约什','贝拉','德米特里','奥列格','苏莱曼','塞利姆','帖木儿','沙哈鲁','奥托','鲁道夫','康拉德','利奥波德','弗朗茨','亚历山大','尼古拉','彼得','米哈伊尔','弗拉基米尔','巴西尔','曼努埃尔','君士坦丁','巴赫兰','朱棣','李成桂','足利义政','黎利','郑和','王振'];
const ROMAN=['一世','二世','三世','四世','五世','六世','七世','八世','九世','十世','十一世','十二世'];
// EU4 1444 时期国家命名（覆盖 world-atlas 110m 全部 177 个 ISO 3166-1 numeric）
// 边界仍是现代国境（公开数据没有 1444 矢量），但国家名按 15 世纪中叶
const ZH_NAMES={
  '004':'呼罗珊','008':'阿尔巴尼亚','010':'南极诸部','012':'阿尔及尔诸部','024':'刚果王国','031':'希尔万','032':'拉普拉塔诸部','036':'澳大利亚无人地','040':'奥地利公国','044':'巴哈马诸部','050':'孟加拉苏丹国','051':'亚美尼亚','056':'布拉班特','064':'不丹诸部','068':'玻利维亚诸部','070':'波斯尼亚','072':'博茨瓦纳诸部','076':'巴西诸部','084':'伯利兹玛雅','090':'所罗门诸部','096':'文莱苏丹国','100':'保加利亚第二帝国','104':'勃固王国','108':'布隆迪','112':'立陶宛大公国','116':'高棉帝国','120':'喀麦隆诸部','124':'北美诸部','140':'中非诸部','144':'锡兰','148':'乍得湖诸部','152':'马普切','156':'大明','158':'东番诸部','170':'新格拉纳达','178':'刚果王国','180':'刚果','188':'哥斯达黎加诸部','191':'克罗地亚','192':'古巴诸部','196':'塞浦路斯','203':'波希米亚王国','204':'贝宁诸部','2041':'贝宁帝国','214':'多米尼加诸部','218':'厄瓜多尔诸部','222':'萨尔瓦多诸部','226':'赤道几内亚诸部','231':'埃塞俄比亚','232':'厄立特里亚','233':'爱沙尼亚','238':'马尔维纳斯诸部','242':'斐济诸部','246':'芬兰诸部','250':'法兰西王国','260':'法属南极诸部','262':'吉布提诸部','266':'加蓬诸部','268':'格鲁吉亚','270':'冈比亚诸部','275':'巴勒斯坦诸部','276':'德意志诸邦','288':'加纳','300':'希腊','304':'格陵兰因纽特','320':'危地马拉玛雅','324':'几内亚诸部','328':'圭亚那诸部','332':'海地诸部','340':'洪都拉斯玛雅','348':'匈牙利王国','352':'冰岛','356':'印度诸邦','360':'马来诸邦','368':'巴格达','372':'爱尔兰','376':'圣地诸城','380':'意大利诸邦','384':'科特迪瓦','388':'牙买加诸部','392':'日本国','398':'哈萨克诸部','400':'外约旦','404':'基库尤诸部','408':'朝鲜王朝','410':'朝鲜王朝','414':'科威特','417':'吉尔吉斯诸部','418':'老挝诸部','422':'黎巴嫩','426':'莱索托诸部','428':'利沃尼亚','430':'利比里亚诸部','434':'的黎波里','440':'立陶宛大公国','442':'卢森堡','450':'马达加斯加诸部','454':'马拉维诸部','458':'马六甲苏丹国','466':'马里帝国','478':'毛里塔尼亚','484':'阿兹特克','496':'蒙古诸部','499':'黑山','4991':'杜卡利亚','5001':'塞尔维亚','5002':'波斯尼亚','5003':'阿尔巴尼亚','5004':'瓦拉几亚','5005':'特兰西瓦尼亚','5006':'摩尔达维亚','504':'马林王朝','508':'莫桑比克诸部','512':'马斯喀特','516':'纳米比亚诸部','524':'尼泊尔','548':'瓦努阿图诸部','554':'毛利诸部','558':'尼加拉瓜玛雅','562':'博尔努帝国','566':'桑海帝国','578':'挪威','586':'信德','591':'巴拿马诸部','598':'巴布亚诸部','600':'巴拉圭诸部','604':'印加帝国','608':'吕宋诸邦','616':'波兰王国','620':'葡萄牙王国','624':'几内亚比绍','626':'帝汶诸部','630':'波多黎各诸部','642':'瓦拉几亚','643':'莫斯科大公国','646':'卢旺达','662':'南阿拉伯诸部','670':'北也门','672':'南也门','682':'阿拉伯诸部','686':'塞内加尔诸部','688':'塞尔维亚','694':'塞拉利昂','703':'斯洛伐克','704':'大越','705':'卡尔尼奥拉','706':'索马里诸部','710':'祖鲁诸部','716':'津巴布韦诸部','724':'卡斯提尔','728':'南苏丹诸部','729':'苏丹诸部','732':'西撒哈拉诸部','740':'苏里南诸部','748':'斯威士兰诸部','752':'瑞典王国','756':'瑞士邦联','760':'大马士革','762':'塔吉克诸部','364':'波斯','528':'荷兰诸邦','540':'新喀里多尼亚诸部','764':'暹罗王国','788':'突尼斯','768':'多哥诸部','780':'特立尼达诸部','784':'特鲁西尔','792':'奥斯曼帝国','795':'土库曼诸部','800':'乌干达','804':'乌克兰诸部','807':'马其顿','818':'马穆鲁克王朝','826':'英格兰王国','832':'布干达','834':'基卢瓦苏丹国','840':'北美十三部','854':'布基纳法索诸部','858':'乌拉圭诸部','860':'乌兹别克诸部','862':'加拉加斯','882':'萨摩亚诸部','887':'也门','894':'赞比亚诸部'
};

/* ---------- 全局状态 ---------- */
let land=null, provOf=null;              // 栅格
let provinces=[null];                    // 1-based
let countries=[null];                    // 1-based
let armies=[]; let nextArmy=1;
let recruits=[]; let nextRecruit=1;            // 征兵队列：{id,owner,prov,str,isNavy,days,total}
let wars=[]; let truces={};
let player=0, dayCount=0;        // 本机视角的国家（服务端不使用；判定人类玩家一律用 isHuman）
let humans=new Set();            // 人类玩家控制的国家 id 集合（联机时由服务端下发）
function isHuman(cid){ return humans.has(cid); }
function setHumans(list){ humans=new Set(list||[]); }
let cal={y:1444,m:10,d:11};
let paused=true, speed=2;
let mapMode='political';
let selectedProv=0, selectedArmy=0;
let uiTab='info', uiSearch='', diploFocus=0, diploColorFor=0;   // diploColorFor: 正在为其选颜色的属国
let pendingOffers={};             // cid -> 该国玩家当前待决的敌方和约提案
let labelsDirty=true;
let battleProvs=new Set();
let started=false;
let logEntries=[];
const LOG_MAX=140;

/* ---------- 界面钩子：服务端保持空实现，浏览器端由 client.js 覆盖 ---------- */
const UI={
  log:function(){},           // (text, cls, forCid) 追加一条日志
  panel:function(){},         // 刷新侧栏
  topbar:function(){},        // 刷新顶栏
  recolorNbrs:function(){},   // (pid) 重绘该省及其邻省
  cedeReset:function(){},     // 退出割地地图模式
  defeat:function(){}         // (cid) 该人类玩家的王朝覆灭
};

/* ---------- 世界纪事：forCid=0 为公开消息，否则仅该国玩家可见 ---------- */
function fmtDate(){ return `${cal.y}年${cal.m+1}月${cal.d}日`; }
function pushLog(text,cls,forCid){
  forCid=forCid|0;
  logEntries.unshift({t:text,cls:cls||'',d:fmtDate(),f:forCid});
  while(logEntries.length>LOG_MAX) logEntries.pop();
  UI.log(text,cls||'',forCid);
}
/* 只通知涉事的人类玩家（各自收到一份私密消息） */
function pushLogTo(cids,text,cls){
  let any=false;
  for(const cid of cids){ if(isHuman(cid)){ pushLog(text,cls,cid); any=true; } }
  return any;
}
/* 世界大事：涉及人类玩家、或当事国够大时向所有人广播 */
function pushLogWorld(text,cls,involved,big){
  if(big||(involved&&involved.some(isHuman))) pushLog(text,cls,0);
}

/* =====================================================================
   一、世界构建
   ===================================================================== */
function decodeTopo(topo){
  const t=topo.transform||{scale:[1,1],translate:[0,0]};
  const arcs=topo.arcs.map(arc=>{ const out=[]; let x=0,y=0;
    for(const p of arc){ x+=p[0]; y+=p[1]; out.push([x*t.scale[0]+t.translate[0], y*t.scale[1]+t.translate[1]]); }
    return out; });
  const feats=[];
  for(const g of topo.objects.countries.geometries){
    if(!g||g.type===null) continue;
    if(g.id==='010') continue; // 南极
    const polys = g.type==='Polygon' ? [g.arcs] : g.arcs;
    const coords=polys.map(poly=>{
      const rings=poly.map(ring=>{
        const pts=[];
        for(const ai of ring){
          let a = ai>=0 ? arcs[ai] : arcs[~ai].slice().reverse();
          for(let i=0;i<a.length;i++){ if(pts.length>0&&i===0) continue; pts.push(a[i]); }
        }
        return pts;
      });
      // antimeridian unwrap：跨 180° 子午线的环不做切断，而是经度连续化（允许 >180 / <-180），
      // buildLand 填色时按取模回绕到地图列。切断方案的缺陷：左右两侧片段没有沿地图边缘闭合，
      // 扫描线会把两侧交点错误配对（如 -171.6 配 30.0），产生横跨整片海洋的假陆地条带。
      const fixed=[];
      for(const ring of rings){
        if(ring.length<3) continue;
        const out=[[ring[0][0],ring[0][1]]];
        for(let i=1;i<ring.length;i++){
          let lon=ring[i][0];
          const prev=out[out.length-1][0];
          while(lon-prev>180) lon-=360;
          while(lon-prev<-180) lon+=360;
          out.push([lon,ring[i][1]]);
        }
        fixed.push(out);
      }
      return fixed;
    });
    feats.push({id:String(g.id), name:(g.properties&&g.properties.name)||'未知', coords});
  }
  return feats;
}

function buildLand(feats){
  land=new Uint8Array(NPIX);            // 0=海洋, 否则国家编号(1基)
  const cidMap=new Map();               // featIdx -> countryIdx+1
  feats.forEach((f,i)=>cidMap.set(i,cidMap.size+1));
  for(const [fi,f] of feats.entries()){
    const cid=cidMap.get(fi);
    for(const poly of f.coords){
      let minLat=90,maxLat=-90;
      for(const ring of poly) for(const pt of ring){ if(pt[1]<minLat)minLat=pt[1]; if(pt[1]>maxLat)maxLat=pt[1]; }
      let r0=Math.max(0,Math.floor((90-maxLat)/0.25)), r1=Math.min(ROWS-1,Math.ceil((90-minLat)/0.25));
      const edges=[];
      for(const ring of poly) for(let i=0;i<ring.length-1;i++){
        if(ring[i][1]!==ring[i+1][1]) edges.push([ring[i][0],ring[i][1],ring[i+1][0],ring[i+1][1]]);
      }
      for(let r=r0;r<=r1;r++){
        const lat=90-(r+0.5)*0.25, xs=[];
        for(const e of edges){
          if((e[1]<=lat&&e[3]>lat)||(e[3]<=lat&&e[1]>lat)) xs.push(e[0]+(lat-e[1])/(e[3]-e[1])*(e[2]-e[0]));
        }
        if(xs.length<2) continue;
        xs.sort((a,b)=>a-b);
        for(let k=0;k+1<xs.length;k+=2){
          // xs 可能在 [-540,540] 的展开经度空间里：列索引按取模回绕到 [0,COLS)
          const c1=Math.floor((xs[k]+180)/0.25), c2=Math.ceil((xs[k+1]+180)/0.25);
          for(let c=c1;c<=c2;c++){
            const lon=-180+(c+0.5)*0.25;
            if(lon>xs[k]&&lon<xs[k+1]){
              const cw=((c%COLS)+COLS)%COLS;
              land[r*COLS+cw]=cid;
            }
          }
        }
      }
    }
  }
  // 后处理：消除 antimeridian cut 残留导致的横跨整行假陆地（真实大陆单行不可能 >85%）
  for(let r=0;r<ROWS;r++){
    let landCount=0;
    for(let c=0;c<COLS;c++) if(land[r*COLS+c]) landCount++;
    if(landCount>COLS*0.85){
      for(let c=0;c<COLS;c++) land[r*COLS+c]=0;
    }
  }
  return {feats,cidMap};
}

function buildProvinces(cidMap,feats){
  // 1) 抖动网格种子（按纬度疏密排布：spAt(r) 返该行种子间距）
  const sites=[]; const siteOwner=[];
  for(let r=0;r<ROWS;r++){
    const sp=spAt(r);
    if(r%sp!==(sp>>1)) continue;        // 行起点偏移 = sp/2（原行为 SP>>1）
    for(let c=sp>>1;c<COLS;c+=sp){
      const rr=Math.min(ROWS-1,r+ri(sp)), cc=Math.min(COLS-1,c+ri(sp));
      if(land[rr*COLS+cc]){ sites.push(rr*COLS+cc); }
    }
  }
  // 2) 多源 BFS 分配（含孤岛补种子）
  provOf=new Int32Array(NPIX);
  const queue=new Int32Array(NPIX); let qh=0,qt=0;
  let pid=0;
  function addSite(px){
    pid++;
    provOf[px]=pid; queue[qt++]=px; sites.push(px);
  }
  for(const s of sites){ pid++; provOf[s]=pid; queue[qt++]=s; }
  // 注意：sites 数组先被用于种子里程，改为逐个入队
  while(qh<qt){
    const i=queue[qh++], p=provOf[i], r=(i/COLS)|0, c=i%COLS;
    if(c+1<COLS){ const j=i+1; if(land[j]&&!provOf[j]){provOf[j]=p;queue[qt++]=j;} }
    if(c>0){ const j=i-1; if(land[j]&&!provOf[j]){provOf[j]=p;queue[qt++]=j;} }
    if(r+1<ROWS){ const j=i+COLS; if(land[j]&&!provOf[j]){provOf[j]=p;queue[qt++]=j;} }
    if(r>0){ const j=i-COLS; if(land[j]&&!provOf[j]){provOf[j]=p;queue[qt++]=j;} }
  }
  // 孤岛 / 未覆盖地块 → 各成新省
  for(let i=0;i<NPIX;i++){
    if(land[i]&&!provOf[i]){
      addSite(i); // 会覆盖整个连通分量
      while(qh<qt){
        const k=queue[qh++], p2=provOf[k], r2=(k/COLS)|0, c2=k%COLS;
        if(c2+1<COLS){ const j=k+1; if(land[j]&&!provOf[j]){provOf[j]=p2;queue[qt++]=j;} }
        if(c2>0){ const j=k-1; if(land[j]&&!provOf[j]){provOf[j]=p2;queue[qt++]=j;} }
        if(r2+1<ROWS){ const j=k+COLS; if(land[j]&&!provOf[j]){provOf[j]=p2;queue[qt++]=j;} }
        if(r2>0){ const j=k-COLS; if(land[j]&&!provOf[j]){provOf[j]=p2;queue[qt++]=j;} }
      }
    }
  }
  const np=pid;
  // 3) 归集像素、邻接、边界、质心、归属多数票
  provinces=[null];
  for(let i=1;i<=np;i++) provinces.push({id:i,pix:[],nbrs:new Set(),borderPix:new Map(),coastPix:[],cx:0,cy:0});
  const ownerTally=new Int32Array((np+1)*180); // 国家数<180
  for(let i=0;i<NPIX;i++){
    const p=provOf[i]; if(!p) continue;
    const pr=provinces[p];
    pr.pix.push(i);
    const r=(i/COLS)|0,c=i%COLS;
    pr.cx+=c+0.5; pr.cy+=r+0.5;
    const cv=land[i]; ownerTally[p*180+cv]++;
    // 右邻
    if(c+1<COLS){ const j=i+1,q=provOf[j];
      if(!q) pr.coastPix.push(i);
      else if(q!==p){ pr.nbrs.add(q); addBorder(pr,q,i); const qr=provinces[q]; qr.nbrs.add(p); addBorder(qr,p,j); }
    } else pr.coastPix.push(i);
    // 下邻
    if(r+1<ROWS){ const j=i+COLS,q=provOf[j];
      if(!q) pr.coastPix.push(i);
      else if(q!==p){ pr.nbrs.add(q); addBorder(pr,q,i); const qr=provinces[q]; qr.nbrs.add(p); addBorder(qr,p,j); }
    } else pr.coastPix.push(i);
  }
  function addBorder(pr,q,idx){ let a=pr.borderPix.get(q); if(!a){a=[];pr.borderPix.set(q,a);} a.push(idx); }
  // 4) 定名、发展度、归属
  for(let i=1;i<=np;i++){
    const p=provinces[i];
    if(p.pix.length===0){ continue; }
    p.nbrs=[...p.nbrs];
    p.cx/=p.pix.length; p.cy/=p.pix.length;
    // 多数票国家
    let best=0,bestN=-1;
    for(let c2=1;c2<180;c2++){ const n=ownerTally[i*180+c2]; if(n>bestN){bestN=n;best=c2;} }
    p.owner=best; p.controller=best; p.siege=0;
    p.name=PROV_SYL[ri(PROV_SYL.length)]+PROV_SYL[ri(PROV_SYL.length)]+(rnd()<0.35?PROV_SYL[ri(PROV_SYL.length)]:'');
    p.tax=1+ri(3); p.prod=1+ri(2); p.man=1+ri(3);
    p.varF=0.88+(hash32(i*7919)%100)/100*0.24;
  }
  return np;
}

function buildCountries(cidMap,feats){
  const nFeats=cidMap.size;
  countries=[null];
  for(let c=1;c<=nFeats;c++){
    const fi=[...cidMap.entries()].find(([,v])=>v===c)[0];
    const f=feats[fi];
    countries.push({id:c, featId:f.id, name:ZH_NAMES[f.id]||f.name, enName:f.name,
      color:hsl((hash32(c*2654435761)%360)/360,0.46,0.5),
      ruler:RULERS[ri(RULERS.length)]+ROMAN[ri(6)],
      gold:0, mp:0, mpCap:0, income:0, provList:[], capital:0, alive:false, lx:0, ly:0, overlord:0, subject:0, allies:[]});
  }
  // 东番（台湾）并入大明：1444年岛上并无政权，部族之地直属明廷海疆
  // 索马里兰（无ISO代码子区域）并入索马里诸部
  const mergePairs=[['156','158'],['706','__SOMALILAND__']];
  for(const [dstKey,srcKey] of mergePairs){
    const dstC=countries.find(x=>x&&String(x.featId)===dstKey);
    const srcC=srcKey==='__SOMALILAND__'
      ?countries.find(x=>x&&x.enName==='Somaliland')
      :countries.find(x=>x&&String(x.featId)===srcKey);
    if(dstC&&srcC&&srcC!==dstC){
      for(let i=1;i<provinces.length;i++){
        const p=provinces[i];
        if(p&&p.pix.length&&p.owner===srcC.id){ p.owner=dstC.id; p.controller=dstC.id; }
      }
    }
  }
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p||!p.pix.length) continue;
    const c=countries[p.owner]; if(!c) continue;
    c.provList.push(i); c.alive=true;
  }
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc.alive) continue;
    // 首都 = 最大陆块（陆路连通分量）上的最大省。
    // 避免疆域横跨大陆+群岛的国家（如俄罗斯/加拿大）把首都和初始军团放到孤岛上。
    const own=new Set(cc.provList);
    const seen=new Set();
    let bestComp=null;
    for(const pid0 of cc.provList){
      if(seen.has(pid0)) continue;
      const comp=[]; const q=[pid0]; let h=0; const compSet=new Set([pid0]);
      while(h<q.length){
        const u=q[h++]; comp.push(u);
        for(const v of provinces[u].nbrs) if(own.has(v)&&!compSet.has(v)){ compSet.add(v); q.push(v); }
      }
      for(const x of comp) seen.add(x);
      if(!bestComp||comp.length>bestComp.length) bestComp=comp;
    }
    let cap=bestComp[0], capLen=0;
    for(const pid of bestComp){ const L=provinces[pid].pix.length; if(L>capLen){capLen=L;cap=pid;} }
    cc.capital=cap;
    const cp=provinces[cap]; cp.tax+=2; cp.prod+=1; cp.man+=2;
    recomputeCap(cc);
    cc.gold=40+totalDev(cc)*0.6;
    cc.mp=cc.mpCap;
    // 初始军队
    const str=Math.min(30000, 4000+totalDev(cc)*90);
    armies.push({id:nextArmy++,owner:c,prov:cap,str:str,path:[],prog:0});
  }
  rebuildLabels();
}
function recomputeCap(c){
  let mp=0,fl=0;
  for(const pid of c.provList){ const p=provinces[pid]; mp+=p.man*750; fl+=(p.tax+p.man)*220; }
  c.mpCap=mp; c.forceLimit=fl;
}
function totalDev(c){ let d=0; for(const pid of c.provList){ const p=provinces[pid]; d+=p.tax+p.prod+p.man; } return d; }
function rebuildLabels(){
  for(let c=1;c<countries.length;c++){
    const cc=countries[c]; if(!cc||!cc.alive){cc&&(cc.lx=0,cc.ly=0); continue;}
    // 1) 算国家总像素，筛掉 < 0.5% 的极小省份（孤岛），避免质心被拉偏
    let totalPix=0;
    for(const pid of cc.provList){ const p=provinces[pid]; if(p) totalPix+=p.pix.length; }
    const minPix=Math.max(8, totalPix*0.005);
    // 2) 用筛后省份的像素列号/行号求加权质心（按像素直接加权，不按省份面积）
    let sx=0,sy=0,sn=0;
    for(const pid of cc.provList){
      const p=provinces[pid]; if(!p||p.pix.length<minPix) continue;
      for(const px of p.pix){
        const r=(px/COLS)|0, col=px%COLS;
        sx+=col+0.5; sy+=r+0.5; sn++;
      }
    }
    if(sn>0){ cc.lx=sx/sn; cc.ly=sy/sn; }
    else {
      // 兜底：全是小省份就用所有省份质心
      let fx=0,fy=0,fn=0;
      for(const pid of cc.provList){ const p=provinces[pid]; if(!p) continue; fx+=p.cx; fy+=p.cy; fn++; }
      if(fn>0){cc.lx=fx/fn; cc.ly=fy/fn;}
    }
  }
  labelsDirty=false;
}

/* =====================================================================
   三、游戏逻辑
   ===================================================================== */
function overlordOf(cid){ const c=countries[cid]; return c&&c.overlord&&countries[c.overlord]&&countries[c.overlord].alive?c.overlord:0; }
/* ---------- 属国类型（国体） ----------
   SUBJ_VASSAL 附庸国：战争附庸化 / 花钱册封 / 于故土复国 —— 常规藩属
   SUBJ_PUPPET 傀儡国：玩家亲自分封建立的新国家 —— 政权完全由宗主搭建，
                        叛乱倾向只有附庸国的 5%                                */
const SUBJ_VASSAL=1, SUBJ_PUPPET=2;
const PUPPET_REBEL_MUL=0.05;   // 傀儡国叛乱倾向倍率
/* 属国类型（国体）：无宗主一律算独立，老存档没这个字段时按附庸国处理 */
function subjectOf(cid){
  const c=countries[cid];
  if(!c||!overlordOf(cid)) return 0;
  return c.subject||SUBJ_VASSAL;
}
function isPuppet(cid){ return subjectOf(cid)===SUBJ_PUPPET; }
/* 每月举兵造反的概率：附庸国 4%，傀儡国只有它的 5%（0.2%） */
const REBEL_BASE=0.04;
function rebelChanceOf(cid){ return REBEL_BASE*(isPuppet(cid)?PUPPET_REBEL_MUL:1); }
/* 变更宗主关系时统一走这里，保证 overlord 与 subject 永远同步 */
function setOverlord(cid, ovId, subj){
  const c=countries[cid]; if(!c) return;
  c.overlord=ovId||0;
  c.subject=c.overlord?(subj||SUBJ_VASSAL):0;
  invalidateCamps();
}
/* ---------- 盟友体系 ---------- */
function isAllied(a,b){
  if(a===b) return false;
  const ca=countries[a], cb=countries[b];
  return !!(ca&&cb&&ca.allies&&ca.allies.includes(b)&&cb.allies&&cb.allies.includes(a));
}
function formAlliance(a,b){
  const ca=countries[a], cb=countries[b];
  if(!ca||!cb) return;
  if(!ca.allies) ca.allies=[];
  if(!cb.allies) cb.allies=[];
  if(!ca.allies.includes(b)) ca.allies.push(b);
  if(!cb.allies.includes(a)) cb.allies.push(a);
  pushLogWorld(`🤝 ${ca.name} 与 ${cb.name} 缔结盟约，守望相助`,'gold',[a,b],
               ca.provList.length>4||cb.provList.length>4);
  UI.panel();
}
function breakAlliance(a,b,reason){
  const ca=countries[a], cb=countries[b];
  if(!ca||!cb) return;
  if(ca.allies) ca.allies=ca.allies.filter(x=>x!==b);
  if(cb.allies) cb.allies=cb.allies.filter(x=>x!==a);
  pushLogWorld(`💔 ${ca.name} 与 ${cb.name} 的盟约解除${reason?'（'+reason+'）':''}`,'war',[a,b],true);
  UI.panel();
}
// 清理某国的全部盟约（亡国/附庸化时）
function clearAllAlliances(cid){
  const c=countries[cid];
  if(!c||!c.allies) return;
  for(const al of [...c.allies]) if(countries[al]&&countries[al].allies) countries[al].allies=countries[al].allies.filter(x=>x!==cid);
  c.allies=[];
}
// 两国是否陆地接壤（含各自整个宗藩阵营的省份，附庸的附庸亦算）
function countriesAdjacent(a,b){
  if(a===b) return false;
  const aR=campOf(a), bR=campOf(b);
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p.pix.length) continue;
    if(aR.has(p.owner)) for(const q of p.nbrs) if(bR.has(provinces[q].owner)) return true;
  }
  return false;
}
// 占领比例：taker 阵营占领了 enemy 阵营多少比例的省份（含全部层级附庸）
function occRatio(taker,enemy){
  const eCamp=campOf(enemy), tCamp=campOf(taker);
  let total=0, occ=0;
  for(const c of countries){
    if(!c||!c.alive||!eCamp.has(c.id)) continue;
    total+=c.provList.length;
    for(const pid of c.provList){ if(tCamp.has(provinces[pid].controller)) occ++; }
  }
  if(total===0) return 0;
  return occ/total;
}
// 和约割地检查：省份是否可被 taker 割走（海岸线/与taker阵营接壤/与已割省份接壤）
function canDemandProvince(pid,taker,enemy,takenSet){
  const p=provinces[pid]; if(!p||!p.pix.length) return false;
  if(p.owner!==enemy&&!campOf(p.owner).has(enemy)) return false;
  // 海岸线省份可直接割
  if(p.coastPix&&p.coastPix.length) return true;
  // 与 taker 阵营（含全部附庸）的省份接壤
  const takerR=campOf(taker);
  for(const q of p.nbrs){
    if(takerR.has(provinces[q].owner)) return true;
    if(takenSet.has(q)) return true;
  }
  return false;
}
function directWar(a,b){ return wars.some(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&((w.a===a&&w.d===b)||(w.a===b&&w.d===a))); }
// 省份是否位于"前线"：与某国（或其附庸）已控制的省份相邻（用于蚕食推进排序）
function isFrontProv(pid,me){
  for(const q of provinces[pid].nbrs){
    const qc=provinces[q].controller;
    if(qc===me||overlordOf(qc)===me) return true;
  }
  return false;
}
function atWar(a,b){
  if(a===b) return false;
  /* 附庸举兵造反：双方同属一个宗藩阵营，但彼此已经直接开战。
     这种情况必须判为交战，否则平叛时既不会发生会战、也围不了城 ——
     等于根本打不了自己的附庸。 */
  for(let i=0;i<wars.length;i++){
    const w=wars[i];
    if(!w||typeof w.a!=='number'||typeof w.d!=='number') continue;
    if((w.a===a&&w.d===b)||(w.a===b&&w.d===a)) return true;
  }
  // 阵营连带（递归）：与一国交战即与其整个宗藩阵营交战——
  // 宗主的战争所有附庸（含附庸的附庸）一律参战，反之亦然
  const ca=campOf(a);
  if(ca.has(b)) return false;
  const cb=campOf(b);
  for(const w of wars){
    if(!w||typeof w.a!=='number'||typeof w.d!=='number') continue;
    if((ca.has(w.a)&&cb.has(w.d))||(ca.has(w.d)&&cb.has(w.a))) return true;
  }
  return false;
}
/* 国家阵营：自身 + 全部祖先宗主 + 全部后代附庸（附庸的附庸……递归）
   这个函数在内层循环里被调用得非常频繁（国家×军队×战争量级），
   但结果只依赖"宗主关系 + 存活状态"，所以记忆化；这两者变化时调用 invalidateCamps()。 */
let _campCache=new Map();
function invalidateCamps(){ _campCache.clear(); }
function campOf(cid){
  const hit=_campCache.get(cid);
  if(hit) return hit;
  const s=new Set([cid]);
  for(let x=overlordOf(cid); x; x=overlordOf(x)) s.add(x);
  let more=true;
  while(more){
    more=false;
    for(let i=1;i<countries.length;i++){
      const c=countries[i];
      if(c&&c.alive&&c.overlord&&s.has(c.overlord)&&!s.has(c.id)){ s.add(c.id); more=true; }
    }
  }
  _campCache.set(cid,s);
  return s;
}
// 某国的全部附庸（含附庸的附庸，递归展开）
function vassalsAllOf(cid){
  const res=[];
  const s=new Set([cid]);
  let more=true;
  while(more){
    more=false;
    for(const c of countries){
      if(c&&c.alive&&c.overlord&&s.has(c.overlord)&&!s.has(c.id)){ s.add(c.id); res.push(c); more=true; }
    }
  }
  return res;
}
// 战争伤亡归账：把 owner 阵营的 loss 计入其参与的所有战争（会战/围城/远征损耗均走此入口）
function addCasualties(owner,loss){
  if(!owner||!loss||loss<=0.5) return;
  const camp=campOf(owner);
  for(const w of wars){
    if(!w||typeof w.a!=='number'||typeof w.d!=='number') continue;
    const inA=camp.has(w.a), inD=camp.has(w.d);
    if(inA&&!inD) w.casA=(w.casA||0)+loss;
    else if(inD&&!inA) w.casD=(w.casD||0)+loss;
  }
}
function inWar(c){
  // 递归阵营：宗主（含隔代宗主）开战则全阵营均在战中
  const camp=campOf(c);
  return wars.some(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&(camp.has(w.a)||camp.has(w.d)));
}
function truceKey(a,b){ return a<b? a+'|'+b : b+'|'+a; }
function truceBetween(a,b){ const t=truces[truceKey(a,b)]; return t&&t>dayCount; }
function findPath(from,to){
  if(from===to) return [];
  const prev=new Int32Array(provinces.length).fill(-1); prev[from]=from;
  const q=[from]; let h=0;
  while(h<q.length){
    const u=q[h++];
    for(const v of provinces[u].nbrs){
      if(prev[v]===-1){
        prev[v]=u;
        if(v===to){ const path=[]; let x=to; while(x!==from){path.push(x);x=prev[x];} return path.reverse(); }
        q.push(v);
      }
    }
  }
  return null;
}
/* 海路 BFS 的复用工作数组：不再每次调用都分配 4MB 并填充，
   闭包也提到循环外（原来每轮 BFS 都新建一个 tryPush）。 */
let _navPrev=null, _navMark=null, _navGen=0;
let _navCacheMonth=-1; const _navCache=new Map();
function _navArrays(){
  if(!_navPrev || _navPrev.length!==NPIX){
    _navPrev=new Int32Array(NPIX);
    _navMark=new Int32Array(NPIX);
    _navGen=0;
  }
}
// 海路 BFS：从 fromPid 海岸像素到 toPid 海岸像素，仅走海洋像素
function findNavalPath(fromPid,toPid){
  if(fromPid===toPid) return [];
  const from=provinces[fromPid], to=provinces[toPid];
  if(!from||!to||!from.coastPix.length||!to.coastPix.length) return null;
  const startPx=from.coastPix[0], endPx=to.coastPix[0];
  if(startPx===endPx) return [];

  // 同一游戏月内相同起讫直接复用（闲置舰队每月都在重试同样的目标）
  const mk=Math.floor(dayCount/30);
  if(mk!==_navCacheMonth){ _navCacheMonth=mk; _navCache.clear(); }
  const ck=fromPid+'|'+toPid;
  if(_navCache.has(ck)){ const v=_navCache.get(ck); return v? v.slice() : null; }

  _navArrays();
  /* 双向 BFS：从起点和终点同时向外扩，哪边队列短扩哪边。
     单向后 BFS 要探索"以起点为圆心、半径等于路径长度"的整片海域，
     双向只需探索两个半径一半的圆，像素数常常差一两个数量级。 */
  const prev=_navPrev, tag=_navMark, gen=++_navGen;
  // tag: gen+0 未访问 / gen+1 起点侧 / gen+2 终点侧（用 gen 做代际隔离，免清零）
  const tF=gen+1, tB=gen+2; _navGen+=2;
  tag[startPx]=tF; prev[startPx]=startPx;
  tag[endPx]=tB;   prev[endPx]=endPx;
  let qF=[startPx], qB=[endPx];
  let meetU=-1, meetV=-1;
  const expand=(q,s,o)=>{
    const next=[];
    for(let i=0;i<q.length;i++){
      const u=q[i], r=(u/COLS)|0, c=u%COLS;
      for(let k=0;k<4;k++){
        let v;
        if(k===0){ if(c===0) continue; v=u-1; }
        else if(k===1){ if(c+1>=COLS) continue; v=u+1; }
        else if(k===2){ if(r===0) continue; v=u-COLS; }
        else { if(r+1>=ROWS) continue; v=u+COLS; }
        const t=tag[v];
        if(t===s) continue;
        if(t===o){ // 两侧相遇：统一记成 meetU=起点侧、meetV=终点侧
          if(s===tF){ meetU=u; meetV=v; } else { meetU=v; meetV=u; }
          return true;
        }
        if(land[v]!==0) continue;
        tag[v]=s; prev[v]=u; next.push(v);
      }
    }
    q.length=0;
    for(let i=0;i<next.length;i++) q.push(next[i]);
    return false;
  };
  let found=false;
  /* 搜索上限：目标不可达时（例如目标海岸只连着内陆湖）双向 BFS 会把两边的
     连通海域都搜完，单次能卡住上百毫秒。地图总共 1440×720，
     现实航路最多几百像素，15 万次访问远远够用；超了就当作不可达。 */
  let visited=0;
  const VISIT_CAP=150000;
  while(qF.length&&qB.length){
    if(visited>VISIT_CAP) break;
    if(qF.length<=qB.length){ visited+=qF.length; if(expand(qF,tF,tB)){ found=true; break; } }
    else { visited+=qB.length; if(expand(qB,tB,tF)){ found=true; break; } }
  }
  if(!found){ if(_navCache.size<600) _navCache.set(ck,null); return null; }
  // 起点侧：从 meetU 回溯到 startPx（不含 startPx）
  const head=[]; let x=meetU;
  while(x!==startPx){ head.push(x); x=prev[x]; }
  head.reverse();
  // 终点侧：从 meetV 沿父指针走到 endPx（含 endPx）
  const tail=[]; x=meetV;
  while(x!==endPx){ tail.push(x); x=prev[x]; }
  tail.push(endPx);
  const path=head.concat(tail);
  if(_navCache.size<600) _navCache.set(ck,path);
  return path.slice(); // 像素索引序列（含 endPx，不含 startPx）
}
function bfsTo(start,pred){
  const prev=new Int32Array(provinces.length).fill(-1); prev[start]=start;
  const q=[start]; let h=0;
  while(h<q.length){
    const u=q[h++];
    for(const v of provinces[u].nbrs){
      if(prev[v]===-1){
        prev[v]=u;
        if(pred(provinces[v])){ const path=[]; let x=v; while(x!==start){path.push(x);x=prev[x];} return path.reverse(); }
        q.push(v);
      }
    }
  }
  return null;
}
// 阵营本土距离（多源BFS：本国+附庸+宗主的全部省份为源，深度上限12跳）：
// 用于远征后勤损耗与孤岛困军检测；不可达（孤岛/海外）返回 Map 中无该省
function homeDistMap(cid){
  const dist=new Map();
  const c=countries[cid];
  if(!c||!c.alive) return dist;
  let q=[];
  const add=pid=>{ if(pid>0&&provinces[pid]&&provinces[pid].pix.length&&!dist.has(pid)){dist.set(pid,0);q.push(pid);} };
  for(const pid of c.provList) add(pid);
  for(const cc2 of countries) if(cc2&&cc2.alive&&cc2.overlord===cid) for(const pid of cc2.provList) add(pid);
  const ovl=overlordOf(cid);
  if(ovl&&countries[ovl]) for(const pid of countries[ovl].provList) add(pid);
  let d=0;
  while(q.length&&d<12){
    const nq=[];
    for(const pid of q){
      const p=provinces[pid]; if(!p) continue;
      for(const np of p.nbrs){
        if(!dist.has(np)){ dist.set(np,d+1); nq.push(np); }
      }
    }
    q=nq; d++;
  }
  return dist;
}
// 从某省出发陆路可达的全部省份集合（无深度上限）
function bfsSetFrom(start){
  const seen=new Set([start]);
  const q=[start]; let h=0;
  while(h<q.length){
    const u=q[h++];
    const p=provinces[u]; if(!p) continue;
    for(const v of p.nbrs) if(!seen.has(v)){ seen.add(v); q.push(v); }
  }
  return seen;
}
// 远征后勤损耗（每月，全体国家含玩家）：军队距本土阵营（本国+附庸+宗主）越远，
// 减员越快，模拟补给线拉长后的损耗；海军依赖海运补给，损耗明显低于陆军。
function attritionMonthly(){
  for(let c=1;c<countries.length;c++){
    const cc=countries[c];
    if(!cc||!cc.alive) continue;
    // 快速预检：有军队位于本土阵营之外才计算距离（同时清掉旧的损耗标记，避免残留显示）
    const homePids=new Set(cc.provList);
    for(const vc of countries) if(vc&&vc.alive&&vc.overlord===c) for(const pid of vc.provList) homePids.add(pid);
    const ovl0=overlordOf(c);
    if(ovl0&&countries[ovl0]) for(const pid of countries[ovl0].provList) homePids.add(pid);
    let abroad=false;
    for(const a of armies) if(a.owner===c&&!homePids.has(a.prov)){ abroad=true; break; }
    if(!abroad){ for(const a of armies) if(a.owner===c) a.attrit=0; continue; }
    const dm=homeDistMap(c);
    let pCnt=0, pLoss=0, dead=null;
    for(const a of armies){
      if(a.owner!==c) continue;
      const d=dm.get(a.prov);
      const dd=d===undefined?13:d; // 陆路不可达（孤岛/隔海）按最远计
      a.attrit=dd;                 // 供信息面板显示（本土阵营=0）
      if(dd<1) continue;           // 本土/附庸/宗主境内补给充足，不损耗
      // 远征损耗：离开本土即开始（基础1.5%/月），每远离一跳递增1.2%，封顶20%；
      // 海军依托海运补给，损耗明显低于陆军（基础0.8%/月，封顶8%）
      const base=a.isNavy?0.008:0.015, step=a.isNavy?0.005:0.012, cap=a.isNavy?0.08:0.20;
      const loss=a.str*Math.min(cap,base+(dd-1)*step);
      if(loss>0.5){
        a.str-=loss;
        addCasualties(c,loss); // 远征损耗（含敌境消耗）计入战争伤亡
        if(isHuman(c)){ pCnt++; pLoss+=loss; }
      }
      if(a.str<400){ if(!dead) dead=[]; dead.push(a); }
    }
    if(dead&&dead.length){
      for(const a of dead){
        a.dead=true;
        addCasualties(c,Math.max(0,a.str)); // 补给断绝溃散：残部计入伤亡
        if(isHuman(c)) pushLog(`⚓ 远征军 ${a.isNavy?'舰队':''}#${a.id} 补给断绝，于 ${provinces[a.prov].name} 溃散`,'war',c);
      }
      armies=armies.filter(a=>!a.dead);
    }
    if(isHuman(c)&&pCnt>0)
      pushLog(`粮道漫长：${pCnt} 支远征军队本月共减员 ${Math.round(pLoss).toLocaleString()} 人`,'',c);
  }
}
function devOf(p){ return p.tax+p.prod+p.man; }
function peaceCost(p){ return Math.min(85,5+devOf(p)*0.8); } // 封顶85：保证战争分数打满时可割任意地块
function releaseCost(vc){ return Math.min(40,8+totalDev(vc)*0.5); } // 战争条款：要求战败方释放一名附庸的分数消耗
function warScore(w){
  let sA=0,sB=0;
  // 阵营：对独立战争（w.a 造反宗主 w.d），双方阵营不再递归到对方；
  // 普通战争则阵营递归包含上下级
  let aSet,dSet;
  if(overlordOf(w.a)===w.d){
    aSet=new Set([w.a]); dSet=new Set([w.d]);
    for(const c of countries) if(c&&c.alive&&c.overlord){
      if(aSet.has(c.overlord)) aSet.add(c.id);
      else if(dSet.has(c.overlord)) dSet.add(c.id);
    }
  } else {
    aSet=campOf(w.a); dSet=campOf(w.d);
  }
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p.pix.length) continue;
    // 阵营的省份与占领均计入阵营主一侧（附庸的附庸同理）
    const ownA=aSet.has(p.owner), ownD=dSet.has(p.owner);
    const ctlA=aSet.has(p.controller), ctlD=dSet.has(p.controller);
    if(ownA&&ctlD) sB+=6+devOf(p)*0.6;
    if(ownD&&ctlA) sA+=6+devOf(p)*0.6;
  }
  sA+=w.aB*10; sB+=w.dB*10;
  // 时间战争分数：战争拖得越久，优势方分数越高（每2个月+1分，上限+50）
  // 防止"完全占领敌人唯一地块后，分数仍不够割地"的死锁
  if(sA>0||sB>0){
    const months=(dayCount-w.startDay)/30;
    const tBonus=Math.min(50,months*0.5);
    if(sA>=sB) sA+=tBonus; else sB+=tBonus;
  }
  return {a:clamp(sA,0,100),d:clamp(sB,0,100)};
}

function advanceDay(){
  dayCount++; cal.d++;
  const L=cal.m===1?((cal.y%4===0&&cal.y%100!==0)||cal.y%400===0?29:28):CAL_M[cal.m];
  if(cal.d>L){ cal.d=1; cal.m++; if(cal.m>11){cal.m=0;cal.y++;} monthlyTick(); }
}

/* ---------- 征兵队列 ----------
   招募不再"点一下立刻成军"：先扣钱扣人力，进入集结期，到期才生成军队。
   集结期间该省若易主则中止并退还资源。 */
function addRecruit(owner,prov,str,isNavy){
  const days=isNavy?NAVY_DAYS:RECRUIT_DAYS;
  const r={id:nextRecruit++,owner,prov,str,isNavy:isNavy?1:0,days,total:days,start:dayCount};
  recruits.push(r);
  return r;
}
// 某国正在征集的兵力总和（AI 据此避免重复下单）
function pendingStrength(cid){
  let s=0;
  for(let i=0;i<recruits.length;i++) if(recruits[i].owner===cid) s+=recruits[i].str;
  return s;
}
function tickRecruits(){
  if(!recruits.length) return;
  const done=[], cancelled=[];
  for(let i=0;i<recruits.length;i++){
    const r=recruits[i];
    const c=countries[r.owner], p=provinces[r.prov];
    // 每天都查：征兵地一旦易主（或国家灭亡）立即中止并退款，不必等集结期满
    if(!c||!c.alive||!p||p.controller!==r.owner){ cancelled.push(r); continue; }
    r.days--;
    if(r.days>0) continue;
    done.push(r);
  }
  for(let i=0;i<done.length;i++){
    const r=done[i];
    armies.push({id:nextArmy++,owner:r.owner,prov:r.prov,str:r.str,path:[],prog:0,isNavy:r.isNavy||0});
    pushLog(`新${r.isNavy?'舰队':'军团'}在 ${provinces[r.prov].name} 完成集结（${r.str}人）`,'good',r.owner);
  }
  for(let i=0;i<cancelled.length;i++){
    const r=cancelled[i];
    const c=countries[r.owner];
    if(c&&c.alive){
      c.gold += r.isNavy?35:25;
      c.mp = Math.min(c.mpCap, c.mp + (r.isNavy?4000:5000));
      const nm=provinces[r.prov]?provinces[r.prov].name:'征兵地';
      pushLog(`${nm} 征兵中断，资源已退回`,'war',r.owner);
    }
  }
  if(done.length||cancelled.length){
    recruits=recruits.filter(r=>done.indexOf(r)<0&&cancelled.indexOf(r)<0);
  }
}

function tickDay(){
  if(_aiPending){ _aiPending=false; aiMonthly(); }
  tickRecruits();
  // 1) 行军（战斗中的军队锁定）
  for(const a of armies){
    if(a.isNavy){
      // 海军沿 navPath 像素移动
      if(a.navPath&&a.navPath.length){
        a.navIdx++;
        if(a.navIdx>=a.navPath.length){
          // 抵达目标省：在 dstProv 海岸像素就位，回到省份层面
          a.prov=a.dstProv||a.prov;
          a.navPath=null; a.navIdx=0; a.dstProv=0;
        }
      }
      continue;
    }
    if(a.path.length&&!battleProvs.has(a.prov)){
      a.prog++;
      if(a.prog>=HOP){ a.prog=0; a.prov=a.path.shift(); }
    }
  }
  mergeArmies();
  // 2) 会战
  resolveBattles();
  // 3) 围城
  resolveSieges();
  // 4) 滞留检测：陆军没有路径、且当前省份不可控 → 回家；海军不在大陆，不需要 home
  for(const a of armies){
    if(a.isNavy) continue;
    if(a.path.length) continue;
    const p=provinces[a.prov]; if(!p) continue;
    const occ=countries[a.owner];
    if(p.owner===a.owner) continue;
    if(p.controller===a.owner) continue;
    if(atWar(a.owner,p.owner)||atWar(a.owner,p.controller)) continue;
    const homePath=bfsHome(a.prov,a.owner);
    if(homePath){ a.path=homePath; a.prog=0; }
  }
  // 5) 日期
  advanceDay();
}

// 寻找从 start 出发、回到 owner 领土的最短路径（owner 或 controller 匹配）
function bfsHome(start,owner){
  const prev=new Int32Array(provinces.length).fill(-1); prev[start]=start;
  const q=[start]; let h=0;
  while(h<q.length){
    const u=q[h++];
    for(const v of provinces[u].nbrs){
      if(prev[v]!==-1) continue;
      const qp=provinces[v];
      if(qp.owner===owner||qp.controller===owner){
        // 找到一块本方领土，路径回到这一块
        prev[v]=u;
        const path=[]; let x=v; while(x!==start){path.push(x);x=prev[x];}
        return path.reverse();
      }
      prev[v]=u;
      q.push(v);
    }
  }
  return null;
}

function mergeArmies(){
  const m=new Map();
  for(const a of armies){
    const k=a.prov+'_'+a.owner;
    const b=m.get(k);
    if(b){ b.str+=a.str; a.dead=true; if(selectedArmy===a.id) selectedArmy=b.id; }
    else m.set(k,a);
  }
  if(armies.some(a=>a.dead)) armies=armies.filter(a=>!a.dead);
}

function resolveBattles(){
  battleProvs=new Set();
  const byProv=new Map();
  for(const a of armies){ let l=byProv.get(a.prov); if(!l){l=[];byProv.set(a.prov,l);} l.push(a); }
  for(const [pid,list] of byProv){
    let hostile=false;
    outer: for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++)
      if(atWar(list[i].owner,list[j].owner)){ hostile=true; break outer; }
    if(!hostile) continue;
    battleProvs.add(pid);
    const sides=new Map();
    for(const a of list) sides.set(a.owner,(sides.get(a.owner)||0)+a.str);
    for(const a of list){
      let enemy=0;
      for(const [c,s] of sides) if(c!==a.owner&&atWar(a.owner,c)) enemy+=s;
      if(enemy>0){
        const loss=enemy*0.025*(a.str/(sides.get(a.owner)||1));
        a.str-=loss;
        addCasualties(a.owner,loss); // 会战伤亡记账
      }
    }
    for(const a of list){
      if(a.str<400){
        a.dead=true;
        addCasualties(a.owner,Math.max(0,a.str)); // 全军覆没：残部一并计入
        for(const ow of new Set([a.owner,...list.map(b=>b.owner)]))
          if(isHuman(ow)) pushLog(`${provinces[pid].name} 会战：${countries[a.owner].name} 一部被歼灭`,'war',ow);
        const w=wars.find(w=>w.a===a.owner||w.d===a.owner);
        if(w){ if(a.owner===w.a) w.dB++; else w.aB++; }
      }
    }
    if(list.some(a=>a.dead)) armies=armies.filter(a=>!a.dead);
  }
}

function resolveSieges(){
  const byProv=new Map();
  for(const a of armies){ let l=byProv.get(a.prov); if(!l){l=[];byProv.set(a.prov,l);} l.push(a); }
  for(const [pid,list] of byProv){
    if(battleProvs.has(pid)) continue;
    const p=provinces[pid];
    let bstr=0,bowner=0;
    for(const a of list) if(atWar(a.owner,p.controller)){ bstr+=a.str; if(!bowner)bowner=a.owner; }
    if(bstr>0){
      p.siege+=bstr/SIEGE_DIV;
      if(p.siege>=100){
        p.siege=0;
        const old=p.controller;
        p.controller=bowner;
        UI.recolorNbrs(pid);
        pushLogWorld(`${countries[bowner].name} 攻占了 ${p.name}（原属 ${countries[old].name}）`,'war',[old,bowner],
                     countries[bowner].provList.length>4||countries[old].provList.length>4);
      }
    } else if(p.siege>0){
      p.siege=Math.max(0,p.siege-2);
    }
  }
}

/* ---------- 月度结算 ---------- */
let _aiPending=false;    // 本月的 AI 决策推迟到下一帧执行，避免月度结算在一帧里堵住
function monthlyTick(){
  for(let c=1;c<countries.length;c++) if(countries[c].alive) economy(countries[c]);
  /* aiMonthly 是月度结算里最重的一块（约占 3/4）。
     它只是"每月做一次决策"，早一天晚一天没有区别，
     推到一个 tick 之后能把这根尖峰摊成两半，服务端就不容易掉帧。 */
  _aiPending=true;
  attritionMonthly();
  // 兜底：任何绕开 makePeace 的宗主/盟约变动（放附庸独立、吞并、复国……）
  // 都可能留下"控制者与所有者已不交战"的幽灵占领，每月清一次
  releaseStaleOccupations();
  for(const k in pendingOffers){
    if(pendingOffers[k].expire<dayCount){ delete pendingOffers[k]; UI.panel(); }
  }
  // 停战记录只增不减，长局会无限膨胀（还会拖慢每帧的签名计算）；过期的直接清掉
  for(const k in truces) if(truces[k]<=dayCount) delete truces[k];
  if(cal.m===0){ // 每年
    for(let c=1;c<countries.length;c++){
      const cc=countries[c]; if(!cc.alive) continue;
      if(rnd()<0.03){ cc.ruler=RULERS[ri(RULERS.length)]+ROMAN[ri(10)]; if(isHuman(c)) pushLog('老王驾崩，'+cc.ruler+' 继承大统','gold',c); }
    }
  }
  UI.topbar();
  if(started) UI.panel();
}

function economy(c){
  let inc=0;
  for(const pid of c.provList){ const p=provinces[pid]; if(p.controller===p.owner) inc+=(p.tax+p.prod)*0.05; }
  let up=0;
  for(const a of armies) if(a.owner===c.id) up+=a.str/1000*0.15;
  c.income=inc-up;
  c.gold+=inc-up;
  // 附庸朝贡：省份毛收入的30%上缴宗主（不受军队维护费影响）
  const ov=overlordOf(c.id);
  if(ov&&inc>0){
    const tr=inc*0.3;
    c.gold-=tr; c.income-=tr;
    const oc=countries[ov]; if(oc&&oc.alive) oc.gold+=tr;
  }
  if(c.gold<0){
    c.gold=0;
    const mine=armies.filter(a=>a.owner===c.id).sort((x,y)=>x.str-y.str);
    if(mine.length){ addCasualties(c.id,Math.max(0,mine[0].str)); armies=armies.filter(a=>a!==mine[0]); if(selectedArmy===mine[0].id)selectedArmy=0;
      if(isHuman(c.id)) pushLog('国库枯竭，一支军队因欠饷溃散','war',c.id); }
  }
  c.mp=Math.min(c.mpCap,c.mp+c.mpCap/120);
}

function countryStrength(cid){ let s=0; for(const a of armies) if(a.owner===cid) s+=a.str; return s; }

function aiMonthly(){
  // 邻接表
  const adj=new Map();
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i]; if(!p.pix.length) continue;
    for(const q of p.nbrs){
      const o=provinces[q].owner;
      if(o!==p.owner){
        let s=adj.get(p.owner); if(!s){s=new Set();adj.set(p.owner,s);}
        s.add(o);
      }
    }
  }
  // 故土主张表：Map<原主, Map<现占者, Set<pid>>>
  // （省份 former 字段由 transferProvince 维护，用于收复失地决策与蚕食优先）
  const claims=new Map();
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(!p.pix.length||!p.former) continue;
    for(const fo of p.former){
      if(fo===p.owner) continue;
      if(!countries[fo]||!countries[fo].alive) continue;
      let m=claims.get(fo); if(!m){m=new Map();claims.set(fo,m);}
      let s=m.get(p.owner); if(!s){s=new Set();m.set(p.owner,s);}
      s.add(i);
    }
  }
  // 附庸独立战争：附庸国力（发展度）总和 ≥ 宗主国力 且 停战已过 → 举兵造反
  // （玩家作为附庸时自行宣战，不自动触发）
  for(const vc of countries){
    if(!vc||!vc.alive||!vc.overlord||isHuman(vc.id)) continue;
    if(truceBetween(vc.id,vc.overlord)) continue;
    const inDirect=wars.some(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&(w.a===vc.id||w.d===vc.id));
    if(inDirect) continue;
    if(wars.length>=12) break; // 独立战争上限放宽到12，避免被常规宣战(8)挤掉
    const ov=countries[vc.overlord];
    if(!ov||!ov.alive) continue;
    let vassalDev=0;
    for(const v2 of countries) if(v2&&v2.alive&&v2.overlord===vc.overlord) vassalDev+=totalDev(v2);
    if(vassalDev<totalDev(ov)) continue;
    // 傀儡国政权由宗主一手搭建（军队、官僚皆出自我朝），叛乱倾向只有附庸国的 5%
    const rebelChance=rebelChanceOf(vc.id);
    if(rnd()<rebelChance){
      declareWar(vc.id,vc.overlord);
      if(!pushLogTo([vc.overlord],`⚔ ${vc.name} 举兵造反，要求脱离我国独立！`,'war'))
        pushLogWorld(`边关急报：${vc.name} 起兵反抗宗主 ${ov.name}`,'war',[vc.id,vc.overlord],true);
    }
  }
  // AI-AI 和谈
  for(const w of [...wars]){
    if(isHuman(w.a)||isHuman(w.d)) continue;
    const months=(dayCount-w.startDay)/30;
    const s=warScore(w);
    const winA=s.a>s.d;
    const winner=winA?w.a:w.d, loser=winA?w.d:w.a, score=winA?s.a:s.d;
    const ratio=occRatio(winner,loser);
    // 独立战争：w.a 是 w.d 的附庸（附庸造反）
    const indepWar=overlordOf(w.a)===w.d;
    if(indepWar){
      if(months>6&&(Math.abs(s.a-s.d)>15||months>36)){
        if(winA){
          // 附庸赢：解除臣属 + 剩余分数按普通割地模式割宗主的地
          countries[w.a].overlord=0; countries[w.a].subject=0; invalidateCamps();
          const transfers=[]; const taken=new Set(); let cost=30;
          const candidates=[];
          for(let i=1;i<provinces.length;i++){
            const p=provinces[i];
            if(p.pix.length&&p.owner===w.d&&(p.controller===w.a||overlordOf(p.controller)===w.a)&&cost+peaceCost(p)<=s.a) candidates.push(i);
          }
          let added=true;
          while(added){
            added=false;
            for(const pid of candidates){
              if(taken.has(pid)) continue;
              if(cost+peaceCost(provinces[pid])>s.a) continue;
              if(canDemandProvince(pid,w.a,w.d,taken)){
                transfers.push({pid,to:w.a}); taken.add(pid); cost+=peaceCost(provinces[pid]); added=true;
              }
            }
          }
          makePeace(w,transfers,false);
          pushLog(`🎌 ${countries[w.a].name} 赢得独立战争，脱离 ${countries[w.d].name} 自立`,'gold');
        } else {
          // 宗主赢：叛乱被镇压，附庸继续臣服
          makePeace(w,[],false);
          pushLog(`${countries[w.d].name} 镇压了 ${countries[w.a].name} 的叛乱`,'');
        }
      }
      continue;
    }
    // 早期附庸化：分数≥35 + 占领比例≥40% + 接壤或近海
    if(score>=35&&ratio>=0.4&&!overlordOf(loser)&&vassalReachable(winner,loser)&&rnd()<0.15){
      vassalize(winner,loser);
      continue;
    }
    if((months>36&&Math.abs(s.a-s.d)>25)||months>120){
      // 大胜附庸化：分数≥60 + 占领比例≥50% + 接壤或近海
      if(score>=60&&ratio>=0.5&&!overlordOf(loser)&&vassalReachable(winner,loser)&&rnd()<0.4){
        vassalize(winner,loser);
        continue;
      }
      // 割地：仅割接壤/海岸省份，割下后可连锁割附近地块
      const transfers=[];
      const taken=new Set();
      let cost=0;
      // 先扫可割省份（按 canDemandProvince 过滤）
      const candidates=[];
      for(let i=1;i<provinces.length;i++){
        const p=provinces[i];
        if(p.pix.length&&p.owner===loser&&(p.controller===winner||overlordOf(p.controller)===winner)&&cost+peaceCost(p)<=score*0.85) candidates.push(i);
      }
      // 贪心：每轮找一个 canDemand 的省份加入
      let added=true;
      while(added){
        added=false;
        for(const pid of candidates){
          if(taken.has(pid)) continue;
          if(cost+peaceCost(provinces[pid])>score*0.85) continue;
          if(canDemandProvince(pid,winner,loser,taken)){
            transfers.push({pid,to:winner}); taken.add(pid); cost+=peaceCost(provinces[pid]);
            added=true;
          }
        }
      }
      // 释放附庸条款：胜者用剩余分数削弱败者——要求其放附庸独立
      const releases=[];
      const lVass=countries.filter(x=>x&&x.alive&&x.overlord===loser);
      for(const vc of lVass){
        const rc=releaseCost(vc);
        if(cost+rc<=score*0.85&&rnd()<0.55){ releases.push(vc.id); cost+=rc; }
      }
      makePeace(w,transfers,false,releases);
    }
  }
  // 各国决策
  for(let c=1;c<countries.length;c++){
    const cc=countries[c];
    if(!cc.alive||isHuman(c)) continue;
    // 已集结 + 正在征集的兵力一起算，避免 1 年集结期内反复下单
    const myStr=countryStrength(c)+pendingStrength(c);
    // 征兵（陆军 / 海军）：AI 同样要等集结期结束才成军
    if(cc.gold>120&&myStr<cc.forceLimit*0.9&&cc.mp>=5000){
      const coasts=cc.provList.filter(pid=>provinces[pid].coastPix&&provinces[pid].coastPix.length);
      const hasNavy=armies.some(a=>a.owner===c&&a.isNavy)||recruits.some(r=>r.owner===c&&r.isNavy);
      if(!hasNavy&&coasts.length&&cc.gold>=35&&cc.mp>=4000&&rnd()<0.4){
        const cp=coasts[ri(coasts.length)];
        cc.gold-=35; cc.mp-=4000;
        addRecruit(c,cp,4000,true);
      } else if(cc.gold>=25&&cc.mp>=5000){
        // 陆军只在与首都陆路连通的大陆省份征募（俄罗斯/加拿大不再把军团生成在北极群岛上）
        const mainland=bfsSetFrom(cc.capital);
        const prov=cc.provList.find(pid=>mainland.has(pid)&&provinces[pid].controller===c)
          ?? (provinces[cc.capital].controller===c?cc.capital:cc.provList.find(pid=>provinces[pid].controller===c));
        if(prov!==undefined){
          cc.gold-=25; cc.mp-=5000;
          addRecruit(c,prov,5000,false);
        }
      }
    }
    // 发展
    if(cc.gold>350&&cc.provList.length){
      const pid=cc.provList[ri(cc.provList.length)];
      const p=provinces[pid];
      const cost=40+devOf(p)*8;
      if(cc.gold>=cost){ cc.gold-=cost; const r=ri(3); if(r===0)p.tax++;else if(r===1)p.prod++;else p.man++; recomputeCap(cc); }
    }
    // 宣战（附庸国不自行宣战；目标不含他国附庸——要打就打宗主；交战中亦可被第三方宣战）
    // 占据我故土的国家优先开战（收复失地）：条件放宽至国力略占优即可，宣战意愿也更高
    if(!overlordOf(c)&&wars.length<8){
      const myClaims=claims.get(c);
      const warOdds=myClaims&&myClaims.size?0.035:0.012;
      if(rnd()<warOdds){
        let targets=[];
        const nbrs=adj.get(c);
        if(nbrs) targets=[...nbrs];
        const hasNavy=armies.some(a=>a.owner===c&&a.isNavy);
        if(hasNavy){
          for(let i=1;i<countries.length;i++){
            const oc=countries[i];
            if(!oc||!oc.alive||oc.id===c) continue;
            if(oc.provList.some(pid=>provinces[pid].coastPix&&provinces[pid].coastPix.length)){
              targets.push(oc.id);
            }
          }
        }
        // 故土占领者优先入池（须接壤，或有海军且对方临海——对陆路/海路都
        // 够不着的国家宣战只会在战争槽里空耗，如莫斯科对隔海孤岛上的失地）
        if(myClaims) for(const o of myClaims.keys()){
          const oc2=countries[o];
          if((nbrs&&nbrs.has(o))||(hasNavy&&oc2&&oc2.provList.some(pid=>provinces[pid].coastPix&&provinces[pid].coastPix.length))) targets.push(o);
        }
        const cand=[];
        for(const o of [...new Set(targets)]){
          const oc=countries[o];
          if(!oc||!oc.alive||overlordOf(o)||truceBetween(c,o)) continue;
          const lost=!!(myClaims&&myClaims.has(o));
          const need=isHuman(o)?(lost?1.5:1.9):(lost?1.05:1.4);
          if(myStr>need*countryStrength(o)) cand.push({o,lost});
        }
        if(cand.length){
          cand.sort((a,b)=>(b.lost?1:0)-(a.lost?1:0)); // 故土目标置顶
          const pick=(cand[0].lost&&rnd()<0.7)?cand[0]:cand[ri(cand.length)];
          declareWar(c,pick.o);
        }
      }
    }
    // 军队调度（陆军 + 海军；附庸军随宗主的战争出动）
    // 宗主链（递归到顶）：附庸的附庸同样随整个阵营的战争出动
    const chain=[c];
    for(let x=overlordOf(c); x; x=overlordOf(x)) chain.push(x);
    // 该国全部战争（含宗主链上所有战争）。多线作战时按军队所在省匹配相关战争，
    // 避免军队死盯第一场战争、对不可达的敌国空转待命。
    const sideIn=ww=>chain.find(m=>ww.a===m||ww.d===m);
    const myWars=wars.filter(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&sideIn(w));
    const w=myWars[0]||null;
    let enemy=0;
    if(w){ const me=sideIn(w); enemy=w.a===me?w.d:w.a; }
    // —— 蚕食推进 & 本土防御（每国每月只算一次，所有军队共享） ——
    let warInfo=null, invProv=0, idle=null;
    if(myWars.length){
      // 每个敌国的省份集合 + 可蚕食候选（前线优先、其次高发展 → 逐格蚕食）
      warInfo=new Map();
      for(const ww of myWars){
        const me=sideIn(ww);
        const foe=ww.a===me?ww.d:ww.a;
        if(warInfo.has(foe)) continue;
        const set=new Set();
        for(let i=1;i<provinces.length;i++){
          const p=provinces[i];
          if(!p.pix.length) continue;
          if(p.owner===foe||overlordOf(p.owner)===foe) set.add(i);
        }
        const cands=[];
        for(const pid of set){
          const p=provinces[pid];
          if(p.controller===c||overlordOf(p.controller)===c) continue;
          cands.push(pid);
        }
        if(cands.length){
          cands.sort((x,y)=>{
            const fx=isFrontProv(x,c)?0:1, fy=isFrontProv(y,c)?0:1;
            if(fx!==fy) return fx-fy;
            // 前线省份中故土优先（收复失地）
            const lx=(provinces[x].former&&provinces[x].former.includes(c))?0:1;
            const ly=(provinces[y].former&&provinces[y].former.includes(c))?0:1;
            if(lx!==ly) return lx-ly;
            return devOf(provinces[y])-devOf(provinces[x]);
          });
        }
        warInfo.set(foe,{set,cands});
      }
      // 敌方军队入侵我方/附庸领土的位置（本土优先回防；任一战争中的敌国都算）
      const mySide=campOf(c);
      outer: for(const a2 of armies){
        if(a2.isNavy||a2.owner===c) continue;
        const o2=a2.owner, o2ovl=overlordOf(o2);
        const o2Camp=campOf(o2);   // 提到 some 回调外：原来每个战争都重算一次
        const isFoe=myWars.some(ww=>{
          const me=sideIn(ww);
          const f=ww.a===me?ww.d:ww.a;
          return o2===f||o2ovl===f||o2Camp.has(f);
        });
        if(!isFoe) continue;
        const pp=provinces[a2.prov];
        if(mySide.has(pp.owner)||mySide.has(pp.controller)){ invProv=a2.prov; break outer; }
      }
      // 本国空闲陆军（分散目标，避免多军扎堆一省）
      idle=[];
      for(const a2 of armies) if(a2.owner===c&&!a2.isNavy&&!a2.path.length) idle.push(a2);
    }
    for(const a of armies){
      if(a.owner!==c) continue;
      if(a.isNavy){
        if(a.navPath&&a.navPath.length) continue;
        if(w){
          const p=provinces[a.prov];
          if(!(p.owner===enemy||p.controller===enemy)){
            // 找敌方最近海岸省
            let best=null, bestDist=Infinity;
            for(const pid of countries[enemy].provList){
              const pp=provinces[pid];
              if(!pp.coastPix||!pp.coastPix.length) continue;
              const d=Math.abs(pp.cx-provinces[a.prov].cx)+Math.abs(pp.cy-provinces[a.prov].cy);
              if(d<bestDist){bestDist=d;best=pid;}
            }
            if(best){
              const np=findNavalPath(a.prov,best);
              if(np){a.navPath=np;a.navIdx=0;a.dstProv=best;a.path=[];a.prog=0;}
            }
          }
        }
        continue;
      }
      if(a.path.length){ a.noTgt=0; continue; }
      if(myWars.length){
        const p=provinces[a.prov];
        // 选择与本军所在省相关的战争：省属于哪个敌国（或其附庸）就蚕食谁；
        // 不在任何敌国领土上则退回第一场战争的目标。
        let foe=0, info=null;
        for(const ww of myWars){
          const me=sideIn(ww);
          const f=ww.a===me?ww.d:ww.a;
          const st=warInfo.get(f).set;
          if(st.has(a.prov)){ foe=f; info=warInfo.get(f); break; }
        }
        if(!foe){
          const ww=myWars[0];
          const me=sideIn(ww);
          foe=ww.a===me?ww.d:ww.a;
          info=warInfo.get(foe);
        }
        const enemySet=info.set, cands=info.cands;
        const onEnemy=enemySet.has(a.prov);
        // 已完全占领当前敌省 → 继续蚕食下一块（多军队按序号分散目标）
        if(onEnemy&&(p.controller===c||overlordOf(p.controller)===c)){
          if(cands.length){
            const tgt=cands[idle.indexOf(a)%cands.length];
            const path=findPath(a.prov,tgt);
            if(path&&path.length) a.path=path;
          }
          continue;
        }
        if(!onEnemy){
          // 本土被入侵 → 优先回防迎击
          if(invProv&&(p.owner===c||overlordOf(p.owner)===c)){
            const path=findPath(a.prov,invProv);
            if(path&&path.length){ a.path=path; continue; }
          }
          const path=bfsTo(a.prov,q=>q.owner===foe||q.controller===foe);
          if(path) a.path=path;
        }
      } else if(a.prov!==cc.capital){
        const path=findPath(a.prov,cc.capital);
        if(path) a.path=path;
      }
    }
    // —— 孤岛困军：AI 陆军参战却连续数月够不到任何敌省（困在岛屿上打不到敌人）
    //    → 解散该军并在首都重组（撤回本土重新集结，兵力折损一成半）。
    //    不要求"首都能陆路打到敌人"：岛国（如斐济）对岛作战时，困在外岛的军队
    //    撤回首都集结防守也远胜于困死孤岛白吃损耗。
    if(myWars.length&&cc.capital){
      let foeCands=[];
      for(const info of warInfo.values()) for(const pid of info.cands) foeCands.push(pid);
      if(foeCands.length){
        const disband=[];
        for(const a of armies){
          if(a.owner!==c||a.isNavy||a.path.length) continue;
          const ap=provinces[a.prov]; if(!ap) continue;
          // 站在本土/附庸境内的军队不算困军
          if(ap.owner===c||overlordOf(ap.owner)===c) continue;
          // 正在围攻敌省（与当前控制者交战）的军队有战果在身，不算困军
          if(ap.controller!==c&&atWar(a.owner,ap.controller)) continue;
          a.noTgt=(a.noTgt||0)+1;
          if(a.noTgt<3) continue;
          // 3 个月无进展：确认该军所在位置确实够不到任何敌省
          const armReach=bfsSetFrom(a.prov);
          if(!foeCands.some(pid=>armReach.has(pid))) disband.push(a);
        }
        for(const a of disband){
          armies=armies.filter(x=>x.id!==a.id);
          armies.push({id:nextArmy++,owner:c,prov:cc.capital,str:Math.max(1000,Math.round(a.str*0.85)),path:[],prog:0,noTgt:0});
          pushLogTo([c,a.owner],`${provinces[a.prov].name} 的驻军被困孤岛，撤回 ${provinces[cc.capital].name} 重新集结`,'');
        }
      }
    }
  }
  // 敌方向人类玩家提出条件（每位人类玩家各有一份待决提案）
  for(const hp of [...humans]){
    if(!countries[hp]||!countries[hp].alive) continue;
    if(pendingOffers[hp]) continue;
    const pw=wars.find(w=>w.a===hp||w.d===hp);
    if(!pw) continue;
    const enemy=pw.a===hp?pw.d:pw.a;
    const s=warScore(pw);
    const eScore=pw.a===enemy?s.a:s.d;
    if(!(eScore>55&&rnd()<0.25)) continue;
    // 独立战争：造反附庸向玩家宗主提条件 → 先要求承认独立（30分）
    const indepWar=overlordOf(pw.a)===pw.d&&pw.d===hp;
    if(indepWar&&eScore>=30){
      pendingOffers[hp]={war:pw,enemy,transfers:[],releases:[],expire:dayCount+360,indep:true};
      pushLog(`${countries[enemy].name} 举兵造反，遣使要求我国承认其独立……`,'war',hp);
      UI.panel();
      continue;
    }
    const demands=[];
    const taken=new Set();
    let cost=0;
    // 敌方也只能割接壤/海岸的玩家省份
    const cands=[];
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(p.pix.length&&(p.owner===hp||overlordOf(p.owner)===hp)&&(p.controller===enemy||overlordOf(p.controller)===enemy)) cands.push(i);
    }
    let added=true;
    while(added){
      added=false;
      for(const pid of cands){
        if(taken.has(pid)) continue;
        if(cost+peaceCost(provinces[pid])>eScore) continue;
        if(canDemandProvince(pid,enemy,hp,taken)){
          demands.push(pid); taken.add(pid); cost+=peaceCost(provinces[pid]); added=true;
        }
      }
    }
    // 敌方还可能要求我国释放附庸（强敌削弱我朝藩属体系）
    const releases=[];
    if(rnd()<0.35){
      const pVass=countries.filter(x=>x&&x.alive&&x.overlord===hp);
      for(const vc of pVass){
        if(cost+releaseCost(vc)<=eScore&&releases.length<2){ releases.push(vc.id); cost+=releaseCost(vc); }
      }
    }
    if(demands.length||releases.length){
      pendingOffers[hp]={war:pw,enemy,transfers:demands.map(pid=>({pid,to:enemy})),releases,expire:dayCount+360};
      pushLog(`${countries[enemy].name} 派来使节，提出了${!demands.length?'要求我国释放附庸的':'割地求和的'}条件${demands.length&&releases.length?'（含释放附庸）':''}……`,'war',hp);
      UI.panel();
    }
  }
}

/* ---------- 战争与和平 ---------- */
function declareWar(a,d){
  // 进攻方与防御方互为盟友 → 盟约当即作废
  if(isAllied(a,d)) breakAlliance(a,d,'兵戎相见，盟约作废');
  const main={a,d,startDay:dayCount,aB:0,dB:0,casA:0,casD:0};
  wars.push(main);
  // 盟友参战（共同防御）：防御方的盟友践约加入，与进攻方进入战争状态。
  // 每场战争至多 3 名盟友驰援，且受盟友自身战事/停战限制。
  let joins=0;
  const mainIdx=wars.length-1; // 后续 push 只追加，main 的下标稳定
  for(const al of (countries[d].allies||[])){
    if(joins>=3) break;
    const ac=countries[al];
    if(!ac||!ac.alive||al===a||al===d) continue;
    if(campOf(al).has(a)) continue;            // 已在进攻方阵营（如为其附庸）
    if(atWar(al,a)||truceBetween(al,a)||inWar(al)) continue;
    if(rnd()<0.85){
      wars.push({a, d:al, startDay:dayCount, aB:0,dB:0, casA:0,casD:0, joinOf:mainIdx});
      joins++;
      pushLogWorld(`🛡 ${ac.name} 履行盟约，对 ${countries[a].name} 参战！`,'war',[al,a,d],
                   countries[a].provList.length>4||countries[d].provList.length>4);
    }
  }
  {
    const A=countries[a],D=countries[d];
    pushLogWorld(`⚔ ${A.name} 向 ${D.name} 宣战！`,'war',[a,d],A.provList.length>5||D.provList.length>5);
  }
  UI.panel();
}
/* ---------- 占领合法性 ----------
   一条占领只有"控制者与所有者仍处于战争状态"时才成立。
   任何原因导致两者不再交战（战争结束、附庸关系变化、第三方媾和、
   盟约变更……），占领都必须归还给所有者。

   旧实现只在 makePeace 里判断"owner 与 controller 是否分属本战争两侧"，
   漏掉了同阵营的情况：敌人占了附庸的省、宗主再打回来时，owner 与 controller
   同属一方，于是永远不还 —— 表现为"宗主国一直占着附庸的领土"。
   盟友之间互相收复、附庸替宗主收复也是同一个洞。

   同阵营时 atWar() 返回 false（campOf 相同），所以这条统一规则天然覆盖全部情形：
     · 敌人占领        → 仍在交战   → 保留（战后由 makePeace 之外的逻辑割让才易主）
     · 第三方在别的战争里占领 → 仍在交战 → 保留
     · 宗主/盟友收复自家或藩属的省 → 不交战 → 归还
   返回归还的省份数。 */
function releaseStaleOccupations(){
  let n=0;
  for(let i=1;i<provinces.length;i++){
    const p=provinces[i];
    if(!p.pix.length||p.controller===p.owner) continue;
    if(atWar(p.controller,p.owner)) continue;      // 合法占领，保留
    p.controller=p.owner; p.siege=0;
    UI.recolorNbrs(i);
    n++;
  }
  if(n) labelsDirty=true;
  return n;
}
function makePeace(w,transfers,byPlayer,releases){
  // 先收集盟友参战的连带战争（在主战争被移除前），再一并终结
  const joins=[];
  for(const jw of wars) if(jw&&jw!==w&&typeof jw.joinOf==='number'&&wars[jw.joinOf]===w) joins.push(jw);
  wars=wars.filter(x=>x!==w);
  for(const jw of joins) makePeace(jw,[],false);
  UI.cedeReset(); // 战争结束：退出割地地图模式
  for(const t of transfers) transferProvince(t.pid,t.to);
  /* 复位占领：战争结束、附庸条款生效后，把所有"控制者与所有者已不再交战"的
     占领一律归还。放在这里而不是逐条判断阵营，是为了同时覆盖
     宗主/盟友替自家收复、附庸替宗主收复等全部同阵营情形。 */
  releaseStaleOccupations();
  // 释放附庸条款：战败方放其附庸独立（疆土归附庸自己，与旧宗主及交战双方立十年之好）
  if(releases&&releases.length){
    for(const cid of releases){
      const vc=countries[cid];
      if(!vc||!vc.alive||(vc.overlord!==w.a&&vc.overlord!==w.d)) continue;
      const oldOv=vc.overlord;
      vc.overlord=0; vc.subject=0; invalidateCamps();
      // 终结该附庸直接参与的其他战争（含其对旧宗主的独立战争——目标已达成）
      for(const w2 of [...wars]) if(w2&&typeof w2.a==='number'&&(w2.a===cid||w2.d===cid)) makePeace(w2,[],false);
      truces[truceKey(cid,oldOv)]=dayCount+3650;
      truces[truceKey(cid,w.a)]=dayCount+3650;
      truces[truceKey(cid,w.d)]=dayCount+3650;
      pushLogWorld(`🕊 ${vc.name} 依和约脱离 ${countries[oldOv].name}，重获独立`,'gold',[cid,oldOv,w.a,w.d],
                   countries[w.a].provList.length>4||countries[w.d].provList.length>4);
    }
    labelsDirty=true;
  }
  truces[truceKey(w.a,w.d)]=dayCount+3650;
  for(const k in pendingOffers) if(pendingOffers[k].war===w) delete pendingOffers[k];
  {
    const A=countries[w.a],D=countries[w.d];
    if(byPlayer) pushLog(`${A.name} 与 ${D.name} 缔结和约`,'good',0);
    else pushLogWorld(`${A.name} 与 ${D.name} 议和`,'',[w.a,w.d],
                      transfers.length&&(A.provList.length>4||D.provList.length>4));
  }
  labelsDirty=true;
  // 释放附庸条款改变了宗主关系 → 阵营变了，再扫一次，保证没有幽灵占领残留
  releaseStaleOccupations();
  UI.panel();
}
/* ---------- 建立附庸国 ----------
   在自己实际控制的领土上分封一个由玩家命名的新国家（首都在所选省份）。
   pids 可以一次给多个省 —— 「分封地图」就是用它一次性划出整片封地。 */
function foundVassal(overlord, capitalPid, name, extraPids){
  const ov=countries[overlord];
  const p=provinces[capitalPid];
  if(!ov||!ov.alive||!p||!p.pix.length) return 0;
  if(p.owner!==overlord||p.controller!==overlord) return 0;
  // 分封后宗主至少要留一省
  const give=new Set([capitalPid]);
  if(Array.isArray(extraPids)) for(const q of extraPids){
    const pp=provinces[q];
    if(pp&&pp.pix.length&&pp.owner===overlord&&pp.controller===overlord) give.add(q);
  }
  if(ov.provList.length<=give.size) return 0;   // 不能把全部领土都分出去
  const id=countries.length;
  const hue=(hash32(id*2654435761+dayCount*97)%360)/360;
  const nc={ id, featId:'CUSTOM', name, enName:name,
             color:hsl(hue,0.55,0.55).map(v=>v|0),
             capital:capitalPid, provList:[], alive:true,
             gold:120, mp:6000, mpCap:0, forceLimit:0,
             overlord:0, allies:[], ruler:RULERS[ri(RULERS.length)]+ROMAN[ri(10)], lx:0, ly:0 };
  countries.push(nc);
  // 先划地再建关系：transferProvince 里会调 checkDeath，宗主丢光省份的判定
  // 已经在上面用 give.size 挡住了
  for(const pid of give){
    transferProvince(pid, id);
    // 新分封的疆土不算"故土"，抹掉这条记录，免得日后宗主亡国时误判复国位置
    const pp=provinces[pid];
    if(pp.former) pp.former=pp.former.filter(x=>x!==overlord);
  }
  nc.capital=give.has(capitalPid)?capitalPid:[...give][0];
  nc.overlord=overlord;
  nc.subject=SUBJ_PUPPET;      // 玩家亲手分封 → 傀儡国（叛乱倾向仅 5%）
  recomputeCap(nc);
  invalidateCamps();
  return id;
}
function transferProvince(pid,to){
  const p=provinces[pid]; if(!p.pix.length) return;
  const old=p.owner;
  if(old===to) return;
  // 记录故土：此省曾被 old 拥有（供 AI 收复失地决策与蚕食优先使用）
  if(old>0&&countries[old]){
    if(!p.former) p.former=[];
    if(!p.former.includes(old)) p.former.push(old);
  }
  const oc=countries[old];
  oc.provList=oc.provList.filter(x=>x!==pid);
  countries[to].provList.push(pid);
  p.owner=to; p.controller=to; p.siege=0;
  UI.recolorNbrs(pid);
  recomputeCap(oc); recomputeCap(countries[to]);
  labelsDirty=true;
  checkDeath(old);
}
/* ---------- 附庸机制（AI 与玩家共用） ---------- */
// 隔海相近：两国的海岸像素之间有 ≤12 像素（3°）的纯海路（近海岛屿可册封）
/* seaAdjacent 的复用工作数组（延迟分配）
   原来每次调用都 new Uint8Array(NPIX) + new Int32Array(NPIX).fill(-1)（共 5MB），
   而且 tryPush 闭包写在 BFS 循环体里，同样会疯狂触发 GC。 */
let _seaTset=null, _seaDist=null;
const _seaCache=new Map();
let _seaCacheMonth=-1;
function seaAdjacent(a,b){
  if(a===b) return false;
  const ca=countries[a], cb=countries[b];
  if(!ca||!cb) return false;
  const mk=Math.floor(dayCount/30);
  if(mk!==_seaCacheMonth){ _seaCacheMonth=mk; _seaCache.clear(); }
  const key=a+'|'+b;
  if(_seaCache.has(key)) return _seaCache.get(key);
  const A=[], B=[];
  for(const pid of ca.provList){ const p=provinces[pid]; if(p.coastPix&&p.coastPix.length) A.push(pid); }
  for(const pid of cb.provList){ const p=provinces[pid]; if(p.coastPix&&p.coastPix.length) B.push(pid); }
  let res=false;
  if(A.length&&B.length){
    if(!_seaTset){ _seaTset=new Uint8Array(NPIX); _seaDist=new Int16Array(NPIX); }
    const tset=_seaTset, dist=_seaDist;
    // 目标海岸像素集合：只写 B 的海岸像素，用完再清掉同位置，避免整块清零
    const bpx=[];
    for(const pid of B) for(const px of provinces[pid].coastPix){ if(!tset[px]){ tset[px]=1; bpx.push(px); } }
    dist.fill(-1);
    const q=[];
    for(const pid of A) for(const px of provinces[pid].coastPix){ if(dist[px]===-1){ dist[px]=0; q.push(px); } }
    const LIM=12;
    // 闭包提到循环外：用变量代替每次迭代新建函数
    for(let h=0; h<q.length&&!res; h++){
      const u=q[h];
      const du=dist[u];
      if(du>=LIM) continue;
      const r=(u/COLS)|0, c=u%COLS;
      let v, nd=du+1;
      if(c>0){ v=u-1; if(dist[v]===-1){ if(tset[v]){res=true;} else if(land[v]===0){ dist[v]=nd; if(nd<LIM) q.push(v); } } }
      if(!res&&c+1<COLS){ v=u+1; if(dist[v]===-1){ if(tset[v]){res=true;} else if(land[v]===0){ dist[v]=nd; if(nd<LIM) q.push(v); } } }
      if(!res&&r>0){ v=u-COLS; if(dist[v]===-1){ if(tset[v]){res=true;} else if(land[v]===0){ dist[v]=nd; if(nd<LIM) q.push(v); } } }
      if(!res&&r+1<ROWS){ v=u+COLS; if(dist[v]===-1){ if(tset[v]){res=true;} else if(land[v]===0){ dist[v]=nd; if(nd<LIM) q.push(v); } } }
    }
    for(const px of bpx) tset[px]=0;
  }
  if(_seaCache.size<4000) _seaCache.set(key,res);
  return res;
}
// 册封可达：陆地接壤，或隔海相近（近海岛屿）
function vassalReachable(a,b){ return countriesAdjacent(a,b)||seaAdjacent(a,b); }
// 战胜后附庸化：败者保留全部省份，成为胜者附庸（先终结败者的其他战争）
// 条件：两国陆地接壤（含附庸），或隔海相近
function vassalize(winner,loser){
  const w=wars.find(w=>w&&typeof w.a==='number'&&typeof w.d==='number'&&((w.a===winner&&w.d===loser)||(w.d===winner&&w.a===loser)));
  if(!w) return;
  if(!vassalReachable(winner,loser)){ pushLog(`${countries[loser].name} 与 ${countries[winner].name} 既不接壤亦非近海，无法册封附庸`,'war',0); return; }
  for(const w2 of [...wars]){
    if(w2===w||!w2||typeof w2.a!=='number') continue;
    if(w2.a===loser||w2.d===loser) makePeace(w2,[],false);
  }
  makePeace(w,[],isHuman(winner)||isHuman(loser));
  clearAllAlliances(loser); // 附庸不得另有盟约
  countries[loser].overlord=winner; countries[loser].subject=SUBJ_VASSAL; invalidateCamps();
  pushLog(`👑 ${countries[loser].name} 向 ${countries[winner].name} 屈膝称臣，成为附庸`,'gold');
  labelsDirty=true; UI.panel();
}

/* ---------- 玩家自定义：改国名 / 改属国颜色 ----------
   两者都是服务端权威的状态改动：服务端改完用 cp 增量广播，各客户端直接套用。
   单人模式下客户端本地直接调这两个函数。 */
const RENAME_MAX=12;          // 国名字数上限
const RENAME_COST=200;        // 改国名花费（金）
function sanitizeCountryName(raw){
  return String(raw==null?'':raw).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,RENAME_MAX);
}
function setCountryName(cid, name){
  const c=countries[cid]; if(!c||!c.alive) return false;
  const nm=sanitizeCountryName(name);
  if(!nm) return false;
  c.name=nm; c.enName=nm;
  labelsDirty=true;
  return true;
}
function setCountryColor(cid, rgb){
  const c=countries[cid]; if(!c) return false;
  if(!Array.isArray(rgb)||rgb.length<3) return false;
  const out=[];
  for(let i=0;i<3;i++){
    const v=Math.round(+rgb[i]);
    if(!isFinite(v)) return false;
    out.push(Math.max(0,Math.min(255,v)));
  }
  c.color=out;
  return true;
}

/* ---------- 供服务端 / 客户端共用的世界初始化与控制接口 ---------- */
function setSeed(s){ _seed=s>>>0 || 987654321; }
function resetWorld(){
  _seed=987654321;
  land=null; provOf=null;
  provinces=[null]; countries=[null];
  armies=[]; nextArmy=1;
  recruits=[]; nextRecruit=1;
  wars=[]; truces={};
  player=0; humans=new Set(); dayCount=0;
  cal={y:1444,m:10,d:11};
  paused=true; speed=2;
  selectedProv=0; selectedArmy=0;
  labelsDirty=true; battleProvs=new Set();
  started=false; logEntries=[]; pendingOffers={};
  _aiPending=false;
  invalidateCamps();
}
/* 构建世界（客户端与服务端必须调用同一路径，保证省界完全一致） */
function buildWorld(){
  const feats=decodeTopo(WORLD_DATA);
  const {cidMap}=buildLand(feats);
  buildProvinces(cidMap,feats);
  buildCountries(cidMap,feats);
  return {cidMap,feats};
}
/* 当前世界的可序列化快照 */
function makeSaveData(){
  return {v:1,dayCount,cal:{...cal},player,paused,speed,mapMode,
    // [5] 是故土记录 former：复国之机靠它，必须一起存/传
    prov:provinces.slice(1).map(p=>p.former&&p.former.length
      ?[p.owner,p.controller,p.tax,p.prod,p.man,p.former.slice()]
      :[p.owner,p.controller,p.tax,p.prod,p.man]),
    ct:countries.slice(1).map(c=>c?(c.featId==='CUSTOM'
      ?{a:c.alive?1:0,g:Math.round(c.gold*10)/10,mp:Math.round(c.mp),r:c.ruler,ov:c.overlord||0,al:(c.allies||[]).slice(),n:c.name,col:c.color,cap:c.capital,sj:c.subject||0}
      :{a:c.alive?1:0,g:Math.round(c.gold*10)/10,mp:Math.round(c.mp),r:c.ruler,ov:c.overlord||0,al:(c.allies||[]).slice(),sj:c.subject||0}):null),
    arm:armies.map(a=>({i:a.id,o:a.owner,p:a.prov,s:Math.round(a.str),n:a.isNavy?1:0})),
    rec:recruits.map(r=>({i:r.id,o:r.owner,p:r.prov,s:r.str,n:r.isNavy?1:0,d:r.days,t:r.total,st:r.start})),
    nextRecruit,
    wars:wars.map(w=>({...w})), truces:{...truces}, nextArmy,
    humans:[...humans],
    logs:logEntries.slice(0,60)};
}
/* 把快照写回当前世界（纯状态，不触碰界面） */
function applySaveData(d){
  wars=d.wars||[]; truces=d.truces||{};
  d.prov.forEach((a,i)=>{ const p=provinces[i+1]; if(!p) return; p.owner=a[0];p.controller=a[1];p.tax=a[2];p.prod=a[3];p.man=a[4];p.siege=0; p.former=a[5]?a[5].slice():[]; });
  d.ct.forEach((a,i)=>{
    if(!a) return;
    const id=i+1;
    let c=countries[id];
    if(!c){
      // 世界生成时不存在的国家 = 玩家自建的附庸，按存档里的描述补建出来
      if(!a.n) return;
      c={ id, featId:'CUSTOM', name:a.n, enName:a.n, color:(a.col||[180,180,180]).slice(), capital:a.cap||0,
          provList:[], alive:true, gold:0, mp:0, mpCap:0, forceLimit:0, overlord:0, subject:0, allies:[], ruler:'', lx:0, ly:0 };
      while(countries.length<id) countries.push(null);
      countries[id]=c;
    }
    c.alive=!!a.alive||!!a.a; c.gold=a.g; c.mp=a.mp; c.ruler=a.r;
    c.overlord=a.ov||0; c.subject=c.overlord?(a.sj||SUBJ_VASSAL):0;
    c.allies=(a.al||[]).filter(x=>x&&countries[x]&&countries[x].alive);
  });
  for(let c=1;c<countries.length;c++) if(countries[c]) countries[c].provList=[];
  for(let i=1;i<provinces.length;i++){ const p=provinces[i]; if(p.pix.length&&countries[p.owner]) countries[p.owner].provList.push(i); }
  for(let c=1;c<countries.length;c++){ const cc=countries[c]; if(cc){ if(cc.provList.length===0)cc.alive=false; recomputeCap(cc); } }
  nextArmy=d.nextArmy||1;
  // 军队 id 必须与存档保持一致：联机时客户端要按 id 套用服务端增量
  armies=(d.arm||[]).map(a=>{
    const id=(a.i!==undefined&&a.i>0)?a.i:nextArmy++;
    if(id>=nextArmy) nextArmy=id+1;
    return {id,owner:a.o,prov:a.p,str:a.s,path:[],prog:0,isNavy:a.n?1:0};
  });
  nextRecruit=d.nextRecruit||1;
  recruits=(d.rec||[]).map(r=>{
    const id=(r.i!==undefined&&r.i>0)?r.i:nextRecruit++;
    if(id>=nextRecruit) nextRecruit=id+1;
    return {id,owner:r.o,prov:r.p,str:r.s,isNavy:r.n?1:0,days:r.d,total:r.t||r.d,start:(r.st!==undefined?r.st:dayCount)};
  });
  dayCount=d.dayCount; cal={...d.cal};
  if(d.mapMode) mapMode=d.mapMode;
  humans=new Set(d.humans||[]);
  logEntries=(d.logs||[]).slice();
  pendingOffers={};
  invalidateCamps();
  rebuildLabels();
  return true;
}
/* 当前状态引用（服务端读取用；armies/wars 会被整体替换，故每次都取最新） */
function getState(){
  return {provinces,countries,armies,recruits,nextRecruit,wars,truces,dayCount,cal,humans,nextArmy,
          logEntries,pendingOffers,battleProvs,labelsDirty,paused,speed,started};
}

function checkDeath(cid){
  const c=countries[cid];
  if(c.alive&&c.provList.length===0){
    c.alive=false;
    c.overlord=0; c.subject=0;
    invalidateCamps();
    clearAllAlliances(cid); // 亡国后其盟约全部作废
    armies=armies.filter(a=>a.owner!==cid);
    recruits=recruits.filter(r=>r.owner!==cid);
    const ws=wars.filter(w=>w.a===cid||w.d===cid);
    wars=wars.filter(w=>w.a!==cid&&w.d!==cid);
    for(let i=1;i<provinces.length;i++){
      const p=provinces[i];
      if(p.pix.length&&p.controller===cid){ p.controller=p.owner; p.siege=0; UI.recolorNbrs(i); }
    }
    // 宗主灭亡，附庸重获独立
    for(const vc of countries){
      if(vc&&vc.overlord===cid){ vc.overlord=0; vc.subject=0; invalidateCamps(); pushLogWorld(`${vc.name} 随宗主灭亡而重获独立`,'',[vc.id,cid],true); }
    }
    pushLog(`☠ ${c.name} 灭亡，宗庙倾覆`,'war',0);
    if(isHuman(cid)) UI.defeat(cid);
  }
}

/* =====================================================================
   Node 服务端导出（浏览器中 module 未定义，此段自动跳过）
   ===================================================================== */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    UI,isHuman,setHumans,setSeed,resetWorld,buildWorld,getState,invalidateCamps,
    addRecruit,pendingStrength,tickRecruits,RECRUIT_DAYS,NAVY_DAYS,foundVassal,
    makeSaveData,applySaveData,pushLog,pushLogTo,pushLogWorld,fmtDate,
    decodeTopo,buildLand,buildProvinces,buildCountries,rebuildLabels,recomputeCap,totalDev,devOf,
    tickDay,advanceDay,mergeArmies,resolveBattles,resolveSieges,monthlyTick,economy,aiMonthly,
    declareWar,makePeace,transferProvince,checkDeath,vassalize,releaseStaleOccupations,
    warScore,peaceCost,releaseCost,canDemandProvince,occRatio,atWar,inWar,truceBetween,truceKey,
    overlordOf,isAllied,formAlliance,breakAlliance,clearAllAlliances,campOf,vassalsAllOf,
    subjectOf,isPuppet,setOverlord,SUBJ_VASSAL,SUBJ_PUPPET,PUPPET_REBEL_MUL,
    REBEL_BASE,rebelChanceOf,
    setCountryName,setCountryColor,sanitizeCountryName,RENAME_MAX,RENAME_COST,
    findPath,findNavalPath,bfsHome,bfsSetFrom,homeDistMap,countryStrength,
    countriesAdjacent,seaAdjacent,vassalReachable,directWar,isFrontProv,attritionMonthly,
    provinces:()=>provinces, countries:()=>countries, armies:()=>armies,
    wars:()=>wars, truces:()=>truces, humans:()=>humans,
  };
}
