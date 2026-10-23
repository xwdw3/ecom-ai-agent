/* 运营台逻辑：弃单催付 / 活动提醒补券 / 售后工单 / 分流日志 / 工具审计 */
initGateway(cloud); // 初始化服务网关（云库 adapter）

// 运营台服务账号令牌（同样走 JWT 鉴权 + 权限最小化）
let CONSOLE_TOKEN = null;
(async () => {
  await gateRequire(); // P0：登录门禁
  try {
    CONSOLE_TOKEN = await issueToken({
      caller: 'console-ops', name: '运营台操作员',
      scopes: ['order:read', 'user:read', 'marketing:collect', 'marketing:coupon', 'aftersales:write', 'audit:read'],
    });
  } catch (e) { console.warn('令牌签发失败', e); }
})();

// ---------- Tab 切换 ----------
document.querySelectorAll('.sidebar .tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.sidebar .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'marketing') { loadReminders(); loadCoupons(); }
    if (tab.dataset.panel === 'aftersales') loadTickets();
    if (tab.dataset.panel === 'router') loadRouteLogs();
    if (tab.dataset.panel === 'collect') loadCollectTasks();
    if (tab.dataset.panel === 'audit') loadAudit();
  };
});

// ---------- 弃单催付 ----------
document.getElementById('scanAbandon').onclick = async () => {
  const min = Number(document.getElementById('abandonMin').value) || 30;
  const body = document.getElementById('abandonBody');
  body.innerHTML = '<tr><td colspan="6" class="empty">扫描中…</td></tr>';
  let list;
  try {
    list = await ServiceGateway.call('order', 'listAbandoned', { minAgeMinutes: min });
  } catch (e) {
    return (body.innerHTML = '<tr><td colspan="6" class="empty">扫描失败：' + escapeHtml(e.message || String(e)) + '</td></tr>');
  }
  if (!list.length) return (body.innerHTML = '<tr><td colspan="6" class="empty">✅ 当前无超时弃单</td></tr>');

  const userIds = [...new Set(list.map((o) => o.user_id))];
  const userMap = {};
  await Promise.all(userIds.map(async (u) => {
    try { userMap[u] = await ServiceGateway.call('user', 'get', { user_id: u }); } catch (e) { /* noop */ }
  }));

  body.innerHTML = list.map((o) => {
    const t = tierFor(o.amount);
    const mins = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000);
    const uname = (userMap[o.user_id] && userMap[o.user_id].nickname) || o.user_id;
    return `<tr>
      <td><b>${escapeHtml(o.order_no)}</b></td>
      <td>${escapeHtml(uname)}</td>
      <td class="data-emphasis">¥${o.amount}</td>
      <td>${mins} 分钟</td>
      <td><span class="badge on">${escapeHtml(t.tier)}</span> <span class="empty" style="font-size:11px">${escapeHtml(t.channel)} · ${escapeHtml(t.strategy)}</span></td>
      <td><button class="btn small blue" data-order="${escapeHtml(o.order_no)}" data-user="${escapeHtml(o.user_id)}">发送催付</button></td>
    </tr>`;
  }).join('');

  body.querySelectorAll('button[data-order]').forEach((btn) => {
    btn.onclick = async () => {
      const orderNo = btn.dataset.order, userId = btn.dataset.user;
      const o = list.find((x) => x.order_no === orderNo);
      const t = tierFor(o.amount);
      btn.disabled = true; btn.textContent = '入队中…';
      try {
        // 走 Agent 工具链：频控（防骚扰）→ MQ 异步入队（削峰、不阻塞）
        const r = await executeTool({
          tool: 'send_collect_task',
          args: {
            order_no: orderNo, user_id: userId, amount: o.amount, tier: t.tier,
            channel: t.channel, strategy: t.strategy, coupon: t.coupon || null,
          },
        }, { token: CONSOLE_TOKEN });
        if (r.queued) showToast('已入队MQ（' + t.tier + '）：' + r.reason + '，点击「消费MQ队列」异步发送', 'success');
        else showToast('已被频控拦截：' + r.reason, 'error');
      } catch (e) {
        showToast('发送失败：' + (e.message || e), 'error');
      }
      loadCollectTasks();
    };
  });
};

// 消费 MQ 队列（真实 MQ：原子抢占→频控复核→发送→ack/nack，失败自动退避重试/死信）
document.getElementById('consumeMq').onclick = async () => {
  const btn = document.getElementById('consumeMq');
  btn.disabled = true; btn.textContent = '消费中…';
  try {
    const results = await consumeCollectQueue(cloud, 50);
    const sent = results.filter((r) => r.sent).length;
    const skipped = results.filter((r) => r.skipped).length;
    const retry = results.filter((r) => r.retry).length;
    showToast(`队列消费完成：发送 ${sent} 条，频控跳过 ${skipped} 条${retry ? `，失败转重试 ${retry} 条` : ''}`, 'success');
  } catch (e) {
    showToast('消费失败：' + (e.message || e), 'error');
  }
  btn.disabled = false; btn.textContent = '⚡ 消费MQ队列（异步发送）';
  loadCollectTasks();
};

// 队列状态（pgmq 式统计：pending/processing/consumed/dead/积压时长）
document.getElementById('mqStats').onclick = async () => {
  try {
    const s = await ServiceGateway.call('mq', 'stats', {});
    if (!s.length) return showToast('队列空：暂无消息', 'success');
    showToast(s.map((t) => `${t.topic}：待发${t.pending} 处理中${t.processing} 已消费${t.consumed} 死信${t.dead}` +
      (t.oldest_pending_seconds ? ` 积压${t.oldest_pending_seconds}s` : '')).join(' ｜ '), 'success');
  } catch (e) { showToast('统计失败：' + (e.message || e), 'error'); }
};

// 死信重驱动：把死信消息重置回队列重新消费
document.getElementById('mqRedrive').onclick = async () => {
  try {
    const n = await ServiceGateway.call('mq', 'requeueDead', {});
    showToast(`死信重驱动完成：${n} 条回到队列`, n > 0 ? 'success' : 'info');
  } catch (e) { showToast('重驱动失败：' + (e.message || e), 'error'); }
};

async function loadCollectTasks() {
  const { data, error } = await cloud.database.from('collect_tasks').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(50);
  const body = document.getElementById('collectBody');
  if (error) return (body.innerHTML = '<tr><td colspan="6" class="empty">加载失败</td></tr>');
  if (!data || !data.length) return (body.innerHTML = '<tr><td colspan="6" class="empty">暂无催付任务</td></tr>');
  body.innerHTML = data.map((t) => `<tr>
    <td><b>${escapeHtml(t.order_no)}</b></td><td>${escapeHtml(t.user_id)}</td>
    <td>${escapeHtml(t.tier)}</td><td>${escapeHtml(t.channel)}</td>
    <td>${escapeHtml(t.strategy)}${t.result ? ' · ' + escapeHtml(t.result) : ''}</td>
    <td>${fmtTime(t.created_at)}</td></tr>`).join('');
}
document.getElementById('refreshCollect').onclick = loadCollectTasks;

// ---------- 活动提醒 / 补券 ----------
async function loadReminders() {
  let list;
  try { list = await ServiceGateway.call('marketing', 'listReminders', {}); }
  catch (e) { return (document.getElementById('remindBody').innerHTML = '<tr><td colspan="5" class="empty">加载失败</td></tr>'); }
  const body = document.getElementById('remindBody');
  if (!list.length) return (body.innerHTML = '<tr><td colspan="5" class="empty">暂无到期提醒</td></tr>');
  body.innerHTML = list.map((r) => `<tr>
    <td>${escapeHtml(r.user_id)}</td>
    <td><b>${escapeHtml(r.activity_name)}</b></td>
    <td>${fmtTime(r.expires_at)}</td>
    <td>${escapeHtml(r.content)}</td>
    <td>${r.status === 'pending' ? `<button class="btn small blue" data-id="${r.id}">发送提醒</button>` : '<span class="badge done">已发送</span>'}</td>
  </tr>`).join('');
  body.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      const { error } = await cloud.database.from('activity_reminders').update({ status: 'sent' }).eq('tenant_id', Tenant.id()).eq('id', btn.dataset.id);
      showToast(error ? '发送失败' : '提醒已发送', error ? 'error' : 'success');
      loadReminders();
    };
  });
}

async function loadCoupons() {
  let list;
  try { list = await ServiceGateway.call('marketing', 'listCoupons', {}); }
  catch (e) { return (document.getElementById('couponBody').innerHTML = '<tr><td colspan="6" class="empty">加载失败</td></tr>'); }
  const body = document.getElementById('couponBody');
  if (!list.length) return (body.innerHTML = '<tr><td colspan="6" class="empty">暂无补发记录</td></tr>');
  body.innerHTML = list.map((c) => `<tr>
    <td>${escapeHtml(c.user_id)}</td><td><b>${escapeHtml(c.coupon_name)}</b></td>
    <td class="data-emphasis">¥${c.amount}</td><td>${escapeHtml(c.reason)}</td>
    <td>${c.valid_days} 天</td><td>${fmtTime(c.created_at)}</td></tr>`).join('');
}

document.getElementById('grantCoupon').onclick = async () => {
  const userId = document.getElementById('cgUser').value.trim();
  const name = document.getElementById('cgName').value.trim();
  const amount = Number(document.getElementById('cgAmount').value) || 0;
  const reason = document.getElementById('cgReason').value.trim() || '运营手动补发';
  if (!userId || !name || amount <= 0) return showToast('请填写用户ID、券名称与有效面额', 'error');
  try {
    await ServiceGateway.call('marketing', 'reissueCoupon', { user_id: userId, coupon_name: name, amount, reason, valid_days: 7 });
    showToast('补发成功', 'success');
    document.getElementById('cgName').value = ''; document.getElementById('cgAmount').value = ''; document.getElementById('cgReason').value = '';
    loadCoupons();
  } catch (e) { showToast('补发失败：' + (e.message || e), 'error'); }
};

// ---------- 售后工单 ----------
async function loadTickets() {
  const f = document.getElementById('asFilter').value;
  let list;
  try { list = await ServiceGateway.call('aftersales', 'listTickets', {}); }
  catch (e) { return (document.getElementById('asBody').innerHTML = '<tr><td colspan="7" class="empty">加载失败</td></tr>'); }
  if (f === 'auto') list = list.filter((t) => t.auto_processed);
  if (f === 'manual') list = list.filter((t) => !t.auto_processed);
  const body = document.getElementById('asBody');
  if (!list.length) return (body.innerHTML = '<tr><td colspan="7" class="empty">暂无售后工单</td></tr>');
  const typeNames = { return_refund: '退货退款', refund_only: '仅退款', exchange: '换货' };
  body.innerHTML = list.map((t) => {
    const syncBadge = t.sync_status === 'synced'
      ? '<span class="badge done">✓ ' + escapeHtml(t.external_system || 'legacy') + '：' + escapeHtml(t.external_ticket_no || '') + '</span>'
      : '<span class="badge fallback">待流转</span>';
    return `<tr>
    <td><b>${escapeHtml(t.ticket_no)}</b></td>
    <td>${escapeHtml(t.order_no)}</td>
    <td>${escapeHtml(typeNames[t.type] || t.type)}</td>
    <td>${escapeHtml(t.reason || '-')}</td>
    <td>${t.status === 'auto_done'
      ? '<span class="badge on">AI已办理</span>'
      : t.status === 'open' ? '<span class="badge fallback">待处理</span>' : '<span class="badge done">' + escapeHtml(t.status) + '</span>'}</td>
    <td>${syncBadge}</td>
    <td>${escapeHtml(t.note || '-')}</td>
    <td>${fmtTime(t.created_at)}</td></tr>`;
  }).join('');
}
document.getElementById('asRefresh').onclick = loadTickets;
document.getElementById('asFilter').onchange = loadTickets;

// ---------- 分流日志 ----------
async function loadRouteLogs() {
  const f = document.getElementById('rtFilter').value;
  let list;
  try { list = await ServiceGateway.call('router', 'listDecisions', {}); }
  catch (e) { return (document.getElementById('rtList').innerHTML = '<div class="empty">加载失败</div>'); }
  if (f) list = list.filter((r) => r.route === f);
  const el = document.getElementById('rtList');
  if (!list.length) return (el.innerHTML = '<div class="empty">暂无分流记录</div>');
  el.innerHTML = list.map((r) => `<div class="log-item">
    <div class="meta">
      <span>${fmtTime(r.created_at)}</span>
      ${r.route === 'human'
        ? '<span class="badge fallback">→ 转人工</span>'
        : '<span class="badge on">AI 自动</span>'}
      <span>风险：${escapeHtml(r.risk_level)}</span>
      <span>会话 ${escapeHtml(String(r.session_id).slice(0, 12))}…</span>
    </div>
    <div class="content">${escapeHtml(r.question)}${r.reason ? ' · ' + escapeHtml(r.reason) : ''}</div>
  </div>`).join('');
}
document.getElementById('rtRefresh').onclick = loadRouteLogs;
document.getElementById('rtFilter').onchange = loadRouteLogs;

// ---------- 工具审计日志 ----------
async function loadAudit() {
  const fStatus = document.getElementById('auditStatus').value;
  const fTrace = document.getElementById('auditTrace').value.trim();
  let list;
  try { list = await ServiceGateway.call('audit', 'list', {}); }
  catch (e) { return (document.getElementById('auditList').innerHTML = '<div class="empty">加载失败：' + escapeHtml(e.message || e) + '</div>'); }
  if (fStatus) list = list.filter((a) => a.status === fStatus);
  if (fTrace) list = list.filter((a) => a.trace_id === fTrace);
  const el = document.getElementById('auditList');
  if (!list.length) return (el.innerHTML = '<div class="empty">暂无审计记录</div>');
  el.innerHTML = list.map((a) => {
    const st = a.status === 'success' ? '<span class="badge on">success</span>'
      : a.status === 'denied' ? '<span class="badge fallback">denied</span>'
      : '<span class="badge fallback">failed</span>';
    return `<div class="log-item">
      <div class="meta">
        <span>${fmtTime(a.created_at)}</span>
        <span>链路 <b>${escapeHtml(String(a.trace_id || '').slice(0, 14))}</b></span>
        ${st}
        <span>调用人：${escapeHtml(a.caller)}</span>
        <span>耗时 ${a.latency_ms}ms</span>
      </div>
      <div class="content"><b>${escapeHtml(a.tool)}</b> · 入参 ${escapeHtml(JSON.stringify(a.args || {})).slice(0, 120)}${a.error ? ' · 错误：' + escapeHtml(a.error) : ''}</div>
    </div>`;
  }).join('');
}
document.getElementById('auditRefresh').onclick = loadAudit;
document.getElementById('auditStatus').onchange = loadAudit;
document.getElementById('auditTrace').onchange = loadAudit;

// ---------- 初始化 ----------
loadCollectTasks();
