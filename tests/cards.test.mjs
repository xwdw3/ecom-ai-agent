/**
 * 结构化卡片单测（tests/cards.test.mjs）
 * 用最小 DOM stub 验证 ToolCards.render 的结构识别与降级行为
 * 运行：node --test tests/cards.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

const testsDir = path.dirname(url.fileURLToPath(import.meta.url));
const base = path.join(testsDir, '..');

// 最小 DOM stub：createElement 返回可累积 innerHTML/children 的假节点
class FakeEl {
  constructor(tag) { this.tag = tag; this.className = ''; this.innerHTML = ''; this.children = []; }
  appendChild(c) { this.children.push(c); }
  setAttribute() {}
  querySelector() { return new FakeEl('div'); }
  addEventListener() {}
}
global.document = { createElement: (t) => new FakeEl(t) };
global.window = globalThis;

const cards = await import(url.pathToFileURL(path.join(base, 'js', 'cards.js'))).then(() => globalThis.ToolCards);
assert.ok(cards, 'ToolCards 全局已注册');

test('cards: 退款进度渲染步骤条', () => {
  const bubble = new FakeEl('div');
  const ok = cards.render(bubble, 'query_refund_progress', {
    refund_no: 'RF1', type: 'return_refund', amount: 258, status: 'returning',
    progress: [{ done: true, step: '申请提交' }, { done: true, step: '审核通过' }, { done: false, step: '退款中' }],
  });
  assert.ok(ok);
  const html = JSON.stringify(bubble);
  assert.ok(html.includes('退款进度') && html.includes('RF1') && html.includes('退货退款') && html.includes('¥258.00'));
  assert.ok(html.includes('申请提交') && html.includes('审核通过') && html.includes('退款中'));
});

test('cards: 物流时间线渲染', () => {
  const bubble = new FakeEl('div');
  const ok = cards.render(bubble, 'query_logistics', {
    company: '顺丰速运', tracking_no: 'SF123', status: 'in_transit',
    timeline: [{ done: true, step: '已揽收', time: '10-21 09:00' }, { done: false, step: '运输中' }],
  });
  assert.ok(ok);
  const html = JSON.stringify(bubble);
  assert.ok(html.includes('顺丰速运') && html.includes('SF123') && html.includes('运输中') && html.includes('10-21 09:00'));
});

test('cards: 订单卡渲染字段网格', () => {
  const bubble = new FakeEl('div');
  const ok = cards.render(bubble, 'query_order', {
    order_no: 'SO1', sku: 'TEE-WT-001', qty: 2, amount: 158, status: 'paid', paid_at: '2026-10-20T10:00:00Z',
  });
  assert.ok(ok);
  const html = JSON.stringify(bubble);
  assert.ok(html.includes('SO1') && html.includes('已付款待发货') && html.includes('× 2') && html.includes('¥158.00'));
});

test('cards: 售后资格卡（可办理/需人工两态）', () => {
  const b1 = new FakeEl('div');
  assert.ok(cards.render(b1, 'check_aftersales_eligibility', { eligible: true, reason: '7天内', autoProcess: true }));
  assert.ok(JSON.stringify(b1).includes('可自助办理'));
  const b2 = new FakeEl('div');
  assert.ok(cards.render(b2, 'check_aftersales_eligibility', { eligible: false, reason: '金额≥500需人工审核' }));
  assert.ok(JSON.stringify(b2).includes('需人工确认') && JSON.stringify(b2).includes('≥500'));
});

test('cards: 不识别的结构返回 false（静默降级）', () => {
  const bubble = new FakeEl('div');
  assert.equal(cards.render(bubble, 'query_user', { nickname: 'x' }), false);
  assert.equal(cards.render(bubble, 'query_refund_progress', null), false);
  assert.equal(cards.render(null, 'query_order', { order_no: 'SO1' }), false);
  assert.equal(bubble.children.length, 0, '不渲染任何节点');
});
