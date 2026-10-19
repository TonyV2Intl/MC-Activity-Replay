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
// 用虚线绘制以区别于正常步行轨迹
const DASH_JUMP_BLOCKS = 1000;
const DASH_PATTERN = '12 9'; // 虚线段样式（屏幕像素单位，不随缩放变化）

// tooltip 栏目默认显示开关（localStorage 持久化，键：mc-replay.tipFields）
const DEFAULT_TIP_FIELDS = { name: true, coords: true, speed: true, station: true, route: true };

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
  recordingMode: false,

  pointTimes: [],           // 所有已加载轨迹点的去重时间戳（步进用）

  followUuid: null,         // 画面中心跟随的玩家 uuid（null = 不跟随）
  tooltipPermanent: false,  // 玩家名字 tooltip 是否常显（false = 仅悬停显示）
  speedMode: '2',           // tooltip 速度推算模式：'2' = 最新两点，'3' = 三点平均
  tipFields: null,          // tooltip 栏目显示开关（名字/坐标/速度/站点/线路）

  dashJump: true,           // 超 1000 格跳跃段是否用虚线连接（localStorage 持久化）
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
    // 瓦片代理 / 虚线连接 / 玩家轨迹颜色
    try {
      this.tooltipPermanent = localStorage.getItem('mc-replay.tooltipPermanent') === '1';
      this.speedMode = localStorage.getItem('mc-replay.speedMode') || '2';
      this.tileProxy = localStorage.getItem('mc-replay.tileProxy') === '1';
      this.dashJump = localStorage.getItem('mc-replay.dashJump') !== '0';
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
  },

  /** 切换「瓦片经服务器代理」（localStorage 持久化，切换后立即重建图层） */
  setTileProxy(on) {
    this.tileProxy = !!on;
    try {
      localStorage.setItem('mc-replay.tileProxy', this.tileProxy ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    this.buildTileLayer();
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
    bar.addEventListener('input', () => {
      this.scrubbing = true;
      if (this.t1 > this.t0) {
        this.currentTime = this.t0 + (Number(bar.value) / 100) * (this.t1 - this.t0);
        this.render();
      }
    });
    const endScrub = () => { this.scrubbing = false; };
    bar.addEventListener('change', endScrub);
    bar.addEventListener('pointerup', endScrub);

    // 键盘快捷键：空格 播放/暂停，左右方向键 步进
    document.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); this.stepPrev(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); this.stepNext(); }
      else if (e.code === 'Escape' && this.recordingMode) { this.exitRecordingMode(); }
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

    // 跳跃段虚线连接开关（偏好持久化到 localStorage，切换后重建全部已加载轨迹）
    const dashCb = document.getElementById('check-dash-jump');
    if (dashCb) {
      dashCb.checked = this.dashJump;
      dashCb.addEventListener('change', () => this.setDashJump(dashCb.checked));
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

    Recorder.onStateChange = (recording) => {
      const btn = document.getElementById('btn-record');
      if (btn) btn.textContent = recording ? '停止录制' : '开始录制';
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
      label.title = p.uuid;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.uuid = p.uuid;
      cb.addEventListener('change', () => this.togglePlayer(p.uuid, cb.checked));

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

      // 轨迹颜色：色板指定 + 「自动」清除指定（恢复自动分配）
      const colorBox = document.createElement('span');
      colorBox.className = 'color-box';

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'player-color';
      colorInput.dataset.uuid = p.uuid;
      colorInput.value = this.playerColors[p.uuid] || PLAYER_COLORS[0];
      colorInput.title = '指定该玩家轨迹颜色（默认按加载顺序自动分配）';
      // 位于 label 内，需阻止事件冒泡，避免点击色板误触发行迹加载复选框
      colorInput.addEventListener('click', (e) => e.stopPropagation());
      colorInput.addEventListener('change', () => this.setPlayerColor(p.uuid, colorInput.value));

      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'color-auto';
      autoBtn.textContent = '自动';
      autoBtn.title = '清除指定颜色，恢复自动分配';
      autoBtn.style.display = this.playerColors[p.uuid] ? '' : 'none';
      autoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.clearPlayerColor(p.uuid);
      });

      colorBox.append(colorInput, autoBtn);

      const followBtn = document.createElement('button');
      followBtn.type = 'button';
      followBtn.className = 'follow-btn';
      followBtn.dataset.uuid = p.uuid;
      followBtn.textContent = '跟随';
      followBtn.title = '画面中心跟随该玩家移动（拖动地图可取消）';
      followBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFollow(p.uuid);
      });

      label.append(cb, img, name, count, colorBox, followBtn);
      box.appendChild(label);
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
      const cb = document.querySelector(`#player-list input[data-uuid="${uuid}"]`);
      if (cb && !cb.checked) {
        cb.checked = true;
        await this.loadTrack(uuid);
      }
      if (!this.tracks.has(uuid)) return;      // 加载失败或被用户取消勾选
      if (this.followUuid) return;             // 加载期间用户已切换到其他玩家
    }
    this.setFollow(uuid);
  },

  /** 设置跟随目标并刷新按钮高亮；非 null 时立即居中一次 */
  setFollow(uuid) {
    this.followUuid = uuid;
    this.updateFollowButtons();
    if (uuid) this.render();
  },

  /** 同步所有跟随按钮的高亮状态 */
  updateFollowButtons() {
    const btns = document.querySelectorAll('#player-list .follow-btn');
    for (const btn of btns) {
      btn.classList.toggle('active', btn.dataset.uuid === this.followUuid);
    }
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
  transitAt(track, t) {
    const times = track.transitTimes;
    if (!times.length || t < times[0]) return null;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return track.transitRecs[lo];
  },

  /**
   * 组装 tooltip 内容：玩家名（专属颜色）+ 当前坐标 + 当前时刻的站点/线路名称。
   * 各栏目由 tipFields 开关控制（名字/坐标/速度/站点/线路），偏好持久化在 localStorage。
   * 坐标由 marker 当前渲染位置经 latLngToBlock 逆换算为方块坐标（取整显示）；
   * 仅显示站名/线路名（不显示 ID）；名称表未加载/未收录时回退为原始 ID。
   * @param {object} track  track 对象
   * @param {L.Marker} [marker] 头像标记（取其当前位置换算坐标）
   */
  tooltipHTML(track, marker) {
    const f = this.tipFields || DEFAULT_TIP_FIELDS;
    let html = '';
    if (f.name) {
      html += '<span style="color:' + track.color + '">' + esc(track.name) + '</span>';
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
    if (f.station || f.route) {
      const rec = this.transitAt(track, this.currentTime);
      if (rec) {
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

      // 加载 MTR 乘坐状态变化记录（失败不影响轨迹回放，tooltip 回退为仅玩家名）
      try {
        const data = await api(`/sessions/${this.sessionId}/players/${uuid}/transit`);
        // MTR 会用全零 ID 表示“无”（如 route_id = 0000000000000000），统一归一化为空
        const recs = (data.records || []).map((r) => ({
          t: new Date(r.time).getTime(),
          station: normTransitId(r.station_id),
          route: normTransitId(r.route_id),
          rs1: normTransitId(r.route_station_id1),
          rs2: normTransitId(r.route_station_id2),
        }));
        const track = this.tracks.get(uuid);
        if (track) {
          track.transitTimes = recs.map((r) => r.t);
          track.transitRecs = recs;
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

    // 段属性：相邻两点方块距离超过阈值判定为跳跃段（传送/重连），
    // 用户开启虚线选项时用虚线绘制，否则与普通段一致
    const dashed = new Array(n > 1 ? n - 1 : 0);
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const dz = zs[i + 1] - zs[i];
      dashed[i] = this.dashJump && Math.sqrt(dx * dx + dz * dz) > DASH_JUMP_BLOCKS;
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
      transitTimes: [],   // MTR 状态变化时间戳（ms，升序）
      transitRecs: [],    // 对应的状态记录 {t, station, route, rs1, rs2}
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
        track.tp.marker.options.rotationAngle = normalizeYawAngle(yaws[0]);
      }
      // 插件自带的 passed/notPassed 线整体隐藏（opacity:0；箭头装饰不受影响，
      // 仍沿 passed+notPassed 绘制），线条渲染交由下方按 run 分组的自建 polyline
      track.tp.passedLine.setStyle({ opacity: 0 });
      track.tp.notPassedLine.setStyle({ opacity: 0 });

      // 每个 run 两条 polyline：走过部分=玩家色，未走部分=半透明白；
      // 跳跃段（dash=true）加 dashArray 虚线
      for (const run of runs) {
        run.latlngs = latlngs.slice(run.startIdx, run.endIdx + 1);
        run.cumStart = cum[run.startIdx];
        run.cumEnd = cum[run.endIdx];
        const dashStyle = run.dash ? { dashArray: DASH_PATTERN } : {};
        run.passedLine = L.polyline([], Object.assign({
          color, weight: 4, opacity: 0.95, lineCap: 'butt',
        }, dashStyle)).addTo(this.map);
        run.notPassedLine = L.polyline(run.latlngs, Object.assign({
          color: 'rgba(255,255,255,0.3)', weight: 4, opacity: 1, lineCap: 'butt',
        }, dashStyle)).addTo(this.map);
        run.state = 0;      // 0=未开始 1=部分走过 2=已走过
        run.splitSeg = -1;  // 部分走过时的拆分段索引
        run.splitAlpha = 0; // 段内插值系数
      }
    } else {
      // 单点轨迹：插件要求至少 2 个坐标，退化为普通头像标记
      track.marker = L.marker(latlngs[0], { icon }).addTo(this.map);
    }

    // 玩家名 tooltip：多点轨迹（TrackPlayer 标记）与单点轨迹统一处理
    this.bindPlayerTooltip(track.tp ? track.tp.marker : track.marker, track);

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
    const transit = old.transitTimes.length
      ? { times: old.transitTimes, recs: old.transitRecs } : null;
    this.rebuilding = true;
    try {
      this.removeTrack(uuid);
      this.buildTrack(uuid, name, raw, keepColor);
    } finally {
      this.rebuilding = false;
    }
    const t = this.tracks.get(uuid);
    if (t && transit) {
      t.transitTimes = transit.times;
      t.transitRecs = transit.recs;
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

  /** 把玩家列表的颜色输入框同步为当前生效色（未加载且无指定时显示 palette 首色） */
  syncColorInputs() {
    document.querySelectorAll('#player-list input.player-color').forEach((inp) => {
      const uuid = inp.dataset.uuid;
      const track = this.tracks.get(uuid);
      inp.value = (track && track.color) || this.playerColors[uuid] || PLAYER_COLORS[0];
      const autoBtn = inp.parentElement.querySelector('.color-auto');
      if (autoBtn) autoBtn.style.display = this.playerColors[uuid] ? '' : 'none';
    });
  },

  /** 切换「超 1000 格跳跃段用虚线连接」（localStorage 持久化，重建全部已加载轨迹） */
  setDashJump(on) {
    this.dashJump = !!on;
    try {
      localStorage.setItem('mc-replay.dashJump', this.dashJump ? '1' : '0');
    } catch (e) { /* 隐私模式等场景忽略 */ }
    for (const uuid of [...this.tracks.keys()]) this.rebuildTrack(uuid);
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

  setSpeed(v) {
    this.speed = Number(v) || 1;
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
        // 旋转角需在 setProgress（内部 setLatLng → _setPos → _applyRotation）之前设置
        if (track.tp.marker) {
          track.tp.marker.options.rotationAngle = this.yawAngleAt(track, loc);
        }
        track.tp.setProgress(e);
        // 更新按 run 分组的折线：D = 当前累积距离（haversine），
        // 与 run.cumStart/cumEnd 比较得到 未开始 / 部分走过 / 已走过 三态，
        // 仅在状态或拆分位置变化时写 DOM（暂停/拖动时免去重复渲染）
        if (track.runs.length) {
          const D = e * track.total;
          for (const run of track.runs) {
            let st, segIdx = -1, alpha = 0;
            if (D >= run.cumEnd) st = 2;
            else if (D <= run.cumStart) st = 0;
            else {
              st = 1;
              let i = run.startIdx;
              while (i < run.endIdx - 1 && track.cum[i + 1] <= D) i++;
              const segLen = track.seg[i] || 0;
              alpha = segLen > 0 ? (D - track.cum[i]) / segLen : 0;
              segIdx = i;
            }
            if (run.state === st &&
                (st !== 1 || (run.splitSeg === segIdx && Math.abs(run.splitAlpha - alpha) < 1e-9))) {
              continue;
            }
            run.state = st;
            run.splitSeg = segIdx;
            run.splitAlpha = alpha;
            if (st === 0) {
              run.passedLine.setLatLngs([]);
              run.notPassedLine.setLatLngs(run.latlngs);
            } else if (st === 2) {
              run.passedLine.setLatLngs(run.latlngs);
              run.notPassedLine.setLatLngs([]);
            } else {
              // 部分走过：在拆分段内线性插值出当前位置点，前后两半分别着色
              const a = track.latlngs[segIdx];
              const b = track.latlngs[segIdx + 1];
              const mid = L.latLng(a.lat + (b.lat - a.lat) * alpha, a.lng + (b.lng - a.lng) * alpha);
              run.passedLine.setLatLngs(track.latlngs.slice(run.startIdx, segIdx + 1).concat([mid]));
              run.notPassedLine.setLatLngs([mid].concat(track.latlngs.slice(segIdx + 1, run.endIdx + 1)));
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

    // 进度条（用户拖动时不回写，避免抖动）
    const bar = document.getElementById('progress-bar');
    if (bar && !this.scrubbing) {
      bar.value = (this.t1 > this.t0) ? Math.round(((t - this.t0) / (this.t1 - this.t0)) * 100) : 0;
    }

    // 右上角时间戳（录制时合成进视频）
    const tsEl = document.getElementById('replay-timestamp');
    if (tsEl) tsEl.textContent = fmtTime(t);
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

  /* ---------- 录制模式 ---------- */
  /**
   * 进入/退出录制模式：隐藏所有 UI 只留地图与时间戳。
   * 按任务书要求，进入录制模式即同时启动录屏（弹出浏览器源选择框）。
   */
  toggleRecordingMode() {
    if (this.recordingMode) {
      this.exitRecordingMode();
    } else {
      this.enterRecordingMode();
    }
  },

  async enterRecordingMode() {
    this.recordingMode = true;
    document.body.classList.add('recording-mode');
    document.getElementById('btn-record-mode').textContent = '退出录制模式';
    document.getElementById('btn-record').style.display = '';
    setTimeout(() => this.map && this.map.invalidateSize(), 60);
    // 进入录制模式即启动录屏（用户需在浏览器弹窗中选择"当前标签页"）。
    // 失败（如用户取消选择屏幕源）时退出录制模式，避免界面停留在
    // 控制面板全隐藏的状态（只能靠 Esc 恢复）
    try {
      await this.toggleRecord();
    } catch (e) {
      this.exitRecordingMode();
      this.setLoadStatus('录屏启动失败: ' + e.message);
    }
  },

  exitRecordingMode() {
    this.recordingMode = false;
    document.body.classList.remove('recording-mode');
    document.getElementById('btn-record-mode').textContent = '进入录制模式';
    document.getElementById('btn-record').style.display = 'none';
    if (Recorder.isRecording()) Recorder.stop();
    setTimeout(() => this.map && this.map.invalidateSize(), 60);
  },

  /** 开始/停止录屏（停止后自动下载 webm） */
  async toggleRecord() {
    const btn = document.getElementById('btn-record');
    if (Recorder.isRecording()) {
      Recorder.stop();
      return;
    }
    btn.disabled = true;
    try {
      await Recorder.start();
      btn.textContent = '停止录制';
    } catch (e) {
      btn.textContent = '开始录制';
      throw e;
    } finally {
      btn.disabled = false;
    }
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
