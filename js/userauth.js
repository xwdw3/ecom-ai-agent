/* 用户侧登录注册（云服务官方 Auth · 手机号/邮箱 OTP 验证码，无密码）
 * 契约要点（官方 SDK 规范）：
 * - 先「获取验证码」sendOtp 保存 challenge（verificationId/isExistingUser），提交时 verifyOtp，不重发
 * - 手机号正则 /^1\d{10}$/，不通过则不发请求
 * - 换了手机号/邮箱必须重新取码；成功重发才替换已存 challenge
 * - 不向用户暴露"该账号是否已注册"
 */
(function (global) {
  'use strict';

  var UA = {
    cloud: null,
    user: null,          // 当前登录用户（session.user）
    _pending: null,      // { channel:'phone'|'email', target, verificationId, isExistingUser }
    _listeners: [],      // 登录态变化回调
    _countdownTimer: null,
  };

  UA.onChange = function (fn) { UA._listeners.push(fn); };
  function emit() {
    for (var i = 0; i < UA._listeners.length; i++) { try { UA._listeners[i](UA.user); } catch (e) { /* 忽略监听器异常 */ } }
  }

  UA.isLoggedIn = function () { return !!UA.user; };
  UA.displayName = function () {
    if (!UA.user) return '';
    return UA.user.phone || UA.user.email || (UA.user.name) || '用户';
  };
  /** 打码显示：138****8000 / a***@x.com */
  UA.maskedName = function () {
    var d = UA.displayName();
    if (!d) return '';
    if (/^1\d{10}$/.test(d)) return d.slice(0, 3) + '****' + d.slice(7);
    if (d.indexOf('@') > 0) { var p = d.split('@'); return p[0].slice(0, 1) + '***@' + p[1]; }
    return d;
  };

  UA.init = async function (cloud) {
    UA.cloud = cloud;
    try {
      var r = await cloud.auth.getSession();
      if (r && r.data && r.data.session && r.data.session.user) {
        UA.user = r.data.session.user;
      }
    } catch (e) { /* 未登录/网络异常按未登录处理 */ }
    // 会话过期/登出事件
    try {
      cloud.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_OUT') { UA.user = null; emit(); }
        else if (event === 'SIGNED_IN' && session && session.user) { UA.user = session.user; emit(); }
      });
    } catch (e) { /* 旧版 SDK 无此事件则忽略 */ }
    emit();
    return UA.user;
  };

  UA.signOut = async function () {
    try { await UA.cloud.auth.signOut(); } catch (e) { /* 本地也按登出处理 */ }
    UA.user = null;
    UA._pending = null;
    emit();
  };

  /** 校验手机号；返回错误文案或 null */
  UA.phoneError = function (phone) {
    return /^1\d{10}$/.test(phone) ? null : '请输入正确的 11 位手机号';
  };
  UA.emailError = function (email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : '请输入正确的邮箱地址';
  };

  /**
   * 获取验证码。成功返回 { ok:true, isExistingUser }；失败返回 { ok:false, error }
   * 成功后内部保存 challenge；重发成功会替换旧 challenge（官方契约允许）。
   */
  UA.sendCode = async function (channel, target) {
    var err = channel === 'phone' ? UA.phoneError(target) : UA.emailError(target);
    if (err) return { ok: false, error: err };
    var payload = channel === 'phone' ? { phone: target } : { email: target };
    var sent = await UA.cloud.auth.sendOtp(payload);
    if (sent && sent.error) return { ok: false, error: sent.error.message || '验证码发送失败，请稍后再试' };
    UA._pending = {
      channel: channel,
      target: target,
      verificationId: sent.data.verificationId,
      isExistingUser: !!sent.data.isExistingUser,
    };
    return { ok: true, isExistingUser: UA._pending.isExistingUser };
  };

  /**
   * 提交验证码完成注册/登录。成功返回 { ok:true, user, isNew }。
   * 未取码/换了号码：不发请求，返回提示。
   */
  UA.submitCode = async function (channel, target, token) {
    var p = UA._pending;
    if (!p || p.channel !== channel || p.target !== target) {
      return { ok: false, error: '请先获取当前' + (channel === 'phone' ? '手机号' : '邮箱') + '的验证码' };
    }
    if (!/^\d{4,8}$/.test(token || '')) return { ok: false, error: '请输入验证码' };
    var payload = {
      verificationId: p.verificationId,
      isExistingUser: p.isExistingUser,
      token: token,
    };
    if (channel === 'phone') payload.phone = p.target; else payload.email = p.target;
    var completed = await UA.cloud.auth.verifyOtp(payload);
    if (completed && completed.error) return { ok: false, error: completed.error.message || '验证码错误或已过期' };
    UA._pending = null;
    UA.user = completed.data.user;
    emit();
    return { ok: true, user: UA.user, isNew: !completed.data.user ? false : undefined };
  };

  /** 判断当前输入是否与已保存 challenge 一致（UI 用于提示重新取码） */
  UA.hasPendingFor = function (channel, target) {
    var p = UA._pending;
    return !!(p && p.channel === channel && p.target === target);
  };

  // ---------- 登录弹窗 UI ----------
  UA.mountUI = function (opts) {
    opts = opts || {};
    var mask = document.getElementById('uaMask');
    if (!mask) return;
    var $phone = document.getElementById('uaPhone');
    var $email = document.getElementById('uaEmail');
    var $code = document.getElementById('uaCode');
    var $send = document.getElementById('uaSendCode');
    var $submit = document.getElementById('uaSubmit');
    var $err = document.getElementById('uaError');
    var $tip = document.getElementById('uaModeTip');
    var tabPhone = document.getElementById('uaTabPhone');
    var tabEmail = document.getElementById('uaTabEmail');
    var rowPhone = document.getElementById('uaRowPhone');
    var rowEmail = document.getElementById('uaRowEmail');
    var channel = 'phone';

    function showErr(m) { $err.textContent = m || ''; }
    function setChannel(c) {
      channel = c;
      tabPhone.classList.toggle('on', c === 'phone');
      tabEmail.classList.toggle('on', c === 'email');
      rowPhone.style.display = c === 'phone' ? '' : 'none';
      rowEmail.style.display = c === 'email' ? '' : 'none';
      showErr('');
      $tip.textContent = '新用户验证后自动注册，无需密码';
    }
    tabPhone.onclick = function () { setChannel('phone'); };
    tabEmail.onclick = function () { setChannel('email'); };

    function target() { return (channel === 'phone' ? $phone.value : $email.value).trim(); }

    $send.onclick = async function () {
      showErr('');
      var t = target();
      var r = await UA.sendCode(channel, t);
      if (!r.ok) { showErr(r.error); return; }
      showToast && showToast('验证码已发送', 'success');
      var sec = 60;
      $send.disabled = true;
      var label = '重新获取';
      $send.textContent = sec + 's';
      UA._countdownTimer = setInterval(function () {
        sec -= 1;
        if (sec <= 0) { clearInterval(UA._countdownTimer); $send.disabled = false; $send.textContent = label; }
        else { $send.textContent = sec + 's'; }
      }, 1000);
    };

    $submit.onclick = async function () {
      showErr('');
      $submit.disabled = true;
      try {
        var r = await UA.submitCode(channel, target(), $code.value.trim());
        if (!r.ok) { showErr(r.error); return; }
        close();
        showToast && showToast('登录成功，欢迎回来～', 'success');
      } finally { $submit.disabled = false; }
    };

    function close() { mask.classList.remove('show'); }
    document.getElementById('uaClose').onclick = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    if (opts.onOpen) opts.onOpen();
  };

  UA.openLogin = function () {
    var mask = document.getElementById('uaMask');
    if (mask) mask.classList.add('show');
  };

  // ---------- 顶栏用户区渲染 ----------
  UA.renderTopbar = function () {
    var area = document.getElementById('userArea');
    if (!area) return;
    if (UA.isLoggedIn()) {
      area.innerHTML = '<span class="ua-user" id="uaUserName" title="点击退出登录">👤 ' +
        UA.maskedName() + '</span>';
      document.getElementById('uaUserName').onclick = async function () {
        if (confirm('退出登录？退出后将停止云同步会话历史（本地保留）')) {
          await UA.signOut();
        }
      };
    } else {
      area.innerHTML = '<button class="ua-login-btn" id="uaLoginBtn">登录 / 注册</button>';
      document.getElementById('uaLoginBtn').onclick = UA.openLogin;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UserAuth: UA };
  } else {
    global.UserAuth = UA;
  }
})(typeof window !== 'undefined' ? window : globalThis);
