/**
 * api.js — API 封装与通用工具函数
 */

/** 统一请求封装：自动携带 Cookie，401 跳转登录页 */
async function api(path, options = {}) {
  const opts = Object.assign({}, options, { credentials: 'same-origin' });
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch (e) {
    throw new Error('网络请求失败: ' + e.message);
  }
  if (res.status === 401) {
    if (!location.pathname.endsWith('login.html')) {
      location.href = '/login.html';
    }
    throw new Error('未登录或会话已过期');
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) ? data.error : ('请求失败 (' + res.status + ')');
    throw new Error(msg);
  }
  return data;
}

/**
 * UUID 格式化：数据库存储无连字符小写 UUID，MCHeads 等需要带连字符形式。
 * formatUUID('bfc5393930794fce9cc0717d2cda7b44') => 'bfc53939-3079-4fce-9cc0-717d2cda7b44'
 */
function formatUUID(uuid, withHyphens) {
  const clean = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!withHyphens) return clean;
  if (clean.length !== 32) return clean;
  return clean.slice(0, 8) + '-' + clean.slice(8, 12) + '-' + clean.slice(12, 16) + '-' +
         clean.slice(16, 20) + '-' + clean.slice(20, 32);
}

/** MCHeads 头像 URL（需要带连字符 UUID） */
function avatarURL(uuid, size) {
  const s = size || 32;
  return 'https://mc-heads.net/avatar/' + formatUUID(uuid, true) + '/' + s;
}

/** 时间格式化：YYYY-MM-DD HH:mm:ss（本地时区） */
function fmtTime(t) {
  if (!t) return '-';
  const d = (t instanceof Date) ? t : new Date(t);
  if (isNaN(d.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
         pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** 时长格式化：秒 → "1:23:45" 或 "45s" */
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  sec = Math.floor(sec);
  if (sec < 60) return sec + 's';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

/** 数字千分位 */
function fmtNum(n) {
  if (n == null || isNaN(n)) return '-';
  return Number(n).toLocaleString('zh-CN');
}

/** 转义 HTML */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 显示错误信息到指定元素 */
function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
}
