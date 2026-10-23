/**
 * P1 · 人工客服坐席台
 * 工单列表 → 会话记录 → 接入/回复/完结
 * 用户端（index.html）每 4 秒轮询 role='agent' 消息，坐席回复实时可见
 */
/* global cloud, gateRequire, gateLogout, escapeHtml, showToast */

const db = cloud.database;
let CURRENT = null; // 当前选中工单
let POLL_TIMER = null;

const STATUS_TEXT = { open: '待接入', processing: '处理中', done: '已完结' };

async function loadTickets() {
  const box = document.getElementById('ticketList');
  const { data, error } = await db.from('support_tickets')
    .select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(100);
  if (error) { box.innerHTML = '<div class="empty-tip">加载失败：' + escapeHtml(error.message) + '</div>'; return; }
  const tickets = data || [];
  // 待接入 → 处理中 → 已完结，组内按时间倒序
  const rank = { open: 0, processing: 1, done: 2 };
  tickets.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || new Date(b.created_at) - new Date(a.created_at));
  box.innerHTML = tickets.length ? tickets.map((t) => `
    <div class="ticket ${CURRENT && CURRENT.id === t.id ? 'active' : ''}" data-id="${t.id}">
      <div class="meta">
        <span class="badge ${t.status}">${STATUS_TEXT[t.status] || t.status}</span>
        ${escapeHtml(t.session_id || '')} · ${new Date(t.created_at).toLocaleString('zh-CN', { hour12: false })}
      </div>
      <div class="q">${escapeHtml(t.question || '')}</div>
    </div>`).join('') : '<div class="empty-tip">暂无工单 🎉</div>';
  box.querySelectorAll('.ticket').forEach((el) => {
    el.onclick = () => { CURRENT = tickets.find((t) => String(t.id) === el.dataset.id); renderDetail(); loadTickets(); };
  });
}

async function renderDetail() {
  const pane = document.getElementById('detailPane');
  if (!CURRENT) return;
  pane.innerHTML = '<div class="empty-tip">加载会话中…</div>';
  const { data: msgs } = await db.from('chat_messages')
    .select('*').eq('tenant_id', Tenant.id()).eq('session_id', CURRENT.session_id).order('id', { ascending: true }).limit(200);
  const lines = (msgs || []).map((m) => {
    const who = m.role === 'user' ? '用户' : (m.role === 'agent' ? '人工' : 'AI');
    return `<div class="line ${m.role}"><span class="who">${who}</span><div class="b">${escapeHtml(m.content || '')}</div></div>`;
  }).join('');
  pane.innerHTML = `
    <div class="detail-head">
      <b style="font-size:14px">工单 #${CURRENT.id}</b>
      <span class="badge ${CURRENT.status}">${STATUS_TEXT[CURRENT.status] || CURRENT.status}</span>
      <span style="font-size:12px;color:#64748b">会话 ${escapeHtml(CURRENT.session_id || '')} · 联系方式：${escapeHtml(CURRENT.contact || '未留')}</span>
      <div style="flex:1"></div>
      ${CURRENT.status === 'open' ? '<button class="btn primary" id="btnAccept">接入会话</button>' : ''}
      ${CURRENT.status !== 'done' ? '<button class="btn" id="btnResolve">完结工单</button>' : ''}
    </div>
    <div class="transcript" id="transcript">${lines || '<div class="empty-tip">该会话暂无消息记录</div>'}</div>
    ${CURRENT.status !== 'done' ? `
    <div class="replybar">
      <textarea id="replyText" placeholder="输入人工回复…（用户端将实时收到）"></textarea>
      <button class="btn primary" id="btnSend" style="align-self:flex-end;height:60px">发送回复</button>
    </div>` : '<div class="empty-tip" style="padding:14px">工单已完结</div>'}`;
  const tr = pane.querySelector('#transcript');
  tr.scrollTop = tr.scrollHeight;
  const accept = pane.querySelector('#btnAccept');
  if (accept) accept.onclick = async () => {
    const { error } = await db.from('support_tickets').update({ status: 'processing' }).eq('tenant_id', Tenant.id()).eq('id', CURRENT.id);
    if (error) return showToast('接入失败：' + error.message, 'error');
    await db.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: CURRENT.session_id, role: 'agent', content: '您好，人工客服已接入，请描述您的问题。', refs: null, is_fallback: false });
    CURRENT.status = 'processing';
    showToast('已接入会话，用户端将看到欢迎消息', 'success');
    renderDetail(); loadTickets();
  };
  const resolve = pane.querySelector('#btnResolve');
  if (resolve) resolve.onclick = async () => {
    const note = prompt('处理结果备注：') || '';
    const { error } = await db.from('support_tickets').update({ status: 'done', note: String(note) }).eq('tenant_id', Tenant.id()).eq('id', CURRENT.id);
    if (error) return showToast('完结失败：' + error.message, 'error');
    CURRENT.status = 'done';
    showToast('工单已完结', 'success');
    renderDetail(); loadTickets();
  };
  const send = pane.querySelector('#btnSend');
  if (send) send.onclick = async () => {
    const text = pane.querySelector('#replyText').value.trim();
    if (!text) return showToast('请输入回复内容', 'error');
    send.disabled = true;
    const { error } = await db.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: CURRENT.session_id, role: 'agent', content: text, refs: null, is_fallback: false });
    send.disabled = false;
    if (error) return showToast('发送失败：' + error.message, 'error');
    pane.querySelector('#replyText').value = '';
    renderDetail();
  };
}

// ---------- 初始化（登录门禁后执行） ----------
(async () => {
  const sess = await gateRequire();
  document.getElementById('gateUserBar').textContent = '👤 ' + sess.u + '（客服坐席）';
  document.getElementById('logoutBtn').onclick = gateLogout;
  document.getElementById('btnRefresh').onclick = loadTickets;
  await loadTickets();
  // 工单列表自动刷新
  POLL_TIMER = setInterval(loadTickets, 15000);
})();
