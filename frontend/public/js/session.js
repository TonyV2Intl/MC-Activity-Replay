/**
 * session.js — 会话管理：列表、重命名、删除、合并、导出
 */

const sessionPage = {
  sessions: [],
  selected: new Set(),

  init() {
    this.refresh();
    document.getElementById('check-all').addEventListener('change', e => {
      this.selected.clear();
      if (e.target.checked) {
        this.sessions.forEach(s => this.selected.add(s.id));
      }
      this.render();
    });

    // 「导出」格式选择菜单（点导出后选 JSON / CSV）
    const exportMenu = document.getElementById('session-export-menu');
    if (exportMenu) {
      exportMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-format]');
        if (!btn) return;
        this.exportSession(this._exportMenuSession, btn.dataset.format);
        this.closeExportMenu();
      });
    }

    // 时间段导出对话框
    const modal = document.getElementById('session-export-modal');
    if (modal) {
      document.getElementById('session-export-cancel').addEventListener('click', () => this.closePeriodExport());
      document.getElementById('session-export-ok').addEventListener('click', () => this.submitPeriodExport());
      modal.addEventListener('pointerdown', (e) => {
        if (e.target === modal) this.closePeriodExport();
      });
    }
  },

  async refresh() {
    const errEl = document.getElementById('session-error');
    try {
      const data = await api('/sessions');
      this.sessions = data.sessions || [];
      this.render();
    } catch (e) {
      errEl.textContent = e.message;
    }
  },

  render() {
    const tbody = document.getElementById('sessions-tbody');
    if (!this.sessions.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="hint">暂无会话，点击"开始记录"创建第一个会话</td></tr>';
      this.updateMergeButton();
      return;
    }
    tbody.innerHTML = this.sessions.map(s => {
      const dur = (s.started_at && s.stopped_at)
        ? Math.round((new Date(s.stopped_at) - new Date(s.started_at)) / 1000) : null;
      const checked = this.selected.has(s.id) ? 'checked' : '';
      const reason = s.stopped_reason ? ' <span class="hint">(' + esc(s.stopped_reason) + ')</span>' : '';
      return '<tr class="clickable' + (this.selected.has(s.id) ? ' selected' : '') + '" data-id="' + s.id + '">' +
        '<td><input type="checkbox" class="row-check" data-id="' + s.id + '" ' + checked + '></td>' +
        '<td>' + s.id + '</td>' +
        '<td>' + esc(s.name) + reason + '</td>' +
        '<td>' + esc(fmtTime(s.started_at)) + '</td>' +
        '<td>' + (s.stopped_at ? esc(fmtTime(s.stopped_at)) : '<span class="badge recording">进行中</span>') + '</td>' +
        '<td>' + (dur != null ? fmtDuration(dur) : '-') + '</td>' +
        '<td>' + fmtNum(s.player_count) + '</td>' +
        '<td>' + fmtNum(s.point_count) + '</td>' +
        '<td class="actions">' +
          '<button class="small" onclick="event.stopPropagation();sessionPage.rename(' + s.id + ')">重命名</button> ' +
          '<button class="small" data-export="' + s.id + '">导出</button> ' +
          '<button class="small" data-period="' + s.id + '">时间段导出</button> ' +
          '<button class="small danger" onclick="event.stopPropagation();sessionPage.remove(' + s.id + ')">删除</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    // 「导出」（选格式）/「时间段导出」按钮
    tbody.querySelectorAll('[data-export]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.openExportMenu(parseInt(btn.getAttribute('data-export'), 10), btn);
      });
    });
    tbody.querySelectorAll('[data-period]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.openPeriodExport(parseInt(btn.getAttribute('data-period'), 10));
      });
    });

    // 行点击 → 跳转回放页（进行中的会话不可回放）
    tbody.querySelectorAll('tr.clickable').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.closest('input,button')) return;
        const id = tr.getAttribute('data-id');
        const s = this.sessions.find(x => String(x.id) === id);
        if (s && !s.stopped_at) {
          alert('该会话仍在记录中，停止后可回放');
          return;
        }
        location.href = '/replay.html?session=' + id;
      });
    });
    // 复选框
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = parseInt(e.target.getAttribute('data-id'), 10);
        if (e.target.checked) this.selected.add(id); else this.selected.delete(id);
        this.render();
      });
    });
    this.updateMergeButton();
  },

  updateMergeButton() {
    document.getElementById('btn-merge').disabled = this.selected.size < 2;
  },

  async rename(id) {
    const s = this.sessions.find(x => x.id === id);
    const name = prompt('输入新的会话名称：', s ? s.name : '');
    if (!name || !name.trim()) return;
    try {
      await api('/sessions/' + id, { method: 'PATCH', body: { name: name.trim() } });
      this.refresh();
    } catch (e) {
      document.getElementById('session-error').textContent = e.message;
    }
  },

  async remove(id) {
    const s = this.sessions.find(x => x.id === id);
    if (!confirm('确定删除会话"' + (s ? s.name : id) + '"及其全部轨迹数据吗？此操作不可恢复！')) return;
    try {
      await api('/sessions/' + id, { method: 'DELETE' });
      this.selected.delete(id);
      this.refresh();
    } catch (e) {
      document.getElementById('session-error').textContent = e.message;
    }
  },

  exportSession(id, format) {
    location.href = '/api/sessions/' + id + '/export?format=' + format;
  },

  /* ---------- 导出：格式选择与时间段导出 ---------- */

  /** 在「导出」按钮下方弹出 JSON / CSV 选择菜单 */
  openExportMenu(id, anchor) {
    const menu = document.getElementById('session-export-menu');
    if (!menu) return;
    this._exportMenuSession = id;
    menu.hidden = false;

    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 130;
    const mh = menu.offsetHeight || 76;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    if (!this._exportMenuHandler) {
      this._exportMenuHandler = (ev) => {
        const m = document.getElementById('session-export-menu');
        if (!m || m.hidden) return;
        if (!m.contains(ev.target) && !ev.target.closest('[data-export]')) this.closeExportMenu();
      };
      document.addEventListener('pointerdown', this._exportMenuHandler, true);
    }
  },

  closeExportMenu() {
    const menu = document.getElementById('session-export-menu');
    if (menu) menu.hidden = true;
    if (this._exportMenuHandler) {
      document.removeEventListener('pointerdown', this._exportMenuHandler, true);
      this._exportMenuHandler = null;
    }
    this._exportMenuSession = null;
  },

  /** 打开时间段导出对话框：默认填入会话起止时间 */
  openPeriodExport(id) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    this._periodSession = id;
    const a = new Date(s.started_at).getTime();
    const b = s.stopped_at ? new Date(s.stopped_at).getTime() : Date.now();
    document.getElementById('session-export-title').textContent = '导出时间段 — ' + s.name;
    document.getElementById('session-export-start').value = toDatetimeLocal(a);
    document.getElementById('session-export-end').value = toDatetimeLocal(b);
    document.getElementById('session-export-modal').hidden = false;
  },

  closePeriodExport() {
    const m = document.getElementById('session-export-modal');
    if (m) m.hidden = true;
    this._periodSession = null;
  },

  /** 提交时间段导出：起止时间转 UTC 后请求导出 API（附件下载） */
  submitPeriodExport() {
    const id = this._periodSession;
    if (!id) return;
    const sEl = document.getElementById('session-export-start');
    const eEl = document.getElementById('session-export-end');
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
    const fmt = document.querySelector('input[name="session-export-format"]:checked').value;
    const url = '/api/sessions/' + id + '/export?format=' + fmt +
      '&start=' + encodeURIComponent(new Date(st).toISOString()) +
      '&end=' + encodeURIComponent(new Date(et).toISOString());
    this.closePeriodExport();
    location.href = url;
  },

  async mergeSelected() {
    const errEl = document.getElementById('session-error');
    errEl.textContent = '';
    const ids = Array.from(this.selected).sort((a, b) => a - b);
    if (ids.length < 2) return;
    const newName = prompt('合并后的新会话名称（留空自动生成）：', '');
    if (newName === null) return;
    try {
      await api('/sessions/merge', {
        method: 'POST',
        body: { sessionIds: ids, newName: newName.trim() || null },
      });
      this.selected.clear();
      this.refresh();
      alert('合并完成');
    } catch (e) {
      errEl.textContent = e.message;
    }
  },
};
