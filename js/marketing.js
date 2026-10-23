/**
 * Phase3 · 智能营销Agent
 * 用户分层（RFM）→ 精准触达方案生成 → 老客唤醒 / 复购提醒 / 大促活动方案
 * 纯逻辑函数均可单测；db 写入函数由页面/脚本调用。
 */

const SEGMENT_META = {
  champion: { name: '高价值忠诚客', desc: '近期活跃 + 高频高额', strategy: '专属客服 + 新品优先购 + 生日礼' },
  loyal: { name: '忠诚复购客', desc: '多次购买、频次稳定', strategy: '会员日专属折扣 + 积分加倍' },
  potential: { name: '潜力新客', desc: '首单完成、尚待转化', strategy: '二单立减券 + 关联商品推荐' },
  sleepy: { name: '沉睡客户', desc: '15~30 天未购买', strategy: '老客唤醒券 + 限时召回文案' },
  lost: { name: '流失预警', desc: '超 30 天未购买', strategy: '大额召回券 + 短信/私域触达' },
  active: { name: '活跃客户', desc: '常规活跃', strategy: '活动常态化推送' },
};

const PURCHASE_STATUSES = ['completed', 'paid', 'shipped', 'refund_reviewing', 'refunding', 'refunded'];

/**
 * RFM 用户分层
 * @param users [{user_id, nickname, level, total_spend}]
 * @param orders [{user_id, status, amount, created_at}]
 * @param nowMs
 * @returns [{user_id, nickname, R, F, M, segment}]
 */
function rfmSegment(users, orders, nowMs) {
  const now = nowMs || Date.now();
  const byUser = {};
  for (const o of orders) {
    if (!PURCHASE_STATUSES.includes(o.status)) continue; // 待付款不计入有效购买
    const rec = byUser[o.user_id] || (byUser[o.user_id] = { last: 0, f: 0, m: 0 });
    rec.f += 1;
    rec.m += Number(o.amount) || 0;
    const t = new Date(o.created_at).getTime();
    if (t > rec.last) rec.last = t;
  }
  return (users || []).map((u) => {
    const rec = byUser[u.user_id] || { last: 0, f: 0, m: 0 };
    const R = rec.last ? Math.floor((now - rec.last) / 86400000) : 999;
    const F = rec.f;
    const M = rec.m || Number(u.total_spend) || 0;
    let segment = 'active';
    if (F === 0 || R > 30) segment = 'lost';
    else if (R >= 15) segment = 'sleepy';
    else if (F >= 2 && M >= 1000) segment = 'champion';
    else if (F >= 2) segment = 'loyal';
    else if (F === 1 && R <= 14) segment = 'potential';
    return { user_id: u.user_id, nickname: u.nickname, R, F, M: Math.round(M), segment };
  });
}

/**
 * 按分层生成精准触达方案（不落库，纯生成）
 */
function buildCampaign(type, segmentUsers, opts) {
  const o = opts || {};
  const segMeta = SEGMENT_META[o.segment] || SEGMENT_META.active;
  const count = (segmentUsers || []).length;
  const ids = (segmentUsers || []).map((u) => u.user_id);
  const base = {
    campaign_type: type,
    target_segment: o.segment || 'active',
    target_users: ids,
    title: '',
    content: '',
    channel: count > 3 ? '站内信+短信' : '站内信',
    status: 'draft',
  };
  if (type === 'wake') {
    base.title = `老客唤醒 · ${segMeta.name}（${count}人）`;
    base.content = `您好久不见！小店为您准备了 ${o.coupon || 10} 元专属回归券，7 日内有效，下单立减。您关注的商品近期有补货，快来看看吧～`;
  } else if (type === 'repurchase') {
    base.title = `复购提醒 · ${segMeta.name}（${count}人）`;
    base.content = `您购买的 ${o.productName || '商品'} 已接近用完周期，现已回归价 ¥${o.price || ''}，老客加赠 5 元券，复购更划算～`;
  } else if (type === 'promotion') {
    base.title = `大促方案 · ${o.promotionName || '大促活动'}`;
    base.content = [
      `【活动名称】${o.promotionName || '大促活动'}（${o.date || ''}）`,
      `【目标人群】${(o.segments || ['champion', 'sleepy', 'lost']).map((s) => SEGMENT_META[s].name).join('、')}`,
      `【优惠机制】满 ${o.threshold || 199} 减 ${o.off || 30}；高价值客户额外 95 折`,
      `【触达节奏】预热 D-3 站内信 → 当日 0 点短信推送 → D+1 未转化追加召回券`,
      `【目标覆盖】${count} 人`,
    ].join('\n');
    base.channel = '全渠道（站内信/短信/私域）';
  } else {
    base.title = `精准触达 · ${segMeta.name}（${count}人）`;
    base.content = `触达策略：${segMeta.strategy}`;
  }
  return base;
}

/**
 * 复购提醒候选：同一 sku 距上次购买超过复购周期，且之后无更新订单
 * @param orders 有效订单
 * @param cycles {sku: 周期天数}，缺省 30 天
 */
function repurchaseCandidates(orders, cycles, nowMs) {
  const now = nowMs || Date.now();
  const byUserSku = {};
  for (const o of orders) {
    if (!PURCHASE_STATUSES.includes(o.status) || o.status === 'refunded') continue;
    const key = o.user_id + '|' + o.sku;
    const rec = byUserSku[key] || (byUserSku[key] = { last: null, count: 0 });
    const t = new Date(o.created_at).getTime();
    if (!rec.last || t > rec.last) rec.last = t;
    rec.count += 1;
  }
  const out = [];
  for (const [key, rec] of Object.entries(byUserSku)) {
    const [userId, sku] = key.split('|');
    const cycle = (cycles && cycles[sku]) || 30;
    const days = Math.floor((now - rec.last) / 86400000);
    if (rec.count >= 1 && days >= cycle) {
      out.push({ user_id: userId, sku, lastOrderDays: days, cycle, times: rec.count });
    }
  }
  return out.sort((a, b) => b.lastOrderDays - a.lastOrderDays);
}

/** 大促日历：命中返回活动名与预热建议 */
const PROMO_CALENDAR = [
  { match: '11-11', name: '双11全球狂欢节', lead: 15 },
  { match: '06-18', name: '618年中大促', lead: 10 },
  { match: '12-12', name: '双12年终盛典', lead: 8 },
  { match: '01-28', name: '年货节', lead: 12 },
  { match: '03-08', name: '女神节', lead: 6 },
  { match: '08-18', name: '818嗨购节', lead: 7 },
];
function promotionPlan(dateStr, segmentUsers) {
  const md = String(dateStr || '').slice(5, 10); // MM-DD
  const hit = PROMO_CALENDAR.find((p) => p.match === md);
  const name = hit ? hit.name : '主题促销活动';
  const plan = buildCampaign('promotion', segmentUsers, { promotionName: name, date: dateStr, segments: ['champion', 'sleepy', 'lost'] });
  plan.leadDays = hit ? hit.lead : 5;
  plan.isCalendarHit = !!hit;
  return plan;
}

/**
 * 会员权益提醒：金银牌会员的权益到期/未使用提醒
 * @param users [{user_id, nickname, level}]
 */
function vipBenefitReminders(users) {
  const out = [];
  for (const u of users || []) {
    if (u.level === 'gold') {
      out.push({ user_id: u.user_id, nickname: u.nickname, title: '金牌会员权益提醒', content: '您有一张 20 元会员专属券即将到期，另享新品优先购与专属客服通道，点击即可使用～', channel: '短信+站内信' });
    } else if (u.level === 'silver') {
      out.push({ user_id: u.user_id, nickname: u.nickname, title: '银牌会员权益提醒', content: '本月会员日积分双倍即将开始，消费满 199 再享 95 折，别错过哦～', channel: '站内信' });
    }
  }
  return out;
}

/**
 * 新品定向推送：新品 SKU 推送给目标分层（默认高价值忠诚客 + 潜力新客）
 */
function newArrivalPush(products, rfmUsers, opts) {
  const o = opts || {};
  const targets = (rfmUsers || []).filter((u) => (o.segments || ['champion', 'potential']).includes(u.segment));
  const newSkus = (products || []).filter((p) => p.is_new);
  if (!newSkus.length) return { targets: [], campaign: null };
  const names = newSkus.map((p) => p.name).join('、');
  const campaign = buildCampaign('new_arrival', targets, { segment: 'champion' });
  campaign.title = `新品定向推送 · ${names}（${targets.length}人）`;
  campaign.content = `新品上架：${names}！会员优先购通道已开启，前 100 名下单加赠 10 元无门槛券，先到先得～`;
  return { targets: targets.map((t) => t.user_id), campaign };
}

/**
 * 触达白名单 / 黑名单过滤
 * @param targetUsers [user_id]
 * @param opts {whitelist:[], blacklist:[]}  白名单非空时仅推送白名单
 * @returns {allowed, blocked, blockedBy}
 */
function applyListFilter(targetUsers, opts) {
  const o = opts || {};
  let list = [...(targetUsers || [])];
  let blockedBy = [];
  if (o.whitelist && o.whitelist.length) {
    const before = list.length;
    list = list.filter((u) => o.whitelist.includes(u));
    blockedBy.push({ rule: 'whitelist', blocked: before - list.length });
  }
  if (o.blacklist && o.blacklist.length) {
    const before = list.length;
    list = list.filter((u) => !o.blacklist.includes(u));
    blockedBy.push({ rule: 'blacklist', blocked: before - list.length });
  }
  return { allowed: list, blocked: (targetUsers || []).length - list.length, blockedBy };
}

/** 落库：保存触达方案 */
async function saveCampaign(db, campaign) {
  const { data, error } = await db.from('marketing_campaigns').insert({
    tenant_id: Tenant.id(),
    campaign_type: campaign.campaign_type,
    target_segment: campaign.target_segment,
    target_users: campaign.target_users || null,
    title: campaign.title,
    content: campaign.content,
    channel: campaign.channel,
    status: 'sent',
  }).select('id');
  if (error) throw new Error('方案落库失败：' + error.message);
  return data && data[0];
}

async function listCampaigns(db, limit) {
  const { data, error } = await db.from('marketing_campaigns')
    .select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(limit || 20);
  if (error) throw new Error(error.message);
  return data || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SEGMENT_META, rfmSegment, buildCampaign, repurchaseCandidates, promotionPlan, PROMO_CALENDAR, vipBenefitReminders, newArrivalPush, applyListFilter, saveCampaign, listCampaigns };
}
if (typeof window !== 'undefined') {
  window.MarketingAgent = { SEGMENT_META, rfmSegment, buildCampaign, repurchaseCandidates, promotionPlan, vipBenefitReminders, newArrivalPush, applyListFilter, saveCampaign, listCampaigns };
}
