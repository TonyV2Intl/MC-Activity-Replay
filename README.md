# Minecraft 玩家活动记录与回放系统

自托管的 Minecraft 服务器玩家活动记录与回放系统：服务端按固定间隔轮询上游 API（MTR + Squaremap），将在线玩家的位置与状态存入时序数据库（TimescaleDB），并通过网页控制台进行会话管理与轨迹回放，支持浏览器录屏导出视频。

通过 Docker Compose 一键部署，可运行在开发者 PC 或服务器上。

## 功能特性

- **手动记录控制**：单会话记录，随时开始/停止，支持最长时长上限
- **双上游轮询**：默认 1 秒轮询 MTR 客户端 API 与 Squaremap players.json，1 秒精度回放；MTR 采集可整体关闭（适用于未安装 MTR 的服务器）
- **可选字段采集**：`station_id`/`route_id`/`route_station_id1`/`route_station_id2`（MTR）与 `health`/`armor`（Squaremap）均可勾选，未勾选的字段不写入 `player_state` 表
- **数据清洗**：MTR 缓存去重（cachedResponseTime）、完全相同的重复位置不写入
- **网页回放**：多玩家同时回放、变速播放（1x–32x）、逐点步进、进度条拖动跳转、画面中心跟随指定玩家、玩家名字常显/悬停显示、当前坐标/点位序号/站点/线路（MTR）/血量/护甲/推算速度工具提示（显示栏目可选）、跳跃段虚线连接（可开关，距离阈值可调，默认 1000 格）、方向箭头显示模式三选（一直显示/仅未走过显示/一直隐藏）、最多显示轨迹点数量（可开关，默认 600 ≈ 前后各 5 分钟，路线随播放动态伸缩）、取消地图缩放等级限制（可开关）、玩家轨迹颜色单独指定
- **瓦片地图**：Squaremap 瓦片 + Leaflet，方块坐标精确对齐（见下文“瓦片坐标转换”）；支持瓦片镜像地址（回放与采集可用不同地址）与服务器代理下载（浏览器无法直连瓦片上游时经后端中转）
- **玩家头像**：MCHeads 头像标记，按真实 Minecraft yaw 旋转
- **录屏导出**：独立录制模式保留侧边栏全部控件、隐藏 Leaflet 控件，支持 16:9/4:3 画面比例；「获取录制区域」将采集裁剪到地图区域（Edge/Chrome 132+ RestrictionTarget，不支持时降级录制整个标签页），区域无时间限制可随时反复录制，停止后自动下载 MP4（H.264）
- **会话管理**：重命名、删除、合并（时间段重叠拒绝）、单次会话 JSON/CSV 导入、JSON/CSV/数据库级导出、一键清空数据库
- **实时监控**：记录中实时查看在线玩家（坐标、当前 MTR 站点/线路、血量/护甲、推算速度）与最近错误日志；刷新间隔跟随轮询间隔，未记录时可手动刷新（有快照显示最后快照，无快照拉取一次实时预览）

## 快速开始

### 环境要求

- Docker + Docker Compose（v2，`docker compose` 命令）
- 约 2GB 以上可用内存（TimescaleDB 容器限制 2g，可在 docker-compose.yml 中调整）

### 启动

```bash
# Linux / macOS
./start.sh

# Windows
start.bat
```

或手动：

```bash
cp .env.example .env   # 可选：修改密码与密钥
docker compose up -d --build
```

启动后访问 **http://localhost:8080**，初始密码为 `admin`（首次登录后请立即在控制台“修改密码”中修改）。

### 从 GHCR 预构建镜像部署（无需本地编译）

如果已通过 GitHub Actions 构建并推送镜像（见下文「CI/CD」），部署时无需 Docker 构建环境。仓库内含两份 compose：

- `docker-compose.yml`：本地构建用（含 `build:` 段）
- **`docker-compose.ghcr.yml`**：纯镜像部署用（无 `build:` 段，直接拉取 GHCR 镜像，**适用于 1Panel / 远程服务器**）

**通用（命令行）部署：**

```bash
cp .env.example .env
# 编辑 .env，取消注释并修改为你的 GHCR 镜像地址（版本号与 Actions 输入一致）：
#   BACKEND_IMAGE=ghcr.io/<你的GitHub名>/<仓库名>-backend:1.0.0
#   FRONTEND_IMAGE=ghcr.io/<你的GitHub名>/<仓库名>-frontend:1.0.0
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

**1Panel 部署：** 在「容器 → 编排应用」中新建应用，粘贴 `docker-compose.ghcr.yml` 内容，在“环境变量”里设置 `IMAGE_TAG`（建议填具体版本号，如 `1.0.0`，不填则默认 `latest`），确认创建即可。无需挂载 `init.sql`，表结构由后端启动时自动创建。

> ⚠️ **GHCR 镜像包默认是私有的**（即使代码仓库设为 Public 也不影响包可见性）。二选一：
> 1. 把包改为公开：GitHub 仓库 → 右侧 `Packages` → `mc-activity-replay-backend` → Package settings → Change visibility → Public（frontend 同样操作），之后拉取免登录；
> 2. 或在部署服务器上先登录：`docker login ghcr.io -u <用户名>`（密码用带 `read:packages` 权限的 PAT），1Panel 也可在「容器配置」中填写 ghcr.io 的仓库账号密码。

### 停止

```bash
docker compose down
```

## 配置说明（.env）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_PASSWORD` | `mc_activity_pass` | 数据库密码（首次启动时生效，之后不可更改） |
| `INITIAL_ADMIN_PASSWORD` | `admin` | 初始管理员密码 |
| `SESSION_SECRET` | `change-me-in-production` | Session 签名密钥，生产环境请改为随机字符串 |

其余配置（上游 API 地址、轮询间隔、瓦片缩放级别、瓦片镜像地址、可选采集字段与 MTR 开关等）在控制台“系统配置”页面中修改，存储于数据库，重启后保留。世界名与瓦片 URL 模板固定为系统默认值（`minecraft_overworld` 与 `/tiles/{world}/{zoom}/{x}_{z}.png`），不再提供配置项。

| 配置键 | 说明 |
| --- | --- |
| `mtr_url` / `squaremap_url` | 采集时使用的上游 API 地址（新建会话时写入会话记录，之后按会话固化） |
| `mirror_url` | **瓦片镜像地址**（默认空）：仅影响回放瓦片——设置后回放从该镜像加载瓦片，采集仍使用 `squaremap_url`，适用于内外网分离、瓦片服务器更换等场景；回放页「瓦片经服务器代理」开启时同样优先走镜像 |
| `default_tile_zoom` | 瓦片最大缩放等级（zoom.max），新建会话时作为默认值写入 |
| `default_poll_interval_ms` | 新建会话的默认轮询间隔（毫秒），请求未指定时使用；默认 `1000` |
| `default_max_duration_sec` | 新建会话的默认时长上限（秒），留空表示无上限，请求未指定时使用 |
| `default_mtr_enabled` | 是否默认采集 MTR 乘坐状态（默认 `true`）：关闭后仅使用 Squaremap 坐标数据，适用于未安装 MTR 的服务器；关闭时 MTR 配置项与 `station_id`/`route_id`/`route_station_id1`/`route_station_id2` 字段在控制台隐藏、不写入数据库 |
| `default_collect_station_id` / `default_collect_route_id` / `default_collect_route_station1` / `default_collect_route_station2` | MTR 状态可选字段采集开关（默认均 `true`），未勾选的字段在 `player_state` 表中写 NULL；`default_mtr_enabled` 关闭时无效 |
| `default_collect_health` / `default_collect_armor` | Squaremap 生命值/护甲采集开关（默认均 `false`，需 Squaremap 服务器提供该字段），勾选后写入 `player_state` 表 |

## 系统架构

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│  frontend   │     │  backend    │     │   timescaledb    │
│  nginx :80  │────▶│  Go/Gin     │────▶│  PostgreSQL 16   │
│  静态文件    │ API │  :3000 内网  │     │  + TimescaleDB   │
└─────────────┘     └─────────────┘     └──────────────────┘
      │                                            │
      └──────────── 仅 frontend 暴露 8080 ──────────┘
```

- **frontend**：nginx 托管原生 HTML/CSS/JS 页面（无构建工具），`/api/` 反向代理到 backend
- **backend**：Go 单一二进制，负责轮询采集、数据清洗、入库、REST API、会话回放查询
- **timescaledb**：时序数据库，`player_activity`（1 天分块）与 `player_state`（7 天分块）为 hypertable，30 天自动压缩

## 项目结构

```
mc-activity-replay/
├── docker-compose.yml      # 一键部署编排（本地构建）
├── docker-compose.ghcr.yml # 纯镜像部署编排（拉取 GHCR，适用于 1Panel / 远程）
├── start.sh / start.bat    # 启动脚本
├── .env.example            # 环境变量模板
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # 手动触发构建镜像并推送到 GHCR
├── timescaledb/
│   └── init.sql            # 建表 / hypertable / 压缩策略 / 默认配置
├── backend/
│   ├── Dockerfile
│   ├── main.go             # 入口：加载配置 → 连库 → 幂等建表 → 恢复异常会话 → 启动 API
│   ├── config/             # 环境变量配置
│   ├── db/                 # 连接池 / 幂等建表（安全网）/ 共享配置读取
│   ├── models/             # 数据结构
│   ├── collector/          # MTR/Squaremap 客户端 + 轮询采集器
│   └── api/                # Gin 路由与全部 REST 端点（含瓦片代理 tiles.go）
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    └── public/
        ├── index.html      # 控制台（记录控制 / 实时监控 / 会话管理 / 配置）
        ├── login.html      # 登录
        ├── replay.html     # 回放页
        ├── css/style.css
        ├── fonts/          # 本地托管 JetBrains Mono woff2（latin 子集，400/700，无外部 CDN 依赖）
        └── js/
            ├── api.js      # API 封装 / UUID 格式化 / 时间格式化
            ├── auth.js     # 登录态守卫
            ├── tile.js     # Squaremap 瓦片坐标转换（关键模块）
            ├── console.js  # 控制台逻辑
            ├── session.js  # 会话管理逻辑
            ├── replay.js   # 回放播放引擎
            ├── recorder.js # MediaRecorder 编码与下载（screen stream 由 replay.js 区域获取流程注入）
            └── leaflet-trackplayer.js # 本地托管的轨迹播放插件 v2.0.3
```

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录（HMAC-SHA256 签名 Cookie，7 天有效） |
| POST | `/api/logout` | 登出 |
| GET | `/api/auth/check` | 检查登录态 |
| POST | `/api/auth/password` | 修改密码 |
| GET | `/api/collector/status` | 采集器状态（含最近 100 条错误环形缓冲） |
| POST | `/api/collector/start` | 开始记录（单会话，可带 URL / 间隔 / 时长上限） |
| POST | `/api/collector/stop` | 停止记录 |
| GET | `/api/collector/live` | 实时在线玩家（录制中或停止后的最后快照） |
| GET | `/api/collector/preview` | 未记录时的实时预览（临时拉取上游，不建会话、不写库） |
| GET | `/api/sessions` | 会话列表（含统计） |
| GET | `/api/sessions/:id` | 会话详情 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/sessions/merge` | 合并会话（时间段重叠拒绝） |
| POST | `/api/sessions/import` | 导入单次会话（JSON 或 CSV，multipart 上传） |
| GET | `/api/sessions/:id/players` | 会话内玩家列表 |
| GET | `/api/sessions/:id/players/:uuid/trajectory?chunk=0&chunkSize=2000` | 轨迹分页 |
| GET | `/api/sessions/:id/players/:uuid/state` | 玩家状态变化记录（MTR 乘坐状态 + 血量/护甲，按采集配置可选） |
| GET | `/api/sessions/:id/snapshot?at=` | 指定时间点在线玩家快照 |
| GET | `/api/sessions/:id/export` | 会话导出（JSON 流式 / CSV 坐标流式） |
| GET | `/api/config` / PUT | 系统配置读写 |
| GET | `/api/network/names` | MTR 站点/线路 ID → 名称映射（回放工具提示用，后端缓存 10 分钟） |
| GET | `/api/tiles/{world}/{zoom}/{x}_{z}.png` | 瓦片代理：浏览器经后端中转下载 Squaremap 瓦片（上游取 `mirror_url`，回退 `squaremap_url`；FIFO 缓存 + 浏览器缓存头） |
| GET | `/api/database/export` | 整库导出（数据快照 SQL，COPY 格式，psql 可执行） |
| POST | `/api/database/import` | 整库导入（清空当前数据并从快照重建） |
| POST | `/api/database/wipe` | 一键清空数据库（TRUNCATE 全部表 + 恢复默认配置与初始密码，不可恢复） |

## 瓦片坐标转换（前端关键模块）

坐标转换公式经 **Java 源码推导 + 浏览器实测双重验证**，实现位于 `frontend/public/js/tile.js`：

1. **squaremap Java 端**（`RegionImage.java`）：瓦片 512×512 px，URL 为 `{world}/{urlZoom}/{tileX}_{tileZ}.png`，`tileX = floorDiv(blockX, 512 * 2^(maxZoom - urlZoom))`，`maxZoom = 3`
2. **squaremap Web 端**（`Squaremap.js`）：`toLatLng(x, z) = L.latLng(-z * scale, x * scale)`，`scale = 2^-zoom.max`，crs 为 `L.CRS.Simple`
3. **实测验证**：Playwright 拦截 demo 站点瓦片请求，确认 zoom 3 时 1 格 = 1 像素、zoom 0 时 8 格 = 1 像素

最终实现采用 Leaflet 1.9.4 `CRS.Simple` 语义（`scale(zoom) = 256 * 2^zoom`）：

```
latlngPerBlock = 1 / (256 * 2^maxZoom)
latLng(x, z)    = L.latLng(-(z + offsetZ) * s, (x + offsetX) * s)
```

代码中保留可配置偏移量常量 `TileConfig.offsetX / offsetZ`，便于校准。

## 回放播放引擎

`frontend/public/js/replay.js` 采用**时间驱动**方案：leaflet-trackplayer 内部按距离推进，无法直接按时间轴播放。本实现为每个玩家创建 `speed: 0` 的 `L.TrackPlayer`（内部推进恒为 0），由 `requestAnimationFrame` 循环按墙上时钟推进 `currentTime`，二分定位时间区间后换算为距离比例 `e = (cum[i] + α·seg[i]) / total` 并调用 `setProgress(e)` 驱动渲染。变速即倍增每帧时间增量；步进在全部已加载轨迹点的去重时间戳上跳转。

方向旋转关闭插件自带的 turf 方位角，改为按真实 Minecraft yaw 插值（屏幕朝向角 = 180° + yaw）。

画面跟随：`render()` 每帧渲染结束后，若 `followUuid` 非空则取该玩家标记的 `getLatLng()` 调用 `map.panTo(..., {animate: false})` 使其保持居中（播放、拖动进度条、步进时均生效）；地图 `dragstart` 事件触发即自动取消跟随（`panTo` 不触发该事件，不会自我取消）；取消勾选或移除被跟随玩家轨迹时同步清除跟随状态。

玩家名 tooltip：多点轨迹（TrackPlayer 标记）与单点轨迹统一通过 `bindPlayerTooltip()` 绑定，内容为按玩家专属颜色着色的名字（HTML 转义防注入）。`permanent` 行为由 Leaflet 在 `bindTooltip` 时决定（常显则立即 `openTooltip`，否则绑定 mouseover/mouseout），因此「常显玩家名字」开关切换时先 `unbindTooltip` 再重新 `bindTooltip`；偏好持久化在 localStorage（`mc-replay.tooltipPermanent`）。tooltip 还包含：当前数据点序号/总点数（1-based，形如 `245/2705`：取 `locate()` 得到的最后一个 ≤ 当前时刻的点，早于首点显示 1、晚于末点显示总点数；位于名字下方第一行）、当前坐标（由标记位置经 `latLngToBlock()` 逆换算为方块坐标取整显示，随播放逐帧更新）、当前时刻的 MTR 站点名与线路名（仅显示名称，不显示 ID）、当前推算速度。

跳跃段虚线：`buildTrack()` 计算相邻两点方块距离 `√(Δx²+Δz²)`，超过阈值（`dashJumpBlocks`，默认 1000 格，可调，localStorage `mc-replay.dashJumpBlocks`）的段判定为跳跃段（传送/重连导致的位置跳变）。连续同属性段合并为 run，每个 run 建两条自建 polyline（走过=玩家色，未走=半透明白，跳跃段在开关开启时加 `dashArray`）；TrackPlayer 自带的 passed/notPassed 线设 `opacity: 0` 隐藏（箭头装饰不受影响仍沿轨迹绘制）。`render()` 中按 `D = e·total` 与各 run 的 `cumStart/cumEnd` 比较得到 未开始/部分走过/已走过 三态，仅在状态或拆分位置变化时 `setLatLngs`（1e-9 容差避免重复渲染）；部分走过状态在拆分段内线性插值出当前位置点，前后两半分别着色（切片基于 run 局部数组 `run.latlngs`，其 `[0]` 对应全局 `startIdx`）。回放页「跳跃段用虚线连接」复选框（localStorage `mc-replay.dashJump`，默认开）+ 距离阈值输入框：开关只切换 dash 样式、不重建轨迹图层（多轨迹时避免卡顿），调整阈值才基于本地缓存的原始点（`track.rawPoints`）重建轨迹，不重新请求数据，并保持原颜色、乘坐状态与画面跟随。

方向箭头：箭头由 TrackPlayer 自带的 `polylineDecorator`（L.Symbol.arrowHead，offset 30 / repeat 60，玩家色）绘制，但插件的 `playAction` 每帧都会用**全轨迹** passed+notPassed 调 `setPaths` 覆盖箭头路径，因此 `render()` 在 `setProgress` 之后按当前模式重设装饰路径（与「最多显示轨迹点」的窗口裁剪叠加）：

- **一直显示**（默认，`all`）：窗口内全部路径（走过+未走）铺箭头；无窗口时为整条轨迹，与插件默认 passed+notPassed 拼接等价
- **仅未走过显示**（`notPassed`）：从当前时刻所在点（`locate()` 的 `loc.i`；早于首点取窗口起点、晚于末点为空）到窗口末端铺箭头，已走过的部分不显示
- **一直隐藏**（`none`）：`setPaths([])`，不绘制任何箭头；轨迹加载瞬间即生效，无需等待首帧渲染

回放页「方向箭头」单选组（localStorage `mc-replay.arrowMode`，默认「一直显示」）切换后调用 `render()` 重绘即时生效，不重建轨迹图层；与最多显示轨迹点数量、跳跃段虚线两个选项相互独立。

最多显示轨迹点数量：回放页复选框 + 数量输入框（localStorage `mc-replay.maxPointsEnabled` / `mc-replay.maxPoints`，默认不勾选、默认 600 ≈ 当前时刻前后各 5 分钟，按每秒 1 个数据点估算）。勾选后 `render()` 以当前时刻所在点为中心开一个总数不超过上限的索引窗口 `[wLo, wHi]`（一侧被轨迹首/末端截断时剩余额度转给另一侧），各 run 与窗口求交得到可见切片，窗口外的段整段隐藏（state=3），已/未走过着色逻辑不变；方向箭头装饰（`tp.polylineDecorator`）每帧在 `setProgress` 之后重新 `setPaths` 为窗口路径（插件每帧会用全轨迹 passed+notPassed 覆盖它，不覆盖则窗口外仍铺满箭头）。窗口随播放滑动，路线动态伸缩，避免长轨迹混乱；轨迹总点数不超过上限时该选项无效果；未勾选时行为与此前完全一致。切换/改值只需重绘，不重建轨迹图层。

速度推算：`api.js` 的 `calcSpeed(pts, mode)` 按前后坐标点推算瞬时速度（单位：格/秒），回放与控制台实时监控共用。模式由用户在页面上单选（localStorage 记忆）：**两点**取最新两个相邻点位移/时差，**三点**取最新三个点首末总位移/总时差（平均速度，抗单点抖动）。回放侧 `speedAtTrack()` 从当前播放位置取轨迹点序列；控制台侧按每次轮询快照的 `polledAt` 为时间戳维护每玩家最近 3 个点的历史队列。点数不足（回放开头/单点轨迹）或时差为 0 时不显示速度行。

玩家状态：采集轮询将 MTR 客户端 API 的 `stationId`/`routeId`/`routeStationId1`/`routeStationId2` 与 Squaremap players.json 的 `health`/`armor` 按状态变化写入 `player_state` 表（每类字段可分别勾选采集，未勾选写 NULL）；`mtr_enabled` 关闭时完全不请求 MTR 上游、仅记录 Squaremap 坐标与血量/护甲。回放时 `GET /api/sessions/:id/players/:uuid/state` 返回该玩家的状态变化序列，前端 `stateAt()` 二分定位当前时刻状态并由 `tooltipHTML()` 组装进工具提示（`render()` 中仅内容变化时调用 `setTooltipContent`）。站点/线路 ID → 名称由 `GET /api/network/names` 提供：后端由配置的 `mtr_url` 推导出 `stations-and-routes` 上游地址（路径 `clients` 段替换），拉取后内存缓存 10 分钟，多语言名称取第一个非空段；上游不可用时前端回退为显示原始 ID。控制台实时监控（`GET /api/collector/live`）同样返回每位玩家的乘坐状态与血量/护甲字段，与回放共用 `api.js` 的 `resolveTransit()` 解析名称后展示坐标/站点/线路/血量/护甲。

实时监控刷新：面板定时器间隔与记录时的轮询间隔保持一致（取 `GET /api/collector/status` 的 `pollInterval`，变化时自动重建定时器，下限 200ms）；标题旁显示「每 Xms 刷新 · 更新于 …」。**未开始记录时停止自动轮询**，改为提供「刷新」按钮手动拉取数据：有轮询快照时走 `GET /api/collector/live`（停止录制后仍保留最后的玩家列表，见 `collector.go` 的 `Live()` 条件 `livePolledAt != nil`）；无快照时（从未录制，或后端重启后快照已丢失）回退到 `GET /api/collector/preview`——按 `app_config` 的上游 URL 与 `default_mtr_enabled` 临时拉取一次 Squaremap（+MTR）并合并，不创建会话、不写库，提示文案变为「未在记录 · 实时预览 · 预览更新于 …」。

实时监控卡片栏目：「卡片显示」复选框组（坐标/速度/血量/护甲/站点/线路，其中血量/护甲默认不勾选，localStorage `mc-console.liveFields` 持久化）控制每位玩家卡片展示的栏目，名字与头像始终显示；与回放 tooltip 的「tooltip 显示」复选框组（`mc-replay.tipFields`，含名字，血量/护甲同样默认不勾选）逻辑一致。未采集的字段（如未勾选 health）在卡片中不显示。

## 使用说明

1. **开始记录**：控制台点击“开始记录”，可配置上游 URL、轮询间隔（默认 1s）、最长时长。记录期间可在“实时监控”查看在线玩家与错误；监控刷新间隔与轮询间隔保持一致，未开始记录时可用面板上的「刷新」按钮手动查看最后一次快照；若没有任何快照（从未录制或后端刚重启），「刷新」会拉取一次实时预览（不写库）。
2. **采集配置（可选字段与 MTR 开关）**：控制台“配置”页可勾选要采集的可选字段——MTR 侧的 `station_id`/`route_id`/`route_station_id1`/`route_station_id2`（默认勾选）与 Squaremap 侧的 `health`/`armor`（默认不勾选，需 Squaremap 服务器提供）。勾选「启用 MTR 数据采集」（默认开）才会显示 MTR 配置与字段；**不勾选时仅采集 Squaremap 坐标**，适用于把本系统用在只有 Squaremap 的其他服务器，此时 MTR 字段不写入 `player_state` 表。以上设置在新建会话时作为默认值写入会话记录（也可在开始记录时单独指定）。
3. **查看会话**：“会话管理”列出所有会话（玩家数 / 轨迹点数 / 时间段 / 停止原因），支持重命名、删除、合并、导出。
4. **回放**：点击会话进入回放页，勾选玩家加载轨迹（分块并行加载），使用播放控制进行播放/暂停/变速/步进/拖动跳转。点击玩家行的「跟随」按钮可让画面中心锁定该玩家移动（未加载轨迹时会自动加载），拖动地图或再次点击取消。勾选「常显玩家名字」后所有头像旁常显玩家名（按玩家专属颜色着色），关闭时仅鼠标悬停显示；该偏好记忆在浏览器本地。工具提示随回放进度显示该玩家名字、当前点位序号（名字下方第一行，形如 245/2705，即第几个数据点/该玩家轨迹总点数）、当前坐标、所处 MTR 站点/线路名称、血量/护甲与推算速度；「速度采样」单选组可选择按最新两点还是最新三点推算速度，「tooltip 显示」复选框组可选择 tooltip 显示的栏目（名字/坐标/点位/速度/血量/护甲/站点/线路，其中血量/护甲默认不勾选，偏好记忆在浏览器本地，全部关闭时显示占位提示）。「跳跃段用虚线连接」复选框控制传送/重连造成的远距离跳变段是否用虚线绘制（距离阈值可在旁边输入框调节，单位格，默认 1000，偏好记忆在浏览器本地；切换开关只切换线型不重建轨迹，调整阈值才重建）。「方向箭头」单选组选择轨迹箭头的显示方式：一直显示（默认）/ 仅未走过的路径显示箭头 / 一直隐藏，偏好记忆在浏览器本地，切换后即时生效。「最多显示轨迹点数量」复选框 + 数量输入框（默认 600 ≈ 当前时刻前后各 5 分钟）勾选后仅绘制以当前播放时刻为中心、总数不超过上限的轨迹点，路线随播放动态伸缩，避免长时间录制的轨迹混乱；未勾选时显示完整轨迹。「取消地图缩放等级限制」复选框（默认不勾选）勾选后解除回放地图的最小/最大缩放等级限制，可缩放到 0 级以下或瓦片原生最大等级之上（超出部分为放大显示，瓦片仍正常加载）。玩家列表每行的色板可**单独指定该玩家轨迹颜色**（折线、箭头、tooltip 名字立即生效，按 uuid 持久化在浏览器本地），点「自动」清除指定恢复按加载顺序的自动分配。相邻数据点间移动超过设定距离（默认 1000 格，可调）的轨迹段（传送/重连）在开启「跳跃段用虚线连接」时以虚线绘制。
5. **录制视频**：点击“进入录制模式”——侧边栏控件全部保留、Leaflet 缩放按钮隐藏、地图区按 16:9（可切 4:3）比例居中，右上角时间戳作为地图容器后代元素始终在录制范围内。点击「获取录制区域」并在浏览器弹窗中选择**当前标签页**：Edge/Chrome 132+ 自动把采集裁剪到地图区域，其他浏览器（或选错源导致裁剪失败）降级为录制整个标签页（需后期手动裁剪）；区域就绪后无时间限制。点击「开始录制」即开始录屏（回放不暂停、可继续操作地图），「停止录制」后自动下载 `replay-{会话ID}-{时间戳}.mp4`（H.264 编码；浏览器不支持 MP4/H.264 时开始录制会提示无法录制），可再次录制无需重新获取；按 Esc 或再次点击「退出录制模式」退出（录制中会先停止并下载）。
6. **数据库备份**：控制台“数据库”区域点击“导出数据库”下载全库数据快照；点击“导入数据库”选择快照文件恢复。
7. **一键清空数据库**：控制台“数据库导入导出”区域点击「一键清空数据库」（双重确认）——TRUNCATE 全部表并恢复默认系统配置与初始管理员密码，相当于全新安装，用于彻底重置、避免旧配置项冲突；**不可恢复**，录制中会拒绝执行。
8. **导入单次会话**：控制台“数据库导入导出”区域点击“导入单次会话（JSON/CSV）”，选择文件后追加导入一次会话（不清空现有数据）。JSON 为「导出会话 JSON」的结构（version=1，含完整玩家轨迹与状态记录 `state`：MTR 乘坐字段 + 血量/护甲）；CSV 为「导出会话 CSV」的宽表格式（`time,player_uuid,player_name,x,z,yaw,station_id,route_id`），后端按玩家分组还原轨迹，连续相同的 (station_id, route_id) 按状态变化去重为状态记录，会话元数据由数据推导（名称取文件名、起止时间取首末点、轮询间隔取相邻点间隔中位数，URL/世界/瓦片取当前配置或系统默认值）。

## 瓦片来源：镜像地址与服务器代理

回放瓦片默认由**浏览器直连**会话记录时的 Squaremap 地址拉取。两种切换方式（回放页左侧「瓦片经服务器代理」复选框 + 系统配置 `mirror_url`）：

- **瓦片镜像地址**（`mirror_url`，控制台“配置”页设置）：设置后回放改从镜像加载瓦片，**采集仍使用 `squaremap_url`**——回放瓦片与采集 API 可以使用不同地址，适用于内外网分离、瓦片服务器更换等场景。留空则回放与采集使用相同地址。修改后重新打开回放页生效。
- **瓦片经服务器代理**（回放页复选框，localStorage 记忆）：瓦片改由 `GET /api/tiles/{world}/{zoom}/{x}_{z}.png` 经**后端中转**下载（浏览器只访问本系统），适用于浏览器无法直连瓦片上游的场景（跨域限制、内网部署、防火墙）。上游基址取 `mirror_url`（优先），未设置时回退 `squaremap_url`。

代理实现（`backend/api/tiles.go`）：路径白名单校验（`{world}/{zoom}/{x}_{z}.png`，防路径穿越与 SSRF）→ 上游请求（15s 超时）→ 透传状态码（404 等按缺失瓦片处理）→ 响应带 `Cache-Control: public, max-age=86400`；后端另有 FIFO 内存缓存（最多 1024 块、单块 ≤1MB），与浏览器缓存互补。

## 回放地图缩放等级限制

回放地图默认限制在 **0 至 `瓦片最大缩放 + 额外层级`**（如瓦片 zoom.max=3、extra=2 时为 0–5）：地图 `minZoom/maxZoom` 选项与瓦片图层同名选项共同作用——后者超界时 Leaflet `GridLayer._setView` 会把 `_tileZoom` 置 `undefined` 导致整层瓦片不显示，因此解除限制时两者必须同步放宽。

「取消地图缩放等级限制」复选框（回放页，localStorage `mc-replay.unlimitedZoom`，默认不勾选）勾选后范围放宽到 **-6 至 20**（`UNLIMITED_ZOOM_MIN/MAX`）：可缩小到整个世界之外、放大到瓦片原生等级之上（超出部分由 `maxNativeZoom/minNativeZoom` 钳制后放大显示，瓦片仍正常加载）。取消勾选即恢复默认范围，当前缩放若已超界由 `setMinZoom/setMaxZoom` 自动纠正。开关切换经 `applyZoomLimits()` 同时更新地图与瓦片图层选项并 `redraw()`；瓦片图层重建（镜像/代理切换）后也会按当前偏好重新应用。

## 回放录制模式

录制模式是**独立状态**（`replay.js` 状态机：`off → RECORDING_MODE → REGION_READY → RECORDING`），与旧版「进入即录屏、隐藏全部 UI」的实现不同：

- **界面**：进入后侧边栏控件**全部保留**，仅通过 CSS 隐藏 Leaflet 控件容器（缩放按钮/归属等，`body.recording-mode .leaflet-control-container`），侧边「录制」区显示比例切换（16:9/4:3）与录制面板。`#map-area` 用 flex 居中，`#map-container` 用 `aspect-ratio` + `max-width` 实现横向顶满、上下留空；时间戳 `#timestamp` 是 `#map-container` 的**后代元素**（绝对定位右上角、`pointer-events:none`），因此一定在录制范围内。
- **比例切换**（仅非录制状态可用）：只改 `#map-container` 尺寸，**不调 `fitBounds`**，地图中心点与缩放级别不变，切换后 `map.invalidateSize()` 重算。
- **获取录制区域**（`acquireRegion()`）：`getDisplayMedia({ video: { frameRate: 30 }, selfBrowserSurface: 'include', preferCurrentTab: true, audio: false })`。若浏览器支持 `RestrictionTarget`（Edge/Chrome 132+）则 `RestrictionTarget.fromElement(mapContainer)` + `track.restrictTo()` 把采集**裁剪到地图区域**；不支持或裁剪失败（含用户选错源）则**降级保留未裁剪的原始 stream**，提示「将录制整个标签页，请后期手动裁剪」，仍进入 REGION_READY。用户取消（`NotAllowedError`）则停留 RECORDING_MODE 可重试。
- **区域有效期**：获取区域后无时间限制，可随时开始/再次录制；仅当用户在浏览器原生 UI 主动停止共享（track `ended` 事件）时才回收区域，提示重新获取。
- **录制**：「开始录制」创建 `MediaRecorder(stream)` 并 `start(1000)`，**不自动播放回放**；编码仅 MP4/H.264，按 `video/mp4;codecs=avc1.42E01E`（H.264 Baseline）→ `video/mp4;codecs=avc1` → `video/mp4` 优先级探测（Chrome/Edge 107+ 支持），均不支持时拒绝启动并提示（不回退 WebM/VP9），码率 8Mbps，文件名固定 `replay-{sessionId}-{yyyyMMdd-HHmmss}.mp4`，Blob 容器固定 `video/mp4`。开录前会校验 stream 的 video track 仍为 `live`（已被浏览器原生停止共享的流直接录会得到 0KB 文件，此时提示重新获取）。「停止录制」合成 Blob 自动下载，回放继续播放不暂停，stream 保留，可再次录制无需重新获取。REGION_READY 下重取区域会先释放旧 stream 再完整重走流程；RECORDING 下「获取录制区域」与比例切换均禁用。
- **画面保活与 0KB 防护**：捕获源为「当前标签页」时，页面完全静止（回放暂停且无交互）或切到后台都会**停止产出视频帧**，导致 MediaRecorder 收不到数据、合成出 0KB 文件。对此有三层机制：① **保活**——录制期间用 `#map-container` 内 1×1 不可见元素（`#record-keepalive`，`pointer-events:none`）每 200ms 切换 opacity 触发页面重绘，使画面静止时也持续产帧；② **后台警告**——录制中页面切到后台（`visibilitychange`）时状态行警告「当前标签页录制将无画面」；③ **空数据防护**——`onstop` 时若整个录制期未收到任何数据，**不下载 0KB 文件**，改为提示「未捕获到视频数据。请保持本标签页在前台且画面有变化，或重新获取区域时选择『整个屏幕』作为录制源」，区域保留可重试；诊断信息（UA、编码支持情况、分片数字节数）记录在 `Recorder.diag` 并输出 `console.error` 便于排查。
- **退出**：退出录制模式时若正在录制先停止并下载（`Recorder.stop()` 返回 Promise，await 到下载完成），然后释放 stream、恢复默认视图（Leaflet 控件重现、比例回 16:9、面板隐藏）。Esc 同样可退出。

实现：`frontend/public/js/recorder.js`（MediaRecorder 编码与下载，stream 由外部注入）+ `frontend/public/js/replay.js` 录制段落（状态机与 UI）。nginx 对 `.html` 入口不缓存、`.js/.css` 设 5 分钟 `must-revalidate`，保证前端更新后用户即时生效（避免旧 JS 缓存）。

## 数据库导入导出

- **导出**：`GET /api/database/export` 生成全库**数据快照**（`COPY ... FROM stdin` 格式的 SQL 文本，文件名为 `mc-activity-db-<UTC时间>.sql`），包含全部 5 张表的行数据与序列当前值。
- **导入**：`POST /api/database/import` 上传快照文件，后端将**删除并重建数据库**（DROP/CREATE DATABASE）、按 `init.sql` 重建表结构（hypertable / 压缩策略）、TRUNCATE 后通过 psql 执行快照。导入前请确保未在记录中（采集中会拒绝导入）。
- **一键清空**：`POST /api/database/wipe` 彻底重置系统——TRUNCATE 全部 5 张表（`sessions` 重置自增 ID）后由 `db.EnsureSchema` 重新种子默认配置（含 `mirror_url` 等新键，避免旧配置项冲突）与初始管理员密码，并清空采集器内存快照。控制台「一键清空数据库」按钮即调用该端点（双重确认，不可恢复，录制中拒绝）。

> 实现说明：TimescaleDB 的 hypertable 数据存放在内部 schema 的分片表中，`pg_dump --data-only` 对父表 COPY 输出为 0 行，且 `pg_dump --clean` 的 DDL 无法直接恢复到 hypertable 上。因此导出改为通过服务端 `COPY (SELECT ...) TO STDOUT` 经父表读出全部行；导入采用"删库重建 + 结构迁移 + 快照回放"策略（见 `backend/api/export.go` 与 `backend/db/db.go`）。

## 单次会话导入（JSON/CSV）

`POST /api/sessions/import` 以 `multipart/form-data`（字段名 `file`）上传**一次会话**的数据，追加导入、不清空现有数据。按扩展名/Content-Type 分流：

- **JSON**（`GET /api/sessions/:id/export` 的产物，`version=1`）：完整还原会话元数据、全部玩家轨迹点与状态变化（MTR 乘坐字段含 `routeStationId1/2` 起终点 + 血量/护甲）。
- **CSV**（`GET /api/sessions/:id/export?format=csv` 的产物，宽表 `time,player_uuid,player_name,x,z,yaw,station_id,route_id`）：每行一个数据点，`time` 为 RFC3339（可带小数秒，亚秒精度保证同一秒内多点与状态变化的顺序，导入往返无损），`station_id/route_id` 为该时刻最新乘坐状态（由导出端 LATERAL 关联生成，空表示未乘车）。导入时（见 `parseSessionCSV`）：
  - 按 `player_uuid` 分组还原每玩家轨迹点序列（保持时间排序）；
  - 连续相同的 `(station_id, route_id)` 按「状态变化才记录」去重为 `player_state` 行，与采集器语义一致；
  - 会话元数据推导：名称 `导入_<文件名>`、起止时间取首末点、轮询间隔取相邻点间隔中位数（钳制 50ms–600s），`mtr_url/squaremap_url` 取当前配置，世界名与瓦片 URL 模板取系统默认值；
  - 已知限制：CSV 宽表不携带 `routeStationId1/2`，导入后回放工具提示的线路起止方向（`A → B`）不显示，仅显示线路名。

导入成功后返回 `{ok, sessionId, name}`，前端刷新会话列表。

## 构建说明

- `docker compose up -d --build` 默认使用 `GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct`；国内网络可改为腾讯源加速：`docker compose build --build-arg GOPROXY=https://mirrors.tencent.com/go/,direct`
- 前端 `leaflet-trackplayer` 已本地托管于 `frontend/public/js/leaflet-trackplayer.js`（v2.0.3，UMD 构建）：jsdelivr 对 `.cjs` 文件返回 `application/node` MIME 类型，Chrome 严格模式会拒绝执行，故不依赖外网 CDN

## CI/CD：GitHub Actions 构建并推送到 GHCR

工作流位于 `.github/workflows/docker-publish.yml`，**仅支持手动触发**：

1. 将代码推送到 GitHub 仓库
2. 仓库页面进入 **Actions → Build and Push to GHCR → Run workflow**
3. 填写参数：
   - `version`（必填）：镜像版本号，如 `1.0.0`，只能包含字母、数字、点、下划线、连字符
   - `update_latest`（默认勾选）：是否同时更新 `latest` 标签
4. 运行完成后镜像推送到：
   - `ghcr.io/<你的GitHub名>/<仓库名>-backend:<version>`
   - `ghcr.io/<你的GitHub名>/<仓库名>-frontend:<version>`

说明：

- 使用仓库内置的 `GITHUB_TOKEN` 推送到 GHCR，无需额外配置 Secret（工作流已声明 `packages: write` 权限）
- 首次推送的软件包默认为私有，如需免登录拉取，请在 GitHub 仓库 → Packages 页面将可见性改为 Public
- 两个服务并行构建，使用 GitHub Actions 缓存加速；backend 构建时 CI 环境使用官方 Go 代理（`proxy.golang.org`）
- 推送的镜像为 `linux/amd64`（runner 架构）；如需 arm64 等架构可在工作流中扩展 QEMU + 多平台构建

## 注意事项

- UUID 统一以**无连字符小写**存储，MCHeads 请求时前端转换为带连字符格式
- 所有时间戳以 UTC（TIMESTAMPTZ）存储，前端展示时转本地时区
- 容器重启后，未正常停止的会话会被标记为异常终止（`stopped_reason = 'error'`）
- 合并会话时时间段重叠将直接拒绝
- 系统假设单世界（`minecraft_overworld`），不做跨维度轨迹处理
- 按需求不提供健康检查端点、不实现密码错误限流
- 数据库文件位于 `timescaledb/data/`，删除该目录将清空所有数据

## 技术栈

Go 1.22（Gin + pgx v5）· PostgreSQL 16 + TimescaleDB · 原生 HTML/CSS/JS · Leaflet 1.9.4 · leaflet-trackplayer 2.0.3 · Squaremap 瓦片 · MCHeads 头像 · nginx · Docker Compose
