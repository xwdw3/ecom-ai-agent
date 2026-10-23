/* 智能运营中心（Phase3）：营销 / 风控 / 巡检 / 分析 */

const db = cloud.database;
let USERS = [], ORDERS = [], PRODUCTS = [], RFM = [];

// ---------- RBAC：登录身份 + 操作守卫（P0：角色由登录会话决定，不再前端切换） ----------
let GATE_USER = null;
function role() { return RBAC.currentRole(); }
function actor() { return GATE_USER ? GATE_USER.r + ':' + GATE_USER.u : role() + ':未登录'; }
function guard(perm) {
  const r = RBAC.requirePerm(role(), perm);
  if (!r.ok) { showToast(r.reason, 'error'); RBAC.auditLog(db, actor(), 'denied:' + perm, null, 'denied'); }
  return r.ok;
}

// 触达名单过滤（白/黑名单）
function listOpts() {
  const parse = (id) => document.getElementById(id).value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return { whitelist: parse('whitelist'), blacklist: parse('blacklist') };
}

async function loadAll() {
  const q = (t) => db.from(t).select('*').limit(500);
  const [users, orders, products] = await Promise.all([q('svc_users'), q('svc_orders'), q('svc_products')]);
  USERS = users.data || []; ORDERS = orders.data || []; PRODUCTS = products.data || [];
}

// ---------- 标签页 ----------
document.querySelectorAll('.sidebar .tab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.sidebar .tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
  };
});

const SEG_NAME = { champion: '高价值忠诚客', loyal: '忠诚复购客', potential: '潜力新客', sleepy: '沉睡客户', lost: '流失预警', active: '活跃客户' };
const SEG_BADGE = { champion: 'on', loyal: 'on', potential: 'pending', sleepy: 'mid', lost: 'off' };
const RISK_NAME = {
  brushing_suspect: '刷单嫌疑', malicious_order: '恶意下单', zero_purchase: '0元购',
  wool_coupon_abuse: '券滥用', wool_zero_purchase: '羊毛0元购',
};
const CHECK_NAME = { inventory: '库存异常', price: '价格异常', activity_config: '活动配置', order_backlog: '订单积压', refund_backlog: '退款积压', logistics_stuck: '物流停滞' };

// ---------- 智能营销 ----------
function renderRfm() {
  document.getElementById('rfmSummary').innerHTML =
    `共 ${RFM.length} 名用户 · ` + Object.entries(
      RFM.reduce((acc, u) => { acc[u.segment] = (acc[u.segment] || 0) + 1; return acc; }, {})
    ).map(([s, n]) => `${SEG_NAME[s]} ${n} 人`).join(' · ');
  document.getElementById('rfmBody').innerHTML = RFM.map((u) => `
    <tr>
      <td><b>${escapeHtml(u.nickname)}</b> <span class="empty">${escapeHtml(u.user_id)}</span></td>
      <td>${u.R > 300 ? '从未购买' : u.R + ' 天前'}</td>
      <td>${u.F} 次</td><td>¥${u.M}</td>
      <td><span class="badge ${SEG_BADGE[u.segment] || 'pending'}">${SEG_NAME[u.segment]}</span></td>
      <td class="empty">${escapeHtml(MarketingAgent.SEGMENT_META[u.segment].strategy)}</td>
    </tr>`).join('');
}

document.getElementById('btnRfm').onclick = async () => {
  try {
    RFM = MarketingAgent.rfmSegment(USERS, ORDERS);
    renderRfm();
    showToast('RFM 分层完成', 'success');
  } catch (e) { showToast('分层失败：' + (e.message || e), 'error'); }
};

async function genCampaign(type, opts) {
  if (!guard('marketing.send')) return;
  const targets = RFM.length ? RFM.filter((u) => (opts.segments || [opts.segment]).includes(u.segment)) : [];
  if (!targets.length) return showToast('请先「运行 RFM 分层」且目标分层有人', 'error');
  const camp = MarketingAgent.buildCampaign(type, targets, { ...opts, segment: opts.segment });
  const filtered = MarketingAgent.applyListFilter(camp.target_users || [], listOpts());
  if (!filtered.allowed.length) return showToast('白/黑名单过滤后无人可触达', 'error');
  camp.target_users = filtered.allowed;
  if (filtered.blocked) camp.content += `\n（名单过滤：屏蔽 ${filtered.blocked} 人）`;
  await MarketingAgent.saveCampaign(db, camp);
  await RBAC.auditLog(db, actor(), 'marketing.send', { title: camp.title });
  await renderCampaigns();
  showToast('方案已生成并保存：' + camp.title, 'success');
}

document.getElementById('btnWake').onclick = () => genCampaign('wake', { segment: 'lost', coupon: 10, segments: ['lost', 'sleepy'] });
document.getElementById('btnRepurchase').onclick = async () => {
  const cands = MarketingAgent.repurchaseCandidates(ORDERS, { 'TEE-WT-001': 15, 'CUP-SS-500': 10 });
  if (!cands.length) return showToast('暂无到复购周期的用户', 'error');
  const byUser = {};
  for (const c of cands) (byUser[c.user_id] || (byUser[c.user_id] = [])).push(c);
  const segUsers = Object.keys(byUser).map((uid) => ({ user_id: uid, nickname: (USERS.find((u) => u.user_id === uid) || {}).nickname || uid }));
  const camp = MarketingAgent.buildCampaign('repurchase', segUsers, { segment: 'loyal', productName: '白T恤 / 保温杯', price: '79' });
  camp.content = camp.content + '\n（命中用户：' + segUsers.map((u) => u.nickname).join('、') + '）';
  await MarketingAgent.saveCampaign(db, camp);
  await renderCampaigns();
  showToast(`复购提醒已生成（${segUsers.length} 人）`, 'success');
};
document.getElementById('btnPromo').onclick = () => {
  const date = document.getElementById('promoDate').value || new Date().toISOString().slice(0, 10);
  genCampaign('promotion', { segments: ['champion', 'sleepy', 'lost'], date });
};

// 会员权益提醒 / 新品定向推送
document.getElementById('btnVip').onclick = async () => {
  if (!guard('marketing.send')) return;
  const rems = MarketingAgent.vipBenefitReminders(USERS);
  if (!rems.length) return showToast('暂无金银牌会员', 'error');
  const camp = MarketingAgent.buildCampaign('vip_benefit', rems.map((v) => ({ user_id: v.user_id })), { segment: 'champion' });
  camp.title = `会员权益提醒（${rems.length}人）`;
  camp.content = rems.map((v) => `${v.nickname}: ${v.content}`).join('\n');
  const filtered = MarketingAgent.applyListFilter(camp.target_users || [], listOpts());
  camp.target_users = filtered.allowed;
  await MarketingAgent.saveCampaign(db, camp);
  await RBAC.auditLog(db, actor(), 'marketing.send', { title: camp.title });
  await renderCampaigns();
  showToast(`会员权益提醒已生成（${rems.length} 人）`, 'success');
};
document.getElementById('btnNewArrival').onclick = async () => {
  if (!guard('marketing.send')) return;
  if (!RFM.length) return showToast('请先「运行 RFM 分层」', 'error');
  const prods = PRODUCTS.map((p) => ({ ...p, is_new: p.sku === 'TEE-WT-001' })); // 演示：白T恤标记新品
  const { targets, campaign } = MarketingAgent.newArrivalPush(prods, RFM);
  if (!campaign) return showToast('无新品可推送', 'error');
  const filtered = MarketingAgent.applyListFilter(targets, listOpts());
  campaign.target_users = filtered.allowed;
  if (!filtered.allowed.length) return showToast('名单过滤后无人可触达', 'error');
  await MarketingAgent.saveCampaign(db, campaign);
  await RBAC.auditLog(db, actor(), 'marketing.send', { title: campaign.title });
  await renderCampaigns();
  showToast(`新品定向推送已生成（${filtered.allowed.length} 人）`, 'success');
};

async function renderCampaigns() {
  const list = await MarketingAgent.listCampaigns(db, 20);
  document.getElementById('campaignBody').innerHTML = list.length ? list.map((c) => `
    <tr>
      <td><b>${escapeHtml(c.title)}</b></td>
      <td><span class="badge pending">${escapeHtml(c.campaign_type)}</span></td>
      <td style="white-space:pre-line" class="empty">${escapeHtml(c.content || '')}</td>
      <td>${escapeHtml(c.channel || '')}</td>
      <td class="empty">${fmtTime(c.created_at)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">暂无方案</td></tr>';
}

// ---------- 智能风控 ----------
document.getElementById('btnRiskScan').onclick = async () => {
  if (!guard('risk.execute')) return;
  const body = document.getElementById('riskBody');
  body.innerHTML = '<tr><td colspan="6" class="empty">扫描中…</td></tr>';
  try {
    const grants = (await db.from('coupon_grants').select('*').eq('tenant_id', Tenant.id()).limit(200)).data || [];
    const aftersales = (await db.from('aftersales_tickets').select('*').eq('tenant_id', Tenant.id()).limit(200)).data || [];
    const events = [
      ...RiskAgent.detectAbnormalOrders(ORDERS),
      ...RiskAgent.detectWoolUsers(grants, ORDERS),
      ...RiskAgent.detectAftersalesAbuse(aftersales),
    ];
    const byKey = {};
    for (const ev of events) { const k = ev.event_type + '|' + ev.user_id; if (!byKey[k]) byKey[k] = ev; }
    const uniq = Object.values(byKey);
    for (const ev of uniq) {
      await RiskAgent.saveRiskEvent(db, ev);
      await AlertCenter.notifyRiskHit(db, ev); // 风控命中→统一告警实时推送
    }
    await RBAC.auditLog(db, actor(), 'risk.execute', { events: uniq.length });
    document.getElementById('riskSummary').textContent =
      `扫描完成：命中 ${uniq.length} 条风险事件（高危 ${uniq.filter((e) => e.risk_level === 'high').length} 条）`;
    body.innerHTML = uniq.map((ev) => `
      <tr>
        <td><b>${RISK_NAME[ev.event_type] || escapeHtml(ev.event_type)}</b></td>
        <td>${escapeHtml(ev.user_id || '')}${ev.order_no ? '<br><span class="empty">' + escapeHtml(ev.order_no) + '</span>' : ''}</td>
        <td><span class="badge ${ev.risk_level === 'high' ? 'off' : 'mid'}">${ev.risk_level === 'high' ? '高危' : '中危'}</span></td>
        <td class="empty" style="font-size:12px">${escapeHtml(JSON.stringify(ev.detail).slice(0, 120))}</td>
        <td><span class="badge ${ev.action === 'block' ? 'off' : 'pending'}">${ev.action === 'block' ? '拦截' : ev.action === 'review' ? '人工复核' : '放行'}</span></td>
        <td class="empty">${fmtTime(new Date().toISOString())}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">未发现风险</td></tr>';
    showToast('风控扫描完成：' + uniq.length + ' 条事件已落库', 'success');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="empty">扫描失败：' + escapeHtml(e.message || String(e)) + '</td></tr>';
  }
};

async function initGuard() {
  const sel = document.getElementById('guardUser');
  sel.innerHTML = USERS.map((u) => `<option value="${escapeHtml(u.user_id)}">${escapeHtml(u.nickname)}（${escapeHtml(u.user_id)}）</option>`).join('');
  document.getElementById('btnGuard').onclick = async () => {
    const uid = sel.value;
    const grants = (await db.from('coupon_grants').select('*').eq('tenant_id', Tenant.id()).eq('user_id', uid).limit(50)).data || [];
    const r = RiskAgent.seckillGuard(grants, uid, 2);
    document.getElementById('guardResult').innerHTML = r.allow
      ? '<span class="badge on">✅ 校验通过，允许领取</span>'
      : '<span class="badge off">⛔ ' + escapeHtml(r.reason) + '</span>';
  };
}

// ---------- 每日巡检 ----------
document.getElementById('btnInspect').onclick = async () => {
  if (!guard('inspection.execute')) return;
  const body = document.getElementById('inspectBody');
  body.innerHTML = '<tr><td colspan="4" class="empty">巡检中…</td></tr>';
  try {
    const [refunds, logistics] = await Promise.all([
      db.from('svc_refunds').select('*').eq('tenant_id', Tenant.id()).limit(200),
      db.from('svc_logistics').select('*').eq('tenant_id', Tenant.id()).limit(200),
    ]);
    const report = InspectionAgent.runInspection({
      products: PRODUCTS, orders: ORDERS,
      refunds: refunds.data || [], logistics: logistics.data || [],
    });
    await InspectionAgent.saveInspectionReport(db, report, new Date().toISOString().slice(0, 10));
    for (const f of report.findings) await AlertCenter.notifyInspectionFinding(db, f); // 巡检异常→统一告警
    await RBAC.auditLog(db, actor(), 'inspection.execute', { findings: report.findings.length });
    document.getElementById('inspectSummary').textContent = report.summary;
    body.innerHTML = report.findings.length ? report.findings.map((f) => `
      <tr>
        <td><b>${CHECK_NAME[f.check] || escapeHtml(f.check)}</b></td>
        <td><span class="badge ${f.severity === 'high' ? 'off' : 'mid'}">${f.severity === 'high' ? '高危' : f.severity === 'mid' ? '中危' : '低危'}</span></td>
        <td>${escapeHtml(f.detail)}</td>
        <td class="empty">${escapeHtml(f.suggestion)}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="empty">✅ 全部通过</td></tr>';
    renderInspectHistory();
    showToast('巡检完成：' + report.summary, report.severity === 'high' ? 'error' : 'success');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="4" class="empty">巡检失败：' + escapeHtml(e.message || String(e)) + '</td></tr>';
  }
};

async function renderInspectHistory() {
  const list = await InspectionAgent.listInspectionReports(db, 10);
  document.getElementById('inspectHistoryBody').innerHTML = list.length ? list.map((r) => `
    <tr>
      <td><b>${escapeHtml(r.report_date)}</b></td>
      <td><span class="badge ${r.severity === 'high' ? 'off' : r.severity === 'ok' ? 'on' : 'mid'}">${r.severity === 'ok' ? '正常' : r.severity === 'high' ? '高危' : '中危'}</span></td>
      <td class="empty">${escapeHtml(r.summary)}</td>
      <td class="empty">${fmtTime(r.created_at)}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">暂无报告</td></tr>';
}

// ---------- 数据分析 ----------
document.getElementById('btnAnalytics').onclick = async () => {
  if (!guard('analytics.export')) return;
  try {
    const [sessions, messages, tickets, collect] = await Promise.all([
      db.from('chat_sessions').select('*').eq('tenant_id', Tenant.id()).limit(200),
      db.from('chat_messages').select('*').eq('tenant_id', Tenant.id()).limit(500),
      db.from('support_tickets').select('*').eq('tenant_id', Tenant.id()).limit(200),
      db.from('collect_tasks').select('*').eq('tenant_id', Tenant.id()).limit(200),
    ]);
    const hot = AnalyticsAgent.hotQuestions(messages.data || []);
    const attr = AnalyticsAgent.aftersalesAttribution(tickets.data || [], []);
    const conv = AnalyticsAgent.conversionReport(sessions.data || [], messages.data || [], ORDERS, collect.data || []);
    const summary = `咨询 ${hot.totalConsults} 次；${attr.conclusion}；今日订单 ${conv.ordersToday} / GMV ¥${conv.gmvToday}`;
    await AnalyticsAgent.saveAnalyticsDaily(db, hot, attr, conv, summary, new Date().toISOString().slice(0, 10));

    document.getElementById('hotBox').innerHTML =
      `<b>咨询总量：</b>${hot.totalConsults} 次<br>` +
      `<b>主题分布：</b>${hot.topTopics.map((t) => `${t.topic} ×${t.count}`).join(' · ') || '—'}<br>` +
      `<b>热点词：</b>${hot.topWords.map((w) => `${escapeHtml(w.word)}×${w.count}`).join(' · ') || '—'}`;
    document.getElementById('attrBox').innerHTML =
      `<b>归因结论：</b>${escapeHtml(attr.conclusion)}<br>` +
      (attr.ranked.map((r) => `<span class="empty">· ${escapeHtml(r.cause)} ×${r.count}（责任：${escapeHtml(r.owner)}）</span>`).join('<br>') || '—');
    document.getElementById('convBox').innerHTML =
      `<b>今日：</b>订单 ${conv.ordersToday} 笔 · 支付 ${conv.paidToday} 笔 · GMV ¥${conv.gmvToday}<br>` +
      `<b>催付：</b>发送 ${conv.collectSent} · 挽回 ${conv.collectRecovered}（${conv.collectRecoveryRate == null ? '—' : conv.collectRecoveryRate + '%'}）<br>` +
      `<b>自动解决率：</b>${conv.autoResolveRate == null ? '—' : conv.autoResolveRate + '%'}<br>` +
      `<span class="empty">${escapeHtml(conv.note)}</span>`;
    showToast('今日数据分析已生成并落库', 'success');
  } catch (e) { showToast('分析失败：' + (e.message || e), 'error'); }
};

// ---------- 统一告警 ----------
document.getElementById('btnAlerts').onclick = renderAlerts;
async function renderAlerts() {
  try {
    const list = await AlertCenter.listAlerts(db, 30);
    document.getElementById('alertBody').innerHTML = list.length ? list.map((a) => `
      <tr>
        <td><b>${escapeHtml(a.alert_type)}</b></td>
        <td><span class="badge ${a.severity === 'high' || a.severity === 'error' ? 'off' : 'mid'}">${escapeHtml(a.severity)}</span></td>
        <td style="font-size:12px">${escapeHtml(a.message || '')}</td>
        <td class="empty">${fmtTime(a.created_at)}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="empty">暂无告警</td></tr>';
  } catch (e) {
    document.getElementById('alertBody').innerHTML = '<tr><td colspan="4" class="empty">加载失败：' + escapeHtml(e.message || e) + '</td></tr>';
  }
}

// ---------- 初始化（登录门禁后执行） ----------
(async () => {
  GATE_USER = await gateRequire(); // P0：登录门禁，角色来自账号表
  RBAC.setRole(GATE_USER.r);
  document.getElementById('gateUserBar').innerHTML =
    '👤 <b>' + escapeHtml(GATE_USER.u) + '</b>（' + escapeHtml((RBAC.ROLES[GATE_USER.r] || {}).name || GATE_USER.r) + '）';
  document.getElementById('logoutBtn').onclick = gateLogout;
  RBAC.applyPageGuards(GATE_USER.r);
  await loadAll();
  await renderCampaigns();
  await renderInspectHistory();
  await renderAlerts();
  await renderChannels();
  await initGuard();
})();

// ---------- 推送渠道配置（P1：webhook 可视化配置） ----------
async function renderChannels() {
  const body = document.getElementById('chBody');
  try {
    const rows = await AlertCenter.listChannels(db);
    body.innerHTML = rows.length ? rows.map((c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.type === 'dingtalk' ? '钉钉' : '企微'}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.webhook_url)}</td>
        <td>${c.enabled ? '<span style="color:#16a34a">已启用</span>' : '<span style="color:#94a3b8">已停用</span>'}</td>
        <td>
          <button class="btn small blue" data-test="${c.id}" data-type="${c.type}">测试发送</button>
          <button class="btn small" data-toggle="${c.id}" data-en="${c.enabled ? 1 : 0}">${c.enabled ? '停用' : '启用'}</button>
          <button class="btn small danger" data-del="${c.id}">删除</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">尚未配置渠道，保存 webhook 后告警将真实推送</td></tr>';
    body.querySelectorAll('[data-test]').forEach((b) => b.onclick = () => testChannel(b.dataset.type));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
      try { await db.from('alert_channels').update({ enabled: b.dataset.en !== '1' }).eq('tenant_id', Tenant.id()).eq('id', b.dataset.id); renderChannels(); }
      catch (e) { showToast('操作失败：' + (e.message || e), 'error'); }
    });
    body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('确认删除该渠道？')) return;
      try { await AlertCenter.deleteChannel(db, b.dataset.del); renderChannels(); showToast('已删除', 'success'); }
      catch (e) { showToast('删除失败：' + (e.message || e), 'error'); }
    });
  } catch (e) {
    body.innerHTML = '<tr><td colspan="5" class="empty">加载失败：' + escapeHtml(e.message || e) + '</td></tr>';
  }
}

async function testChannel(type) {
  const r = await AlertCenter.pushToChannel(type, '🧪 电商AI助手测试消息：如果您在钉钉/企微群里看到这条消息，说明告警通道已打通。', db);
  if (r.ok && !r.simulated) showToast(type + ' 测试推送成功 ✓', 'success');
  else if (r.ok) showToast(type + ' 未配置 webhook，已模拟推送', 'info');
  else showToast(type + ' 推送失败：' + (r.reason || r.detail), 'error');
}

document.getElementById('btnSaveChannel').onclick = async () => {
  const name = document.getElementById('chName').value.trim();
  const url = document.getElementById('chUrl').value.trim();
  if (!name || !url) return showToast('请填写渠道名称和 Webhook 地址', 'error');
  try {
    await AlertCenter.saveChannel(db, {
      name, type: document.getElementById('chType').value, webhook_url: url,
      secret: document.getElementById('chSecret').value.trim() || null, enabled: true,
    });
    document.getElementById('chName').value = ''; document.getElementById('chUrl').value = ''; document.getElementById('chSecret').value = '';
    renderChannels();
    showToast('渠道已保存，可用「测试发送」验证连通性', 'success');
  } catch (e) { showToast('保存失败：' + (e.message || e), 'error'); }
};
