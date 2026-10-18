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

const replayPage = {
  /* ---------- 状态 ---------- */
  sessionId: null,
  session: null,
  map: null,
  tileLayer: null,

  players: [],              // [{uuid, name, pointCount}]
  tracks: new Map(),        // uuid -> track 对象
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

  /* ---------- 初始化 ---------- */
  async init() {
    const params = new URLSearchParams(location.search);
    const id = parseInt(params.get('session') || '', 10);
    if (!id) {
      location.href = '/index.html';
      return;
    }
    this.sessionId = id;

    try {
      this.session = await api('/sessions/' + id);
    } catch (e) {
      this.setLoadStatus('加载会话失败: ' + e.message);
      return;
    }
    document.title = '回放 — ' + (this.session.name || ('会话 ' + id));

    this.initMap();
    this.bindControls();

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

    this.tileLayer = createSquaremapTileLayer(
      s.squaremap_url, s.tile_url_template, s.world, s.tile_zoom || 3, TileConfig.extraZoom || 2);
    this.tileLayer.addTo(this.map);

    // 用户手动拖动地图时自动取消跟随（panTo 不触发 dragstart，不会自我取消）
    this.map.on('dragstart', () => {
      if (this.followUuid) this.setFollow(null);
    });

    window.addEventListener('resize', () => this.map && this.map.invalidateSize());
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

      label.append(cb, img, name, count, followBtn);
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
      if (this.tracks.has(uuid)) return;
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

  /**
   * 加载单个玩家完整轨迹（分块并行请求）。
   * 返回后若复选框已取消（竞态），立即移除。
   */
  async loadTrack(uuid) {
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

    // 加载期间用户可能已取消勾选
    const cb = document.querySelector(`#player-list input[data-uuid="${uuid}"]`);
    if (cb && !cb.checked) this.removeTrack(uuid);
  },

  /** 由原始点构建 TrackPlayer（<2 个点退化为普通标记） */
  buildTrack(uuid, name, points) {
    if (!points.length) return;
    const n = points.length;
    const times = new Array(n);
    const latlngs = new Array(n);
    const yaws = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      times[i] = new Date(p.time).getTime();
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

    const color = PLAYER_COLORS[this.colorIndex % PLAYER_COLORS.length];
    this.colorIndex++;

    const icon = L.icon({
      iconUrl: avatarURL(uuid),
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const track = { uuid, name, color, times, latlngs, yaws, seg, cum, total, tp: null, marker: null };

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
    } else {
      // 单点轨迹：插件要求至少 2 个坐标，退化为普通头像标记
      track.marker = L.marker(latlngs[0], { icon }).addTo(this.map);
      track.marker.bindTooltip(name, { direction: 'top', offset: [0, -14] });
    }

    this.tracks.set(uuid, track);

    // 首个轨迹加载后自动适配视野
    if (this.tracks.size === 1) {
      this.map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
    }
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
        // 时间范围外的玩家标记淡化
        const out = loc.before || loc.after;
        if (track.tp.marker) {
          track.tp.marker.setOpacity(out ? 0.25 : 1);
        }
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
    // 进入录制模式即启动录屏（用户需在浏览器弹窗中选择"当前标签页"）
    try {
      await this.toggleRecord();
    } catch (e) {
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
