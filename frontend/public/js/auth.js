/**
 * auth.js — 登录逻辑（login.html）与登录态守卫（index.html / replay.html）
 */

// 登录页逻辑
async function doLogin() {
  const pwdInput = document.getElementById('password');
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const password = pwdInput.value;
  if (!password) {
    errEl.textContent = '请输入密码';
    return;
  }
  btn.disabled = true;
  errEl.textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password } });
    location.href = '/index.html';
  } catch (e) {
    errEl.textContent = e.message || '登录失败';
    btn.disabled = false;
  }
}

// 控制台/回放页守卫：未登录则跳转登录页
async function guardAuth() {
  try {
    await api('/auth/check');
    return true;
  } catch (e) {
    location.href = '/login.html';
    return false;
  }
}

// 退出登录
async function doLogout() {
  try { await api('/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  location.href = '/login.html';
}
