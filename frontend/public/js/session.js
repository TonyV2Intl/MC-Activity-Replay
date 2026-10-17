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
          '<button class="small" onclick="event.stopPropagation();sessionPage.exportSession(' + s.id + ',\'json\')">JSON</button> ' +
          '<button class="small" onclick="event.stopPropagation();sessionPage.exportSession(' + s.id + ',\'csv\')">CSV</button> ' +
          '<button class="small danger" onclick="event.stopPropagation();sessionPage.remove(' + s.id + ')">删除</button>' +
        '</td>' +
      '</tr>';
    }).join('');

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
