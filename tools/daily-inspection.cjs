/**
 * Phase3 · 无人值守每日运营执行器（定时任务调用）
 * 一键完成：业务巡检 → 风控扫描（含恶意售后）→ 统一告警 → 营销自动触达 → 数据日报
 * 用法：node tools/daily-inspection.cjs [--no-llm]
 */
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const inspection = require(path.join(__dirname, '..', 'js', 'inspection.js'));
const analytics = require(path.join(__dirname, '..', 'js', 'analytics.js'));
const risk = require(path.join(__dirname, '..', 'js', 'risk.js'));
const marketing = require(path.join(__dirname, '..', 'js', 'marketing.js'));
const alerting = require(path.join(__dirname, '..', 'js', 'alerting.js'));

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
const db = cloud.database;
const NO_LLM = process.argv.includes('--no-llm');
const reportDate = new Date().toISOString().slice(0, 10);

// 触达黑名单（演示：羊毛党与刷单小号永不触达）
const MARKETING_BLACKLIST = ['U1014', 'U1012', 'U1013'];

async function loadData() {
  const q = (t) => db.from(t).select('*').limit(500);
  const [products, orders, refunds, logistics, sessions, messages, tickets, collect, aftersales, couponGrants] = await Promise.all([
    q('svc_products'), q('svc_orders'), q('svc_refunds'), q('svc_logistics'),
    q('chat_sessions'), q('chat_messages'), q('support_tickets'),
    db.from('collect_tasks').select('*').limit(200),
    db.from('aftersales_tickets').select('*').limit(200),
    db.from('coupon_grants').select('*').limit(200),
  ]);
  const out = {};
  for (const [name, r] of Object.entries({ products, orders, refunds, logistics, sessions, messages, tickets, collect, aftersales, couponGrants })) {
    if (r.error) throw new Error(name + ' 查询失败: ' + r.error.message);
    out[name] = r.data;
  }
  return out;
}

async function llmSummary(prompt) {
  let out = '';
  for await (const ch of cloud.llm.chat.completions.create({
    model: 'deepseek-v4-flash', stream: true, temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  })) {
    const d = ch.choices?.[0]?.delta?.content;
    if (d) out += d;
  }
  return out.trim();
}

(async () => {
  console.log('== Phase3 无人值守每日运营 ==', reportDate);
  const data = await loadData();
  console.log(`数据：商品${data.products.length} 订单${data.orders.length} 售后${data.aftersales.length} 消息${data.messages.length}`);

  // ===== 1. 业务巡检（异常→统一告警） =====
  const report = inspection.runInspection(data);
  await inspection.saveInspectionReport(db, report, reportDate);
  console.log('\n【1.巡检】', report.summary);
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${f.check}: ${f.detail}`);
    await alerting.notifyInspectionFinding(db, f);
  }

  // ===== 2. 风控扫描（异常订单/薅羊毛/刷单/恶意售后 → 预警+上报风控后台） =====
  const riskEvents = [
    ...risk.detectAbnormalOrders(data.orders),
    ...risk.detectWoolUsers(data.couponGrants, data.orders),
    ...risk.detectAftersalesAbuse(data.aftersales),
  ];
  const uniq = {};
  for (const ev of riskEvents) { const k = ev.event_type + '|' + ev.user_id + '|' + (ev.order_no || ''); uniq[k] = ev; }
  let riskSaved = 0;
  console.log('\n【2.风控】命中', Object.keys(uniq).length, '条：');
  for (const ev of Object.values(uniq)) {
    await risk.saveRiskEvent(db, ev);
    riskSaved++;
    console.log(`  [${ev.risk_level}] ${ev.event_type} ${ev.user_id} ${ev.order_no || ''} → ${ev.action}`);
    await alerting.notifyRiskHit(db, ev); // 高危实时推送钉钉/企微
  }

  // ===== 3. 营销自动触达（分层/唤醒/复购/权益，黑名单过滤） =====
  const users = (await db.from('svc_users').select('*').limit(200)).data || [];
  const rfm = marketing.rfmSegment(users, data.orders);
  let campaigns = 0;
  console.log('\n【3.营销】');
  const genAndSave = async (camp) => {
    const filtered = marketing.applyListFilter(camp.target_users || [], { blacklist: MARKETING_BLACKLIST });
    if (!filtered.allowed.length) { console.log('  跳过（黑名单过滤后无人）:', camp.title); return; }
    camp.target_users = filtered.allowed;
    camp.content = camp.content + `\n（黑名单过滤：屏蔽 ${filtered.blocked} 人）`;
    await marketing.saveCampaign(db, camp);
    campaigns++;
    console.log('  已生成:', camp.title);
  };
  const lostUsers = rfm.filter((u) => u.segment === 'lost' || u.segment === 'sleepy');
  if (lostUsers.length) await genAndSave(marketing.buildCampaign('wake', lostUsers, { segment: 'lost', coupon: 10 }));
  const repCands = marketing.repurchaseCandidates(data.orders, { 'TEE-WT-001': 15, 'CUP-SS-500': 10 });
  if (repCands.length) {
    const segUsers = [...new Set(repCands.map((c) => c.user_id))].map((uid) => ({ user_id: uid }));
    await genAndSave(marketing.buildCampaign('repurchase', segUsers, { segment: 'loyal', productName: '白T恤 / 保温杯', price: '79' }));
  }
  const vipReminders = marketing.vipBenefitReminders(users);
  if (vipReminders.length) {
    const camp = marketing.buildCampaign('vip_benefit', vipReminders.map((v) => ({ user_id: v.user_id })), { segment: 'champion' });
    camp.title = `会员权益提醒（${vipReminders.length}人）`;
    camp.content = vipReminders.map((v) => `${v.nickname}: ${v.content}`).join('\n');
    await genAndSave(camp);
  }

  // ===== 4. 数据日报（热点/归因/转化） =====
  const hot = analytics.hotQuestions(data.messages);
  const attr = analytics.aftersalesAttribution(data.tickets, data.refunds);
  const conv = analytics.conversionReport(data.sessions, data.messages, data.orders, data.collect);
  let summary = `咨询 ${hot.totalConsults} 次，热点主题：${hot.topTopics.slice(0, 3).map((t) => t.topic + '×' + t.count).join('、')}；${attr.conclusion}；今日订单 ${conv.ordersToday} 笔 / 支付 ${conv.paidToday} 笔 / GMV ¥${conv.gmvToday}。`;
  console.log('\n【4.日报】', summary);

  // ===== 5. AI 经营建议 =====
  if (!NO_LLM) {
    try {
      const advice = await llmSummary(
        '你是电商运营分析专家。基于以下巡检、风控与日报数据，用3条以内的要点给出今日经营建议（简体中文，每条不超过40字）：\n'
        + '巡检：' + report.summary + '\n' + report.findings.map((f) => `- [${f.severity}] ${f.detail}`).join('\n')
        + '\n风控命中：' + Object.keys(uniq).length + ' 条（高危 ' + Object.values(uniq).filter((e) => e.risk_level === 'high').length + '）'
        + '\n售后归因：' + attr.conclusion + '\n转化：' + summary
      );
      if (advice) {
        summary += '\nAI 建议：' + advice;
        console.log('\n【5.AI建议】', advice);
      }
    } catch (e) {
      console.log('LLM 建议生成失败（不影响落库）：', e.message);
    }
  }
  await analytics.saveAnalyticsDaily(db, hot, attr, conv, summary, reportDate);

  // ===== 6. MQ 积压消费（真实 MQ：回收超时→原子抢占→发送→ack/nack） =====
  let mqSent = 0, mqSkipped = 0, mqRetry = 0, mqPending = 0, mqDead = 0;
  try {
    tools.initGateway(cloud);
    try { await tools.ServiceGateway.call('mq', 'reclaimExpired', {}); } catch (_) {}
    const results = await tools.consumeCollectQueue(cloud, 100);
    mqSent = results.filter((r) => r.sent).length;
    mqSkipped = results.filter((r) => r.skipped).length;
    mqRetry = results.filter((r) => r.retry).length;
    const stats = await tools.ServiceGateway.call('mq', 'stats', {});
    const row = (stats || []).find((s) => s.topic === 'collect.send');
    mqPending = (row && row.pending) || 0;
    mqDead = (row && row.dead) || 0;
    console.log(`\n【6.MQ消费】发送${mqSent} 跳过${mqSkipped} 转重试${mqRetry}｜剩余待发${mqPending} 死信${mqDead}`);
  } catch (e) {
    console.log('MQ消费失败（不影响其他步骤）:', e.message);
  }

  console.log(`\n完成：巡检 ${report.findings.length} 项异常 | 风控落库 ${riskSaved} 条 | 营销方案 ${campaigns} 个 | MQ发送 ${mqSent} 条 | 告警推送已执行`);
  console.log('DONE');
})().catch(async (e) => {
  await alerting.notifyServiceError(db, 'daily-ops-runner', e, { reportDate }).catch(() => {});
  console.error('FATAL', e.message);
  process.exit(1);
});
