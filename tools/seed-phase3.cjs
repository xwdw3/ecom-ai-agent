// Phase3 演示数据扩充：12 用户、跨 30 天订单（含风控样本）、领券样本
// 幂等：先删后插（按标记范围）
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
const db = cloud.database;
const DAY = 86400000;
const now = Date.now();
const iso = (daysAgo, hour = 10) => new Date(now - daysAgo * DAY - (16 - hour) * 3600000).toISOString();

const USERS = [
  ['U1004', '陈晨', 'gold', 5210, '137****4411'], ['U1005', '赵磊', 'normal', 320, '151****8802'],
  ['U1006', '孙悦', 'silver', 1980, '188****6655'], ['U1007', '周琪', 'normal', 156, '135****0921'],
  ['U1008', '吴敏', 'gold', 7420, '189****3344'], ['U1009', '郑浩', 'normal', 89, '136****7788'],
  ['U1010', '冯静', 'silver', 2450, '158****1122'], ['U1011', '何强', 'normal', 45, '150****9966'],
  ['U1012', '刷单小号A', 'normal', 260, '199****0001'], ['U1013', '刷单小号B', 'normal', 260, '199****0002'],
  ['U1014', '羊毛党C', 'normal', 0, '197****0003'],
];

// [单号, 用户, sku, qty, 金额, 状态, 天前, 优惠ID]
const ORDERS = [
  // 正常历史订单（复购/分层样本）
  ['SO20260923010', 'U1001', 'TEE-WT-001', 2, 158, 'completed', 30], ['SO20260925011', 'U1004', 'LAMP-LD-008', 1, 499, 'completed', 28],
  ['SO20260926012', 'U1006', 'CUP-SS-500', 1, 129, 'completed', 27], ['SO20260928013', 'U1008', 'LAMP-LD-008', 2, 998, 'completed', 25],
  ['SO20260930014', 'U1005', 'TEE-WT-001', 1, 79, 'completed', 23], ['SO20261002015', 'U1004', 'CUP-SS-500', 1, 129, 'completed', 21],
  ['SO20261004016', 'U1010', 'TEE-WT-001', 3, 237, 'completed', 19], ['SO20261005017', 'U1007', 'BAG-CN-002', 1, 59, 'completed', 18],
  ['SO20261007018', 'U1008', 'TEE-WT-001', 2, 158, 'completed', 16], ['SO20261009019', 'U1006', 'LAMP-LD-008', 1, 499, 'completed', 14],
  ['SO20261011020', 'U1005', 'CUP-SS-500', 1, 129, 'completed', 12], ['SO20261013021', 'U1010', 'CUP-SS-500', 1, 129, 'completed', 10],
  ['SO20261015022', 'U1007', 'TEE-WT-001', 1, 79, 'completed', 8], ['SO20261016023', 'U1009', 'BAG-CN-002', 1, 59, 'pending_payment', 7],
  ['SO20261018024', 'U1011', 'TEE-WT-001', 1, 79, 'pending_payment', 5], ['SO20261019025', 'U1009', 'TEE-WT-001', 1, 79, 'pending_payment', 4],
  // 风控样本：同一用户短时多单 + 频繁取消
  ['SO20261022030', 'U1012', 'TEE-WT-001', 1, 79, 'cancelled', 1], ['SO20261022031', 'U1012', 'TEE-WT-001', 1, 79, 'cancelled', 1],
  ['SO20261022032', 'U1012', 'TEE-WT-001', 2, 158, 'completed', 1], ['SO20261022033', 'U1013', 'TEE-WT-001', 2, 158, 'completed', 1],
  ['SO20261022034', 'U1013', 'TEE-WT-001', 1, 79, 'cancelled', 1], ['SO20261022035', 'U1012', 'TEE-WT-001', 3, 237, 'completed', 0.6],
  // 风控样本：薅羊毛（新客券批量套现）
  ['SO20261022040', 'U1014', 'TEE-WT-001', 1, 0.01, 'completed', 0.8], ['SO20261022041', 'U1014', 'BAG-CN-002', 1, 0.01, 'completed', 0.8],
  ['SO20261022042', 'U1014', 'CUP-SS-500', 1, 0.01, 'cancelled', 0.8],
  // 巡检样本：待发货积压（paid 超 48h）
  ['SO20261020050', 'U1006', 'CUP-SS-500', 1, 129, 'paid', 3.2], ['SO20261020051', 'U1008', 'TEE-WT-001', 1, 79, 'paid', 2.6],
  ['SO20261021052', 'U1005', 'LAMP-LD-008', 1, 499, 'paid', 1.8],
  // 已有数据不变：SO20261015006(退款完成) SO20261018005(退款中) SO20261021004 SO20261022001-003
];

(async () => {
  // 清理旧演示数据（仅本脚本的 SO 范围）
  for (const [orderNo] of ORDERS) {
    await db.from('svc_orders').delete().eq('order_no', orderNo);
  }
  await db.from('svc_users').delete().in('user_id', USERS.map(u => u[0]));

  for (const [uid, nick, level, spend, phone] of USERS) {
    const { error } = await db.from('svc_users').insert({
      user_id: uid, nickname: nick, level, total_spend: spend, phone_masked: phone,
    });
    if (error) return console.log('user insert fail', uid, error.message);
  }
  console.log('users inserted:', USERS.length);

  let ok = 0;
  for (const [no, uid, sku, qty, amount, status, daysAgo] of ORDERS) {
    const created = iso(daysAgo, 11);
    const paid = status === 'pending_payment' ? null : iso(daysAgo, 11.1);
    const { error } = await db.from('svc_orders').insert({
      order_no: no, user_id: uid, sku, qty, amount, status, coupon_id: null,
      created_at: created, paid_at: paid,
    });
    if (error) console.log('order fail', no, error.message); else ok++;
  }
  console.log('orders inserted:', ok, '/', ORDERS.length);

  // 羊毛党领券样本
  await db.from('coupon_grants').delete().eq('user_id', 'U1014');
  const coupons = [['U1014', '新人5元券', 5, 'new_user'], ['U1014', '新人5元券', 5, 'new_user'], ['U1014', '新人5元券', 5, 'new_user']];
  for (const [uid, name, amt, reason] of coupons) {
    await db.from('coupon_grants').insert({ user_id: uid, coupon_name: name, amount: amt, reason, valid_days: 7, status: 'used' });
  }
  console.log('coupons inserted');
  console.log('SEED DONE');
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
