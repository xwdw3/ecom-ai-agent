/* 客服问答页逻辑：RAG 检索 → 流式生成 → 幻觉抑制 → 日志落库 → 人工兜底 */

const SUGGESTIONS = [
  '订单SO20261018005退款到哪一步了？',
  '订单SO20261021004的物流到哪了？',
  '订单SO20261022001我想退货，符合条件吗？',
  '白T恤是什么材质的？怎么选尺码？',
  '优惠券能和满减活动叠加吗？',
  '你们这个东西是假货，我要投诉！',
];

const FALLBACK_TEXT = '抱歉，这个问题暂时超出了我的知识范围，您可以点击下方「转人工客服」，我会为您登记并尽快由人工跟进。';

// 日常寒暄/闲聊本地应答：不走知识库与模型（零幻觉、零延迟），避免对"你好"等输入误判为知识库外问题
const SMALLTALK_REPLIES = [
  {
    re: /^(你好|您好|hi|hello|嗨|哈喽|在吗|在么|在不在)(呀|啊|哟|呦)?[\s!！。~～?？]*$/i,
    reply: '您好呀～我是智能客服「小智」😊\n关于商品参数、尺码推荐、发货时效、退换货政策、优惠活动都可以直接问我；\n想查订单或物流，把订单号发给我即可；售后问题我也能帮您自动登记处理～',
  },
  {
    re: /^(谢谢|多谢|感谢|辛苦了|thank you|thanks)(啦|了|你|您)?[\s!！。~～]*$/i,
    reply: '不客气，能帮到您就好～ 还有其他问题随时问我哦 😊',
  },
  {
    re: /^(你是谁|你叫什么|你是什么|介绍一下你自己|你能做什么|你会什么|有什么功能|你能干什么)[\s?？!！。]*$/,
    reply: '我是本店 AI 智能客服「小智」，7×24 小时在线，可以帮您：\n1. 解答商品参数、尺码、材质问题；\n2. 查询订单状态、物流轨迹、退款进度；\n3. 自动判断售后资格并创建售后工单；\n4. 解答优惠券、满减等活动规则；\n5. 复杂问题自动转接人工客服。请问有什么可以帮您？',
  },
  {
    re: /^(再见|拜拜|bye|晚安|好滴|好的呢)[\s!！。~～]*$/i,
    reply: '好的，期待再次为您服务～ 祝您购物愉快 👋',
  },
];
function matchSmalltalk(q) {
  const t = q.trim();
  for (const s of SMALLTALK_REPLIES) {
    if (s.re.test(t)) return s.reply;
  }
  return null;
}

let KB_CHUNKS = [];
let HISTORY = []; // [{role, content}]
let SESSION_ID = sessionStorage.getItem('session_id');
// Agent 独立服务账号 JWT（30分钟有效，权限最小化：无支付/大额退款审批权限）
let AGENT_TOKEN = sessionStorage.getItem('agent_token');
async function ensureAgentToken() {
  try {
    if (AGENT_TOKEN) {
      const v = await verifyToken(AGENT_TOKEN);
      if (v.ok) return;
    }
    AGENT_TOKEN = await issueToken(AGENT_ACCOUNT);
    sessionStorage.setItem('agent_token', AGENT_TOKEN);
  } catch (e) { console.warn('令牌签发失败', e); }
}
if (!SESSION_ID) {
  SESSION_ID = 's-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
  sessionStorage.setItem('session_id', SESSION_ID);
}

const $messages = document.getElementById('messages');
const $input = document.getElementById('input');
const $sendBtn = document.getElementById('sendBtn');
let generating = false;
let stopFlag = false;

// ---------- 知识库加载（sessionStorage 缓存 30 分钟，进页少一次全量查询） ----------
const KB_CACHE_KEY = 'kb_chunks_cache_v1';
const KB_CACHE_TTL = 30 * 60 * 1000;
async function loadChunks() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(KB_CACHE_KEY) || 'null');
    if (cached && cached.data && Array.isArray(cached.data) && Date.now() - cached.ts < KB_CACHE_TTL) {
      KB_CHUNKS = cached.data;
      return 'cache';
    }
  } catch (e) { /* 缓存损坏则直接拉云端 */ }
  const { data, error } = await cloud.database
    .from('kb_chunks')
    .select('id, entry_id, chunk_index, title, category, tags, content').eq('tenant_id', Tenant.id())
    .eq('status', 'published')
    .limit(500);
  if (error) {
    showToast('知识库加载失败：' + error.message, 'error');
    return 'error';
  }
  KB_CHUNKS = data || [];
  try { sessionStorage.setItem(KB_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: KB_CHUNKS })); } catch (e) { /* 容量满忽略 */ }
  return 'fresh';
}

// ---------- 错误告警（技术验收3：LLM调用失败/检索异常可告警） ----------
async function raiseAlert(alertType, message, context, severity = 'error') {
  try {
    await cloud.database.from('alert_logs').insert({
      tenant_id: Tenant.id(),
      alert_type: alertType, severity, message: String(message).slice(0, 500),
      context: context || null, session_id: SESSION_ID,
    });
  } catch (e) {
    console.warn('告警写入失败', e);
  }
}

// ---------- 消息渲染 ----------
function addMsg(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const t = new Date();
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  wrap.innerHTML = `
    <div class="avatar">${role === 'user' ? '我' : 'AI'}</div>
    <div class="bwrap ${role === 'user' ? 'right' : ''}">
      <div class="bubble"><span class="text"></span></div>
      <span class="time">${time}</span>
    </div>`;
  wrap.querySelector('.text').textContent = text;
  $messages.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function appendRefs(bubbleEl, refs) {
  if (!refs || !refs.length) return;
  const refsEl = document.createElement('div');
  refsEl.className = 'refs';
  const lines = refs.map((r, i) => {
    const cat = { sku: '商品', faq: 'FAQ', activity: '活动' }[r.category] || r.category;
    return `[${i + 1}] <b>${escapeHtml(r.title)}</b>（${cat} · 相关度 ${(r.score * 100).toFixed(0)}%）`;
  });
  refsEl.innerHTML = '依据知识库：<br>' + lines.join('<br>');
  bubbleEl.appendChild(refsEl);
}

function scrollBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

// ---------- 系统提示词（强制知识库约束，抑制幻觉） ----------
function buildSystemPrompt(refs) {
  let context = '（知识库未检索到相关内容）';
  if (refs.length) {
    context = refs
      .map((r, i) => `[${i + 1}] ${r.title}（分类:${r.category}）\n${r.content}`)
      .join('\n\n');
  }
  return [
    '你是一家电商店铺的智能客服助手「小智」。你必须严格遵守以下规则：',
    '1. 只能依据下方【知识库检索结果】中的信息回答，禁止使用知识库之外的任何知识。',
    '2. 如果知识库检索结果不足以回答用户问题（如订单状态、支付故障、库存等未收录信息），必须一字不差地回复固定话术：「' + FALLBACK_TEXT + '」。禁止编造、猜测或自由发挥。',
    '3. 涉及价格、参数、规则、时效的内容必须与知识库原文完全一致，不得改动任何数字和表述。',
    '4. 结合对话上下文理解用户追问（例如「那XL呢」指上一条消息中的商品）。',
    '5. 回答简洁友好、适当分点，总长度控制在200字以内。使用简体中文。',
    '',
    '【知识库检索结果】',
    context,
  ].join('\n');
}

// ---------- Phase2：工具调用回答 ----------
function buildToolPrompt(toolName, note, result) {
  return [
    '你是电商智能客服「小智」。你刚刚通过调用微服务工具获得了实时业务数据，请依据数据回答用户问题。',
    '规则：1.数字、状态、时间必须与数据完全一致，禁止编造；2.数据为空或缺失时如实告知并建议核对单号；3.如结果显示需人工处理/需人工审核，礼貌引导用户点击「转人工客服」；4.回答简洁友好，150字以内，使用简体中文。',
    '',
    `【调用工具】${toolName}（${note || ''}）`,
    `【工具返回数据】`,
    JSON.stringify(result, null, 1),
  ].join('\n');
}

function appendToolBadge(bubbleEl, toolName) {
  const el = document.createElement('div');
  el.className = 'refs';
  const names = {
    query_user: '用户服务', query_product: '商品服务', query_order: '订单服务',
    query_logistics: '物流服务', query_refund_progress: '售后工单服务',
    check_aftersales_eligibility: '售后资格判定', create_aftersales_ticket: '创建售后工单',
  };
  el.innerHTML = '🔧 已调用工具：<b>' + escapeHtml(names[toolName] || toolName) + '</b>';
  bubbleEl.appendChild(el);
}

// 失败重试按钮：一键重发同一问题
function appendRetry(bubbleEl, question) {
  const act = document.createElement('div');
  act.className = 'fallback-actions';
  act.innerHTML = '<button>🔄 重试</button>';
  act.querySelector('button').onclick = () => { $input.value = question; send(); };
  bubbleEl.appendChild(act);
}

// ---------- 订单号缺失的确定性兜底：列出当前用户近期订单，让用户选 ----------
const NEED_ORDER_TOOLS = ['query_order', 'query_logistics', 'query_refund_progress', 'check_aftersales_eligibility', 'create_aftersales_ticket'];
const ORDER_STATUS_TEXT = {
  pending_payment: '待付款', paid: '已付款待发货', shipped: '已发货', completed: '已完成',
  refund_reviewing: '退款审核中', refunding: '退款中', refunded: '已退款', cancelled: '已取消',
};
async function buildOrderMenu() {
  try {
    const { data: orders } = await cloud.database.from('svc_orders')
      .select('order_no,sku,amount,status').eq('tenant_id', Tenant.id()).eq('user_id', 'U1001')
      .order('order_no', { ascending: false }).limit(5);
    if (!orders || !orders.length) return null;
    const skus = [...new Set(orders.map((o) => o.sku).filter(Boolean))];
    const nameMap = {};
    if (skus.length) {
      try {
        const { data: prods } = await cloud.database.from('svc_products').select('sku,name').eq('tenant_id', Tenant.id()).in('sku', skus);
        (prods || []).forEach((p) => { nameMap[p.sku] = p.name; });
      } catch (e) { /* 商品名缺省不影响主流程 */ }
    }
    const lines = orders.map((o, i) =>
      `${i + 1}. ${o.order_no}　${nameMap[o.sku] || o.sku || ''}　¥${Number(o.amount).toFixed(2)}（${ORDER_STATUS_TEXT[o.status] || o.status}）`);
    return '查询订单、物流或退款需要具体订单号哦～ 查到您名下最近的订单：\n' + lines.join('\n')
      + '\n\n请回复「订单号 + 您的问题」，例如：SO20261021004 退款到哪一步了';
  } catch (e) { console.warn('订单菜单构建失败', e); return null; }
}

// ---------- 回合状态机：发送⇄停止、结束恢复 ----------
function setSendBtn(mode) {
  $sendBtn.disabled = false;
  if (mode === 'stop') {
    $sendBtn.textContent = '停止';
    $sendBtn.classList.add('stopping');
    $sendBtn.setAttribute('aria-label', '停止生成');
  } else {
    $sendBtn.textContent = '发送';
    $sendBtn.classList.remove('stopping');
    $sendBtn.setAttribute('aria-label', '发送消息');
  }
}
function endTurn() {
  generating = false;
  saveHistory();
  setSendBtn('send');
  $input.focus();
}

// ---------- 发送主流程 ----------
async function send() {
  const question = $input.value.trim();
  if (!question || generating) return;
  generating = true;
  stopFlag = false;
  setSendBtn('stop');
  $input.value = '';
  $input.style.height = '46px';

  addMsg('user', question);
  document.getElementById('chips').style.display = 'none';

  // ===== 日常寒暄快速应答（不进入分流/工具/检索链路，<10ms 响应） =====
  const smalltalk = matchSmalltalk(question);
  if (smalltalk) {
    const wrap = addMsg('assistant', smalltalk);
    const refsEl = document.createElement('div');
    refsEl.className = 'refs';
    refsEl.innerHTML = '💬 日常寒暄 · 本地应答（不经知识库）';
    wrap.querySelector('.bubble').appendChild(refsEl);
    HISTORY.push({ role: 'user', content: question });
    HISTORY.push({ role: 'assistant', content: smalltalk });
    try {
      await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false });
      await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'assistant', content: smalltalk, refs: null, is_fallback: false });
    } catch (e) { console.warn('日志落库失败', e); }
    endTurn();
    return;
  }

  // ===== Phase2：人机分流（高风险/高金额/纠纷 → 转人工） =====
  const orderNo = extractOrderNo(question);
  let riskOpts = {};
  if (orderNo) {
    try {
      const o = await ServiceGateway.call('order', 'get', { order_no: orderNo });
      if (o) riskOpts.amount = o.amount;
    } catch (e) { /* 分流降级为关键词判断 */ }
  }
  const route = riskRoute(question, riskOpts);
  try {
    await ServiceGateway.call('router', 'logDecision', {
      session_id: SESSION_ID, question: maskPII(question), route: route.route,
      risk_level: route.riskLevel, reason: route.reason,
      handled_by: route.route === 'human' ? 'human' : 'ai',
    });
  } catch (e) { console.warn('分流日志写入失败', e); }
  if (route.route === 'human') {
    const wrap = addMsg('assistant', '');
    const textSpan = wrap.querySelector('.text');
    const text = `您好，您反馈的问题属于${route.riskLevel === 'high' ? '高风险' : '需人工确认'}场景（${route.reason}），为了更好地保障您的权益，已为您优先转接人工客服处理。`;
    textSpan.textContent = text;
    const act = document.createElement('div');
    act.className = 'fallback-actions';
    act.innerHTML = '<button>补充联系方式</button>';
    act.querySelector('button').onclick = () => openTicket(question);
    wrap.querySelector('.bubble').appendChild(act);
    const badge = document.createElement('div');
    badge.className = 'refs';
    badge.innerHTML = '🚦 人机分流：AI 识别为「' + route.riskLevel + '」风险 → 已转人工';
    wrap.querySelector('.bubble').appendChild(badge);
    HISTORY.push({ role: 'user', content: question });
    HISTORY.push({ role: 'assistant', content: text });
    try {
      await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false });
      await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'assistant', content: text, refs: null, is_fallback: true });
    } catch (e) { console.warn('日志落库失败', e); }
    endTurn();
    return;
  }

  // ===== Phase2：Agent 工具调用（确定性规则优先 → LLM 规划兜底） =====
  const traceId = newTraceId(); // 链路追踪：一次对话一条 trace（模拟 SkyWalking）
  let plan = rulePlan(question, { orderNo, userId: 'U1001', sku: null });
  if (!plan) {
    try {
      let plannerOut = '';
      for await (const ch of cloud.llm.chat.completions.create({
        model: CHAT_MODEL, stream: true, temperature: 0,
        messages: [{ role: 'user', content: buildPlannerPrompt(question) }],
      })) {
        const d = ch.choices?.[0]?.delta?.content;
        if (d) plannerOut += d;
      }
      plan = parseAgentPlan(plannerOut);
    } catch (e) { console.warn('LLM 规划失败，走知识库问答', e); }
  }
  if (plan) {
    // 订单号缺失 → 确定性订单菜单兜底（禁止模型凭空猜单号）
    if (NEED_ORDER_TOOLS.includes(plan.tool) && !plan.args.order_no) {
      const menu = await buildOrderMenu();
      const text = menu || '请提供您的订单号（SO 开头），我来帮您查询订单、物流或退款进度～';
      const wrap = addMsg('assistant', text);
      const badge = document.createElement('div');
      badge.className = 'refs';
      badge.innerHTML = '📦 意图已识别（' + escapeHtml(plan.note || plan.tool) + '）· 缺少订单号，已列出您名下近期订单';
      wrap.querySelector('.bubble').appendChild(badge);
      HISTORY.push({ role: 'user', content: question });
      HISTORY.push({ role: 'assistant', content: text });
      try {
        await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false });
        await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'assistant', content: text, refs: null, is_fallback: false });
      } catch (e) { console.warn('日志落库失败', e); }
      endTurn();
      return;
    }
    const toolWrap = addMsg('assistant', '');
    const toolSpan = toolWrap.querySelector('.text');
    toolSpan.innerHTML = '<span class="thinking">正在调用微服务工具：' + escapeHtml(plan.tool) + '（链路 ' + traceId + '）…</span>';
    let answer = '';
    try {
      const result = await executeTool(plan, { token: AGENT_TOKEN, traceId });
      // 工具返回空（如订单无退款记录）→ 确定性引导话术，不依赖模型自由发挥
      if (result == null && NEED_ORDER_TOOLS.includes(plan.tool)) {
        const text = plan.tool === 'query_refund_progress'
          ? `该订单暂无退款记录哦～ 如果您想申请退货退款，请回复「${plan.args.order_no || '订单号'} 我想退货」，我来帮您判定资格并办理。`
          : '未查询到该订单的相关记录，请核对订单号（SO 开头）后重试，或回复「订单号 + 您的问题」。';
        toolSpan.textContent = text;
        appendToolBadge(toolWrap.querySelector('.bubble'), plan.tool);
        HISTORY.push({ role: 'user', content: question });
        HISTORY.push({ role: 'assistant', content: text });
        try {
          await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false });
          await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'assistant', content: text, refs: null, is_fallback: false });
        } catch (e) { console.warn('日志落库失败', e); }
        endTurn();
        return;
      }
      const messages = [
        { role: 'system', content: buildToolPrompt(plan.tool, plan.note, result) },
        ...HISTORY.slice(-6),
        { role: 'user', content: question },
      ];
      let first = true;
      for await (const chunk of cloud.llm.chat.completions.create({
        model: CHAT_MODEL, messages, stream: true, temperature: 0.3, conversationId: SESSION_ID,
      })) {
        const delta = chunk.choices?.[0]?.delta;
        if (stopFlag) break;
        if (delta?.content) {
          if (first) { toolSpan.textContent = ''; first = false; }
          answer += delta.content;
          toolSpan.textContent = answer;
          scrollBottom();
        }
      }
      const needHuman = typeof result === 'object' && result !== null
        && (result.eligible === false || result.created === false);
      if (!answer) {
        toolSpan.textContent = '工具调用成功，但生成回答失败，请重试。';
        appendRetry(toolWrap.querySelector('.bubble'), question);
      } else {
        appendToolBadge(toolWrap.querySelector('.bubble'), plan.tool);
        // 结构化卡片：物流时间线 / 退款进度条 / 订单卡 / 售后资格卡
        window.ToolCards && ToolCards.render(toolWrap.querySelector('.bubble'), plan.tool, result);
        if (needHuman) {
          const act = document.createElement('div');
          act.className = 'fallback-actions';
          act.innerHTML = '<button>转人工客服</button>';
          act.querySelector('button').onclick = () => openTicket(question);
          toolWrap.querySelector('.bubble').appendChild(act);
        }
      }
      HISTORY.push({ role: 'user', content: question });
      if (answer) HISTORY.push({ role: 'assistant', content: answer });
      try {
        await cloud.database.from('chat_messages').insert({ tenant_id: Tenant.id(), session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false });
        if (answer) {
          await cloud.database.from('chat_messages').insert({
      tenant_id: Tenant.id(),
            session_id: SESSION_ID, role: 'assistant', content: maskPII(answer),
            refs: [{ title: '🔧 ' + plan.tool, category: 'tool', score: 1 }],
            is_fallback: false,
          });
        }
      } catch (e) { console.warn('日志落库失败', e); }
      endTurn();
      return;
    } catch (err) {
      toolSpan.textContent = '';
      console.warn('工具链路失败，降级为知识库问答', err);
      // 降级：继续走 RAG 流程（保持 generating 状态，RAG 流程结束时统一复位）
    }
  }

  // 检索
  let refs = [];
  try {
    const r = await retrieve(question, KB_CHUNKS, 4);
    refs = r.refs;
    if (!r.refs.length && KB_CHUNKS.length) {
      // 检索零命中不告警（属正常兜底），仅知识库加载异常才告警
    }
  } catch (e) {
    await raiseAlert('retrieval_error', '检索异常：' + (e.message || e), { question: maskPII(question) });
    showToast('检索异常，已记录告警', 'error');
  }

  // 歧义识别：候选知识条目分数接近时先澄清，不直接作答
  const amb = detectAmbiguity(refs);
  if (amb.ambiguous) {
    const wrap = addMsg('assistant', '');
    const textSpan = wrap.querySelector('.text');
    const lines = amb.candidates.map((c, i) => `${i + 1}. 「${c.title}」`).join('\n');
    const clarify = `您的问题可能涉及以下几方面，请问您想了解哪一个呢？\n${lines}\n您可以直接回复对应的名称，我来为您详细解答～`;
    textSpan.textContent = clarify;
    const refsEl = document.createElement('div');
    refsEl.className = 'refs';
    refsEl.innerHTML = '🌀 已识别到歧义问题，先澄清后回答（可避免答非所问）';
    wrap.querySelector('.bubble').appendChild(refsEl);
    HISTORY.push({ role: 'user', content: question });
    HISTORY.push({ role: 'assistant', content: clarify });
    try {
      await cloud.database.from('chat_messages').insert({
      tenant_id: Tenant.id(),
        session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false,
      });
      await cloud.database.from('chat_messages').insert({
      tenant_id: Tenant.id(),
        session_id: SESSION_ID, role: 'assistant', content: clarify, refs: null, is_fallback: false,
      });
    } catch (e) { console.warn('日志落库失败', e); }
    endTurn();
    return;
  }

  // 流式生成
  const aiWrap = addMsg('assistant', '');
  const textSpan = aiWrap.querySelector('.text');
  textSpan.innerHTML = '<span class="thinking">正在检索知识库并组织回答…</span>';
  let answer = '';
  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt(refs) },
      ...HISTORY.slice(-6),
      { role: 'user', content: question },
    ];
    let first = true;
    for await (const chunk of cloud.llm.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      stream: true,
      temperature: 0.3,
      conversationId: SESSION_ID,
    })) {
      if (stopFlag) break;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        if (first) { textSpan.textContent = ''; first = false; }
        answer += delta.content;
        textSpan.textContent = answer;
        scrollBottom();
      }
      // delta.reasoning_content 为思考过程，不对外展示
    }
  } catch (err) {
    const code = err?.error?.code || '';
    answer = '';
    if (code.startsWith('auth_')) {
      textSpan.textContent = '模型通道校验失败（来源域名不匹配）。请通过应用卡片或正式发布链接访问本页面。';
    } else if (code.startsWith('quota_')) {
      textSpan.textContent = '模型调用额度不足，请联系管理员。';
    } else {
      const raw = String(err?.error?.message || err?.message || '未知错误').slice(0, 120);
      textSpan.textContent = '网络异常，回复生成失败（' + (code || 'unknown') + '：' + raw + '）。\n请确认通过正式发布链接（含 ?sharecode= 参数）在浏览器中打开本页面；若仍失败，请把括号内的详情发给管理员。';
    }
    showToast('模型调用失败：' + (err?.error?.message || err.message || code), 'error');
    await raiseAlert('llm_call_failed', 'LLM调用失败：' + (err?.error?.code || '') + ' ' + (err?.error?.message || err?.message || 'unknown'), {
      model: CHAT_MODEL, question: maskPII(question),
    });
    appendRetry(aiWrap.querySelector('.bubble'), question);
  }

  // 兜底判定：未检索到知识 或 模型按话术拒答
  const isFallback = !answer || !refs.length || answer.includes('超出了我的知识范围');
  if (!answer) {
    // 生成失败时不落库回答内容
  } else {
    if (isFallback && !answer.includes('转人工客服')) {
      textSpan.textContent = FALLBACK_TEXT;
      answer = FALLBACK_TEXT;
    }
    appendRefs(aiWrap.querySelector('.bubble'), refs);
    if (isFallback) {
      const act = document.createElement('div');
      act.className = 'fallback-actions';
      act.innerHTML = '<button>转人工客服</button>';
      act.querySelector('button').onclick = () => openTicket(question);
      aiWrap.querySelector('.bubble').appendChild(act);
    }
  }

  // 日志落库（用户消息 + 助手消息；落库前隐私脱敏，不明文存储手机号/地址）
  try {
    await cloud.database.from('chat_messages').insert({
      tenant_id: Tenant.id(),
      session_id: SESSION_ID, role: 'user', content: maskPII(question), refs: null, is_fallback: false,
    });
    if (answer) {
      await cloud.database.from('chat_messages').insert({
      tenant_id: Tenant.id(),
        session_id: SESSION_ID, role: 'assistant', content: maskPII(answer),
        refs: refs.length ? JSON.parse(JSON.stringify(refs)) : null, is_fallback: isFallback,
      });
    }
  } catch (e) {
    console.warn('日志落库失败', e);
  }

  HISTORY.push({ role: 'user', content: question });
  if (answer) HISTORY.push({ role: 'assistant', content: answer });

  endTurn();
}

// ---------- 人工兜底 ----------
function openTicket(prefill) {
  document.getElementById('ticketQuestion').value = prefill || (HISTORY.length ? HISTORY[HISTORY.length - 2]?.content || '' : '');
  document.getElementById('ticketContact').value = '';
  document.getElementById('ticketMask').classList.add('show');
}

document.getElementById('ticketCancel').onclick = () => document.getElementById('ticketMask').classList.remove('show');
document.getElementById('ticketSubmit').onclick = async () => {
  const question = document.getElementById('ticketQuestion').value.trim();
  if (!question) return showToast('请描述您的问题', 'error');
  const contact = document.getElementById('ticketContact').value.trim() || null;
  const { error } = await cloud.database.from('support_tickets').insert({
      tenant_id: Tenant.id(),
    session_id: SESSION_ID, question: maskPII(question), contact: contact ? maskPII(contact) : null, status: 'open',
  });
  if (error) return showToast('提交失败：' + error.message, 'error');
  document.getElementById('ticketMask').classList.remove('show');
  showToast('已登记，人工客服会尽快跟进', 'success');
};

document.getElementById('manualEntry').onclick = () => openTicket('');

// ---------- 对话历史（登录=云同步可换设备恢复；未登录=sessionStorage 本地恢复） ----------
const CHAT_HISTORY_KEY = 'chat_history_v1';
function saveHistory() {
  try { sessionStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(HISTORY.slice(-20))); } catch (e) { /* ignore */ }
  // 登录用户：同步最近 20 条到云端（RLS 仅本人可读写，owner_id 自动绑定 auth.uid()）
  if (window.UserAuth && UserAuth.isLoggedIn()) {
    cloud.database.from('user_chat_history')
      .upsert({ messages: HISTORY.slice(-20), updated_at: new Date().toISOString() }, { onConflict: 'owner_id' })
      .then((r) => { if (r && r.error) console.warn('会话云同步失败', r.error.message); })
      .catch(() => {});
  }
}
async function loadCloudHistory() {
  try {
    const { data, error } = await cloud.database.from('user_chat_history')
      .select('messages').limit(1);
    if (error || !data || !data.length) return false;
    const saved = data[0].messages;
    if (!Array.isArray(saved) || !saved.length) return false;
    renderHistory(saved);
    return true;
  } catch (e) { return false; }
}
function renderHistory(saved) {
  const $messages = document.getElementById('messages');
  $messages.innerHTML = '';
  HISTORY = saved.slice();
  for (const m of saved) {
    if (!m || !m.role || !m.content) continue;
    addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
  }
}
function restoreHistory() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_HISTORY_KEY) || 'null');
    if (!Array.isArray(saved) || !saved.length) return false;
    for (const m of saved) {
      if (!m || !m.role || !m.content) continue;
      addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
    }
    HISTORY = saved.slice();
    return true;
  } catch (e) { return false; }
}

// ---------- 初始化 ----------
const WELCOME_TEXT = '您好，我是电商智能客服「小智」👋 关于商品参数、尺码、发货、退换货、优惠活动等问题都可以直接问我～';
function sayWelcome() { addMsg('assistant', WELCOME_TEXT); }
async function init() {
  await ensureAgentToken();
  const chips = document.getElementById('chips');
  chips.innerHTML = SUGGESTIONS.map((s) => `<button>${escapeHtml(s)}</button>`).join('');
  chips.querySelectorAll('button').forEach((b, i) => (b.onclick = () => { $input.value = SUGGESTIONS[i]; send(); }));

  // 登录态：登录→切云端历史；登出→清空重开（云历史仍在，下次登录找回）
  let restored = false;
  try {
    if (window.UserAuth) {
      await UserAuth.init(cloud);
      UserAuth.mountUI();
      UserAuth.renderTopbar();
      UserAuth.onChange(async (u) => {
        UserAuth.renderTopbar();
        if (u) {
          const has = await loadCloudHistory();
          if (!has) saveHistory(); // 首次登录把本地历史推上云
          showToast('已登录，会话历史云端同步已开启', 'success');
        } else {
          HISTORY = [];
          document.getElementById('messages').innerHTML = '';
          sayWelcome();
        }
      });
      if (UserAuth.isLoggedIn()) restored = await loadCloudHistory();
    }
  } catch (e) { console.warn('登录态初始化失败（按未登录继续）', e); }

  if (!restored && !restoreHistory()) {
    sayWelcome();
  }

  const kbSrc = await loadChunks();
  document.getElementById('backendTag').textContent = `RAG 混合检索 · 知识分块 ${KB_CHUNKS.length}${kbSrc === 'cache' ? '（缓存）' : ''}`;

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $input.addEventListener('input', () => {
    $input.style.height = '46px';
    $input.style.height = Math.min(120, $input.scrollHeight) + 'px';
  });
  $sendBtn.onclick = () => { if (generating) { stopFlag = true; } else { send(); } };
}

// ---------- P1：人工客服消息实时接收（4 秒轮询 role='agent' 消息） ----------
const SEEN_AGENT_IDS = new Set();
let AGENT_CONNECTED_SHOWN = false;
async function pollAgentMessages() {
  try {
    const { data } = await cloud.database.from('chat_messages')
      .select('id, role, content').eq('tenant_id', Tenant.id()).eq('session_id', SESSION_ID).eq('role', 'agent')
      .order('id', { ascending: false }).limit(20);
    const fresh = (data || []).filter((m) => !SEEN_AGENT_IDS.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) SEEN_AGENT_IDS.add(m.id);
    if (!AGENT_CONNECTED_SHOWN) {
      AGENT_CONNECTED_SHOWN = true;
      const tip = addMsg('assistant', '👩‍💼 人工客服已接入，正在为您服务');
      tip.querySelector('.avatar').textContent = '系';
      tip.querySelector('.avatar').style.background = '#94a3b8';
    }
    for (const m of fresh.reverse()) {
      const wrap = addMsg('assistant', m.content);
      const av = wrap.querySelector('.avatar');
      av.textContent = '人工';
      av.style.background = '#2563eb';
    }
    scrollBottom();
  } catch (e) { /* 静默：轮询失败不打断对话 */ }
}

init();
setInterval(pollAgentMessages, 4000);
// 首轮先标记历史坐席消息为已读（刷新页面不重复弹出），之后只推新消息
setTimeout(async () => {
  try {
    const { data } = await cloud.database.from('chat_messages')
      .select('id').eq('tenant_id', Tenant.id()).eq('session_id', SESSION_ID).eq('role', 'agent').limit(50);
    for (const m of data || []) SEEN_AGENT_IDS.add(m.id);
  } catch (e) { /* ignore */ }
}, 1500);
