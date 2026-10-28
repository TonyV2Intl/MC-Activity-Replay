/**
 * replay.js — 回放页核心逻辑
 *
 * 播放引擎设计（时间驱动）：
 *   leaflet-trackplayer 内部按 turf 距离推进（speed 单位为 km/h），
 *   无法直接按时间轴播放。本实现为每个玩家创建 speed=0 的 TrackPlayer
 *   （内部推进量为 0，动画循环永不自动前进），由本模块的 requestAnimationFrame
 *   循环按墙上时钟计算 currentTime，再换算为轨迹距离比例 e 后调用
 *   tp.setProgress(e) 驱动渲染：
 *     e = (cum[i] + alpha * seg[i]) / total
 *   其中 i 为 currentTime 所在的时间区间，alpha 为区间内插值系数。
 *   cum/seg 使用 L.latLng.distanceTo（haversine）计算，与插件内部 turf.distance
 *   的比例完全一致（两者仅地球半径常数不同，为等比缩放，比例不受影响）。
 *
 *   注意：setProgress 到终点后再回拖会触发插件的 startAction 内部循环，
 *   因此每帧渲染前先调用 tp.pause() 停掉内部循环，保证渲染完全由本引擎驱动。
 *
 * 方向旋转：插件自带的 markerRotation 使用 turf 方位角，与 Minecraft yaw 不符。
 *   本实现关闭插件旋转，自行按真实 yaw 插值计算旋转角：
 *     MC yaw 0° = 南(+z)，顺时针递增；地图上 +z 朝下、+x 朝右，+z 为屏幕下方。
 *     屏幕朝向角（自正北起算，顺时针）= 180° + yaw（归一化到 [0,360)）。
 */

/** 多玩家预设颜色数组（第一个玩家使用任务书指定的青色 #00e5ff） */
const PLAYER_COLORS = [
  '#00e5ff', '#ffb300', '#69f0ae', '#ff80ab',
  '#b388ff', '#ffd740', '#40c4ff', '#ccff90',
];

const CHUNK_SIZE = 2000;   // 与后端默认分页一致
const CHUNK_CONCURRENCY = 4; // 并行分块请求数

// 相邻两个数据点间方块距离超过该阈值判定为“跳跃段”（传送 / 跨区域重连），
// 开启虚线连接时用虚线绘制以区别于正常步行轨迹；阈值可调（默认 1000 格，
// localStorage 持久化，键：mc-replay.dashJumpBlocks）
const DEFAULT_DASH_JUMP_BLOCKS = 1000;
const MIN_DASH_JUMP_BLOCKS = 1;
const DASH_PATTERN = '12 9'; // 虚线段样式（屏幕像素单位，不随缩放变化）

// 方向箭头显示模式（localStorage 持久化，键：mc-replay.arrowMode）
const ARROW_MODES = ['all', 'notPassed', 'none']; // all=一直显示（默认）| notPassed=仅未走过的路径 | none=一直隐藏

// tooltip 栏目默认显示开关（localStorage 持久化，键：mc-replay.tipFields；血量/护甲默认不勾选）
const DEFAULT_TIP_FIELDS = { name: true, coords: true, point: true, speed: true, health: false, armor: false, station: true, route: true };

// 取消地图缩放等级限制时的缩放范围（Leaflet 支持负缩放；超出瓦片原生等级的部分为放大显示）
const UNLIMITED_ZOOM_MIN = -6;
const UNLIMITED_ZOOM_MAX = 20;

// 最多显示轨迹点数量：默认 600 ≈ 当前时刻前后各 5 分钟（按每秒 1 个数据点估算）。
// 勾选后仅绘制以当前时刻为中心、总数不超过该值的轨迹点，路线随播放动态伸缩
const DEFAULT_MAX_POINTS = 600;
const MIN_MAX_POINTS = 10;

// 录制模式地图区域高度（px）：0=自适应（横向顶满）；宽度 = 高度 × 画面比例
const MIN_RECORD_HEIGHT = 200;

// 选中玩家进度条高亮：相邻数据点时间差 ≥ 该倍数 × 会话轮询间隔即视为「数据断档」，
// 高亮在此处断开（默认 1s 轮询 → 间隔 5s 及以上断开），避免把长时间无数据的空档标成连续覆盖
const SELECT_BREAK_GAP_FACTOR = 5;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const replayPage = {
  /* ---------- 状态 ---------- */
  sessionId: null,
  session: null,
  map: null,
  tileLayer: null,

  players: [],              // [{uuid, name, pointCount}]
  tracks: new Map(),        // uuid -> track 对象
  loadingTracks: new Set(), // 正在加载中的 uuid（防止重复加载产生重复轨迹图层）
  colorIndex: 0,            // 颜色分配计数器

  t0: 0,                    // 回放时间范围（ms epoch）
  t1: 0,
  currentTime: 0,
  speed: 1,
  playing: false,
  rafId: null,
  lastFrameTs: null,
  scrubbing: false,         // 用户是否正在拖动进度条
  recordingMode: false,     // 是否处于录制模式（独立状态：侧边栏保留、隐藏 Leaflet 控件、显示录制面板）
  recordState: 'off',       // 录制状态机：off | RECORDING_MODE | REGION_READY | RECORDING
  recordStream: null,       // getDisplayMedia 获取的屏幕流（REGION_READY/RECORDING 期间保留，停止录制不释放）
  recordRatio: '16:9',      // 录制画面比例：16:9 | 4:3
  recordHeight: 0,          // 录制地图区域高度（px，0=自适应；宽度=高度×比例，localStorage 持久化）

  pointTimes: [],           // 所有已加载轨迹点的去重时间戳（步进用）

  followUuid: null,         // 画面中心跟随的玩家 uuid（null = 不跟随）
  selectedUuid: null,       // 列表中选中的玩家 uuid（null = 未选中）：进度条高亮其数据覆盖时间段（断档处断开）
  _selSegCache: null,       // 进度条选中高亮的分段缓存（key 命中即复用，见 selectionSegments）
  _selectAllToken: 0,       // 全选加载代际：取消全选时自增，用于中止排队中的加载
  tooltipPermanent: false,  // 玩家名字 tooltip 是否常显（false = 仅悬停显示）
  speedMode: '2',           // tooltip 速度推算模式：'2' = 最新两点，'3' = 三点平均
  tipFields: null,          // tooltip 栏目显示开关（名字/坐标/速度/血量/护甲/站点/线路）

  dashJump: true,           // 超过设定距离的跳跃段是否用虚线连接（localStorage 持久化）
  dashJumpBlocks: DEFAULT_DASH_JUMP_BLOCKS, // 跳跃段距离阈值（格，可调，默认 1000）
  hideJump: false,          // 是否完全不绘制跳跃段（与虚线共用阈值，默认关；localStorage 持久化）
  fixedAvatarRotation: false, // 地图头像是否固定朝向（不按 yaw 旋转；默认关）
  avatarOutline: false,     // 是否用玩家色给地图头像描边（默认关）
  arrowMode: 'all',         // 方向箭头显示模式：all=一直显示（默认）| notPassed=仅未走过 | none=一直隐藏
  hideNotPassed: false,     // 隐藏未走过的路线（localStorage 持久化，默认关）
  unlimitedZoom: false,     // 是否取消地图最小/最大缩放等级限制（localStorage 持久化，默认关）
  maxPointsEnabled: false,  // 是否限制最多显示轨迹点数量（localStorage 持久化，默认关）
  maxPoints: DEFAULT_MAX_POINTS, // 最多显示的轨迹点数量（默认 600 ≈ 前后各 5 分钟）
  playerColors: {},         // uuid -> '#rrggbb' 用户指定的轨迹颜色（localStorage 持久化）
  rebuilding: false,        // 正在本地重建轨迹（抑制 fitBounds 等副作用）

  tileProxy: false,         // 瓦片是否经服务器代理下载（localStorage 持久化）
  mirrorUrl: '',            // 瓦片镜像地址（来自系统配置 mirror_url，留空 = 用会话记录地址）

  // MTR 站线名称表（ID → 名称，来自 /api/network/names；加载失败时为 null）
  network: null,

  /* ---------- 初始化 ---------- */
  async init() {
    const params = new URLSearchParams(location.search);
    const id = parseInt(params.get('session') || '', 10);
    if (!id) {
      location.href = '/index.html';
      return;
    }
    this.sessionId = id;

    // 读取偏好（localStorage，跨会话保持）：常显名字 / 速度模式 / tooltip 栏目 /
    // 瓦片代理 / 虚线连接 / 最多显示轨迹点数量 / 玩家轨迹颜色
    try {
      this.tooltipPermanent = localStorage.getItem('mc-replay.tooltipPermanent') === '1';
      this.speedMode = localStorage.getItem('mc-replay.speedMode') || '2';
      this.tileProxy = localStorage.getItem('mc-replay.tileProxy') === '1';
      this.dashJump = localStorage.getItem('mc-replay.dashJump') !== '0';
      const savedDashBlocks = parseInt(localStorage.getItem('mc-replay.dashJumpBlocks') || '', 10);
      this.dashJumpBlocks = (savedDashBlocks >= MIN_DASH_JUMP_BLOCKS) ? savedDashBlocks : DEFAULT_DASH_JUMP_BLOCKS;
      this.hideNotPassed = localStorage.getItem('mc-replay.hideNotPassed') === '1';
      this.hideJump = localStorage.getItem('mc-replay.hideJump') === '1';
      this.fixedAvatarRotation = localStorage.getItem('mc-replay.fixedAvatarRotation') === '1';
      this.avatarOutline = localStorage.getItem('mc-replay.avatarOutline') === '1';
      const savedRecordHeight = parseInt(localStorage.getItem('mc-replay.recordHeight') || '', 10);
      this.recordHeight = (savedRecordHeight >= MIN_RECORD_HEIGHT) ? savedRecordHeight : 0;
      const savedArrowMode = localStorage.getItem('mc-replay.arrowMode');
      this.arrowMode = ARROW_MODES.includes(savedArrowMode) ? savedArrowMode : 'all';
      this.unlimitedZoom = localStorage.getItem('mc-replay.unlimitedZoom') === '1';
      this.maxPointsEnabled = localStorage.getItem('mc-replay.maxPointsEnabled') === '1';
      const savedMaxPoints = parseInt(localStorage.getItem('mc-replay.maxPoints') || '', 10);
      this.maxPoints = (savedMaxPoints >= MIN_MAX_POINTS) ? savedMaxPoints : DEFAULT_MAX_POINTS;
      const savedFields = JSON.parse(localStorage.getItem('mc-replay.tipFields') || 'null');
      this.tipFields = Object.assign({}, DEFAULT_TIP_FIELDS, savedFields || {});
      this.playerColors = JSON.parse(localStorage.getItem('mc-replay.playerColors') || '{}') || {};
    } catch (e) { /* 隐私模式等场景忽略 */ }
    if (!this.tipFields) this.tipFields = Object.assign({}, DEFAULT_TIP_FIELDS);
    if (!this.playerColors || typeof this.playerColors !== 'object') this.playerColors = {};

    try {
      this.session = await api('/sessions/' + id);
    } catch (e) {
      this.setLoadStatus('加载会话失败: ' + e.message);
      return;
    }
    document.title = '回放 — ' + (this.session.name || ('会话 ' + id));

    // 瓦片镜像地址（系统配置 mirror_url）：/config 为数据库读取、耗时极短，先于建图加载
    try {
      const cfg = await api('/config');
      this.mirrorUrl = (cfg.config && cfg.config.mirror_url || '').trim();
    } catch (e) { /* 忽略：无镜像时用会话记录地址 */ }

    this.initMap();
    this.bindControls();

    // MTR 站线名称表：后台加载不阻塞回放页渲染（上游响应约 2MB，
    // 慢速链路下可达数分钟）；就绪后刷新 tooltip，失败则回退为原始 ID。
    api('/network/names')
      .then((n) => {
        this.network = { stations: n.stations || {}, routes: n.routes || {} };
        if (this.map) this.render();
      })
      .catch(() => { /* 忽略：tooltip 回退为原始 ID */ });

    try {
      const data = await api('/sessions/' + id + '/players');
      this.players = data.players || [];
    } catch (e) {
      this.setLoadStatus('加载玩家列表失败: ' + e.message);
      return;
    }
    this.renderPlayerList();
    this.recomputeRange();
    this.render();
  },

  /** 初始化 Leaflet 地图与 Squaremap 瓦片图层 */
  initMap() {
    const s = this.session;
    // 瓦片缩放等级必须与数据库一致（latlngPerBlock 依赖 maxZoom）
    TileConfig.maxZoom = s.tile_zoom || 3;

    this.map = L.map('map', {
      crs: McMapCRS,
      minZoom: 0,
      maxZoom: TileConfig.maxZoom + (TileConfig.extraZoom || 2),
      zoomControl: true,
      attributionControl: false,
    }).setView(blockToLatLng(0, 0), Math.max(0, TileConfig.maxZoom));

    this.buildTileLayer();

    // 用户手动拖动地图时自动取消跟随（panTo 不触发 dragstart，不会自我取消）
    this.map.on('dragstart', () => {
      if (this.followUuid) this.setFollow(null);
    });

    window.addEventListener('resize', () => this.map && this.map.invalidateSize());
  },

  /* ---------- 瓦片来源（镜像 / 服务器代理） ---------- */

  /** 回放瓦片上游基址：镜像地址优先，否则会话记录时的 Squaremap 地址 */
  tileBase() {
    return String(this.mirrorUrl || this.session.squaremap_url || '').replace(/\/+$/, '');
  },

  /** 瓦片 URL 模板：代理模式走本系统 /api/tiles/（浏览器只访问本系统），否则用会话记录的模板 */
  tileTemplate() {
    return this.tileProxy
      ? '/api/tiles/{world}/{zoom}/{x}_{z}.png'
      : (this.session.tile_url_template || '/tiles/{world}/{zoom}/{x}_{z}.png');
  },

  /** 按当前来源（镜像/代理/原地址）重建瓦片图层 */
  buildTileLayer() {
    if (!this.map || !this.session) return;
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
      this.tileLayer = null;
    }
    // 代理模式走同源相对路径 /api/tiles/...（base 必须为空），直连模式用镜像/原地址基址
    const base = this.tileProxy ? '' : this.tileBase();
    this.tileLayer = createSquaremapTileLayer(
      base, this.tileTemplate(), this.session.world,
      this.session.tile_zoom || 3, TileConfig.extraZoom || 2);
    this.tileLayer.addTo(this.map);
    this.updateTileHint();
    // 新图层带默认层级限制，需按当前「取消缩放限制」偏好重新应用
    this.applyZoomLimits();
  },

  /** 切换「瓦片经服务器代理」（localStorage 持久化，切换后立即重建图层） */
  setTileProxy(on) {
    this.tileProxy = !!on;
    try {
      localStorage.setItem('mc-replay.tileProxy', this.tileProxy ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.buildTileLayer();
  },

  /**
   * 切换「取消地图缩放等级限制」（持久化到 localStorage）。
   * 地图与瓦片图层的 minZoom/maxZoom 都需放宽：地图选项决定用户可缩放到哪一级，
   * 图层选项超界时 GridLayer._setView 会将 tileZoom 置 undefined 导致整层不显示。
   */
  setUnlimitedZoom(on) {
    this.unlimitedZoom = !!on;
    try {
      localStorage.setItem('mc-replay.unlimitedZoom', this.unlimitedZoom ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.applyZoomLimits();
  },

  /** 按 unlimitedZoom 应用地图与瓦片图层的缩放等级范围（含提示文案刷新） */
  applyZoomLimits() {
    if (!this.map) return;
    const min = this.unlimitedZoom ? UNLIMITED_ZOOM_MIN : 0;
    const max = this.unlimitedZoom ? UNLIMITED_ZOOM_MAX : TileConfig.maxZoom + (TileConfig.extraZoom || 2);
    // setMinZoom/setMaxZoom 在当前缩放已超界时会自动纠正（Leaflet 内部处理）
    this.map.setMinZoom(min);
    this.map.setMaxZoom(max);
    if (this.tileLayer) {
      this.tileLayer.options.minZoom = min;
      this.tileLayer.options.maxZoom = max;
      // redraw 会按新的原生钳制重算 _tileZoom 并刷新瓦片（绕过 _setView 的层级检查）
      this.tileLayer.redraw();
    }
    this.updateZoomHint();
  },

  /** 刷新缩放限制提示文案（当前生效的范围） */
  updateZoomHint() {
    const el = document.getElementById('zoom-limit-hint');
    if (!el) return;
    if (this.unlimitedZoom) {
      el.textContent = '已取消限制（' + UNLIMITED_ZOOM_MIN + ' 至 ' + UNLIMITED_ZOOM_MAX +
        ' 级），超出瓦片原生等级的部分为放大显示';
    } else {
      el.textContent = '默认限制 0 至 ' + (TileConfig.maxZoom + (TileConfig.extraZoom || 2)) +
        ' 级（跟随会话瓦片配置）';
    }
  },

  /** 更新瓦片来源提示（代理开关/镜像地址变化时调用） */
  updateTileHint() {
    const el = document.getElementById('tile-source-hint');
    if (!el) return;
    const via = this.tileProxy ? '服务器代理' : '浏览器直连';
    let src;
    if (this.mirrorUrl) {
      src = '镜像 ' + this.mirrorUrl;
    } else if (this.tileProxy) {
      src = '上游 ' + (this.session.squaremap_url || '（未记录）');
    } else {
      src = '原地址 ' + (this.session.squaremap_url || '（未记录）');
    }
    el.textContent = '瓦片来源：' + via + ' · ' + src;
  },

  bindControls() {
    const bar = document.getElementById('progress-bar');
    // 进度条取值 0..1000（千分比，比 0..100 拖动更细腻）
    bar.addEventListener('input', () => {
      this.scrubbing = true;
      if (this.t1 > this.t0) {
        this.currentTime = this.t0 + (Number(bar.value) / 1000) * (this.t1 - this.t0);
        this.render();
      }
    });
    const endScrub = () => { this.scrubbing = false; };
    bar.addEventListener('change', endScrub);
    bar.addEventListener('pointerup', endScrub);

    // 单玩家时间段导出对话框
    const exportModal = document.getElementById('player-export-modal');
    if (exportModal) {
      document.getElementById('player-export-cancel').addEventListener('click', () => this.closePlayerExport());
      document.getElementById('player-export-ok').addEventListener('click', () => this.submitPlayerExport());
      exportModal.addEventListener('pointerdown', (e) => {
        if (e.target === exportModal) this.closePlayerExport(); // 点击遮罩关闭
      });
    }

    // 自定义播放倍数（选择「自定义…」后出现的输入框）
    const speedCustom = document.getElementById('speed-custom');
    if (speedCustom) {
      speedCustom.addEventListener('change', () => this.applyCustomSpeed());
      speedCustom.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.applyCustomSpeed();
          speedCustom.blur();
        }
      });
    }

    // 一键全选玩家
    const allPlayers = document.getElementById('check-all-players');
    if (allPlayers) {
      allPlayers.addEventListener('change', () => this.toggleAllPlayers(allPlayers.checked));
    }

    // 键盘快捷键：空格 播放/暂停，左右方向键 步进
    document.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); this.stepPrev(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); this.stepNext(); }
      else if (e.code === 'Escape' && this.recordingMode) { this.exitRecordingMode(); }
    });

    // 录制中页面切到后台：「当前标签页」捕获源将停止产帧（录出空视频），警告用户；
    // 同时把可见性变化同步给 Recorder，累计后台时长用于失败原因诊断
    document.addEventListener('visibilitychange', () => {
      Recorder.noteVisibility(document.hidden);
      if (this.recordState === 'RECORDING' && document.hidden) {
        this.setRecordStatus('警告：页面已切到后台，「当前标签页」录制不会产生画面，请立即切回本标签页');
      }
    });

    // 常显玩家名字开关（偏好持久化到 localStorage）
    const tipCb = document.getElementById('check-tooltip-permanent');
    if (tipCb) {
      tipCb.checked = this.tooltipPermanent;
      tipCb.addEventListener('change', () => this.setTooltipPermanent(tipCb.checked));
    }

    // 瓦片经服务器代理开关（偏好持久化到 localStorage，切换后重建瓦片图层）
    const proxyCb = document.getElementById('check-tile-proxy');
    if (proxyCb) {
      proxyCb.checked = this.tileProxy;
      proxyCb.addEventListener('change', () => this.setTileProxy(proxyCb.checked));
    }

    // 取消地图缩放等级限制（偏好持久化到 localStorage，切换后即时调整地图与瓦片图层层级范围）
    const zoomCb = document.getElementById('check-unlimited-zoom');
    if (zoomCb) {
      zoomCb.checked = this.unlimitedZoom;
      zoomCb.addEventListener('change', () => this.setUnlimitedZoom(zoomCb.checked));
    }

    // 跳跃段虚线连接开关与距离阈值（偏好持久化到 localStorage；
    // 开关只切换 dash 样式不重建轨迹，阈值变化才重建全部已加载轨迹）
    const dashCb = document.getElementById('check-dash-jump');
    if (dashCb) {
      dashCb.checked = this.dashJump;
      dashCb.addEventListener('change', () => this.setDashJump(dashCb.checked));
    }
    const dashInput = document.getElementById('input-dash-blocks');
    if (dashInput) {
      dashInput.addEventListener('change', () => this.setDashJumpBlocks(dashInput.value));
      this.syncDashBlocksInput();
    }

    // 隐藏跳跃段（与虚线共用阈值，偏好持久化到 localStorage，切换后重绘即时生效）
    const hideJumpCb = document.getElementById('check-hide-jump');
    if (hideJumpCb) {
      hideJumpCb.checked = this.hideJump;
      hideJumpCb.addEventListener('change', () => this.setHideJump(hideJumpCb.checked));
    }

    // 地图头像显示：固定朝向 / 玩家色描边（偏好持久化到 localStorage，切换后即时生效）
    const fixedRotCb = document.getElementById('check-fixed-avatar-rotation');
    if (fixedRotCb) {
      fixedRotCb.checked = this.fixedAvatarRotation;
      fixedRotCb.addEventListener('change', () => this.setFixedAvatarRotation(fixedRotCb.checked));
    }
    const outlineCb = document.getElementById('check-avatar-outline');
    if (outlineCb) {
      outlineCb.checked = this.avatarOutline;
      outlineCb.addEventListener('change', () => this.setAvatarOutline(outlineCb.checked));
    }

    // 方向箭头显示模式（偏好持久化到 localStorage，切换后重绘即时生效）
    const arrowRadios = document.querySelectorAll('input[name="arrow-mode"]');
    arrowRadios.forEach((r) => {
      r.checked = r.value === this.arrowMode;
      r.addEventListener('change', () => {
        if (r.checked) this.setArrowMode(r.value);
      });
    });

    // 隐藏未走过的路线（偏好持久化到 localStorage，切换后重绘即时生效）
    const hideNpCb = document.getElementById('check-hide-not-passed');
    if (hideNpCb) {
      hideNpCb.checked = this.hideNotPassed;
      hideNpCb.addEventListener('change', () => this.setHideNotPassed(hideNpCb.checked));
    }

    // 最多显示轨迹点数量（偏好持久化到 localStorage；切换/改值即时生效，无需重建轨迹）
    const maxCb = document.getElementById('check-max-points');
    if (maxCb) {
      maxCb.checked = this.maxPointsEnabled;
      maxCb.addEventListener('change', () => this.setMaxPointsEnabled(maxCb.checked));
    }
    const maxInput = document.getElementById('input-max-points');
    if (maxInput) {
      maxInput.value = this.maxPoints;
      maxInput.disabled = !this.maxPointsEnabled;
      maxInput.addEventListener('change', () => this.setMaxPoints(maxInput.value));
    }

    // 速度推算模式（持久化到 localStorage，切换后强制刷新所有 tooltip）
    const speedRadios = document.querySelectorAll('input[name="speed-mode"]');
    speedRadios.forEach((r) => {
      r.checked = r.value === this.speedMode;
      r.addEventListener('change', () => {
        if (r.checked) this.setSpeedMode(r.value);
      });
    });

    // tooltip 栏目显示开关（持久化到 localStorage，切换后强制刷新所有 tooltip）
    const tipFieldCbs = document.querySelectorAll('.tip-field');
    tipFieldCbs.forEach((cb) => {
      cb.checked = !!(this.tipFields || DEFAULT_TIP_FIELDS)[cb.value];
      cb.addEventListener('change', () => this.setTipField(cb.value, cb.checked));
    });

    // 录制模式：画面比例切换（仅非录制状态可用，切换只改容器尺寸）
    document.querySelectorAll('input[name="record-ratio"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) this.setRecordRatio(r.value);
      });
    });

    // 录制模式：地图区域高度（留空=自适应，宽度按比例计算；持久化到 localStorage）
    const recordHeightInput = document.getElementById('input-record-height');
    if (recordHeightInput) {
      recordHeightInput.addEventListener('change', () => this.setRecordHeight(recordHeightInput.value));
      // 失焦时按生效值回显（聚焦期间不写值，避免打断输入；如输入 50 会被提升为 200）
      recordHeightInput.addEventListener('blur', () => this.syncRecordHeightInput());
      this.syncRecordHeightInput();
    }

    // 录制状态变化（开始/停止录制）→ 刷新面板
    Recorder.onStateChange = (recording, err) => {
      this.stopRecordKeepAlive();
      this.stopRecordWatchdog();
      if (recording) {
        this.recordState = 'RECORDING';
      } else if (this.recordState === 'RECORDING') {
        // 录制结束：stream 仍有效 → 回到 REGION_READY 可再次录制；
        // stream 已被浏览器原生停止共享 → 回到 RECORDING_MODE 需重新获取
        const streamLive = this.recordStream &&
          this.recordStream.getVideoTracks().some(t => t.readyState === 'live');
        if (streamLive) {
          this.recordState = 'REGION_READY';
          this.setRecordStatus(err
            ? err + '（区域仍有效，排除上述原因后可再次录制）'
            : '已下载；可再次录制，无需重新获取');
        } else {
          this.recordState = 'RECORDING_MODE';
          this.recordStream = null;
          this.setRecordStatus(err || '录制源已结束，请重新获取区域');
        }
      }
      this.updateRecordPanel();
    };
  },

  /* ---------- 玩家列表 ---------- */
  renderPlayerList() {
    const box = document.getElementById('player-list');
    if (!this.players.length) {
      box.innerHTML = '<span class="hint">该会话没有轨迹数据</span>';
      return;
    }
    box.innerHTML = '';
    for (const p of this.players) {
      const label = document.createElement('label');
      label.className = 'player-item';
      label.dataset.uuid = p.uuid;
      // 悬停提示显示玩家名称（而非 UUID）
      label.title = p.name || p.uuid;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.uuid = p.uuid;
      cb.addEventListener('change', () => {
        this.togglePlayer(p.uuid, cb.checked);
        this.updateSelectAllState();
      });

      const img = document.createElement('img');
      img.src = avatarURL(p.uuid);
      img.alt = '';
      img.loading = 'lazy';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name || p.uuid.slice(0, 8);

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = fmtNum(p.point_count);

      // 每行只保留一个「⋯」按钮，颜色 / 跟随 / 选中 / 删除数据点 / 导出时段
      // 全部收进弹出菜单（见 openPlayerMenu）
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'player-menu-btn';
      more.dataset.uuid = p.uuid;
      more.textContent = '⋯';
      more.title = '更多操作：颜色 / 跟随 / 选中 / 删除当前数据点 / 导出时间段';
      more.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openPlayerMenu(p.uuid, more);
      });

      label.append(cb, img, name, count, more);
      box.appendChild(label);
    }
    this.updateFollowButtons();
    this.updateSelectionUI();
    this.updateSelectAllState();
  },

  /* ---------- 一键全选 ---------- */

  /**
   * 全选/取消全选玩家。
   *   勾选：先把所有复选框置为选中，再以 2 路并发加载轨迹（一次加载几十个
   *   玩家会同时打出大量分块请求）；_selectAllToken 用于取消时中止排队。
   *   取消：立即取消勾选并移除已加载轨迹；仍在途的 loadTrack 完成后会因
   *   复选框未选而自行 removeTrack（见 loadTrack 末尾的竞态检查）。
   * 全选框本身支持半选（indeterminate）表示部分玩家被选中。
   */
  async toggleAllPlayers(on) {
    const boxes = [...document.querySelectorAll('#player-list input[data-uuid]')];
    if (!boxes.length) return;
    const token = ++this._selectAllToken;

    if (!on) {
      for (const cb of boxes) {
        if (!cb.checked) continue;
        cb.checked = false;
        this.removeTrack(cb.dataset.uuid);
      }
      this.updateSelectAllState();
      return;
    }

    for (const cb of boxes) cb.checked = true;
    this.updateSelectAllState();

    const queue = boxes.map((cb) => cb.dataset.uuid)
      .filter((uuid) => !this.tracks.has(uuid) && !this.loadingTracks.has(uuid));
    if (!queue.length) return;
    this.setLoadStatus('正在加载 ' + queue.length + ' 名玩家的轨迹…');

    const worker = async () => {
      while (queue.length && token === this._selectAllToken) {
        const uuid = queue.shift();
        if (token !== this._selectAllToken) return; // 已取消全选
        if (this.tracks.has(uuid) || this.loadingTracks.has(uuid)) continue;
        try {
          await this.loadTrack(uuid);
        } catch (e) { /* 单个玩家失败不阻断其余加载 */ }
      }
    };
    await Promise.all([worker(), worker()]);
    if (token === this._selectAllToken) this.updateSelectAllState();
  },

  /** 同步全选框：全部选中=checked，部分选中=indeterminate，其余 unchecked */
  updateSelectAllState() {
    const all = document.getElementById('check-all-players');
    if (!all) return;
    const boxes = [...document.querySelectorAll('#player-list input[data-uuid]')];
    const picked = boxes.filter((cb) => cb.checked).length;
    all.checked = boxes.length > 0 && picked === boxes.length;
    all.indeterminate = picked > 0 && picked < boxes.length;
  },

  /* ---------- 玩家行操作菜单 ---------- */

  /** 打开玩家操作菜单（挂到 body，避免被玩家列表的滚动容器裁剪） */
  openPlayerMenu(uuid, anchor) {
    this.closePlayerMenu();
    const p = this.players.find((x) => x.uuid === uuid);
    const track = this.tracks.get(uuid);

    const menu = document.createElement('div');
    menu.className = 'player-menu';
    menu.id = 'player-menu';
    menu.dataset.uuid = uuid;

    // 颜色：色板 + 「自动」恢复按加载顺序分配
    const colorRow = document.createElement('div');
    colorRow.className = 'menu-row';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = '颜色';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'player-color';
    colorInput.dataset.uuid = uuid;
    colorInput.value = (track && track.color) || this.playerColors[uuid] || PLAYER_COLORS[0];
    colorInput.title = '指定该玩家轨迹颜色（默认按加载顺序自动分配）';
    colorInput.addEventListener('change', () => this.setPlayerColor(uuid, colorInput.value));
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'color-auto';
    autoBtn.textContent = '自动';
    autoBtn.title = '清除指定颜色，恢复自动分配';
    autoBtn.style.display = this.playerColors[uuid] ? '' : 'none';
    autoBtn.addEventListener('click', () => this.clearPlayerColor(uuid));
    colorRow.append(colorLabel, colorInput, autoBtn);

    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.className = 'menu-item follow-btn';
    followBtn.dataset.uuid = uuid;
    const following = this.followUuid === uuid;
    followBtn.textContent = following ? '取消跟随' : '跟随';
    followBtn.classList.toggle('active', following);
    followBtn.addEventListener('click', () => this.toggleFollow(uuid));

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'menu-item select-btn';
    selectBtn.dataset.uuid = uuid;
    const selected = this.selectedUuid === uuid;
    selectBtn.textContent = selected ? '取消选中' : '选中';
    selectBtn.classList.toggle('active', selected);
    selectBtn.title = '选中后在进度条上高亮该玩家数据覆盖的时间段';
    selectBtn.addEventListener('click', () => this.setSelected(uuid));

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'menu-item';
    exportBtn.textContent = '导出时间段…';
    exportBtn.title = '选择起止时间，导出该玩家的 JSON / CSV';
    exportBtn.addEventListener('click', () => this.openPlayerExport(uuid));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'menu-item danger';
    delBtn.textContent = '删除当前数据点';
    delBtn.title = '删除该玩家在当前回放时刻所处的数据点（不可恢复）';
    delBtn.addEventListener('click', () => this.deleteCurrentPoint(uuid));

    menu.append(colorRow, followBtn, selectBtn, exportBtn, delBtn);
    document.body.appendChild(menu);

    // 定位：优先在按钮右侧（地图方向）展开，避免遮挡玩家列表；右侧空间不足
    // 时回退到左侧；垂直与按钮顶部对齐，超出视口则上移
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 180;
    let left = r.right + 6;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 6);
    let top = r.top;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // 点击菜单外或按 Esc 关闭（延迟注册，避免同一次点击立刻把它关掉）
    this._menuOutside = (ev) => {
      if (!menu.contains(ev.target)) this.closePlayerMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', this._menuOutside, true), 0);
    this._menuEsc = (ev) => { if (ev.key === 'Escape') this.closePlayerMenu(); };
    document.addEventListener('keydown', this._menuEsc);
  },

  closePlayerMenu() {
    const menu = document.getElementById('player-menu');
    if (menu) menu.remove();
    if (this._menuOutside) {
      document.removeEventListener('pointerdown', this._menuOutside, true);
      this._menuOutside = null;
    }
    if (this._menuEsc) {
      document.removeEventListener('keydown', this._menuEsc);
      this._menuEsc = null;
    }
  },

  setLoadStatus(msg) {
    const el = document.getElementById('player-load-status');
    if (el) el.textContent = msg || '';
  },

  /** 勾选/取消勾选玩家 */
  async togglePlayer(uuid, checked) {
    if (checked) {
      if (this.tracks.has(uuid) || this.loadingTracks.has(uuid)) return;
      try {
        await this.loadTrack(uuid);
      } catch (e) {
        this.setLoadStatus('加载轨迹失败: ' + e.message);
        // 恢复复选框状态
        const cb = document.querySelector(`#player-list input[data-uuid="${uuid}"]`);
        if (cb) cb.checked = false;
      }
    } else {
      this.removeTrack(uuid);
    }
  },

  /* ---------- 画面跟随 ---------- */

  /**
   * 确保玩家轨迹已加载：未勾选则勾选并加载。
   * 供「跟随」「选中」共用（两者都需要轨迹才能定位/取色）。
   * 返回是否已就绪。
   */
  async ensureTrack(uuid) {
    if (this.tracks.has(uuid)) return true;
    if (this.loadingTracks.has(uuid)) return false;
    const cb = document.querySelector(`#player-list input[data-uuid="${uuid}"]`);
    if (cb && !cb.checked) cb.checked = true;
    try {
      await this.loadTrack(uuid);
    } catch (e) {
      this.setLoadStatus('加载轨迹失败: ' + e.message);
      if (cb) cb.checked = false;
      return false;
    }
    return this.tracks.has(uuid);
  },

  /**
   * 切换画面跟随目标。
   * 再次点击同一玩家 = 取消跟随；点击其他玩家 = 切换跟随目标。
   * 目标轨迹尚未加载时自动勾选并加载，加载完成后才生效。
   */
  async toggleFollow(uuid) {
    if (this.followUuid === uuid) {
      this.setFollow(null);
      return;
    }
    if (!this.tracks.has(uuid)) {
      const ok = await this.ensureTrack(uuid);
      if (!ok) return;                          // 加载失败或被用户取消勾选
      if (this.followUuid) return;               // 加载期间用户已切换到其他玩家
    }
    this.setFollow(uuid);
  },

  /** 设置跟随目标并刷新按钮高亮；非 null 时立即居中一次 */
  setFollow(uuid) {
    this.followUuid = uuid;
    this.updateFollowButtons();
    if (uuid) this.render();
  },

  /** 同步所有跟随按钮的高亮与文案（按钮仅在玩家操作菜单中出现） */
  updateFollowButtons() {
    const btns = document.querySelectorAll('#player-list .follow-btn, #player-menu .follow-btn');
    for (const btn of btns) {
      const on = btn.dataset.uuid === this.followUuid;
      btn.classList.toggle('active', on);
      if (btn.classList.contains('menu-item')) btn.textContent = on ? '取消跟随' : '跟随';
    }
  },

  /* ---------- 选中玩家（进度条时间段高亮） ---------- */

  /**
   * 切换选中玩家。再次点击同一玩家 = 取消选中。
   * 选中需要该玩家已加载轨迹（用于取颜色与数据起止时间），未加载则先加载；
   * _selecting 防止加载期间重复点击造成并发加载。
   */
  async setSelected(uuid) {
    if (this._selecting) return;
    if (this.selectedUuid === uuid) {
      this.selectedUuid = null;
      this.updateSelectionUI();
      this.renderTimeline();
      this.closePlayerMenu();
      return;
    }
    this.closePlayerMenu();
    this._selecting = true;
    try {
      if (!this.tracks.has(uuid) && !(await this.ensureTrack(uuid))) {
        this.setLoadStatus('选中失败：该玩家轨迹未能加载');
        return;
      }
      this.selectedUuid = uuid;
      this.updateSelectionUI();
      this.renderTimeline();
    } finally {
      this._selecting = false;
    }
  },

  /** 同步玩家行的选中态与选中按钮文案（选中/取消选中） */
  updateSelectionUI() {
    document.querySelectorAll('#player-list .player-item').forEach((el) => {
      el.classList.toggle('selected', el.dataset.uuid === this.selectedUuid);
    });
    document.querySelectorAll('#player-menu .select-btn').forEach((btn) => {
      const on = btn.dataset.uuid === this.selectedUuid;
      btn.classList.toggle('active', on);
      btn.textContent = on ? '取消选中' : '选中';
    });
  },

  /* ---------- 删除当前数据点 ---------- */

  /**
   * 删除该玩家在当前回放时刻所处的数据点（需已加载轨迹）。
   * 「当前点」= 当前时刻之前最后一个数据点；早于首点时即首点、晚于末点时即末点。
   * 后端按采集时间删除（毫秒窗口，兼容前端时间精度截断），成功后本地同步移除
   * 原始点并重建轨迹（保持颜色与跟随/选中状态），无需重新拉取整条轨迹。
   */
  async deleteCurrentPoint(uuid) {
    const track = this.tracks.get(uuid);
    if (!track || !track.rawPoints || !track.rawPoints.length) {
      this.setLoadStatus('请先勾选加载该玩家轨迹，再删除数据点');
      return;
    }
    const n = track.times.length;
    const loc = this.locate(track, this.currentTime);
    const idx = loc.after ? n - 1 : loc.i;
    const t = track.times[idx];
    const bx = Math.round(track.xs[idx]);
    const bz = Math.round(track.zs[idx]);
    if (!confirm('删除 ' + track.name + ' 在 ' + fmtTime(new Date(t)) + ' 的数据点？\n' +
      '坐标: ' + bx + ', ' + bz + '（第 ' + (idx + 1) + '/' + n + ' 点）\n\n此操作不可恢复。')) {
      return;
    }
    this.closePlayerMenu();
    try {
      await api('/sessions/' + this.sessionId + '/players/' + encodeURIComponent(uuid) +
        '/points?time=' + encodeURIComponent(new Date(t).toISOString()), { method: 'DELETE' });
    } catch (e) {
      this.setLoadStatus('删除失败: ' + e.message);
      return;
    }

    // 本地同步：从原始点缓存移除该点后重建轨迹
    track.rawPoints.splice(idx, 1);
    const remain = track.rawPoints.length;
    const p = this.players.find((x) => x.uuid === uuid);
    if (p) p.point_count = remain;
    const countEl = document.querySelector('#player-list .player-item[data-uuid="' + uuid + '"] .count');
    if (countEl) countEl.textContent = fmtNum(remain);

    if (remain === 0) {
      const cb = document.querySelector('#player-list input[data-uuid="' + uuid + '"]');
      if (cb) cb.checked = false;
      this.removeTrack(uuid);
      this.updateSelectAllState();
      this.setLoadStatus('已删除最后一个数据点，该玩家已从地图移除');
    } else {
      this.rebuildTrack(uuid);
      this.setLoadStatus('已删除 1 个数据点，' + track.name + ' 剩余 ' + fmtNum(remain) + ' 点');
    }
  },

  /* ---------- 单玩家时间段导出 ---------- */

  /** 打开时间段导出对话框，默认填入该玩家轨迹的首末数据点时间 */
  openPlayerExport(uuid) {
    const track = this.tracks.get(uuid);
    const p = this.players.find((x) => x.uuid === uuid);
    this._exportUuid = uuid;

    document.getElementById('player-export-title').textContent =
      '导出 ' + (p ? (p.name || uuid.slice(0, 8)) : uuid) + ' 的时间段';
    let a = this.t0;
    let b = this.t1;
    if (track && track.times.length) {
      a = track.times[0];
      b = track.times[track.times.length - 1];
    }
    document.getElementById('player-export-start').value = toDatetimeLocal(a);
    document.getElementById('player-export-end').value = toDatetimeLocal(b);
    document.getElementById('player-export-hint').textContent =
      '按浏览器本地时区；结束时间包含该秒内的数据点';
    document.getElementById('player-export-modal').hidden = false;
    this.closePlayerMenu();
  },

  closePlayerExport() {
    const m = document.getElementById('player-export-modal');
    if (m) m.hidden = true;
    this._exportUuid = null;
  },

  /** 提交导出：起止时间转 UTC 后交给导出 API（JSON / CSV） */
  submitPlayerExport() {
    const uuid = this._exportUuid;
    if (!uuid) return;
    const sEl = document.getElementById('player-export-start');
    const eEl = document.getElementById('player-export-end');
    const st = new Date(sEl.value).getTime();
    let et = new Date(eEl.value).getTime();
    if (!sEl.value || !eEl.value || !isFinite(st) || !isFinite(et)) {
      alert('请填写有效的开始与结束时间');
      return;
    }
    if (et < st) {
      alert('结束时间不能早于开始时间');
      return;
    }
    et += 999; // datetime-local 精确到秒：让所选结束时刻包含该秒内的数据点
    const fmt = document.querySelector('input[name="player-export-format"]:checked').value;
    const url = '/api/sessions/' + this.sessionId + '/players/' + encodeURIComponent(uuid) +
      '/export?format=' + fmt +
      '&start=' + encodeURIComponent(new Date(st).toISOString()) +
      '&end=' + encodeURIComponent(new Date(et).toISOString());
    this.closePlayerExport();
    location.href = url; // 响应为附件，触发浏览器下载
  },

  /* ---------- 玩家名 tooltip ---------- */

  /**
   * 绑定/刷新头像标记的玩家名 tooltip。
   * permanent 行为由 Leaflet 在 bindTooltip 时决定（常显则立即打开，
   * 否则绑定 mouseover/mouseout），因此切换时常显需先 unbind 再重新 bind。
   */
  bindPlayerTooltip(marker, track) {
    if (!marker) return;
    if (marker.getTooltip()) marker.unbindTooltip();
    const html = this.tooltipHTML(track, marker);
    marker.bindTooltip(html, {
      permanent: this.tooltipPermanent,
      direction: 'top',
      offset: [0, -20],
      className: 'player-tooltip',
      opacity: 1,
    });
    if (this.tooltipPermanent) marker.openTooltip();
  },

  /** 切换「常显玩家名字」（持久化到 localStorage，并刷新所有已加载轨迹） */
  setTooltipPermanent(on) {
    this.tooltipPermanent = !!on;
    try {
      localStorage.setItem('mc-replay.tooltipPermanent', this.tooltipPermanent ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) {
      this.bindPlayerTooltip(track.tp ? track.tp.marker : track.marker, track);
    }
  },

  /** 切换速度推算模式（持久化到 localStorage，强制所有 tooltip 重算） */
  setSpeedMode(mode) {
    this.speedMode = mode;
    try {
      localStorage.setItem('mc-replay.speedMode', mode);
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) track.tipHTML = null; // 内容强制重算
    this.render();
  },

  /**
   * 当前时刻的移动速度（格/s）。
   * '2' = 当前区间 [i, i+1] 两点位移/时差；'3' = 前三 [i-1, i+1] 点总位移/总时差（平均速度）。
   * 复用共享 calcSpeed；点数不足（单点轨迹/区间起点）时自动退化为两点模式。
   */
  speedAtTrack(track) {
    const xs = track.xs, zs = track.zs, times = track.times;
    if (!xs || xs.length < 2) return null;
    const loc = this.locate(track, this.currentTime);
    const i = loc.i;
    const j = Math.min(i + 1, xs.length - 1);
    if (j <= i) return null;
    const pts = [
      { x: xs[i], z: zs[i], t: times[i] },
      { x: xs[j], z: zs[j], t: times[j] },
    ];
    if (this.speedMode === '3' && i >= 1) {
      pts.unshift({ x: xs[i - 1], z: zs[i - 1], t: times[i - 1] });
    }
    return calcSpeed(pts, this.speedMode);
  },

  /**
   * 二分查找时间 t 时玩家的 MTR 乘坐状态（最后一个 ≤ t 的记录）。
   * t 早于首条记录时返回 null（无状态信息）。
   */
  stateAt(track, t) {
    const times = track.stateTimes;
    if (!times.length || t < times[0]) return null;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return track.stateRecs[lo];
  },

  /**
   * 组装 tooltip 内容：玩家名（专属颜色）+ 当前点位序号 + 当前坐标 + 当前时刻的血量/护甲与站点/线路名称。
   * 各栏目由 tipFields 开关控制（名字/坐标/点位/速度/血量/护甲/站点/线路），偏好持久化在 localStorage。
   * 坐标由 marker 当前渲染位置经 latLngToBlock 逆换算为方块坐标（取整显示）；
   * 点位为「当前数据点序号/总点数」（1-based）；血量/护甲未采集时不显示；仅显示站名/线路名（不显示 ID）；
   * 名称表未加载/未收录时回退为原始 ID。
   * @param {object} track  track 对象
   * @param {L.Marker} [marker] 头像标记（取其当前位置换算坐标）
   */
  tooltipHTML(track, marker) {
    const f = this.tipFields || DEFAULT_TIP_FIELDS;
    let html = '';
    if (f.name) {
      html += '<span style="color:' + track.color + '">' + esc(track.name) + '</span>';
    }
    // 当前数据点序号 / 总点数（1-based，形如 245/2705）：
    // 取当前时刻最后一个 ≤ t 的点；早于首点显示 1，晚于末点显示总点数
    if (f.point) {
      const loc = this.locate(track, this.currentTime);
      const n = track.times.length;
      const cur = loc.after ? n : Math.min(n, loc.i + 1);
      html += '<br><span class="tip-sub">点位: ' + cur + '/' + n + '</span>';
    }
    if (f.coords && marker) {
      const b = latLngToBlock(marker.getLatLng());
      html += '<br><span class="tip-sub">坐标: ' + Math.round(b.x) + ', ' + Math.round(b.z) + '</span>';
    }
    // 速度推算（格/s）
    if (f.speed) {
      const v = this.speedAtTrack(track);
      if (v != null && isFinite(v)) {
        html += '<br><span class="tip-sub">速度: ' + v.toFixed(1) + ' 格/s</span>';
      }
    }
    if (f.station || f.route || f.health || f.armor) {
      const rec = this.stateAt(track, this.currentTime);
      if (rec) {
        // 生命值/护甲（未采集的字段为 null，不显示）
        if (f.health && rec.health != null) {
          html += '<br><span class="tip-sub">血量: ' + rec.health + '</span>';
        }
        if (f.armor && rec.armor != null) {
          html += '<br><span class="tip-sub">护甲: ' + rec.armor + '</span>';
        }
        const r = resolveTransit(rec, this.network);
        if (f.station && r.stationName) {
          html += '<br><span class="tip-sub">站点: ' + esc(r.stationName) + '</span>';
        }
        if (f.route && r.routeName) {
          let line = '线路: ' + esc(r.routeName);
          if (r.fromName && r.toName) line += ' ' + esc(r.fromName) + ' → ' + esc(r.toName);
          html += '<br><span class="tip-sub">' + line + '</span>';
        }
      }
    }
    return html || '<span class="tip-sub">（tooltip 栏目已全部关闭）</span>';
  },

  /** 切换 tooltip 栏目显示（持久化到 localStorage，强制所有 tooltip 重算） */
  setTipField(field, on) {
    if (!this.tipFields) this.tipFields = Object.assign({}, DEFAULT_TIP_FIELDS);
    this.tipFields[field] = !!on;
    try {
      localStorage.setItem('mc-replay.tipFields', JSON.stringify(this.tipFields));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) track.tipHTML = null; // 内容强制重算
    this.render();
  },

  /**
   * 加载单个玩家完整轨迹（分块并行请求）。
   * 返回后若复选框已取消（竞态），立即移除。
   * loadingTracks 守卫防止并发重复加载（重复加载会产生两份轨迹图层，
   * 且后建的会覆盖 tracks 中的条目导致旧图层泄漏）。
   */
  async loadTrack(uuid) {
    if (this.tracks.has(uuid) || this.loadingTracks.has(uuid)) return;
    this.loadingTracks.add(uuid);
    try {
      const meta = await api(`/sessions/${this.sessionId}/players/${uuid}/trajectory?chunk=0&chunkSize=${CHUNK_SIZE}`);
      const name = meta.name || uuid.slice(0, 8);
      const totalChunks = Math.max(1, meta.totalChunks || 1);
      const chunks = new Array(totalChunks);
      chunks[0] = meta.points || [];

      let next = 1;
      const worker = async () => {
        while (next < totalChunks) {
          const c = next++;
          this.setLoadStatus(`加载 ${name} 轨迹… 分块 ${c + 1}/${totalChunks}`);
          const data = await api(`/sessions/${this.sessionId}/players/${uuid}/trajectory?chunk=${c}&chunkSize=${CHUNK_SIZE}`);
          chunks[c] = data.points || [];
        }
      };
      const workers = [];
      for (let i = 0; i < Math.min(CHUNK_CONCURRENCY, totalChunks - 1); i++) workers.push(worker());
      await Promise.all(workers);

      // 按分块顺序拼接（各块内部已按时间升序）
      const points = [];
      for (const c of chunks) if (c) points.push(...c);
      this.setLoadStatus(`${name} 轨迹加载完成（${fmtNum(points.length)} 点）`);

      this.buildTrack(uuid, name, points);
      this.recomputeRange();
      this.syncColorInputs();

      // 加载期间用户可能已取消勾选
      const cb = document.querySelector(`#player-list input[data-uuid="${uuid}"]`);
      if (cb && !cb.checked) {
        this.removeTrack(uuid);
        return;
      }

      // 加载玩家状态变化记录（失败不影响轨迹回放，tooltip 回退为仅玩家名）
      try {
        const data = await api(`/sessions/${this.sessionId}/players/${uuid}/state`);
        // MTR 会用全零 ID 表示“无”（如 route_id = 0000000000000000），统一归一化为空
        const recs = (data.records || []).map((r) => ({
          t: new Date(r.time).getTime(),
          station: normTransitId(r.station_id),
          route: normTransitId(r.route_id),
          rs1: normTransitId(r.route_station_id1),
          rs2: normTransitId(r.route_station_id2),
          health: (r.health == null) ? null : Number(r.health),
          armor: (r.armor == null) ? null : Number(r.armor),
        }));
        const track = this.tracks.get(uuid);
        if (track) {
          track.stateTimes = recs.map((r) => r.t);
          track.stateRecs = recs;
          this.render();
        }
      } catch (e) { /* 忽略 */ }
    } finally {
      this.loadingTracks.delete(uuid);
    }
  },

  /** 由原始点构建 TrackPlayer（<2 个点退化为普通标记）。
   * @param {string} keepColor 重建时传入原轨迹颜色，保持视觉连续（新加载时不传） */
  buildTrack(uuid, name, points, keepColor) {
    if (!points.length) return;
    const n = points.length;
    const times = new Array(n);
    const latlngs = new Array(n);
    const yaws = new Array(n);
    const xs = new Array(n);
    const zs = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      times[i] = new Date(p.time).getTime();
      xs[i] = Number(p.x);
      zs[i] = Number(p.z);
      latlngs[i] = blockToLatLng(p.x, p.z);
      yaws[i] = (p.yaw == null) ? null : Number(p.yaw);
    }

    // 段长与累积距离（haversine，比例与插件内部 turf.distance 一致）
    const seg = new Array(n > 1 ? n - 1 : 0);
    const cum = new Array(n);
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
      seg[i - 1] = latlngs[i - 1].distanceTo(latlngs[i]);
      cum[i] = cum[i - 1] + seg[i - 1];
    }
    const total = cum[n - 1];

    // 段属性：相邻两点方块距离超过阈值判定为跳跃段（传送/重连）。
    // runs 始终按该属性分组（与虚线开关无关），开关只决定是否给跳跃 run
    // 加 dashArray 样式——这样切换开关无需重建轨迹图层，避免多轨迹时卡顿
    const dashed = new Array(n > 1 ? n - 1 : 0);
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const dz = zs[i + 1] - zs[i];
      dashed[i] = Math.sqrt(dx * dx + dz * dz) > this.dashJumpBlocks;
    }
    // 连续同属性段合并为 run（减少 polyline 数量与每帧更新开销）；
    // run 覆盖点索引 [startIdx, endIdx]（含两端）
    const runs = [];
    if (n > 1) {
      let s = 0;
      for (let i = 1; i < n - 1; i++) {
        if (dashed[i] !== dashed[s]) {
          runs.push({ startIdx: s, endIdx: i, dash: dashed[s] });
          s = i;
        }
      }
      runs.push({ startIdx: s, endIdx: n - 1, dash: dashed[s] });
    }

    const color = this.resolveTrackColor(uuid, keepColor);

    const icon = L.icon({
      iconUrl: avatarURL(uuid),
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const track = {
      uuid, name, color, times, latlngs, yaws, xs, zs, seg, cum, total,
      rawPoints: points,      // 原始点缓存（切换虚线/颜色时本地重建，无需重新请求）
      rawName: name,
      tp: null, marker: null,
      runs,                   // 折线分组 [{startIdx, endIdx, dash, latlngs, cumStart, cumEnd,
                             //   passedLine, notPassedLine, state, splitSeg, splitAlpha}]
      stateTimes: [],   // 玩家状态变化时间戳（ms，升序）
      stateRecs: [],    // 对应的状态记录 {t, station, route, rs1, rs2, health, armor}
      tipHTML: null,      // 工具提当前内容（变化检测用）
    };

    if (n >= 2) {
      // speed=0：禁用插件内部按距离的自动推进，完全由本引擎按时间驱动
      track.tp = new L.TrackPlayer(latlngs, {
        speed: 0,
        weight: 4,
        markerIcon: icon,
        passedLineColor: color,
        notPassedLineColor: 'rgba(255,255,255,0.3)',
        panTo: false,
        markerRotation: false, // 使用真实 MC yaw 自行旋转
        progress: 0,
        polylineDecoratorOptions: {
          patterns: [{
            offset: 30, repeat: 60,
            symbol: L.Symbol.arrowHead({
              pixelSize: 5, headAngle: 75, polygon: false,
              pathOptions: { stroke: true, weight: 2, color: color },
            }),
          }],
        },
      }).addTo(this.map);
      if (track.tp.marker) {
        // 修正插件旋转的叠加缺陷：leaflet-trackplayer 的 _applyRotation 用
        // `transform += rotateZ(...)` 追加，而打包文件里插件被包含两次、每次定位
        // 会追加多次，同一角度被叠成多份（如 270°×4=1080°），计算矩阵退化为单位阵
        // ——头像实际从未按 yaw 旋转。这里换成幂等实现：先剥离历史 rotateZ，
        // 再追加当前角度（「固定头像朝向」时角度为 0，即完全不旋转）。
        const m = track.tp.marker;
        m._applyRotation = function () {
          const icon = this._icon;
          if (!icon) return;
          const base = icon.style.transform.replace(/\s*rotateZ\([^)]*\)/g, '');
          const a = this.options.rotationAngle;
          icon.style.transformOrigin = this.options.rotationOrigin || 'center';
          icon.style.transform = a ? base + ' rotateZ(' + a + 'deg)' : base;
        };
        m.options.rotationAngle = this.fixedAvatarRotation ? 0 : normalizeYawAngle(yaws[0]);
        m._applyRotation(); // 首帧前即应用，避免加载瞬间朝向错误
      }
      // 插件自带的 passed/notPassed 线整体隐藏（opacity:0；箭头装饰不受影响，
      // 仍沿 passed+notPassed 绘制），线条渲染交由下方按 run 分组的自建 polyline
      track.tp.passedLine.setStyle({ opacity: 0 });
      track.tp.notPassedLine.setStyle({ opacity: 0 });
      // 「一直隐藏」模式下加载瞬间即清空箭头（插件默认全轨迹铺箭头，
      // render() 每帧会按模式重设，这里保证首帧前即符合偏好）
      if (this.arrowMode === 'none') track.tp.polylineDecorator.setPaths([]);

      // 每个 run 两条 polyline：走过部分=玩家色，未走部分=半透明白；
      // 跳跃段（dash=true）在开关开启时加 dashArray 虚线
      for (const run of runs) {
        run.latlngs = latlngs.slice(run.startIdx, run.endIdx + 1);
        run.cumStart = cum[run.startIdx];
        run.cumEnd = cum[run.endIdx];
        const dashStyle = (run.dash && this.dashJump) ? { dashArray: DASH_PATTERN } : {};
        run.passedLine = L.polyline([], Object.assign({
          color, weight: 4, opacity: 0.95, lineCap: 'butt',
        }, dashStyle)).addTo(this.map);
        // 隐藏未走过的路线：加载瞬间未走部分即为空（render() 每帧按状态重设）
        run.notPassedLine = L.polyline(this.hideNotPassed ? [] : run.latlngs, Object.assign({
          color: 'rgba(255,255,255,0.3)', weight: 4, opacity: 1, lineCap: 'butt',
        }, dashStyle)).addTo(this.map);
        run.state = 0;      // 0=未开始 1=部分走过 2=已走过 3=窗口外隐藏
        run.splitSeg = -1;  // 部分走过时的拆分段索引
        run.splitAlpha = 0; // 段内插值系数
        run.vs = run.startIdx; // 窗口裁剪后的可见切片起止索引（变化时重绘）
        run.ve = run.endIdx;
      }
    } else {
      // 单点轨迹：插件要求至少 2 个坐标，退化为普通头像标记
      track.marker = L.marker(latlngs[0], { icon }).addTo(this.map);
    }

    // 玩家名 tooltip：多点轨迹（TrackPlayer 标记）与单点轨迹统一处理
    this.bindPlayerTooltip(track.tp ? track.tp.marker : track.marker, track);
    // 头像描边（偏好开启时用该玩家轨迹色给头像加描边）
    this.applyAvatarOutline(track);

    this.tracks.set(uuid, track);

    // 首个轨迹加载后自动适配视野（本地重建时不触发，避免视图跳动）
    if (!this.rebuilding && this.tracks.size === 1) {
      this.map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
    }
  },

  /* ---------- 轨迹颜色 ---------- */

  /** 解析轨迹颜色：用户指定 > 重建保持 > 按 palette 顺序自动分配 */
  resolveTrackColor(uuid, keepColor) {
    const override = this.playerColors[uuid];
    if (override) return override;
    if (keepColor) return keepColor;
    const c = PLAYER_COLORS[this.colorIndex % PLAYER_COLORS.length];
    this.colorIndex++;
    return c;
  },

  /** 本地重建已加载轨迹（切换虚线/颜色时调用，不重新请求数据） */
  rebuildTrack(uuid) {
    const old = this.tracks.get(uuid);
    if (!old || !old.rawPoints) return;
    const follow = this.followUuid === uuid ? uuid : null;
    const raw = old.rawPoints;
    const name = old.rawName || old.name;
    const keepColor = old.color;
    const stateKeep = old.stateTimes.length
      ? { times: old.stateTimes, recs: old.stateRecs } : null;
    this.rebuilding = true;
    try {
      this.removeTrack(uuid);
      this.buildTrack(uuid, name, raw, keepColor);
    } finally {
      this.rebuilding = false;
    }
    const t = this.tracks.get(uuid);
    if (t && stateKeep) {
      t.stateTimes = stateKeep.times;
      t.stateRecs = stateKeep.recs;
    }
    if (follow) this.setFollow(follow);
    this.recomputeRange();
    this.render();
    this.syncColorInputs();
  },

  /** 指定玩家轨迹颜色（localStorage 持久化，已加载则立即重建生效） */
  setPlayerColor(uuid, color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    this.playerColors[uuid] = color;
    try {
      localStorage.setItem('mc-replay.playerColors', JSON.stringify(this.playerColors));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    if (this.tracks.has(uuid)) this.rebuildTrack(uuid);
    this.syncColorInputs();
  },

  /** 清除指定颜色，恢复自动分配（已加载轨迹保持当前显示色，避免视觉跳变） */
  clearPlayerColor(uuid) {
    delete this.playerColors[uuid];
    try {
      localStorage.setItem('mc-replay.playerColors', JSON.stringify(this.playerColors));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    if (this.tracks.has(uuid)) this.rebuildTrack(uuid);
    this.syncColorInputs();
  },

  /** 把颜色输入框同步为当前生效色（玩家菜单中的色板） */
  syncColorInputs() {
    document.querySelectorAll('.player-color').forEach((inp) => {
      const uuid = inp.dataset.uuid;
      const track = this.tracks.get(uuid);
      inp.value = (track && track.color) || this.playerColors[uuid] || PLAYER_COLORS[0];
      const autoBtn = inp.parentElement.querySelector('.color-auto');
      if (autoBtn) autoBtn.style.display = this.playerColors[uuid] ? '' : 'none';
    });
  },

  /**
   * 切换「跳跃段用虚线连接」（localStorage 持久化）。
   * runs 在 buildTrack 中始终按跳跃段分组，因此这里只切换 dash 样式、
   * 不重建轨迹图层（多轨迹时避免 remove/build 造成的卡顿）；
   * 阈值变化才需要重建（见 setDashJumpBlocks）。
   */
  setDashJump(on) {
    this.dashJump = !!on;
    try {
      localStorage.setItem('mc-replay.dashJump', this.dashJump ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    const dash = this.dashJump ? DASH_PATTERN : null;
    for (const track of this.tracks.values()) {
      for (const run of track.runs) {
        if (!run.dash) continue;
        run.passedLine.setStyle({ dashArray: dash });
        run.notPassedLine.setStyle({ dashArray: dash });
      }
    }
    this.syncDashBlocksInput();
  },

  /**
   * 设置跳跃段距离阈值（格，localStorage 持久化，下限 MIN_DASH_JUMP_BLOCKS）。
   * runs 按阈值分组，变化后重建全部已加载轨迹。
   */
  setDashJumpBlocks(v) {
    let n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < MIN_DASH_JUMP_BLOCKS) n = MIN_DASH_JUMP_BLOCKS;
    this.dashJumpBlocks = n;
    try {
      localStorage.setItem('mc-replay.dashJumpBlocks', String(n));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const uuid of [...this.tracks.keys()]) this.rebuildTrack(uuid);
    this.syncDashBlocksInput();
  },

  /** 同步虚线阈值输入框：虚线开关与「隐藏跳跃段」都关闭时禁用（阈值对两者共用）；非聚焦时同步当前值 */
  syncDashBlocksInput() {
    const input = document.getElementById('input-dash-blocks');
    if (!input) return;
    input.disabled = !this.dashJump && !this.hideJump;
    if (document.activeElement !== input) input.value = this.dashJumpBlocks;
  },

  /**
   * 切换「隐藏跳跃段」（localStorage 持久化，默认关）。
   * 与「跳跃段用虚线连接」共用 dashJumpBlocks 阈值；runs 已按该阈值分组，
   * render() 里把跳跃 run 按「窗口外」处理即整段不绘制（含箭头路径剔除），
   * 因此只置脏重绘、无需重建轨迹图层。
   */
  setHideJump(on) {
    this.hideJump = !!on;
    try {
      localStorage.setItem('mc-replay.hideJump', this.hideJump ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) {
      for (const run of track.runs) run.state = -1;
    }
    this.syncDashBlocksInput();
    this.render();
  },

  /**
   * 切换「固定头像朝向」（localStorage 持久化，默认关）：开启后地图头像不再
   * 按 yaw 旋转（rotationAngle=0），始终朝上。切换时立即重设当前旋转角，
   * 避免等下一帧（setProgress 在 progress 未变化时会跳过重绘）。
   */
  setFixedAvatarRotation(on) {
    this.fixedAvatarRotation = !!on;
    try {
      localStorage.setItem('mc-replay.fixedAvatarRotation', this.fixedAvatarRotation ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) {
      if (!track.tp || !track.tp.marker) continue;
      const loc = this.locate(track, this.currentTime);
      track.tp.marker.setRotationAngle(
        this.fixedAvatarRotation ? 0 : this.yawAngleAt(track, loc));
    }
    this.render();
  },

  /** 切换「头像描边」（localStorage 持久化，默认关）：用该玩家轨迹色给头像描边 */
  setAvatarOutline(on) {
    this.avatarOutline = !!on;
    try {
      localStorage.setItem('mc-replay.avatarOutline', this.avatarOutline ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) this.applyAvatarOutline(track);
  },

  /**
   * 头像描边：给标记元素加纯色圆角描边——box-shadow 零偏移/零模糊/5px 扩散，
   * 是一圈边缘锐利的实色框（不是沿透明通道的渐变光晕），颜色取该玩家当前
   * 轨迹色；同时给元素 4px 圆角，头像与描边一起变成小圆角矩形（box-shadow
   * 会跟随 border-radius）。随头像一起旋转，关闭时清空内联样式。
   */
  applyAvatarOutline(track) {
    const marker = track.tp ? track.tp.marker : track.marker;
    const el = marker && typeof marker.getElement === 'function' ? marker.getElement() : null;
    if (!el) return;
    const c = track.color;
    const on = this.avatarOutline && c;
    el.style.boxShadow = on ? '0 0 0 5px ' + c : '';
    el.style.borderRadius = on ? '4px' : '';
  },

  /**
   * 箭头装饰路径：返回 [lo, hi] 范围内用于铺箭头的折线数组。
   * 隐藏跳跃段开启时按 run 分组剔除跳跃段（否则空线段上仍会浮着箭头）；
   * 未开启时保持原有的单条整段切片行为。
   */
  arrowPaths(track, lo, hi) {
    if (lo > hi) return [];
    if (!this.hideJump) return [track.latlngs.slice(lo, hi + 1)];
    const paths = [];
    for (const run of track.runs) {
      if (run.dash) continue;
      const s = Math.max(run.startIdx, lo);
      const e = Math.min(run.endIdx, hi);
      if (s < e) paths.push(track.latlngs.slice(s, e + 1));
    }
    return paths;
  },

  /**
   * 切换方向箭头显示模式（localStorage 持久化）：
   *   all       一直显示（默认）：窗口内全部路径（走过+未走）铺箭头
   *   notPassed 仅未走过的路径显示箭头：从当前时刻所在点到窗口末端
   *   none      一直隐藏
   * 箭头路径在 render() 内按模式重设，切换后只需重绘，无需重建轨迹图层。
   */
  setArrowMode(mode) {
    this.arrowMode = ARROW_MODES.includes(mode) ? mode : 'all';
    try {
      localStorage.setItem('mc-replay.arrowMode', this.arrowMode);
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.render();
  },

  /**
   * 切换「隐藏未走过的路线」（localStorage 持久化）：
   * 开启后不再绘制当前位置之后的轨迹（未走过部分），只保留已走过的路线。
   * 该开关不影响 run 的状态/拆分位置判定，变化检测会漏掉重绘，
   * 因此切换时把所有 run.state 置为脏值（-1）强制下一帧重写折线。
   */
  setHideNotPassed(on) {
    this.hideNotPassed = !!on;
    try {
      localStorage.setItem('mc-replay.hideNotPassed', this.hideNotPassed ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const track of this.tracks.values()) {
      for (const run of track.runs) run.state = -1;
    }
    this.render();
  },

  /**
   * 切换「最多显示轨迹点数量」（localStorage 持久化）。
   * 窗口裁剪发生在 render() 内，切换后只需重绘，无需重建轨迹图层。
   */
  setMaxPointsEnabled(on) {
    this.maxPointsEnabled = !!on;
    try {
      localStorage.setItem('mc-replay.maxPointsEnabled', this.maxPointsEnabled ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.syncMaxPointsInput();
    this.render();
  },

  /** 设置最多显示的轨迹点数量（localStorage 持久化，下限 MIN_MAX_POINTS，即时生效） */
  setMaxPoints(v) {
    let n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < MIN_MAX_POINTS) n = MIN_MAX_POINTS;
    this.maxPoints = n;
    try {
      localStorage.setItem('mc-replay.maxPoints', String(n));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.syncMaxPointsInput();
    this.render();
  },

  /** 同步数量输入框（未勾选时禁用；聚焦中不抢写值，避免打断输入） */
  syncMaxPointsInput() {
    const input = document.getElementById('input-max-points');
    if (!input) return;
    input.disabled = !this.maxPointsEnabled;
    if (document.activeElement !== input) input.value = this.maxPoints;
  },

  removeTrack(uuid) {
    const track = this.tracks.get(uuid);
    if (!track) return;
    if (track.tp) {
      try { track.tp.remove(); } catch (e) { /* 忽略 */ }
    }
    if (track.marker) {
      this.map.removeLayer(track.marker);
    }
    // 清理自建的 run 折线（TrackPlayer.remove 不会移除它们）
    for (const run of track.runs || []) {
      this.map.removeLayer(run.passedLine);
      this.map.removeLayer(run.notPassedLine);
    }
    this.tracks.delete(uuid);
    // 被跟随的玩家轨迹被移除时取消跟随
    if (this.followUuid === uuid) this.setFollow(null);
    // 被选中的玩家轨迹被移除时清除选中（进度条不再高亮）
    if (this.selectedUuid === uuid) {
      this.selectedUuid = null;
      this.updateSelectionUI();
    }
    this.recomputeRange();
    this.render();
  },

  /** 根据已加载轨迹重算时间范围与点时间缓存 */
  recomputeRange() {
    if (this.tracks.size === 0) {
      const start = new Date(this.session.started_at).getTime();
      const end = this.session.stopped_at ? new Date(this.session.stopped_at).getTime() : Date.now();
      this.t0 = start;
      this.t1 = Math.max(end, start);
    } else {
      let t0 = Infinity, t1 = -Infinity;
      const all = [];
      for (const track of this.tracks.values()) {
        if (track.times[0] < t0) t0 = track.times[0];
        if (track.times[track.times.length - 1] > t1) t1 = track.times[track.times.length - 1];
        for (const t of track.times) all.push(t);
      }
      this.t0 = t0;
      this.t1 = t1;
      all.sort((a, b) => a - b);
      const uniq = [];
      for (const t of all) {
        if (!uniq.length || t - uniq[uniq.length - 1] > 1) uniq.push(t);
      }
      this.pointTimes = uniq;
    }
    if (this.currentTime < this.t0 || this.currentTime > this.t1) {
      this.currentTime = this.t0;
    }
  },

  /* ---------- 播放控制 ---------- */
  togglePlay() {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  },

  play() {
    if (this.playing) return;
    if (this.t1 <= this.t0) return;
    if (this.currentTime >= this.t1) this.currentTime = this.t0; // 到终点后重新播放
    this.playing = true;
    this.lastFrameTs = null;
    this.updatePlayButton();
    this.rafId = requestAnimationFrame((ts) => this.frame(ts));
  },

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.updatePlayButton();
  },

  /**
   * 设置播放速度（倍）。传入 'custom' 表示切到自定义输入框（不立即改速度）；
   * 自定义倍数由 applyCustomSpeed() 校验后生效。
   */
  setSpeed(v) {
    const custom = document.getElementById('speed-custom');
    if (v === 'custom') {
      if (custom) {
        custom.hidden = false;
        custom.value = String(this.speed);
        custom.focus();
        custom.select();
      }
      return;
    }
    this.speed = Number(v) || 1;
    if (custom) custom.hidden = true;
  },

  /** 应用自定义倍数：0.1–1000，非法输入回退当前速度（回车或失焦触发） */
  applyCustomSpeed() {
    const inp = document.getElementById('speed-custom');
    if (!inp) return;
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v) || v <= 0) {
      inp.value = String(this.speed);
      return;
    }
    this.speed = Math.min(1000, Math.max(0.1, v));
    inp.value = String(this.speed);
  },

  /** 上一个轨迹点（暂停并跳转） */
  stepPrev() {
    this.pause();
    let target = null;
    for (const t of this.pointTimes) {
      if (t < this.currentTime - 1) target = t;
      else break;
    }
    if (target != null) {
      this.currentTime = target;
      this.render();
    }
  },

  /** 下一个轨迹点（暂停并跳转） */
  stepNext() {
    this.pause();
    let target = null;
    for (const t of this.pointTimes) {
      if (t > this.currentTime + 1) { target = t; break; }
    }
    if (target != null) {
      this.currentTime = target;
      this.render();
    }
  },

  updatePlayButton() {
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = this.playing ? '⏸ 暂停' : '▶ 播放';
  },

  /** 动画帧：按墙上时钟推进 currentTime（受变速倍率影响） */
  frame(ts) {
    if (!this.playing) return;
    if (this.lastFrameTs == null) this.lastFrameTs = ts;
    const dt = (ts - this.lastFrameTs) * this.speed;
    this.lastFrameTs = ts;

    let t = this.currentTime + dt;
    if (t >= this.t1) {
      t = this.t1;
      this.currentTime = t;
      this.render();
      this.pause();
      return;
    }
    this.currentTime = t;
    this.render();
    this.rafId = requestAnimationFrame((ts2) => this.frame(ts2));
  },

  /* ---------- 渲染 ---------- */
  render() {
    const t = this.currentTime;
    for (const track of this.tracks.values()) {
      if (track.tp) {
        const loc = this.locate(track, t);
        let e;
        if (loc.before) {
          e = 0;
        } else if (loc.after) {
          e = 1;
        } else {
          const segLen = track.seg[loc.i] || 0;
          const alpha = segLen > 0 ? loc.alpha : 0;
          e = track.total > 0 ? (track.cum[loc.i] + alpha * segLen) / track.total : 0;
          e = Math.min(1, Math.max(0, e));
        }
        // 每帧先停掉插件内部循环（setProgress 到过终点后会启动它）
        if (!track.tp.isPaused) track.tp.pause();
        // 旋转角需在 setProgress（内部 setLatLng → _setPos → _applyRotation）之前设置；
        // 「固定头像朝向」开启时恒为 0（不做 yaw 旋转）
        if (track.tp.marker) {
          track.tp.marker.options.rotationAngle = this.fixedAvatarRotation
            ? 0 : this.yawAngleAt(track, loc);
        }
        track.tp.setProgress(e);
        // 最多显示轨迹点数量：窗口 [wLo, wHi] 以当前时刻所在点为中心，总数不超过
        // maxPoints，随播放滑动（路线动态伸缩）。未开启时窗口覆盖整条轨迹，行为不变
        let wLo = 0, wHi = track.times.length - 1;
        if (this.maxPointsEnabled && this.maxPoints < track.times.length) {
          const n = track.times.length;
          const half = this.maxPoints >> 1;
          const c = loc.after ? n - 1 : loc.i;
          let lo = c - half;
          let hi = c + (this.maxPoints - half - 1);
          // 一侧被轨迹首/末端截断时，剩余额度转给另一侧（可见总数仍不超过 maxPoints）
          if (lo < 0) { hi += -lo; lo = 0; }
          if (hi > n - 1) { lo -= hi - (n - 1); hi = n - 1; }
          wLo = Math.max(0, lo);
          wHi = hi;
        }
        // 方向箭头装饰：插件的 setProgress 每帧都会用全轨迹 passed+notPassed 覆盖
        // 装饰路径，且 progress 未变化时整个 setProgress 会跳过重绘，因此三个模式
        // 都在此处显式重设装饰路径（与「最多显示轨迹点」的窗口裁剪叠加）：
        //   all       窗口内全部路径（走过+未走）铺箭头；无窗口时为整条轨迹，
        //             与插件默认 passed+notPassed 拼接等价
        //   notPassed 仅未走过的路径铺箭头：从当前时刻所在点到窗口末端
        //   none      空路径（不绘制任何箭头）
        if (this.arrowMode === 'none') {
          track.tp.polylineDecorator.setPaths([]);
        } else if (this.arrowMode === 'notPassed') {
          // 未走部分起点：当前时刻所在点（before → 窗口起点；after → 已全部走过）
          const from = loc.after ? wHi + 1 : Math.max(wLo, loc.i);
          track.tp.polylineDecorator.setPaths(this.arrowPaths(track, from, wHi));
        } else {
          track.tp.polylineDecorator.setPaths(this.arrowPaths(track, wLo, wHi));
        }
        // 更新按 run 分组的折线：D = 当前累积距离（haversine），
        // 与可见切片的 cum 比较得到 未开始 / 部分走过 / 已走过 / 窗口外 四态，
        // 仅在状态或拆分位置变化时写 DOM（暂停/拖动时免去重复渲染）
        if (track.runs.length) {
          const D = e * track.total;
          for (const run of track.runs) {
            // 窗口与 run 索引区间求交，得到可见切片 [vs, ve]（含两端）
            const vs = Math.max(run.startIdx, wLo);
            const ve = Math.min(run.endIdx, wHi);
            let st;
            if (vs > ve) st = 3;                 // 整段在窗口外：隐藏
            else if (D >= track.cum[ve]) st = 2; // 可见部分已全部走过
            else if (D <= track.cum[vs]) st = 0; // 可见部分尚未开始
            else st = 1;                         // 部分走过
            // 隐藏跳跃段：跳跃 run 整段按「窗口外」处理（两条折线清空、轨迹断开）
            if (this.hideJump && run.dash) st = 3;
            let segIdx = -1, alpha = 0;
            if (st === 1) {
              // 拆分段必落在 [vs, ve-1]：由 cum[vs] < D < cum[ve] 可证；
              // 仍做钳制防御，防止越界切片
              let i = Math.min(Math.max(loc.i, vs), ve - 1);
              while (i < ve - 1 && track.cum[i + 1] <= D) i++;
              const segLen = track.seg[i] || 0;
              alpha = segLen > 0 ? (D - track.cum[i]) / segLen : 0;
              segIdx = i;
            }
            if (run.state === st && run.vs === vs && run.ve === ve &&
                (st !== 1 || (run.splitSeg === segIdx && Math.abs(run.splitAlpha - alpha) < 1e-9))) {
              continue;
            }
            run.state = st;
            run.vs = vs;
            run.ve = ve;
            run.splitSeg = segIdx;
            run.splitAlpha = alpha;
            if (st === 3) {
              run.passedLine.setLatLngs([]);
              run.notPassedLine.setLatLngs([]);
            } else if (st === 0) {
              run.passedLine.setLatLngs([]);
              // 隐藏未走过的路线：整个 run 未开始 → 整体不画
              run.notPassedLine.setLatLngs(this.hideNotPassed ? [] :
                run.latlngs.slice(vs - run.startIdx, ve - run.startIdx + 1));
            } else if (st === 2) {
              run.passedLine.setLatLngs(run.latlngs.slice(vs - run.startIdx, ve - run.startIdx + 1));
              run.notPassedLine.setLatLngs([]);
            } else {
              // 部分走过：在拆分段内线性插值出当前位置点，前后两半分别着色。
              // 注意必须用 run.latlngs（run 局部数组，其 [0] 对应全局 startIdx）：
              // 误用 track.latlngs（全局数组）配局部偏移会从轨迹第一个点开始切片，
              // 拼上当前位置后形成「从首记录点到当前位置」的长直线（仅 startIdx>0
              // 的 run 出现，即开启虚线分组后才暴露）
              const a = track.latlngs[segIdx];
              const b = track.latlngs[segIdx + 1];
              const mid = L.latLng(a.lat + (b.lat - a.lat) * alpha, a.lng + (b.lng - a.lng) * alpha);
              run.passedLine.setLatLngs(run.latlngs.slice(vs - run.startIdx, segIdx + 1 - run.startIdx).concat([mid]));
              // 隐藏未走过的路线：当前位置之后不画，只保留走过的部分
              run.notPassedLine.setLatLngs(this.hideNotPassed ? [] :
                [mid].concat(run.latlngs.slice(segIdx + 1 - run.startIdx, ve - run.startIdx + 1)));
            }
          }
        }
        // 时间范围外的玩家标记淡化
        const out = loc.before || loc.after;
        if (track.tp.marker) {
          track.tp.marker.setOpacity(out ? 0.25 : 1);
        }
      }
    }

    // tooltip 内容跟随当前坐标/站点/线路状态更新（仅变化时写 DOM）
    for (const track of this.tracks.values()) {
      const marker = track.tp ? track.tp.marker : track.marker;
      if (!marker || !marker.getTooltip()) continue;
      const html = this.tooltipHTML(track, marker);
      if (html !== track.tipHTML) {
        track.tipHTML = html;
        marker.setTooltipContent(html);
      }
    }

    // 画面跟随：把被跟随玩家的标记保持在地图中心
    if (this.followUuid) {
      const track = this.tracks.get(this.followUuid);
      const marker = track ? (track.tp ? track.tp.marker : track.marker) : null;
      if (marker) {
        this.map.panTo(marker.getLatLng(), { animate: false });
      }
    }

    // 时间显示
    const curEl = document.getElementById('time-current');
    const totalEl = document.getElementById('time-total');
    if (curEl) curEl.textContent = fmtClock(t);
    if (totalEl) totalEl.textContent = fmtDuration(Math.round((this.t1 - this.t0) / 1000));

    // 进度条（用户拖动时不回写，避免抖动）；同时刷新选中玩家时间段高亮
    this.renderTimeline();

    // 右上角时间戳（#map-container 后代元素，录制时合成进视频）
    const tsEl = document.getElementById('timestamp');
    if (tsEl) tsEl.textContent = fmtTime(t);
  },

  /**
   * 更新地图下方播放控制条的进度显示：
   *   已播放填充 / 拖动手柄 / 选中玩家的数据覆盖时间段高亮。
   * 轨道为自绘（原生 range 透明覆盖负责交互）；高亮把选中轨迹按「数据断档」
   * 切成多个连续段，每段与当前时间轴 [t0, t1] 取交集，颜色用该玩家轨迹色。
   */
  renderTimeline() {
    const span = this.t1 - this.t0;
    const ratio = span > 0
      ? Math.min(1, Math.max(0, (this.currentTime - this.t0) / span)) : 0;
    const pct = (ratio * 100).toFixed(3) + '%';

    const played = document.getElementById('pb-played');
    const thumb = document.getElementById('pb-thumb');
    if (played) played.style.width = pct;
    if (thumb) thumb.style.left = pct;

    const bar = document.getElementById('progress-bar');
    if (bar && !this.scrubbing) bar.value = Math.round(ratio * 1000);

    const layer = document.getElementById('pb-selected');
    if (!layer) return;
    if (!span || span <= 0) { layer.hidden = true; return; }
    const info = this.selectionSegments();
    if (!info || !info.segs.length) {
      layer.hidden = true;
      if (layer.childElementCount) layer.replaceChildren();
      delete layer.dataset.selKey;
      return;
    }
    layer.hidden = false;
    // 高亮区间只取决于轨迹/时间轴/颜色，与本帧播放进度无关：命中缓存直接返回，
    // 避免逐帧重建 DOM 与重写样式（render() 每帧都会调用本方法）
    if (layer.dataset.selKey === info.key && layer.childElementCount === info.segs.length) return;
    layer.dataset.selKey = info.key;
    layer.replaceChildren();
    for (const seg of info.segs) {
      const a = seg[0], b = seg[1];
      const el = document.createElement('div');
      el.className = 'pb-seg';
      el.style.left = (((a - this.t0) / span) * 100).toFixed(3) + '%';
      // 极短区间（如只剩单个数据点的段）也保留最小可见宽度，否则高亮会消失
      el.style.width = Math.max(0.2, ((b - a) / span) * 100).toFixed(3) + '%';
      el.style.background = info.color;
      layer.appendChild(el);
    }
  },

  /**
   * 选中玩家在进度条上的高亮区间（按数据断档切段）。
   * 判定：相邻两个数据点时间差 ≥ SELECT_BREAK_GAP_FACTOR × 会话轮询间隔
   * （poll_interval_ms，缺失时按 1000ms）即视为断档，高亮在此断开；
   * 每段与当前时间轴 [t0, t1] 取交集，完全在轴外的段丢弃。
   * 结果按 key（选中玩家/颜色/时间轴/数据点数量与首末时间）缓存。
   * @returns {{key: string, color: string, segs: Array<[number, number]>}|null}
   */
  selectionSegments() {
    const track = this.selectedUuid ? this.tracks.get(this.selectedUuid) : null;
    if (!track || !track.times.length) return null;
    const times = track.times;
    const key = this.selectedUuid + '|' + track.color + '|' + this.t0 + '|' + this.t1 +
      '|' + times.length + '|' + times[0] + '|' + times[times.length - 1];
    if (this._selSegCache && this._selSegCache.key === key) return this._selSegCache;

    const pollMs = Number(this.session && this.session.poll_interval_ms) > 0
      ? Number(this.session.poll_interval_ms) : DEFAULT_POLL_INTERVAL_MS;
    const breakGap = pollMs * SELECT_BREAK_GAP_FACTOR;

    const segs = [];
    const pushSeg = (s, e) => {
      const a = Math.max(this.t0, s);   // 裁剪到时间轴，保证高亮落在进度条范围内
      const b = Math.min(this.t1, e);
      if (b >= a) segs.push([a, b]);
    };
    let start = times[0];
    let prev = start;
    for (let i = 1; i < times.length; i++) {
      const t = times[i];
      if (t - prev >= breakGap) {  // 断档：当前段收尾于上一个点，下一段从本点开始
        pushSeg(start, prev);
        start = t;
      }
      prev = t;
    }
    pushSeg(start, prev);

    this._selSegCache = { key, color: track.color, segs };
    return this._selSegCache;
  },

  /**
   * 在轨迹中定位 currentTime：返回区间下标 i、区间内插值 alpha，
   * before/after 表示是否超出轨迹首末端点。
   */
  locate(track, t) {
    const times = track.times;
    const last = times.length - 1;
    if (t <= times[0]) return { i: 0, alpha: 0, before: true, after: false };
    if (t >= times[last]) return { i: Math.max(0, last - 1), alpha: 1, before: false, after: true };
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = times[lo + 1] - times[lo];
    const alpha = span > 0 ? (t - times[lo]) / span : 0;
    return { i: lo, alpha, before: false, after: false };
  },

  /** 按 MC yaw 插值计算标记旋转角（自正北起算，顺时针，deg） */
  yawAngleAt(track, loc) {
    let yaw;
    if (loc.before) {
      yaw = track.yaws[0];
    } else if (loc.after) {
      yaw = track.yaws[track.yaws.length - 1];
    } else {
      const y0 = track.yaws[loc.i];
      const y1 = track.yaws[loc.i + 1];
      if (y0 == null) yaw = y1;
      else if (y1 == null) yaw = y0;
      else {
        let d = y1 - y0;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        yaw = y0 + d * loc.alpha;
      }
    }
    if (yaw == null || isNaN(yaw)) return 0;
    return normalizeYawAngle(yaw);
  },

  /* ---------- 录制模式（独立状态） ----------
   * 状态机：off → RECORDING_MODE → REGION_READY → RECORDING
   *   off            正常回放（无录制面板）
   *   RECORDING_MODE 录制模式中，未获取区域（可切比例）
   *   REGION_READY   已获取 screen stream（裁剪或降级），可随时开始录制（无时间限制）
   *   RECORDING      MediaRecorder 录制中（禁比例切换与重新获取）
   */
  toggleRecordingMode() {
    if (this.recordingMode) this.exitRecordingMode();
    else this.enterRecordingMode();
  },

  enterRecordingMode() {
    this.recordingMode = true;
    this.recordState = 'RECORDING_MODE';
    document.body.classList.add('recording-mode');
    document.getElementById('btn-record-mode').textContent = '退出录制模式';
    document.getElementById('record-panel').style.display = '';
    this.setRecordRatio('16:9'); // 比例复位（同时应用容器尺寸）
    this.setRecordStatus('点击「获取录制区域」选择录制源');
    this.updateRecordPanel();
    // 布局变化后让 Leaflet 按新容器尺寸重算（保持中心点与缩放级别），
    // 并应用持久化的地图区域高度（若有）
    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
      this.applyRecordContainerSize();
    }, 60);
  },

  async exitRecordingMode() {
    // 正在录制 → 先停止并下载（await 到 onstop 下载完成）
    if (this.recordState === 'RECORDING') {
      this.setRecordStatus('正在停止并下载…');
      await Recorder.stop();
    }
    this.stopRecordKeepAlive();
    this.stopRecordWatchdog();
    // 释放 stream
    this.releaseRecordStream();
    this.recordState = 'off';
    this.recordingMode = false;
    // 恢复默认视图：缩放按钮重现（移除 recording-mode 即恢复）、比例回 16:9、面板隐藏
    document.body.classList.remove('recording-mode', 'recording-ratio-169', 'recording-ratio-43');
    this.recordRatio = '16:9';
    document.querySelectorAll('input[name="record-ratio"]').forEach(r => { r.checked = r.value === '16:9'; });
    document.getElementById('btn-record-mode').textContent = '进入录制模式';
    document.getElementById('record-panel').style.display = 'none';
    // 清除显式尺寸（inline style），回归默认全屏布局
    const container = document.getElementById('map-container');
    if (container) { container.style.width = ''; container.style.height = ''; }
    this.updateRecordSizeHint();
    this.setRecordStatus('点击「获取录制区域」选择录制源');
    setTimeout(() => this.map && this.map.invalidateSize(), 60);
  },

  /**
   * 切换画面比例（仅非录制状态可用）：只改变 #map-container 容器尺寸，
   * 不调用 fitBounds，地图中心点与缩放级别保持不变，切换后 invalidateSize()。
   */
  setRecordRatio(ratio) {
    if (this.recordState === 'RECORDING') return;
    this.recordRatio = ratio === '4:3' ? '4:3' : '16:9';
    document.body.classList.remove('recording-ratio-169', 'recording-ratio-43');
    document.body.classList.add(this.recordRatio === '4:3' ? 'recording-ratio-43' : 'recording-ratio-169');
    document.querySelectorAll('input[name="record-ratio"]').forEach(r => { r.checked = r.value === this.recordRatio; });
    setTimeout(() => this.map && this.map.invalidateSize(), 30);
    // 已设定显式高度时，宽度按新比例重算
    this.applyRecordContainerSize();
  },

  /**
   * 设置录制地图区域高度（px；0/空 = 自适应）。宽度 = 高度 × 当前比例，
   * 超出 #map-area 可用空间时同比缩小（保持比例）。localStorage 持久化。
   */
  setRecordHeight(v) {
    const raw = String(v == null ? '' : v).trim();
    let n = raw === '' ? 0 : Math.floor(Number(raw));
    if (raw !== '' && (!Number.isFinite(n) || n < MIN_RECORD_HEIGHT)) n = MIN_RECORD_HEIGHT;
    this.recordHeight = n;
    try {
      localStorage.setItem('mc-replay.recordHeight', String(n));
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.syncRecordHeightInput();
    this.applyRecordContainerSize();
    if (this.recordState === 'REGION_READY') {
      // 裁剪区域按获取时的容器尺寸固定，尺寸变更后需重新获取才生效
      this.setRecordStatus('画面尺寸已调整；若已获取区域，请重新获取以使录制范围生效');
    }
  },

  /** 同步高度输入框（非聚焦时写值，避免打断用户输入） */
  syncRecordHeightInput() {
    const input = document.getElementById('input-record-height');
    if (!input) return;
    if (document.activeElement !== input) input.value = this.recordHeight ? String(this.recordHeight) : '';
  },

  /**
   * 应用地图区域尺寸：recordHeight>0 时按 高度×比例 设置容器显式宽高
   * （inline style，覆盖 CSS 的 aspect-ratio 自适应规则），并受 #map-area
   * 可用空间钳制；为 0 时清除 inline style 回归自适应。仅录制模式下生效。
   */
  applyRecordContainerSize() {
    const container = document.getElementById('map-container');
    const area = document.getElementById('map-area');
    if (!container || !area) return;
    if (!this.recordingMode || !this.recordHeight) {
      container.style.width = '';
      container.style.height = '';
      this.updateRecordSizeHint();
      return;
    }
    const ratio = this.recordRatio === '4:3' ? 4 / 3 : 16 / 9;
    const availW = area.clientWidth;
    const availH = area.clientHeight;
    let h = this.recordHeight;
    let w = Math.round(h * ratio);
    if (w > availW) { w = availW; h = Math.round(w / ratio); } // 宽度触顶 → 同比缩小
    if (h > availH) { h = availH; w = Math.round(h * ratio); } // 高度触顶 → 同比缩小（兜底）
    container.style.width = w + 'px';
    container.style.height = h + 'px';
    this.updateRecordSizeHint();
    setTimeout(() => this.map && this.map.invalidateSize(), 30);
  },

  /** 更新面板中的「当前画面尺寸」提示 */
  updateRecordSizeHint() {
    const hint = document.getElementById('record-size-hint');
    if (!hint) return;
    const ratioText = this.recordRatio === '4:3' ? '4:3' : '16:9';
    const container = document.getElementById('map-container');
    const w = container && container.style.width ? parseInt(container.style.width, 10) : 0;
    const h = container && container.style.height ? parseInt(container.style.height, 10) : 0;
    hint.textContent = w && h
      ? '当前画面尺寸：' + w + ' × ' + h + '（' + ratioText + '，录制分辨率）'
      : '当前画面尺寸：自适应（' + ratioText + '，横向顶满）';
  },

  /**
   * 获取录制区域：getDisplayMedia（preferCurrentTab + selfBrowserSurface）+
   * RestrictionTarget 裁剪到 #map-container（Edge/Chrome 132+）。
   * - 裁剪成功 → REGION_READY（区域无时间限制，可随时开始录制）
   * - 捕获源不是「当前标签页」（displaySurface 为 monitor/window）→ 按规格
   *   必然无法裁剪，不发起 restrictTo（失败的调用在部分 Edge 版本会把轨道
   *   卡在无帧状态），录制整个源并明确提示
   * - 捕获源是当前标签页但裁剪失败 → 降级录制整个标签页（仍可用）
   * - 轨道探活为零帧（限制变换抑制产帧等）→ 丢弃坏轨道自动重取一次
   *   （重取不再尝试裁剪），两次都无帧则拒绝进入 REGION_READY 并给出建议
   * - 用户取消 → 停留 RECORDING_MODE 可重试
   * REGION_READY 下重新获取：先释放旧 stream 再完整重走流程。
   */
  async acquireRegion() {
    if (this.recordState === 'RECORDING' || this._acquiring) return; // 录制中/获取中禁用
    this._acquiring = true;
    try {
      await this._acquireRegionOnce(false);
    } finally {
      this._acquiring = false;
    }
  },

  /** 单次获取流程；retry=true 表示探活失败后的自动重取（不再尝试裁剪） */
  async _acquireRegionOnce(retry) {
    if (this.recordStream) this.releaseRecordStream(); // 重取：先释放旧 stream
    // 重新获取期间状态先降级（按钮态与「开始录制」禁用），获取成功再置 REGION_READY
    this.recordState = this.recordingMode ? 'RECORDING_MODE' : 'off';
    this.setRecordStatus(retry
      ? '采集源无画面输出，请重新选择「当前标签页」作为录制源…'
      : '等待选择录制源…');
    this.updateRecordPanel();

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // cursor:'never' 请求不把鼠标指针合成进画面：对「整个屏幕/窗口」源生效，
        // 「当前标签页」源多数实现本来就不含光标（会忽略该约束）
        video: { frameRate: 30, cursor: 'never' },
        selfBrowserSurface: 'include',
        preferCurrentTab: true,
        audio: false,
      });
    } catch (e) {
      // 用户取消选择 → 停留 RECORDING_MODE 可重试
      this.recordState = this.recordingMode ? 'RECORDING_MODE' : 'off';
      this.setRecordStatus(e && e.name === 'NotAllowedError'
        ? '已取消获取，可重试'
        : '获取录制源失败: ' + (e && e.message ? e.message : e));
      this.updateRecordPanel();
      return;
    }

    // 采集源类型：browser=当前标签页（可裁剪）；monitor/window=整个屏幕/窗口（按规格不可裁剪）
    const surface = this._recordSurfaceType(stream);
    const surfaceText = surface === 'monitor' ? '整个屏幕' : surface === 'window' ? '整个窗口' : null;

    // 仅「当前标签页」源尝试 RestrictionTarget 裁剪（#map-container 已按规格
    // 加 isolation:isolate 等确保资格；其他源发起也必然失败且可能卡死轨道）
    let cropped = false;
    if (!surfaceText && !retry) {
      try {
        const track = stream.getVideoTracks()[0];
        if (window.RestrictionTarget && typeof RestrictionTarget.fromElement === 'function' &&
            typeof track.restrictTo === 'function') {
          const restriction = await RestrictionTarget.fromElement(document.getElementById('map-container'));
          await track.restrictTo(restriction);
          cropped = true;
        }
      } catch (e) {
        cropped = false;
        console.warn('[Replay] RestrictionTarget 裁剪失败，降级录制整个标签页', e);
      }
    }

    // 轨道探活：当前标签页捕获时，本页前台 + 保活强制重绘下必须持续产帧；
    // 零帧说明轨道被卡死（如限制变换抑制产帧——规格规定无效限制目标会
    // 抑制后续帧），保留它只会录出空视频 → 丢弃重取
    if (!surfaceText) {
      const health = await this._probeStreamFrames(stream);
      if (health === 'dead') {
        this._stopStream(stream);
        if (retry) {
          // 重取后仍然无帧：拒绝进入 REGION_READY，给出排查建议
          this.recordState = this.recordingMode ? 'RECORDING_MODE' : 'off';
          this.setRecordStatus('采集源仍然无画面输出。请尝试重新获取区域时选择「整个屏幕」作为录制源，' +
            '或更换浏览器（Chrome/Edge 107+）后重试');
          this.updateRecordPanel();
          return;
        }
        await this._acquireRegionOnce(true); // 自动重取一次（重取不再尝试裁剪）
        return;
      }
    }

    this.recordStream = stream;
    // 用户在浏览器原生 UI 停止共享时同步回收
    stream.getVideoTracks()[0].addEventListener('ended', () => this.onRecordStreamEnded());
    this.recordState = 'REGION_READY';
    this.updateRecordPanel();
    this.setRecordStatus(cropped
      ? '录制区域已就绪（仅地图区域，含时间戳），点击「开始录制」'
      : surfaceText
        ? '将录制' + surfaceText + '（无法裁剪到地图区域），请后期手动裁剪；请保持该源有画面变化'
        : retry
          ? '裁剪不可用，将录制整个标签页，请后期手动裁剪'
          : '将录制整个标签页，请后期手动裁剪');
  },

  /** 采集源类型（getSettings().displaySurface）：browser/window/monitor，取不到返回 '' */
  _recordSurfaceType(stream) {
    try {
      const t = stream.getVideoTracks()[0];
      const s = t && t.getSettings ? t.getSettings() : {};
      return (s && s.displaySurface) || '';
    } catch (e) { return ''; }
  },

  /** 停止并丢弃一条 stream（未采纳的坏轨道用） */
  _stopStream(stream) {
    if (!stream) return;
    try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* 忽略 */ }
  },

  /**
   * 采集源探活：把 stream 挂到帧观测器上跑约 0.8s，看是否有真实帧到达。
   * 仅对「当前标签页」源有意义——本页前台 + 保活强制重绘下必须产帧；
   * 屏幕/窗口源的画面变化取决于外部内容，无法据此判定（调用方已排除）。
   * @returns {'ok'|'dead'|'skip'|'unknown'} skip=页面在后台；unknown=无帧观测能力
   */
  async _probeStreamFrames(stream) {
    if (document.hidden) return 'skip'; // 页面前台才可能靠保活产帧
    this.startRecordKeepAlive();        // 借用保活：静止页面也持续重绘
    Recorder._startFrameMonitor(stream);
    this.setRecordStatus('正在检查采集源画面输出…');
    await new Promise(r => setTimeout(r, 800));
    const active = Recorder.frameMonitorActive;
    const frames = Recorder.frameCount;
    Recorder._stopFrameMonitor();
    this.stopRecordKeepAlive();
    if (!active) return 'unknown';      // 观测不可用（老浏览器）：不猜
    return frames > 0 ? 'ok' : 'dead';
  },

  /** 开始录制：MediaRecorder(stream) + start，不自动播放回放。
   *  编码仅 MP4/H.264；浏览器不支持或流已失效时停留在当前状态并提示 */
  startRecording() {
    if (this.recordState !== 'REGION_READY' || !this.recordStream) return;
    // 流已被浏览器原生停止共享（ended）时不能直接开录（会得到 0KB 文件）
    const vt = this.recordStream.getVideoTracks()[0];
    if (!vt || vt.readyState !== 'live') {
      this.recordStream = null;
      this.recordState = 'RECORDING_MODE';
      this.updateRecordPanel();
      this.setRecordStatus('录制源已失效，请重新获取区域');
      return;
    }
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const ts = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    const ok = Recorder.start(this.recordStream, 'replay-' + this.session.id + '-' + ts);
    if (!ok) {
      this.setRecordStatus('启动录制失败：浏览器不支持 MP4/H.264 录制（请使用 Chrome/Edge 107+ 或新版 Firefox/Safari）');
      return;
    }
    this.recordState = 'RECORDING';
    this.startRecordKeepAlive();
    this.startRecordWatchdog();
    this.updateRecordPanel();
    this.setRecordStatus('录制中…（回放继续播放，可随时拖动/缩放地图）');
  },

  /** 停止录制：onstop 合成 Blob 自动下载，随后回到 REGION_READY 可再次录制 */
  stopRecording() {
    if (this.recordState !== 'RECORDING') return;
    this.stopRecordKeepAlive();
    this.stopRecordWatchdog();
    Recorder.stop(); // onstop → 下载 → onStateChange(false) 复位状态
  },

  /**
   * 录制保活：tab capture 捕获「当前标签页」时，页面完全静止（回放暂停、无交互）
   * 会停止产出视频帧，导致 MediaRecorder 收不到数据、下载 0KB 文件。
   * 录制期间用 1×1 元素周期性切换 opacity 触发页面重绘，保持帧产出。
   * 元素必须是「看得见的变化」才会产帧：CSS 里给了实际背景色（rgba(0,0,0,0.02)）
   * 并用 z-index 盖住 Leaflet 瓦片图层（否则被遮挡/全透明时切 opacity 零像素差、
   * 不触发重绘）；opacity 在 0 与 1 之间切换，保证合成像素差 ≥ 1/255。
   */
  startRecordKeepAlive() {
    if (this._keepAliveTimer) return;
    const el = document.getElementById('record-keepalive');
    if (!el) return;
    let on = false;
    this._keepAliveTimer = setInterval(() => {
      on = !on;
      el.style.opacity = on ? '0' : '1';
    }, 200);
  },

  stopRecordKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    const el = document.getElementById('record-keepalive');
    if (el) el.style.opacity = '0';
  },

  /**
   * 录制看护（watchdog）：保活只覆盖「前台+静止」场景；若录制数秒后仍未收到
   * 任何视频帧（Recorder 帧观测，与编码分片机制无关），说明是切后台/被遮挡、
   * 或捕获了其他静止源——立即在状态行警告，让用户录制中就能发现并处理，
   * 而不是停止后才发现 0KB。帧观测不可用（老浏览器）时自动禁用。
   */
  startRecordWatchdog() {
    this.stopRecordWatchdog();
    this._recordStartAt = performance.now();
    this._noFrameWarned = false;
    this._recordWatchdog = setInterval(() => {
      if (this.recordState !== 'RECORDING') return;
      if (!Recorder.frameMonitorActive) return; // 无帧观测能力：不猜
      const elapsed = (performance.now() - this._recordStartAt) / 1000;
      if (Recorder.frameCount > 0) {
        if (this._noFrameWarned) {
          // 帧已恢复：撤下警告，回到正常状态
          this._noFrameWarned = false;
          this.setRecordStatus('录制中…（回放继续播放，可随时拖动/缩放地图）');
        }
        return;
      }
      if (elapsed < 3) return;
      this._noFrameWarned = true;
      this.setRecordStatus(document.hidden
        ? '警告：页面已切到后台，「当前标签页」录制不会产生画面，请立即切回本标签页'
        : '警告：已录制 ' + Math.floor(elapsed) + ' 秒但未捕获到任何画面。请确认获取区域时选择的是' +
          '「当前标签页」源，并保持画面变化（播放回放或拖动地图）；若无效，请重新获取区域并选择' +
          '「整个屏幕」作为录制源');
    }, 1000);
  },

  stopRecordWatchdog() {
    if (this._recordWatchdog) {
      clearInterval(this._recordWatchdog);
      this._recordWatchdog = null;
    }
    this._noFrameWarned = false;
  },

  /** stream 被浏览器原生停止共享时回收 */
  onRecordStreamEnded() {
    if (this.recordState === 'REGION_READY') {
      this.recordState = 'RECORDING_MODE';
      this.updateRecordPanel();
      this.setRecordStatus('录制源已停止，请重新获取区域');
    } else if (this.recordState === 'RECORDING') {
      // MediaRecorder 会自动停止 → onstop 下载 → onStateChange(false) 处理状态
      this.recordStream = null;
    }
  },

  /** 释放 screen stream（停止全部 track） */
  releaseRecordStream() {
    if (this.recordStream) {
      this.recordStream.getTracks().forEach(t => t.stop());
      this.recordStream = null;
    }
  },

  /** 按 recordState 刷新录制面板控件状态 */
  updateRecordPanel() {
    const recording = this.recordState === 'RECORDING';
    const ready = this.recordState === 'REGION_READY';
    document.querySelectorAll('input[name="record-ratio"]').forEach(r => { r.disabled = recording; });
    const heightInput = document.getElementById('input-record-height');
    if (heightInput) heightInput.disabled = recording;
    const btnGet = document.getElementById('btn-get-region');
    if (btnGet) {
      btnGet.disabled = recording;
      btnGet.textContent = ready ? '重新获取区域' : '获取录制区域';
    }
    const btnStart = document.getElementById('btn-start-record');
    if (btnStart) btnStart.disabled = !ready;
    const btnStop = document.getElementById('btn-stop-record');
    if (btnStop) btnStop.disabled = !recording;
  },

  setRecordStatus(text) {
    const el = document.getElementById('record-status');
    if (el) el.textContent = text;
  },
};

/** yaw → 屏幕旋转角：180 + yaw，归一化到 [0,360) */
function normalizeYawAngle(yaw) {
  let a = (180 + Number(yaw)) % 360;
  if (a < 0) a += 360;
  return a;
}

/** ms epoch → HH:MM:SS */
function fmtClock(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
