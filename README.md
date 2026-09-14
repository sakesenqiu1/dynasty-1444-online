# 王朝纪元 · 1444 联机版

把一款单文件的大战略游戏改造成**服务端权威的多人联机游戏**：大厅建房、房间号加入、各自选国、同场博弈。

> 原本是一个 2850 行的单文件 HTML 游戏（2007 个省份 / 177 个国家）。这个仓库是它的联机化重构版 ——
> 核心是从零搭起来的一套**确定性世界 + 增量同步**架构。

**在线试玩：<https://mapgame.翼起风落.site>**（个人演示服，可能随时下线；建议按下面的说明自己部署一套）

---

## 玩法

1. 打开游戏地址，填名字 → **创建房间** → 拿到 4 位房间号
2. 把房间号发给朋友 → 朋友输房间号 **加入房间**
3. 各自点选国家（被选走的会置灰，抢选会被拒绝）
4. 房主点 **开始游戏**
5. `空格` 暂停/继续，`1`~`5` 调速；按 `P` 打开性能面板

开局后就是标准大战略玩法：内政发展、招募军团（有集结期）、外交结盟、宣战围城、割地求和、册封与吞并附庸、建立自己的傀儡国、给属国改旗色、花钱改国号……

**属国体系（两种国体）**

| 国体 | 怎么来的 | 每月叛乱倾向 |
|---|---|---|
| **附庸国** | 战争附庸化 / 花钱册封 / 于故土复国 | 4% |
| **傀儡国** | 玩家在自己领土上分封建立的新国家 | **0.2%**（附庸的 5%） |

傀儡国的政权、军队、官僚都由宗主一手搭建，所以远比打服或买来的附庸忠诚。

**外交地图配色**（地图模式切到「外交」）

- 我朝与盟友：蓝色
- 我方附庸国：浅紫
- 我方傀儡国：深紫
- 交战：红 / 停战：橙
- 其余国家（含**他国**的附庸与傀儡）一律中性灰，不作特别表示

**联机规则要点**

- 时间由服务器统一推进，所有人看到的完全一致
- **人类玩家之间的和谈必须双方同意**：提条件只是递交提案，对方在战争页点「接受条件」才真正结束战争
- **附庸造反会真的变成敌对**：可以正常会战、围城、平叛
- 附庸处于交战状态时不可吞并（原版规则）
- 断线后重新打开页面、填**同样的名字和房间号**即可接回原局（座位保留 5 分钟）

**自定义外观**

- **给属国改旗色**：外交页展开我方属国 → `🎨 改色`，36 色预设盘 + 随机。免费，纯外观，服务端广播给所有玩家
- **改自己的国号**：侧栏「王国概览」→ `✏ 修改国名`，花 **200 金**，最多 12 字。名字会随增量同步给所有人，并自动过滤控制字符与尖括号

---

## 核心设计

### 为什么地图不用传输

原游戏的世界地图由**固定种子确定性生成**，代码里没有一处 `Math.random()`。
所以浏览器和服务端**各自跑一遍同样的世界构建代码**，就能得到像素级一致的
2007 个省份、177 个国家 —— 地图一个字节都不用传。

于是同步只需要传**动态状态**：省份归属、国家金钱/人力、军队位置、战争列表。

### 权威模拟 + 绝对值增量

| 点 | 做法 |
|---|---|
| **权威性** | 客户端只发**指令**（行军/宣战/招募…），服务端校验并执行；客户端不跑模拟 |
| **一致性** | 服务端每 65ms 下发**绝对值增量**（不是差分），丢包/重放都无副作用 |
| **确定性** | 每个房间一份独立的游戏内核实例（清 `require` 缓存），互不干扰 |
| **带宽** | 只发改动过的字段，实测约 **14 KB/s/人**（世界每秒更新 12.4 次） |
| **平滑** | 客户端对行军进度做本地插值，插值窗口跟随实测推送间隔自动调整 |
| **断线重连** | 座位按「房间号 + 名字」保留，重连自动接回并对齐状态 |
| **双入口** | 同一份服务同时支持 `/gs/...`（IP 站子路径）和 `/...`（独立域名根路径） |

### 内核与服务端分离

原来的代码到处用全局变量 `player` 表示"玩家"。联机后改成 `humans` 集合 + `isHuman(cid)`，
AI 会把**每一个真人玩家**都当成玩家对待。同时把渲染调用换成 `UI.*` 钩子 ——
浏览器里是真的渲染，服务端是空实现。于是**同一份 `game-core.js` 两端共用**。

### 性能上踩过的坑

这些都有对应的回归测试（见 `tools/`）：

- **每帧重画 3 遍全屏**，静止时也一样 → 改成"画面没变就完全不重画"（渲染耗时 600ms → **0.0ms**）
- **每个增量都重建整个侧栏 DOM** → 状态指纹 + 节流
- **行军插值速度算错**，两帧就跳到终点 → 按时间线性插值
- **`findNavalPath` 每次分配 4MB**，闭包还写在 BFS 循环体里 → 复用数组 + 双向 BFS
- **`campOf` 放在三层循环最内层**，自身还是 O(n²) → 版本化缓存 + 提前到循环外
- **掉帧补偿形成恶性循环**（越卡越补、越补越卡）→ 限制单帧补帧量
- **地图层海洋像素透明**，不填海时旧画面透出来 → 拖动时无数残影 → 地图层改为完全不透明
- **征兵队列每帧全量重发**，占增量体积一半以上 → 只发增删差量

服务端 50 年模拟的 CPU 时间从 **23793ms 降到 6514ms**。

---

## 本地跑起来

只需要 Node.js 18+。

```bash
npm install            # 同时装好 srv/ 的依赖（唯一运行时依赖：ws）
npm start              # 等价于 node srv/server.js
```

默认监听 `127.0.0.1:7788`，子路径 `/gs/`。然后浏览器打开 <http://127.0.0.1:7788/gs/>

想改端口或路径：

```bash
PORT=8080 BASE=/game node srv/server.js     # -> http://127.0.0.1:8080/game/
```

Windows PowerShell：

```powershell
npm install
$env:PORT=7788; $env:BASE="/gs"; node srv/server.js
```

也可以只装服务端：

```bash
cd srv && npm install && node server.js
```

开两个浏览器窗口（或一个正常窗口 + 一个隐私窗口）就能自己和自己联机测试。

---

## 部署到服务器

`tools/` 里带了完整的部署脚本，用环境变量传参，不含任何硬编码凭据：

```bash
export GS_HOST=你的服务器IP
export GS_USER=root
export GS_PASS=你的SSH密码
export GS_DOMAIN=game.example.com      # 可选，用于 HTTPS

node tools/upload.mjs                  # 上传 web/ 与 srv/
node tools/run.mjs tools/sh/deploy-service.sh   # 装 systemd 服务并启动
node tools/run.mjs tools/sh/deploy-nginx.sh     # 配 nginx 反代（子路径方式）
node tools/run.mjs tools/sh/deploy-domain.sh    # 可选：独立域名站点
node tools/run.mjs tools/sh/deploy-ssl.sh       # 可选：申请 Let's Encrypt 证书
node tools/run.mjs tools/sh/deploy-https.sh     # 可选：切到 HTTPS
```

架构：Node 服务监听 `127.0.0.1:7788`（只监听本地），nginx 负责对外与 WebSocket 升级。

**容量参考**：每局约 45–85MB 内存，单房间上限 8 人；服务端有内存水位保护，超限会拒绝开新局。

---

## 测试

```bash
npm test          # 15 个本地测试，不需要服务器
```

CI 每次提交都会自动跑一遍（见 `.github/workflows/tests.yml`）。

也可以单独跑：

```bash
# 本地（不需要服务器）
node tools/test-core.mjs            # 内核：建世界 + 模拟 10 年 + 存档往返
node tools/test-client-unit.mjs     # 客户端 DOM/内核 单元测试
node tools/test-perf-unit.mjs       # 渲染调度与性能回归
node tools/test-map-ghost.mjs       # 地图覆盖不变量（残影回归）
node tools/test-mp.mjs              # 协议端到端（本地起服务，两个客户端）
node tools/test-puppet-mp.mjs       # 傀儡国 / 改色 / 改名的协议广播
node tools/test-ally-mp.mjs         # 盟约增量同步（结盟/断盟广播）
node tools/test-recruit-unit.mjs    # 征兵队列
node tools/test-vassal2-unit.mjs    # 复国 / 建立附庸国
node tools/test-puppet-unit.mjs     # 傀儡国国体、叛乱倾向、外交配色、改色/改名
node tools/test-pvp-peace.mjs       # PvP 和谈必须双方同意
node tools/test-fix3-unit.mjs       # 海路 BFS 与阵营缓存正确性
node tools/test-fix4-unit.mjs       # 吞并规则与报错可见性
node tools/test-fix5-unit.mjs       # 附庸造反可交战
node tools/test-newcountry-label.mjs# 新建国家的同步顺序

# 线上（需要 GS_HOST / GS_PASS / GS_DOMAIN）
node tools/test-final.mjs           # HTTPS + wss + 全流程
node tools/test-jitter.mjs          # 增量间隔抖动与带宽
node tools/test-recruit-live.mjs    # 征兵集结期线上验证
node tools/test-vassal-live.mjs     # 建立附庸国线上验证
node tools/test-puppet-live.mjs     # 傀儡国 / 改色 / 改名线上验证
node tools/test-ally-live.mjs       # 盟约同步线上验证
node tools/test-pvp-live.mjs        # PvP 和谈线上验证
node tools/test-load.mjs            # 并发与资源占用
```

性能剖析：

```bash
node tools/profile-server.mjs                       # 逐日 / 月度结算耗时分布
node --cpu-prof --cpu-prof-dir=prof tools/sim-for-prof.mjs
node tools/analyze-prof.mjs prof                    # CPU 采样热点排序
node tools/bench-delta-scan.mjs                     # 增量扫描循环的微基准
```

---

## 目录结构

```
web/     浏览器端（部署到服务器的就是这里）
  index.html     页面外壳 + 大厅界面
  world-data.js  世界地图拓扑（Natural Earth 110m）
  game-core.js   模拟内核：世界构建 + 全部规则（浏览器与服务端共用）
  client.js      渲染、界面、输入
  net.js         联机客户端：大厅、房间、指令、增量同步

srv/     服务端
  server.js      权威服务端：房间 + 每局独立世界 + 增量下发

tools/   开发、测试、部署、性能剖析
```

---

## 已知限制

- 服务端是**单线程**的，单核跑到极速（速度 5 档）时月度 AI 结算会有约 20ms 的尖峰；多局同时满速会有争抢
- 没有账号系统，名字只用于在同一房间内标识身份
- 没有观战模式
- 地图边界用的是现代国境（公开数据没有 1444 年矢量图），只有国家名按 15 世纪命名

---

## 出处与致谢

- 地图数据：[Natural Earth](https://www.naturalearthdata.com/) 110m（公有领域），经 [world-atlas](https://github.com/topojson/world-atlas) 转为 TopoJSON
- 服务端唯一依赖：[ws](https://github.com/websockets/ws)

## 许可证

[GNU AGPL-3.0](LICENSE) —— 你可以自由使用、修改、分发；但如果你把它改完部署成网络服务，
**必须把修改后的源码也开源**。

---

## English

A single-file grand strategy game rebuilt into a **server-authoritative multiplayer** game:
create a room, share the 4-digit code, pick your nation, and play together in real time.

The key idea: the world map is **deterministically generated from a fixed seed**, so both the browser
and the server build an identical 2007-province / 177-nation world locally — the map itself is never
transferred. Only dynamic state (province ownership, armies, wars) is synced, as **absolute-value
deltas** at ~14 KB/s per player. Same-origin Node server + WebSocket, one isolated game world per room.

PvP peace deals require **mutual consent**; vassal revolts become real wars.

Licensed under **AGPL-3.0**.
