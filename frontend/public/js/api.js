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
 * UUID 格式化：数据库存储无连字符小写 UUID。
 * formatUUID('bfc5393930794fce9cc0717d2cda7b44') => 'bfc53939-3079-4fce-9cc0-717d2cda7b44'
 * formatUUID('bfc53939-3079-4fce-9cc0-717d2cda7b44', false) => 'bfc5393930794fce9cc0717d2cda7b44'
 */
function formatUUID(uuid, withHyphens) {
  const clean = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!withHyphens) return clean;
  if (clean.length !== 32) return clean;
  return clean.slice(0, 8) + '-' + clean.slice(8, 12) + '-' + clean.slice(12, 16) + '-' +
         clean.slice(16, 20) + '-' + clean.slice(20, 32);
}

/** Minotar 头像 URL（UUID 直接拼接，无需带连字符；可带尺寸后缀如 /64） */
function avatarURL(uuid) {
  return 'https://minotar.net/avatar/' + formatUUID(uuid, false);
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

/**
 * MTR 全零 ID 归一化：route_id = 0000000000000000 等全零串表示“无”，
 * 统一归一为空字符串（数据库原始值即如此存储）。
 */
function normTransitId(v) {
  return (v && !/^0+$/.test(v)) ? v : '';
}

/**
 * 将 MTR 乘坐状态解析为可显示名称（回放 tooltip 与控制台实时监控共用）。
 * @param {object} rec     {station, route, rs1, rs2}（应先经 normTransitId 归一化）
 * @param {object|null} network {stations:{id:name}, routes:{id:name}}，null 时回退原始 ID
 * @returns {{stationName:string, routeName:string, fromName:string, toName:string}}
 */
function resolveTransit(rec, network) {
  const stations = network ? network.stations : {};
  const routes = network ? network.routes : {};
  const pick = (id, table) => (id ? (table[id] || id) : '');
  return {
    stationName: pick(rec.station, stations),
    routeName: pick(rec.route, routes),
    fromName: pick(rec.rs1, stations),
    toName: pick(rec.rs2, stations),
  };
}

/**
 * 速度推算（回放 tooltip 与控制台实时监控共用），单位：格/秒。
 * @param {Array<{x:number,z:number,t:number}>} pts 按时间升序的坐标点（t 为 ms epoch）
 * @param {string} mode '2' = 最新两点位移/时差；'3' = 最新三点（首末）位移/总时差（平均速度）
 * @returns {number|null} 点数不足或时差为 0 时返回 null
 */
function calcSpeed(pts, mode) {
  if (!pts || pts.length < 2) return null;
  const last = pts[pts.length - 1];
  let first;
  if (mode === '3' && pts.length >= 3) {
    first = pts[pts.length - 3];
  } else {
    first = pts[pts.length - 2];
  }
  const dt = (last.t - first.t) / 1000; // 秒
  if (dt <= 0) return null;
  return Math.hypot(last.x - first.x, last.z - first.z) / dt;
}

/** 显示错误信息到指定元素 */
function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
}
