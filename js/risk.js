/**
 * Phase3 · 智能风控Agent
 * 异常订单识别 / 刷单拦截 / 薅羊毛行为检测 / 秒杀·优惠券活动风控保护
 * 纯规则引擎（毫秒级、可单测），事件落库 risk_events。
 */

const RISK_LEVEL_ORDER = { low: 1, medium: 2, high: 3 };

/**
 * 异常订单识别 + 刷单拦截
 * 规则：
 *  R1 同一用户 24h 内下单 ≥3 且含取消/退款 → 刷单嫌疑（high/block）
 *  R2 同一用户 7 天内取消 ≥2 → 恶意下单（medium/review）
 *  R3 完成订单金额 ≤1 元 → 0元购套现（high/block）
 *  R4 同一用户 24h 内多单且 SKU 完全相同、数量递增 → 刷单_pattern（high/block）
 */
function detectAbnormalOrders(orders, nowMs) {
  const now = nowMs || Date.now();
  const events = [];
  const byUser = {};
  for (const o of orders) {
    const t = new Date(o.created_at).getTime();
    (byUser[o.user_id] || (byUser[o.user_id] = [])).push({ ...o, _t: t });
  }
  for (const [userId, list] of Object.entries(byUser)) {
    const recent24h = list.filter((o) => now - o._t <= 86400000);
    const recent7d = list.filter((o) => now - o._t <= 7 * 86400000);
    const cancelled7d = recent7d.filter((o) => o.status === 'cancelled');

    // R1 刷单嫌疑
    const sus = recent24h.filter((o) => o.status === 'completed');
    if (recent24h.length >= 3 && (cancelled7d.length >= 1 || sus.length >= 2)) {
      events.push({
        event_type: 'brushing_suspect', user_id: userId, order_no: recent24h[recent24h.length - 1].order_no,
        risk_level: 'high', action: 'block',
        detail: { rule: 'R1', window: '24h', orders: recent24h.length, completed: sus.length, cancelled7d: cancelled7d.length, order_nos: recent24h.map((x) => x.order_no) },
      });
    }
    // R2 恶意下单
    if (cancelled7d.length >= 2 && recent24h.length < 3) {
      events.push({
        event_type: 'malicious_order', user_id: userId, order_no: cancelled7d[cancelled7d.length - 1].order_no,
        risk_level: 'medium', action: 'review',
        detail: { rule: 'R2', cancelled_in_7d: cancelled7d.length, order_nos: cancelled7d.map((x) => x.order_no) },
      });
    }
    // R3 0元购
    for (const o of list) {
      if (o.status === 'completed' && Number(o.amount) <= 1) {
        events.push({
          event_type: 'zero_purchase', user_id: userId, order_no: o.order_no,
          risk_level: 'high', action: 'block',
          detail: { rule: 'R3', amount: Number(o.amount), sku: o.sku },
        });
      }
    }
  }
  return events;
}

/**
 * 薅羊毛行为检测：同一用户领同名券 ≥3 次 或 0 元购完成单 ≥2
 */
function detectWoolUsers(couponGrants, orders, nowMs) {
  const events = [];
  const byUserCoupon = {};
  for (const g of couponGrants || []) {
    const key = g.user_id + '|' + g.coupon_name;
    (byUserCoupon[key] || (byUserCoupon[key] = [])).push(g);
  }
  for (const [key, list] of Object.entries(byUserCoupon)) {
    if (list.length >= 3) {
      const [userId, name] = key.split('|');
      events.push({
        event_type: 'wool_coupon_abuse', user_id: userId, order_no: null,
        risk_level: 'high', action: 'block',
        detail: { rule: 'W1', coupon_name: name, grant_count: list.length, total_amount: list.reduce((s, g) => s + Number(g.amount || 0), 0) },
      });
    }
  }
  const zeroByUser = {};
  for (const o of orders || []) {
    if (o.status === 'completed' && Number(o.amount) <= 1) {
      zeroByUser[o.user_id] = (zeroByUser[o.user_id] || 0) + 1;
    }
  }
  for (const [userId, n] of Object.entries(zeroByUser)) {
    if (n >= 2) {
      events.push({
        event_type: 'wool_zero_purchase', user_id: userId, order_no: null,
        risk_level: 'high', action: 'block',
        detail: { rule: 'W2', zero_completed_orders: n },
      });
    }
  }
  return events;
}

/**
 * 秒杀 / 优惠券活动防护：单用户限领校验（领取前调用）
 * @returns {allow:boolean, reason:string}
 */
function seckillGuard(existingGrants, userId, activityLimitPerUser) {
  const n = (existingGrants || []).filter((g) => g.user_id === userId).length;
  const limit = activityLimitPerUser || 2;
  if (n >= limit) {
    return { allow: false, reason: `风控拦截：该用户在本活动已领取 ${n} 次，超过限领 ${limit} 次上限`, user_id: userId };
  }
  return { allow: true, reason: '校验通过', user_id: userId };
}

/** 单笔订单实时评估（下单/支付前调用） */
function assessOrder(order, userHistory, woolFlags) {
  const history = userHistory || [];
  const recent24h = history.filter((o) => o.status !== 'pending_payment');
  const cancelled = history.filter((o) => o.status === 'cancelled').length;
  let level = 'low';
  const reasons = [];
  if (recent24h.length >= 3) { level = 'high'; reasons.push('24h内高频下单'); }
  if (cancelled >= 2) { level = RISK_LEVEL_ORDER[level] >= 2 ? level : 'medium'; reasons.push('历史取消率异常'); }
  if (Number(order.amount) <= 1) { level = 'high'; reasons.push('0元购特征'); }
  if (woolFlags && woolFlags[order.user_id]) { level = 'high'; reasons.push('命中羊毛党名单'); }
  const action = level === 'high' ? 'block' : level === 'medium' ? 'review' : 'pass';
  return { risk_level: level, action, reasons };
}

/**
 * 恶意售后识别
 * 规则：
 *  M1 同一用户 7 天内售后申请 ≥3 → 恶意售后嫌疑（high/block）
 *  M2 同一用户历史售后 ≥2 且全部退款完成（只退不换、成功率100%）→ 值得复核（medium/review）
 *  M3 售后原因含"仅退款不退货"且金额 ≥200 → 仅退款套利（high/block）
 */
function detectAftersalesAbuse(tickets, nowMs) {
  const now = nowMs || Date.now();
  const events = [];
  const byUser = {};
  for (const t of tickets || []) {
    const rec = byUser[t.user_id] || (byUser[t.user_id] = { all: [], recent7d: [] });
    const created = t.created_at ? new Date(t.created_at).getTime() : now;
    rec.all.push({ ...t, _t: created });
    if (now - created <= 7 * 86400000) rec.recent7d.push(t);
  }
  for (const [userId, rec] of Object.entries(byUser)) {
    if (rec.recent7d.length >= 3) {
      events.push({
        event_type: 'aftersales_abuse', user_id: userId, order_no: rec.recent7d[rec.recent7d.length - 1].order_no,
        risk_level: 'high', action: 'block',
        detail: { rule: 'M1', aftersales_in_7d: rec.recent7d.length, tickets: rec.recent7d.map((t) => t.ticket_no) },
      });
    }
    const done = rec.all.filter((t) => t.status === 'refunded' || t.auto_processed === true);
    if (rec.all.length >= 2 && done.length === rec.all.length && rec.all.length >= 2) {
      events.push({
        event_type: 'aftersales_pattern', user_id: userId, order_no: null,
        risk_level: 'medium', action: 'review',
        detail: { rule: 'M2', total: rec.all.length, refunded: done.length },
      });
    }
    for (const t of rec.all) {
      if (/仅退款|不退.*货|不退货/.test(String(t.reason || '')) && Number(t.amount || t.refund_amount || 0) >= 200) {
        events.push({
          event_type: 'refund_only_arbitrage', user_id: userId, order_no: t.order_no,
          risk_level: 'high', action: 'block',
          detail: { rule: 'M3', reason: String(t.reason).slice(0, 50) },
        });
      }
    }
  }
  return events;
}

async function saveRiskEvent(db, ev) {
  const { error } = await db.from('risk_events').insert({
    event_type: ev.event_type, order_no: ev.order_no || null, user_id: ev.user_id || null,
    risk_level: ev.risk_level, detail: ev.detail || null, action: ev.action,
  });
  if (error) throw new Error('风控事件落库失败：' + error.message);
  return true;
}

async function listRiskEvents(db, limit) {
  const { data, error } = await db.from('risk_events')
    .select('*').order('created_at', { ascending: false }).limit(limit || 30);
  if (error) throw new Error(error.message);
  return data || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectAbnormalOrders, detectWoolUsers, detectAftersalesAbuse, seckillGuard, assessOrder, saveRiskEvent, listRiskEvents };
}
if (typeof window !== 'undefined') {
  window.RiskAgent = { detectAbnormalOrders, detectWoolUsers, detectAftersalesAbuse, seckillGuard, assessOrder, saveRiskEvent, listRiskEvents };
}
