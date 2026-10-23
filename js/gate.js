/**
 * P0 加固 · 登录门禁（admin / console / ops / dashboard 页面共用）
 * - 账号存于 svc_admin_users（加盐 SHA-256 哈希，库中无明文）
 * - 会话存 sessionStorage，8 小时过期
 * - 登录前整页遮罩阻断；登录后按角色对接 RBAC
 * 生产替换位：对接云服务 Auth / 企业 SSO，本模块仅替换 verifyLogin 与 session 签发。
 */

const GATE_ROLES = ['admin', 'ops', 'agent', 'readonly'];
const GATE_SESSION_KEY = 'gate_session';
const GATE_TTL_MS = 8 * 3600 * 1000;

/** 纯函数：加盐 SHA-256 → hex */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 纯函数：会话对象校验（过期/角色非法/字段缺失一律无效；t=服务端会话 token） */
function validateSession(s, now) {
  if (!s || typeof s !== 'object') return false;
  if (!s.u || !s.t || !GATE_ROLES.includes(s.r)) return false;
  return Number(s.exp) > now;
}

function gateReadSession() {
  try { return JSON.parse(sessionStorage.getItem(GATE_SESSION_KEY)); } catch (e) { return null; }
}

/** 当前会话（有效则返回，否则 null） */
function gateSession() {
  const s = gateReadSession();
  return validateSession(s, Date.now()) ? s : null;
}

/** 渲染全屏登录遮罩，返回 {resolve} 由登录成功触发 */
function renderGateOverlay(onSuccess) {
  const ov = document.createElement('div');
  ov.id = 'gate-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.62);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:28px 30px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:system-ui,-apple-system,'PingFang SC',sans-serif">
      <div style="font-size:19px;font-weight:700;color:#0f172a;margin-bottom:4px">🔐 电商AI助手 · 管理端登录</div>
      <div style="font-size:12px;color:#64748b;margin-bottom:18px">请使用运营账号登录（会话 8 小时有效）</div>
      <input id="gate-user" placeholder="用户名" autocomplete="username"
        style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:10px;font-size:14px">
      <input id="gate-pass" type="password" placeholder="密码" autocomplete="current-password"
        style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:12px;font-size:14px">
      <div id="gate-err" style="color:#dc2626;font-size:12px;min-height:16px;margin-bottom:6px"></div>
      <button id="gate-btn" style="width:100%;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer">登 录</button>
    </div>`;
  document.body.appendChild(ov);
  const err = ov.querySelector('#gate-err');
  const btn = ov.querySelector('#gate-btn');
  async function tryLogin() {
    const u = ov.querySelector('#gate-user').value.trim();
    const p = ov.querySelector('#gate-pass').value;
    if (!u || !p) { err.textContent = '请输入用户名和密码'; return; }
    btn.disabled = true; btn.textContent = '验证中…'; err.textContent = '';
    try {
      const ok = await gateVerifyLogin(u, p);
      if (!ok.ok) { err.textContent = ok.reason; btn.disabled = false; btn.textContent = '登 录'; return; }
      sessionStorage.setItem(GATE_SESSION_KEY, JSON.stringify({ u, r: ok.role, t: ok.token, tn: ok.tenant || 'T001', exp: ok.exp || Date.now() + GATE_TTL_MS }));
      ov.remove();
      onSuccess({ u, r: ok.role });
    } catch (e) {
      err.textContent = '登录服务异常：' + (e.message || e);
      btn.disabled = false; btn.textContent = '登 录';
    }
  }
  btn.onclick = tryLogin;
  ov.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
  ov.querySelector('#gate-user').focus();
}

/** 校验登录（服务端 admin_login 函数：库内哈希比对+签发会话 token），仅供模块内部与测试使用 */
async function gateVerifyLogin(username, password) {
  if (typeof cloud === 'undefined' || !cloud) return { ok: false, reason: '云服务未初始化' };
  const { data, error } = await cloud.database.rpc('admin_login', { p_username: username, p_password: password });
  if (error) return { ok: false, reason: '登录服务异常：' + (error.message || JSON.stringify(error)) };
  if (!data || data.ok !== true) return { ok: false, reason: (data && data.reason) || '用户名或密码错误' };
  if (!GATE_ROLES.includes(data.role)) return { ok: false, reason: '账号角色异常，请联系管理员' };
  return { ok: true, role: data.role, token: data.token, tenant: data.tenant || 'T001', exp: data.exp };
}

/** 页面入口：等待有效会话（无则弹登录框）。所有管理页初始化前必须 await。 */
function gateRequire() {
  return new Promise((resolve) => {
    const s = gateSession();
    if (s) { resolve(s); return; }
    sessionStorage.removeItem(GATE_SESSION_KEY);
    renderGateOverlay(resolve);
  });
}

function gateLogout() {
  sessionStorage.removeItem(GATE_SESSION_KEY);
  location.reload();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GATE_ROLES, GATE_TTL_MS, sha256Hex, validateSession, gateSession, gateVerifyLogin, gateRequire, gateLogout };
}
if (typeof window !== 'undefined') {
  window.Gate = { ROLES: GATE_ROLES, session: gateSession, require: gateRequire, logout: gateLogout, verify: gateVerifyLogin, sha256Hex, validateSession };
}
