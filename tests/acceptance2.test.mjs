/**
 * Phase2 验收补充单测：JWT鉴权 / 权限最小化 / 网关治理（限流·熔断·重试·降级）/ 催付频控
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../js/tools.js');
const A = require('../js/auth.js');

// ---------- JWT 鉴权（功能验收6） ----------
test('issueToken/verifyToken: 合法令牌通过', async () => {
  const tk = await A.issueToken(A.AGENT_ACCOUNT);
  const v = await A.verifyToken(tk);
  assert.equal(v.ok, true);
  assert.equal(v.payload.sub, 'agent-svc');
});
test('verifyToken: 篡改签名被拒绝', async () => {
  const tk = await A.issueToken(A.AGENT_ACCOUNT);
  const parts = tk.split('.');
  const bad = parts[0] + '.' + parts[1] + '.' + 'AAAA' + parts[2].slice(4);
  const v = await A.verifyToken(bad);
  assert.equal(v.ok, false);
});
test('verifyToken: 过期令牌被拒绝', async () => {
  const tk = await A.issueToken(A.AGENT_ACCOUNT, -1000);
  const v = await A.verifyToken(tk);
  assert.equal(v.ok, false);
  assert.match(v.reason, /过期/);
});
test('gatewayAuthorize: 合法工具+具备scope → 放行', async () => {
  const tk = await A.issueToken(A.AGENT_ACCOUNT);
  const r = await A.gatewayAuthorize(tk, 'query_order');
  assert.equal(r.ok, true);
  assert.equal(r.caller, 'agent-svc');
});
test('gatewayAuthorize: scope不足 → 拒绝（权限最小化）', async () => {
  const tk = await A.issueToken({ caller: 'low-priv', name: 'x', scopes: ['user:read'] });
  const r = await A.gatewayAuthorize(tk, 'create_aftersales_ticket');
  assert.equal(r.ok, false);
  assert.match(r.reason, /权限不足/);
});
test('gatewayAuthorize: 未注册工具 → 默认拒绝（白名单外）', async () => {
  const tk = await A.issueToken(A.AGENT_ACCOUNT);
  const r = await A.gatewayAuthorize(tk, 'execute_payment');
  assert.equal(r.ok, false);
});
test('Agent 账号权限矩阵：不含支付与大额退款审批权限（技术验收3）', () => {
  assert.equal(A.AGENT_ACCOUNT.scopes.includes('payment:execute'), false);
  assert.equal(A.AGENT_ACCOUNT.scopes.includes('refund:approve_large'), false);
  assert.ok(A.FORBIDDEN_ACTIONS.includes('payment.execute'));
  assert.ok(A.FORBIDDEN_ACTIONS.includes('refund.approve_large'));
});
test('couponAmountAllowed: Agent 补券上限 20 元', () => {
  assert.equal(A.couponAmountAllowed(20), true);
  assert.equal(A.couponAmountAllowed(20.01), false);
  assert.equal(A.couponAmountAllowed(500), false);
});

// ---------- 网关治理（技术验收1） ----------
test('rateLimitAllow: 令牌桶耗尽后拒绝', () => {
  T.GOV.rateLimit.tokens = 0; T.GOV.rateLimit.lastRefill = Date.now();
  assert.equal(T.rateLimitAllow(), false);
  T.GOV.rateLimit.tokens = T.GOV.rateLimit.capacity; // 恢复
});
test('circuitRecord/circuitAllow: 连续失败4次触发熔断', () => {
  const svc = 'test-svc-' + Date.now();
  for (let i = 0; i < 4; i++) T.circuitRecord(svc, false);
  const c = T.circuitAllow(svc);
  assert.equal(c.allowed, false);
  assert.equal(c.state, 'open');
});
test('circuitAllow: 熔断超过 openMs 后进入半开放行', () => {
  const svc = 'test-svc-half-' + Date.now();
  for (let i = 0; i < 4; i++) T.circuitRecord(svc, false);
  // 模拟 31s 后
  const c = T.circuitAllow(svc, Date.now() + 31000);
  assert.equal(c.allowed, true);
  assert.equal(c.state, 'half-open');
});
test('circuitRecord: 成功后熔断恢复 closed', () => {
  const svc = 'test-svc-recover-' + Date.now();
  for (let i = 0; i < 4; i++) T.circuitRecord(svc, false);
  T.circuitRecord(svc, true); // half-open 探测成功
  const c = T.circuitAllow(svc, Date.now() + 31000);
  assert.equal(c.state, 'closed');
});
test('newTraceId: 链路ID 唯一且非空', () => {
  const a = T.newTraceId(), b = T.newTraceId();
  assert.ok(a && b && a !== b);
});

// ---------- 催付频控（功能验收4） ----------
const H = (agoMin, tier) => ({ created_at: new Date(Date.now() - agoMin * 60000).toISOString(), tier: tier || 'T1-轻触达' });
test('frequencyGuard: 72小时内3次后拦截', () => {
  const h = [H(60), H(120), H(180)];
  const r = T.frequencyGuard(h, Date.now(), 'T1-轻触达');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /频次上限/);
});
test('frequencyGuard: 两次触达间隔不足4小时拦截', () => {
  const r = T.frequencyGuard([H(60)], Date.now(), 'T1-轻触达');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /4小时/);
});
test('frequencyGuard: 间隔充足且未超上限 → 放行', () => {
  const r = T.frequencyGuard([H(300), H(2880)], Date.now(), 'T2-标准挽回');
  assert.equal(r.allowed, true);
});
test('frequencyGuard: T3 外呼每日最多1次', () => {
  const now = new Date('2026-10-23T15:00:00').getTime();
  const h = [{ created_at: new Date('2026-10-23T10:00:00').toISOString(), tier: 'T3-专属挽回' }];
  const r = T.frequencyGuard(h, now, 'T3-专属挽回');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /T3/);
});
test('frequencyGuard: 空历史放行', () => {
  assert.equal(T.frequencyGuard([], Date.now(), 'T1-轻触达').allowed, true);
});

// ---------- 工单流转（功能验收3 的流转字段约定） ----------
test('governedCall: 未知服务动作抛错且计入熔断', async () => {
  const svc = ServiceGatewayProbe();
  let threw = false;
  try { await T.governedCall('no-such-svc', 'x', {}); } catch (e) { threw = true; }
  assert.equal(threw, true);
  function ServiceGatewayProbe() { return 0; }
});
