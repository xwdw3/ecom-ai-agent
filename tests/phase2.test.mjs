/**
 * Phase2 单元测试：分层催付 / 售后资格 / 人机分流 / 工具规划
 * 运行：node --test tests/phase2.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../js/tools.js');

// ---------- 分层催付 ----------
test('tierFor: 三层金额分层策略正确', () => {
  const t1 = T.tierFor(59);
  assert.equal(t1.tier, 'T1-轻触达');
  assert.ok(!t1.coupon, '小额不发券');
  const t2 = T.tierFor(158);
  assert.equal(t2.tier, 'T2-标准挽回');
  assert.equal(t2.coupon.amount, 10);
  const t3 = T.tierFor(499);
  assert.equal(t3.tier, 'T3-专属挽回');
  assert.equal(t3.coupon.amount, 20);
  assert.ok(t3.channel.includes('外呼'));
});

// ---------- 售后资格判定 ----------
const ORDER = (over = {}) => ({
  order_no: 'SO20261022001', status: 'paid', amount: 158,
  paid_at: new Date(Date.now() - 2 * 86400000).toISOString(), ...over,
});

test('checkEligibility: 7天内已付订单符合无理由退货且自动办理', () => {
  const r = T.checkEligibility(ORDER(), 'return_refund');
  assert.equal(r.eligible, true);
  assert.equal(r.autoProcess, true);
});

test('checkEligibility: 未支付订单不适用退换', () => {
  const r = T.checkEligibility(ORDER({ status: 'pending_payment', paid_at: null }), 'return_refund');
  assert.equal(r.eligible, false);
  assert.ok(r.reason.includes('尚未付款'));
});

test('checkEligibility: 已有退款中的申请不重复受理', () => {
  const r = T.checkEligibility(ORDER({ status: 'refund_reviewing' }), 'return_refund');
  assert.equal(r.eligible, false);
});

test('checkEligibility: 超7天仅质量问题（可办但不自动）', () => {
  const r = T.checkEligibility(ORDER({ paid_at: new Date(Date.now() - 10 * 86400000).toISOString() }), 'return_refund');
  assert.equal(r.eligible, true);
  assert.equal(r.autoProcess, false);
  assert.ok(r.reason.includes('质量问题'));
});

test('checkEligibility: 超15天售后窗口拒绝', () => {
  const r = T.checkEligibility(ORDER({ paid_at: new Date(Date.now() - 20 * 86400000).toISOString() }), 'return_refund');
  assert.equal(r.eligible, false);
});

test('checkEligibility: 高金额（≥500）转人工审核', () => {
  const r = T.checkEligibility(ORDER({ amount: 499 }), 'return_refund');
  assert.equal(r.eligible, true);
  const r2 = T.checkEligibility(ORDER({ amount: 500 }), 'return_refund');
  assert.equal(r2.eligible, false);
  assert.ok(r2.reason.includes('人工审核'));
});

// ---------- 人机分流 ----------
test('riskRoute: 高风险关键词（投诉/假货/律师）转人工', () => {
  for (const q of ['我要投诉你们', '这是假货', '不解决我就找律师']) {
    const r = T.riskRoute(q);
    assert.equal(r.route, 'human', q);
    assert.equal(r.riskLevel, 'high');
  }
});

test('riskRoute: 中风险关键词', () => {
  const r = T.riskRoute('你们这是欺诈消费者');
  assert.equal(r.route, 'human');
  assert.equal(r.riskLevel, 'medium');
});

test('riskRoute: 高金额售后诉求转人工', () => {
  const r = T.riskRoute('这个订单我想退货', { amount: 520 });
  assert.equal(r.route, 'human');
  assert.equal(r.riskLevel, 'high');
  const r2 = T.riskRoute('这个订单我想退货', { amount: 158 });
  assert.equal(r2.route, 'ai');
});

test('riskRoute: 普通咨询 AI 自动处理', () => {
  const r = T.riskRoute('保温杯什么材质的');
  assert.equal(r.route, 'ai');
  assert.equal(r.riskLevel, 'low');
});

// ---------- 工具规划 ----------
test('extractOrderNo: 提取 SO 单号', () => {
  assert.equal(T.extractOrderNo('帮我查订单so20261018005退款进度'), 'SO20261018005');
  assert.equal(T.extractOrderNo('发货要多久'), null);
});

test('rulePlan: 退款进度→售后查询', () => {
  const p = T.rulePlan('订单SO20261018005退款到哪一步了');
  assert.equal(p.tool, 'query_refund_progress');
  assert.equal(p.args.order_no, 'SO20261018005');
});

test('rulePlan: 物流查询', () => {
  const p = T.rulePlan('订单SO20261021004的物流到哪了？');
  assert.equal(p.tool, 'query_logistics');
});

test('rulePlan: 退货资格判定（含换货识别）', () => {
  const p1 = T.rulePlan('订单SO20261022001我想退货，符合条件吗？');
  assert.equal(p1.tool, 'check_aftersales_eligibility');
  assert.equal(p1.args.type, 'return_refund');
  const p2 = T.rulePlan('订单SO20261022001能换货吗');
  assert.equal(p2.args.type, 'exchange');
});

test('rulePlan: 售后申请→自动建单', () => {
  const p = T.rulePlan('我要给订单SO20261021004申请退货');
  assert.equal(p.tool, 'create_aftersales_ticket');
});

test('rulePlan: 知识库问题不误触发工具', () => {
  assert.equal(T.rulePlan('优惠券能和满减叠加吗'), null);
  assert.equal(T.rulePlan('保温杯质保多久'), null);
});

test('parseAgentPlan: LLM JSON 规划解析（含代码围栏/非法输入）', () => {
  assert.deepEqual(T.parseAgentPlan('```json\n{"tool":"query_logistics","args":{"order_no":"SO1"}}\n```'),
    { tool: 'query_logistics', args: { order_no: 'SO1' }, note: 'LLM 规划' });
  assert.equal(T.parseAgentPlan('{"tool":"unknown_tool"}'), null);
  assert.equal(T.parseAgentPlan('{"tool":null}'), null);
  assert.equal(T.parseAgentPlan('抱歉我无法回答'), null);
  assert.equal(T.parseAgentPlan(''), null);
});
