import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = require(path.join(base, 'js', 'tenant.js'));

// Node 环境：无 location/sessionStorage → 一律默认租户
test('tenant：无浏览器环境回退默认租户', () => {
  assert.equal(T.tenantId(), 'T001');
  assert.equal(T.tenantResolve(), 'T001');
});

test('tenant：tenantRow/tenantRows 补 tenant_id 且不改原对象', () => {
  const src = { session_id: 'S1', role: 'user' };
  const row = T.tenantRow(src);
  assert.equal(row.tenant_id, 'T001');
  assert.equal(row.session_id, 'S1');
  assert.deepEqual(src, { session_id: 'S1', role: 'user' }, '原对象不被修改');
  const rows = T.tenantRows([{ a: 1 }, { a: 2 }]);
  assert.deepEqual(rows.map((r) => r.tenant_id), ['T001', 'T001']);
  assert.equal(rows[0].a, 1);
});

test('tenant：非法租户标识一律拒绝（回退默认）', () => {
  // 直接验证正则契约（resolve 的浏览器分支依赖 DOM，此处验证入口约束）
  assert.equal(T.TENANT_RE.test('T002'), true);
  assert.equal(T.TENANT_RE.test('bad;drop'), false);
  assert.equal(T.TENANT_RE.test("<script>alert(1)</script>"), false);
  assert.equal(T.TENANT_RE.test('x'.repeat(33)), false);
  assert.equal(T.TENANT_RE.test('shop-42'), true);
});

test('tenant：tenantQ 组装 from+select+租户过滤链（mock db）', async () => {
  const calls = [];
  const builder = {
    select(cols) { calls.push(['select', cols]); return builder; },
    eq(k, v) { calls.push(['eq', k, v]); return builder; },
    order() { return builder; },
    limit() { return builder; },
    then(res) { res({ data: [], error: null }); },
  };
  const db = { from(t) { calls.push(['from', t]); return builder; } };
  const q = T.tenantQ(db, 'svc_orders', 'order_no,status');
  await q;
  assert.deepEqual(calls, [
    ['from', 'svc_orders'], ['select', 'order_no,status'], ['eq', 'tenant_id', 'T001'],
  ]);
});
