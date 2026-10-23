/**
 * Phase3 · 数据智能分析
 * 咨询热点统计 / 售后高发问题归因 / 转化数据日报
 * 纯逻辑可单测；日报落库 analytics_daily。
 */

const STOPWORDS = new Set(['请问', '你们', '你们这', '什么', '怎么', '怎么样', '可以', '一下', '这个', '那个', '我的', '你们店', '是不是', '有没有', '为什么', '多少', '还是', '如果', '客服', '您好', '你好', '谢谢', '投诉', '东西', '假货']);

/** 咨询热点统计：用户消息关键词 + 主题归类 */
function hotQuestions(messages, topN) {
  const userMsgs = (messages || []).filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  const TOPICS = [
    { topic: '退款售后', re: /退款|退货|换货|售后|赔偿/ },
    { topic: '物流查询', re: /物流|快递|到哪|发货|签收/ },
    { topic: '商品咨询', re: /材质|尺码|参数|规格|克重|棉/ },
    { topic: '优惠活动', re: /优惠|券|满减|叠加|活动/ },
    { topic: '投诉纠纷', re: /投诉|假货|辱骂|欺诈/ },
  ];
  const topicCount = {};
  const wordCount = {};
  for (const msg of userMsgs) {
    let matched = false;
    for (const t of TOPICS) {
      if (t.re.test(msg)) { topicCount[t.topic] = (topicCount[t.topic] || 0) + 1; matched = true; break; }
    }
    if (!matched) topicCount['其他'] = (topicCount['其他'] || 0) + 1;
    for (const w of msg.replace(/SO\d{6,}/g, ' ').split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
      if (w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
        wordCount[w] = (wordCount[w] || 0) + 1;
      }
    }
  }
  const topWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, topN || 8)
    .map(([word, count]) => ({ word, count }));
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, count }));
  return { totalConsults: userMsgs.length, topTopics, topWords };
}

/** 售后高发问题归因分析 */
function aftersalesAttribution(tickets, refunds) {
  const RULES = [
    { cause: '商品质量', re: /质量|破损|瑕疵|坏|开线|色差/, owner: '质检/供应链', action: '抽查该批次 SKU，联动供应商整改' },
    { cause: '物流问题', re: /物流|快递|破损|丢件|慢|停滞/, owner: '仓配物流', action: '考核承运商时效，停滞件主动补发' },
    { cause: '尺码/描述不符', re: /尺码|偏大|偏小|描述|不符|色差/, owner: '商品/详情页', action: '优化详情页尺码表与实拍图' },
    { cause: '价格/优惠争议', re: /价格|保价|优惠券|优惠|差价/, owner: '运营', action: '上线保价规则说明，统一口径' },
  ];
  const texts = [
    ...(tickets || []).map((t) => String(t.question || '')),
    ...(refunds || []).map((r) => String(r.reason || '')),
  ].filter(Boolean);
  const causeCount = {};
  for (const t of texts) {
    for (const rule of RULES) {
      if (rule.re.test(t)) { causeCount[rule.cause] = (causeCount[rule.cause] || 0) + 1; break; }
    }
    if (!RULES.some((r) => r.re.test(t))) causeCount['其他'] = (causeCount['其他'] || 0) + 1;
  }
  const ranked = Object.entries(causeCount).sort((a, b) => b[1] - a[1]).map(([cause, count]) => {
    const rule = RULES.find((r) => r.cause === cause);
    return { cause, count, owner: rule ? rule.owner : '待人工归因', action: rule ? rule.action : '抽样人工分析' };
  });
  return {
    totalCases: texts.length,
    topCause: ranked[0] || null,
    ranked,
    conclusion: ranked.length
      ? `售后高发首因：「${ranked[0].cause}」（${ranked[0].count} 件，占 ${(ranked[0].count / texts.length * 100).toFixed(0)}%），责任环节：${ranked[0].owner}。建议：${ranked[0].action}`
      : '当前无售后案件，无归因结论。',
  };
}

/**
 * 转化数据日报
 * 说明：转化率为演示口径（会话→订单、催付→挽回），上线接埋点后替换
 */
function conversionReport(sessions, messages, orders, collectTasks, nowMs) {
  const now = nowMs || Date.now();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const isToday = (t) => new Date(t).getTime() >= todayStart.getTime();

  const todayOrders = (orders || []).filter((o) => isToday(o.created_at));
  const paidOrders = todayOrders.filter((o) => o.status !== 'pending_payment' && o.status !== 'cancelled');
  const todaySessions = (sessions || []).filter((s) => isToday(s.created_at || s.started_at));
  const todayMsgs = (messages || []).filter((m) => isToday(m.created_at));
  const assistantMsgs = todayMsgs.filter((m) => m.role === 'assistant');
  const fallbackMsgs = assistantMsgs.filter((m) => m.is_fallback);
  const autoResolveRate = assistantMsgs.length
    ? 1 - fallbackMsgs.length / assistantMsgs.length : null;

  const sent = (collectTasks || []).length;
  const paidAfterCollect = (collectTasks || []).filter((t) => {
    const o = (orders || []).find((x) => x.order_no === t.order_no);
    return o && o.paid_at && new Date(o.paid_at) > new Date(t.created_at);
  }).length;

  return {
    date: todayStart.toISOString().slice(0, 10),
    consults: todaySessions.length,
    autoResolveRate: autoResolveRate == null ? null : Number((autoResolveRate * 100).toFixed(1)),
    ordersToday: todayOrders.length,
    paidToday: paidOrders.length,
    gmvToday: Number(paidOrders.reduce((s, o) => s + Number(o.amount || 0), 0).toFixed(2)),
    collectSent: sent,
    collectRecovered: paidAfterCollect,
    collectRecoveryRate: sent ? Number((paidAfterCollect / sent * 100).toFixed(1)) : null,
    note: '转化口径为演示推演（会话→订单、催付→挽回），上线后接埋点回溯校准',
  };
}

/** 日报落库 */
async function saveAnalyticsDaily(db, hot, aftersales, conversion, summary, reportDate) {
  const { error } = await db.from('analytics_daily').insert({
    tenant_id: Tenant.id(),
    report_date: reportDate,
    hot_questions: hot || null,
    aftersales_analysis: aftersales || null,
    conversion: conversion || null,
    summary,
  });
  if (error) throw new Error('日报落库失败：' + error.message);
  return true;
}

async function listAnalyticsDaily(db, limit) {
  const { data, error } = await db.from('analytics_daily')
    .select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(limit || 10);
  if (error) throw new Error(error.message);
  return data || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hotQuestions, aftersalesAttribution, conversionReport, saveAnalyticsDaily, listAnalyticsDaily, STOPWORDS };
}
if (typeof window !== 'undefined') {
  window.AnalyticsAgent = { hotQuestions, aftersalesAttribution, conversionReport, saveAnalyticsDaily, listAnalyticsDaily };
}
