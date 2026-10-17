/**
 * console.js — 控制台逻辑：记录控制、实时监控、配置、密码、数据库导入导出、错误日志
 */

const consolePage = {
  statusTimer: null,
  liveTimer: null,

  init() {
    this.refreshStatus();
    this.loadConfig();
    this.statusTimer = setInterval(() => this.refreshStatus(), 2000);
    this.liveTimer = setInterval(() => this.refreshLive(), 2000);

    document.getElementById('select-filter-mode').addEventListener('change', e => {
      document.getElementById('filter-inputs').style.display =
        e.target.value === 'all' ? 'none' : 'flex';
    });
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
      if (recording) this.refreshLive();
    } catch (e) {
      document.getElementById('collector-badge').textContent = 'IDLE';
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
        return;
      }
      el.innerHTML = live.players.map(p =>
        '<div class="live-player">' +
          '<img src="' + esc(avatarURL(p.uuid, 32)) + '" alt="" loading="lazy">' +
          '<div class="info">' +
            '<div class="name">' + esc(p.name) + '</div>' +
            '<div class="coords">x: ' + Math.round(p.x) + '  z: ' + Math.round(p.z) +
              (p.health != null ? '  ❤ ' + p.health : '') +
              (p.armor != null ? '  🛡 ' + p.armor : '') + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
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
      document.getElementById('cfg-mtr-url').value = cfg.mtr_url || '';
      document.getElementById('cfg-squaremap-url').value = cfg.squaremap_url || '';
      document.getElementById('cfg-tile-template').value = cfg.tile_url_template || '';
      document.getElementById('cfg-world').value = cfg.default_world || '';
      document.getElementById('cfg-tile-zoom').value = cfg.default_tile_zoom || 3;
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
            tile_url_template: document.getElementById('cfg-tile-template').value.trim(),
            default_world: document.getElementById('cfg-world').value.trim(),
            default_tile_zoom: document.getElementById('cfg-tile-zoom').value.trim(),
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
};
