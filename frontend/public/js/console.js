/**
 * console.js — 控制台逻辑：记录控制、实时监控、配置、密码、数据库导入导出、错误日志
 */

const consolePage = {
  statusTimer: null,
  liveTimer: null,
  liveIntervalMs: null, // 实时监控自动刷新间隔（跟随记录轮询间隔；0 = 已停止自动刷新）
  recording: false, // 是否正在记录（决定实时监控自动刷新/手动刷新）

  // MTR 站线名称表（ID → 名称，来自 /api/network/names；未加载时为 null，回退原始 ID）
  network: null,

  // 速度推算：'2' = 最新两点，'3' = 三点平均（localStorage 持久化）
  speedMode: '2',
  speedHistory: new Map(), // uuid -> [{x, z, t}]（t 取后端 polledAt，最多保留 3 个）

  // 实时监控卡片栏目显示开关（localStorage 持久化；名字/头像始终显示）
  liveFields: { coords: true, speed: true, health: true, armor: true, station: true, route: true },

  init() {
    this.refreshStatus();
    this.loadConfig();
    this.statusTimer = setInterval(() => this.refreshStatus(), 2000);
    this.setLiveInterval(2000); // status 就绪前先用 2s，之后按轮询间隔自动调整

    // MTR 站线名称表：后台加载不阻塞控制台渲染（上游响应约 2MB，
    // 慢速链路下可达数分钟）；就绪前实时监控的站点/线路回退显示原始 ID
    api('/network/names')
      .then((n) => { this.network = { stations: n.stations || {}, routes: n.routes || {} }; })
      .catch(() => { /* 忽略 */ });

    // 速度推算模式（localStorage，跨会话保持）
    try {
      this.speedMode = localStorage.getItem('mc-console.speedMode') || '2';
      const savedLive = JSON.parse(localStorage.getItem('mc-console.liveFields') || 'null');
      this.liveFields = Object.assign({}, this.liveFields, savedLive || {});
    } catch (e) { /* 隐私模式等场景忽略 */ }
    const radios = document.querySelectorAll('input[name="live-speed-mode"]');
    radios.forEach((r) => {
      r.checked = r.value === this.speedMode;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this.speedMode = r.value;
        try { localStorage.setItem('mc-console.speedMode', r.value); } catch (e) { /* 忽略 */ }
        this.refreshLive();
      });
    });

    // 实时监控卡片栏目开关（localStorage，跨会话保持；切换后立即刷新）
    document.querySelectorAll('.live-field').forEach((cb) => {
      cb.checked = !!this.liveFields[cb.value];
      cb.addEventListener('change', () => {
        this.liveFields[cb.value] = cb.checked;
        try { localStorage.setItem('mc-console.liveFields', JSON.stringify(this.liveFields)); } catch (e) { /* 忽略 */ }
        this.refreshLive();
      });
    });

    document.getElementById('select-filter-mode').addEventListener('change', e => {
      document.getElementById('filter-inputs').style.display =
        e.target.value === 'all' ? 'none' : 'flex';
    });

    // MTR 采集总开关：切换时显隐 MTR 配置与字段区
    document.getElementById('cfg-mtr-enabled').addEventListener('change', () => {
      this.toggleMtrSection();
    });
  },

  // ---------- 配置辅助 ----------

  /** 配置值是否为“显式 false”（与后端 parseBoolDefault 对应；空值/缺省交调用方用默认值） */
  cfgIsFalse(v) {
    return v === 'false' || v === '0' || v === 'no' || v === 'off';
  },

  /** 读取某个采集字段复选框的值（'true' / 'false'） */
  collectVal(field) {
    const el = document.querySelector('.cfg-collect[value="' + field + '"]');
    return (el && el.checked) ? 'true' : 'false';
  },

  /** MTR 总开关切换：显隐 MTR 配置与字段区 */
  toggleMtrSection() {
    const on = document.getElementById('cfg-mtr-enabled').checked;
    document.getElementById('cfg-mtr-section').style.display = on ? '' : 'none';
  },

  // ---------- 采集状态 ----------

  async refreshStatus() {
    try {
      const st = await api('/collector/status');
      const badge = document.getElementById('collector-badge');
      const recording = st.status === 'recording';
      badge.textContent = recording ? 'RECORDING' : 'IDLE';
      badge.className = 'badge ' + (recording ? 'recording' : 'idle');
      document.getElementById('btn-start').disabled = recording;
      document.getElementById('btn-stop').disabled = !recording;

      // 已记录时长
      const timerEl = document.getElementById('session-timer');
      if (recording && st.startedAt) {
        const started = new Date(st.startedAt).getTime();
        const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
        timerEl.textContent = '已记录 ' + fmtDuration(elapsed) +
          (st.pollInterval ? ' · 间隔 ' + st.pollInterval + 'ms' : '') +
          (st.playerCount != null ? ' · 在线 ' + st.playerCount : '');
      } else {
        timerEl.textContent = '';
      }

      // 错误日志
      this.renderErrors(st.errors || []);
      this.recording = recording;
      if (recording) {
        this.refreshLive();
        // 实时监控刷新间隔与记录轮询间隔保持一致
        const iv = st.pollInterval || (this.cfg && Number(this.cfg.default_poll_interval_ms)) || 2000;
        this.setLiveInterval(iv);
      } else {
        // 未开始记录：停止自动刷新，改用面板上的「刷新」按钮手动查看最后快照
        this.setLiveInterval(0);
      }
    } catch (e) {
      document.getElementById('collector-badge').textContent = 'IDLE';
    }
  },

  /** 设置实时监控自动刷新间隔（仅在变化时重建定时器）；传 0 表示停止自动刷新 */
  setLiveInterval(ms) {
    if (!ms || Number(ms) <= 0) {
      this.liveIntervalMs = 0;
      if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; }
      this.updateLiveHint(null);
      return;
    }
    ms = Math.max(200, Number(ms) || 2000);
    if (this.liveIntervalMs === ms) return;
    this.liveIntervalMs = ms;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => this.refreshLive(), ms);
    this.updateLiveHint(null);
  },

  /** 更新实时监控标题旁的间隔/更新时间提示 */
  updateLiveHint(live) {
    const hint = document.getElementById('live-interval-hint');
    if (!hint) return;
    if (this.recording) {
      const at = live && live.polledAt ? ' · 更新于 ' + fmtTime(live.polledAt) : '';
      hint.textContent = '每 ' + this.liveIntervalMs + 'ms 刷新' + at;
    } else if (live && live.sessionId) {
      const at = live.polledAt ? ' · 快照更新于 ' + fmtTime(live.polledAt) : '';
      hint.textContent = '未在记录 · 自动刷新已停止' + at;
    } else {
      hint.textContent = '未在记录 · 自动刷新已停止，点击「刷新」查看最后快照';
    }
  },

  renderErrors(errors) {
    const el = document.getElementById('error-log');
    if (!errors.length) {
      el.innerHTML = '<span class="empty">暂无错误</span>';
      return;
    }
    el.innerHTML = errors.slice().reverse().map(e =>
      '<div class="entry"><span class="t">' + esc(fmtTime(e.time)) + '</span>' + esc(e.message) + '</div>'
    ).join('');
  },

  // ---------- 实时监控 ----------

  async refreshLive() {
    try {
      const live = await api('/collector/live');
      const el = document.getElementById('live-players');
      if (!live.sessionId || !live.players || !live.players.length) {
        el.innerHTML = '<span class="hint">未在记录中</span>';
        this.updateLiveHint(null);
        return;
      }
      // 记录坐标历史用于速度推算（时间戳取后端 polledAt，与采集时刻一致；
      // 同一 polledAt 的重复刷新不重复记点）
      const t = live.polledAt ? new Date(live.polledAt).getTime() : Date.now();
      for (const p of live.players) {
        let hist = this.speedHistory.get(p.uuid);
        if (!hist) { hist = []; this.speedHistory.set(p.uuid, hist); }
        const lastPt = hist[hist.length - 1];
        if (!lastPt || lastPt.t !== t) {
          hist.push({ x: p.x, z: p.z, t });
          if (hist.length > 3) hist.shift();
        }
      }
      // 清理已下线玩家的历史，防止长时间记录时 Map 无限增长
      const online = new Set(live.players.map(p => p.uuid));
      for (const uuid of this.speedHistory.keys()) {
        if (!online.has(uuid)) this.speedHistory.delete(uuid);
      }
      this.updateLiveHint(live);
      const fields = this.liveFields || {};
      el.innerHTML = live.players.map(p => {
        let html = '<div class="live-player">' +
          '<img src="' + esc(avatarURL(p.uuid)) + '" alt="" loading="lazy">' +
          '<div class="info">' +
          '<div class="name">' + esc(p.name) + '</div>';
        if (fields.coords) {
          html += '<div class="coords">x: ' + Math.round(p.x) + '  z: ' + Math.round(p.z) + '</div>';
        }
        // 速度推算（格/秒，按用户选择的两点/三点模式）
        if (fields.speed) {
          const speed = calcSpeed(this.speedHistory.get(p.uuid), this.speedMode);
          if (speed != null) {
            html += '<div class="transit">速度: ' + speed.toFixed(1) + ' 格/s</div>';
          }
        }
        // 生命值/护甲（未采集时为 null，不显示）
        if (fields.health && p.health != null) {
          html += '<div class="transit">血量: ' + p.health + '</div>';
        }
        if (fields.armor && p.armor != null) {
          html += '<div class="transit">护甲: ' + p.armor + '</div>';
        }
        // MTR 乘坐状态：站点 + 线路（仅显示名称；名称表未就绪时回退原始 ID）
        if (fields.station || fields.route) {
          const r = resolveTransit({
            station: normTransitId(p.station_id),
            route: normTransitId(p.route_id),
            rs1: normTransitId(p.route_station_id1),
            rs2: normTransitId(p.route_station_id2),
          }, this.network);
          if (fields.station && r.stationName) {
            html += '<div class="transit">站点: ' + esc(r.stationName) + '</div>';
          }
          if (fields.route && r.routeName) {
            html += '<div class="transit">线路: ' + esc(r.routeName) +
              (r.fromName && r.toName ? ' ' + esc(r.fromName) + ' → ' + esc(r.toName) : '') +
              '</div>';
          }
        }
        return html + '</div></div>';
      }).join('');
    } catch (e) { /* 静默 */ }
  },

  // ---------- 记录控制 ----------

  async startRecording() {
    const errEl = document.getElementById('recording-error');
    errEl.textContent = '';
    const body = {};
    const maxDur = document.getElementById('input-max-duration').value.trim();
    if (maxDur) body.maxDurationSec = parseInt(maxDur, 10);
    const interval = document.getElementById('input-poll-interval').value.trim();
    if (interval) body.pollIntervalMs = parseInt(interval, 10);
    // 瓦片最大缩放等级：取配置页的默认值（后端亦有同等的 app_config 回退）
    const tileZoom = parseInt((this.cfg && this.cfg.default_tile_zoom) || '3', 10);
    if (!isNaN(tileZoom) && tileZoom >= 0) body.tileZoom = tileZoom;
    const filterMode = document.getElementById('select-filter-mode').value;
    if (filterMode !== 'all') {
      const lines = document.getElementById('input-filter').value
        .split('\n').map(s => s.trim()).filter(Boolean);
      if (!lines.length) {
        errEl.textContent = '请输入筛选的 UUID 或名称';
        return;
      }
      body.playerFilter = { mode: filterMode, uuids: [], names: [] };
      for (const line of lines) {
        if (/^[0-9a-f]{32}$/i.test(line.replace(/-/g, ''))) {
          body.playerFilter.uuids.push(formatUUID(line, false));
        } else {
          body.playerFilter.names.push(line);
        }
      }
    }
    try {
      await api('/collector/start', { method: 'POST', body });
      this.refreshStatus();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  async stopRecording() {
    const errEl = document.getElementById('recording-error');
    errEl.textContent = '';
    try {
      await api('/collector/stop', { method: 'POST' });
      this.refreshStatus();
      this.refreshLive();
      sessionPage.refresh();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  // ---------- 配置 ----------

  async loadConfig() {
    try {
      const data = await api('/config');
      const cfg = data.config || {};
      this.cfg = cfg; // 缓存，供 startRecording 读取瓦片最大缩放等级等默认值
      document.getElementById('cfg-mtr-url').value = cfg.mtr_url || '';
      document.getElementById('cfg-squaremap-url').value = cfg.squaremap_url || '';
      document.getElementById('cfg-mirror-url').value = cfg.mirror_url || '';
      document.getElementById('cfg-tile-zoom').value = cfg.default_tile_zoom || 3;
      // 采集标志（缺省时用系统默认：MTR 与 MTR 字段开、health/armor 关）
      document.getElementById('cfg-mtr-enabled').checked =
        cfg.default_mtr_enabled === undefined ? true : !this.cfgIsFalse(cfg.default_mtr_enabled);
      const collectDefaults = {
        station_id: true, route_id: true, route_station1: true, route_station2: true,
        health: false, armor: false,
      };
      for (const [field, def] of Object.entries(collectDefaults)) {
        const el = document.querySelector('.cfg-collect[value="' + field + '"]');
        if (!el) continue;
        const v = cfg['default_collect_' + field];
        el.checked = v === undefined ? def : !this.cfgIsFalse(v);
      }
      this.toggleMtrSection();
    } catch (e) { /* 静默 */ }
  },

  async saveConfig() {
    const okEl = document.getElementById('config-ok');
    const errEl = document.getElementById('config-error');
    okEl.textContent = '';
    errEl.textContent = '';
    try {
      await api('/config', {
        method: 'PUT',
        body: {
          config: {
            mtr_url: document.getElementById('cfg-mtr-url').value.trim(),
            squaremap_url: document.getElementById('cfg-squaremap-url').value.trim(),
            mirror_url: document.getElementById('cfg-mirror-url').value.trim(),
            default_tile_zoom: document.getElementById('cfg-tile-zoom').value.trim(),
            default_mtr_enabled: document.getElementById('cfg-mtr-enabled').checked ? 'true' : 'false',
            default_collect_station_id: this.collectVal('station_id'),
            default_collect_route_id: this.collectVal('route_id'),
            default_collect_route_station1: this.collectVal('route_station1'),
            default_collect_route_station2: this.collectVal('route_station2'),
            default_collect_health: this.collectVal('health'),
            default_collect_armor: this.collectVal('armor'),
          },
        },
      });
      okEl.textContent = '已保存';
      setTimeout(() => { okEl.textContent = ''; }, 3000);
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  // ---------- 修改密码 ----------

  async changePassword() {
    const okEl = document.getElementById('pwd-ok');
    const errEl = document.getElementById('pwd-error');
    okEl.textContent = '';
    errEl.textContent = '';
    try {
      await api('/auth/password', {
        method: 'POST',
        body: {
          old: document.getElementById('pwd-old').value,
          new: document.getElementById('pwd-new').value,
        },
      });
      okEl.textContent = '密码已修改';
      document.getElementById('pwd-old').value = '';
      document.getElementById('pwd-new').value = '';
      setTimeout(() => { okEl.textContent = ''; }, 3000);
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  // ---------- 数据库导入导出 ----------

  exportDatabase() {
    // 直接浏览器下载（携带 Cookie）
    // 导出内容为全库数据快照（COPY 格式 SQL，兼容 psql 导入）
    location.href = '/api/database/export';
  },

  async importDatabase() {
    const errEl = document.getElementById('db-error');
    errEl.textContent = '';
    const fileInput = document.getElementById('db-import-file');
    if (!fileInput.files || !fileInput.files.length) {
      errEl.textContent = '请先选择 SQL 文件';
      return;
    }
    if (!confirm('导入将清空当前所有数据（包括全部会话与采集记录），并从快照文件重建数据库，确定继续吗？')) return;
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    try {
      const res = await fetch('/api/database/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('导入失败 (' + res.status + ')'));
      alert('数据库导入成功');
      sessionPage.refresh();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  // ---------- 一键清空数据库 ----------

  async wipeDatabase() {
    const errEl = document.getElementById('db-error');
    errEl.textContent = '';
    if (!confirm('确定要一键清空数据库吗？\n\n将删除全部会话与轨迹数据、恢复默认系统配置，并把管理员密码重置为初始密码。此操作不可恢复！')) return;
    if (!confirm('请再次确认：清空后所有历史记录将永久丢失，确定继续？')) return;
    try {
      const res = await fetch('/api/database/wipe', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('清空失败 (' + res.status + ')'));
      alert('数据库已清空（配置与密码已恢复初始状态），页面即将刷新');
      location.reload();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  // ---------- 单次会话导入（JSON/CSV） ----------
  async importSession() {
    const errEl = document.getElementById('session-import-error');
    const okEl = document.getElementById('session-import-ok');
    errEl.textContent = '';
    okEl.textContent = '';
    const fileInput = document.getElementById('session-import-file');
    if (!fileInput.files || !fileInput.files.length) {
      errEl.textContent = '请先选择 JSON 或 CSV 文件';
      return;
    }
    const file = fileInput.files[0];
    if (!/\.(json|csv)$/i.test(file.name)) {
      errEl.textContent = '仅支持 .json 或 .csv 文件';
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/sessions/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('导入失败 (' + res.status + ')'));
      okEl.textContent = '已导入会话「' + (data.name || file.name) + '」（ID ' + data.sessionId + '）';
      fileInput.value = '';
      sessionPage.refresh();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },
};
