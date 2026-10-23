/* 登录注册与账号管理单测（mock 驱动，覆盖官方 OTP 契约与 usermgmt 网关语义） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UserAuth } = require('../js/userauth.js');
const tools = require('../js/tools.js');

// ---------- mock cloud.auth（严格模拟官方 SDK 返回形态） ----------
function makeMockAuth() {
  const calls = [];
  const state = { pending: new Map() }; // target -> {verificationId, isExistingUser}
  let seq = 0;
  return {
    calls,
    auth: {
      async sendOtp(p) {
        calls.push(['sendOtp', p]);
        if (p.phone && !/^1\d{10}$/.test(p.phone)) return { error: { message: '手机号格式错误' } };
        const key = p.phone || p.email;
        seq += 1;
        state.pending.set(key, { verificationId: 'V' + seq, isExistingUser: false });
        return { data: { verificationId: 'V' + seq, isExistingUser: false } };
      },
      async verifyOtp(p) {
        calls.push(['verifyOtp', p]);
        const key = p.phone || p.email;
        const saved = state.pending.get(key);
        if (!saved || saved.verificationId !== p.verificationId) return { error: { message: '验证码错误或已过期' } };
        if (p.token !== '123456') return { error: { message: '验证码错误或已过期' } };
        state.pending.delete(key);
        return { data: { user: { id: 'u1', phone: p.phone, email: p.email } } };
      },
      async getSession() { return { data: { session: null } }; },
      async signOut() { calls.push(['signOut']); return { data: {} }; },
      onAuthStateChange() { /* noop */ },
    },
  };
}

function freshUA() {
  // 重置 UA 内部状态（模块级单例）
  UserAuth._pending = null;
  UserAuth.user = null;
  UserAuth._listeners = [];
  return UserAuth;
}

test('手机号校验：11 位且 1 开头，否则拦截不发请求', async () => {
  const ua = freshUA();
  assert.equal(ua.phoneError('13812345678'), null);
  assert.ok(ua.phoneError('1381234567')); // 10 位
  assert.ok(ua.phoneError('23812345678')); // 非 1 开头
  const m = makeMockAuth();
  ua.cloud = m;
  const r = await ua.sendCode('phone', '123');
  assert.equal(r.ok, false);
  assert.equal(m.calls.length, 0); // 未发出任何请求
});

test('OTP 契约：先取码保存 challenge，提交 verifyOtp 不重发', async () => {
  const ua = freshUA();
  const m = makeMockAuth();
  ua.cloud = m;
  const s = await ua.sendCode('phone', '13812345678');
  assert.equal(s.ok, true);
  const sub = await ua.submitCode('phone', '13812345678', '123456');
  assert.equal(sub.ok, true);
  assert.equal(ua.isLoggedIn(), true);
  assert.equal(m.calls.filter((c) => c[0] === 'sendOtp').length, 1);
  assert.equal(m.calls.filter((c) => c[0] === 'verifyOtp').length, 1);
  // verifyOtp 必须携带 sendOtp 返回的 verificationId 与 isExistingUser
  const v = m.calls.find((c) => c[0] === 'verifyOtp')[1];
  assert.equal(v.verificationId, 'V1');
  assert.equal(v.phone, '13812345678');
  assert.ok('isExistingUser' in v);
});

test('OTP 契约：未取码直接提交→本地提示，不发请求', async () => {
  const ua = freshUA();
  const m = makeMockAuth();
  ua.cloud = m;
  const r = await ua.submitCode('phone', '13812345678', '123456');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('验证码'));
  assert.equal(m.calls.length, 0);
});

test('OTP 契约：换了号码→提示重新取码，不消费旧 challenge', async () => {
  const ua = freshUA();
  const m = makeMockAuth();
  ua.cloud = m;
  await ua.sendCode('phone', '13812345678');
  const r = await ua.submitCode('phone', '13900000000', '123456');
  assert.equal(r.ok, false);
  assert.equal(m.calls.filter((c) => c[0] === 'verifyOtp').length, 0);
  // 原号码仍可正常提交（challenge 未被消费）
  const ok = await ua.submitCode('phone', '13812345678', '123456');
  assert.equal(ok.ok, true);
});

test('OTP 契约：验证码错误→保持未登录，原 challenge 仍可重试', async () => {
  const ua = freshUA();
  const m = makeMockAuth();
  ua.cloud = m;
  await ua.sendCode('email', 'a@example.com');
  const bad = await ua.submitCode('email', 'a@example.com', '000000');
  assert.equal(bad.ok, false);
  assert.equal(ua.isLoggedIn(), false);
  const retry = await ua.submitCode('email', 'a@example.com', '123456');
  assert.equal(retry.ok, true); // 复用已存 challenge，未重发
  assert.equal(m.calls.filter((c) => c[0] === 'sendOtp').length, 1);
});

test('脱敏显示：手机号 3+****+4，邮箱首字母+***@域名', () => {
  const ua = freshUA();
  ua.user = { phone: '13812345678' };
  assert.equal(ua.maskedName(), '138****5678');
  ua.user = { email: 'alice@example.com' };
  assert.equal(ua.maskedName(), 'a***@example.com');
});

// ---------- usermgmt 网关（capture mock rpc：对应云库 admin_user_* 函数） ----------
function captureDb() {
  const state = { last: null };
  const db = {
    database: {
      from() { throw new Error('不应直连表'); },
      async rpc(fn, args) {
        state.last = [fn, args];
        const FIX = {
          admin_user_list: { data: { ok: true, users: [{ id: 1, username: 'admin', role: 'admin', enabled: true, created_at: 't' }] }, error: null },
          admin_user_create: { data: { ok: true, username: args.p_username, role: args.p_role }, error: null },
          admin_user_resetpwd: { data: { ok: true }, error: null },
          admin_user_toggle: { data: { ok: true }, error: null },
          admin_user_delete: { data: { ok: true }, error: null },
        };
        return FIX[fn] || { data: null, error: { message: 'unknown fn ' + fn } };
      },
    },
  };
  return { state, ...db };
}

test('usermgmt：list 走 admin_user_list 函数且带 token，返回 users 数组', async () => {
  const mock = captureDb();
  tools.initGateway(mock);
  const r = await tools.ServiceGateway.call('usermgmt', 'list', { token: 'T'.repeat(64) });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.users));
  assert.equal(mock.state.last[0], 'admin_user_list');
  assert.equal(mock.state.last[1].p_token, 'T'.repeat(64));
});

test('usermgmt：缺 token 直接拒绝（不触库）', async () => {
  const mock = captureDb();
  tools.initGateway(mock);
  const r = await tools.ServiceGateway.call('usermgmt', 'list', {});
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes('重新登录'));
  assert.equal(mock.state.last, null);
});

test('usermgmt：create/resetPwd/toggle/delete 参数映射到 p_* 函数入参', async () => {
  const mock = captureDb();
  tools.initGateway(mock);
  const T = 'T'.repeat(64);
  await tools.ServiceGateway.call('usermgmt', 'create', { token: T, username: 'carol', password: 'Passw0rd!', role: 'ops' });
  assert.deepEqual(mock.state.last, ['admin_user_create', { p_token: T, p_username: 'carol', p_password: 'Passw0rd!', p_role: 'ops' }]);
  await tools.ServiceGateway.call('usermgmt', 'resetPwd', { token: T, username: 'carol', password: 'NewPass!23' });
  assert.deepEqual(mock.state.last, ['admin_user_resetpwd', { p_token: T, p_username: 'carol', p_password: 'NewPass!23' }]);
  await tools.ServiceGateway.call('usermgmt', 'toggle', { token: T, username: 'carol', enabled: false });
  assert.deepEqual(mock.state.last, ['admin_user_toggle', { p_token: T, p_username: 'carol', p_enabled: false }]);
  await tools.ServiceGateway.call('usermgmt', 'delete', { token: T, username: 'carol' });
  assert.deepEqual(mock.state.last, ['admin_user_delete', { p_token: T, p_username: 'carol' }]);
});

test('gate.validateSession：缺服务端 token 的旧会话一律无效', () => {
  const Gate = require('../js/gate.js');
  const now = Date.now();
  assert.equal(Gate.validateSession({ u: 'a', r: 'admin', exp: now + 1000 }, now), false); // 无 t
  assert.equal(Gate.validateSession({ u: 'a', r: 'admin', t: 'x'.repeat(64), exp: now + 1000 }, now), true);
  assert.equal(Gate.validateSession({ u: 'a', r: 'admin', t: 'x'.repeat(64), exp: now - 1 }, now), false);
});
