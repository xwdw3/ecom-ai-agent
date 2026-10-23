/**
 * cards.js —— 工具结果结构化卡片渲染（浏览器端）
 * 把订单/物流/退款等工具返回的实时数据渲染成卡片：物流时间线、退款进度步骤条、订单卡、售后资格卡
 * 设计原则：只读传入的 result，渲染失败静默降级（不影响 LLM 文字回答）；不识别的结构不渲染
 * 全局唯一 ToolCards，避免跨脚本命名冲突
 */
(function (global) {
  'use strict';

  var ORDER_STATUS_TEXT = {
    pending_payment: '待付款', paid: '已付款待发货', shipped: '已发货', completed: '已完成',
    refund_reviewing: '退款审核中', refunding: '退款中', refunded: '已退款', cancelled: '已取消',
  };
  var REFUND_STATUS_TEXT = {
    applying: '申请中', reviewing: '审核中', returning: '退货中', refunding: '退款中', refunded: '已退款', rejected: '已拒绝',
  };
  var LOGI_STATUS_TEXT = {
    pending: '待揽收', in_transit: '运输中', delivered: '已签收', exception: '异常',
  };

  function h(tag, cls, html) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    var n = Number(v);
    return isNaN(n) ? String(v) : '¥' + n.toFixed(2);
  }

  /** 进度步骤条（退款 progress / 物流 timeline 共用） */
  function steps(items) {
    var wrap = h('div', 'tsteps');
    (items || []).forEach(function (p, i) {
      var done = p && (p.done === true || p.time);
      var row = h('div', 'tstep' + (done ? ' done' : '') + (i === (items || []).length - 1 ? ' last' : ''));
      row.innerHTML =
        '<span class="dot"></span>' +
        '<span class="s-name">' + esc((p && p.step) || (p && p.event) || '') + '</span>' +
        ((p && p.time) ? '<span class="s-time">' + esc(p.time) + '</span>' : '');
      wrap.appendChild(row);
    });
    return wrap;
  }

  /** 物流时间线卡 */
  function logisticsCard(r) {
    var card = h('div', 'tcard');
    var head = '<div class="t-head">🚚 物流信息 <span class="t-tag">' + esc(LOGI_STATUS_TEXT[r.status] || r.status || '') + '</span></div>'
      + '<div class="t-meta">' + esc(r.company || '') + (r.tracking_no ? ' · 运单号 ' + esc(r.tracking_no) : '') + '</div>';
    card.innerHTML = head;
    var tl = r.timeline || r.progress;
    if (tl && tl.length) card.appendChild(steps(tl));
    return card;
  }

  /** 退款进度卡 */
  function refundCard(r) {
    var card = h('div', 'tcard');
    card.innerHTML =
      '<div class="t-head">💰 退款进度 <span class="t-tag">' + esc(REFUND_STATUS_TEXT[r.status] || r.status || '') + '</span></div>'
      + '<div class="t-meta">退款单 ' + esc(r.refund_no || '') + (r.type === 'return_refund' ? ' · 退货退款' : r.type === 'refund_only' ? ' · 仅退款' : r.type === 'exchange' ? ' · 换货' : '')
      + (r.amount != null ? ' · ' + money(r.amount) : '') + '</div>';
    if (r.progress && r.progress.length) card.appendChild(steps(r.progress));
    return card;
  }

  /** 订单卡 */
  function orderCard(r) {
    var card = h('div', 'tcard');
    card.innerHTML =
      '<div class="t-head">📦 订单详情 <span class="t-tag">' + esc(ORDER_STATUS_TEXT[r.status] || r.status || '') + '</span></div>'
      + '<div class="t-meta">订单号 <b>' + esc(r.order_no || '') + '</b></div>'
      + '<div class="t-grid">'
      + '<span>商品</span><b>' + esc(r.sku || '-') + (r.qty ? ' × ' + esc(r.qty) : '') + '</b>'
      + '<span>金额</span><b>' + money(r.amount) + '</b>'
      + (r.paid_at ? '<span>付款时间</span><b>' + esc(String(r.paid_at).replace('T', ' ').slice(0, 16)) + '</b>' : '')
      + '</div>';
    return card;
  }

  /** 售后资格卡 */
  function eligibilityCard(r) {
    var ok = r.eligible === true;
    var card = h('div', 'tcard ' + (ok ? 't-ok' : 't-warn'));
    card.innerHTML =
      '<div class="t-head">' + (ok ? '✅ 可自助办理' : '⚠️ 需人工确认') + '</div>'
      + '<div class="t-reason">' + esc(r.reason || '') + '</div>'
      + (r.autoProcess ? '<div class="t-meta">系统可直接自动办理</div>' : '');
    return card;
  }

  /** 工单卡 */
  function ticketCard(r) {
    var card = h('div', 'tcard t-ok');
    card.innerHTML =
      '<div class="t-head">🧾 售后工单已创建</div>'
      + '<div class="t-meta">工单号 <b>' + esc(r.ticket_no || '') + '</b></div>'
      + (r.external_ticket_no ? '<div class="t-meta">已同步至人工系统：' + esc(r.external_ticket_no) + '</div>' : '');
    return card;
  }

  /**
   * 主入口：按工具名 + 返回结构渲染卡片到气泡
   * @returns {boolean} 是否渲染了卡片
   */
  function render(bubbleEl, tool, result) {
    try {
      if (!bubbleEl || !result || typeof result !== 'object') return false;
      var card = null;
      if (tool === 'query_logistics' && (result.timeline || result.progress || result.company)) card = logisticsCard(result);
      else if (tool === 'query_refund_progress' && (result.progress || result.refund_no)) card = refundCard(result);
      else if (tool === 'query_order' && result.order_no) card = orderCard(result);
      else if (tool === 'check_aftersales_eligibility' && 'eligible' in result) card = eligibilityCard(result);
      else if (tool === 'create_aftersales_ticket' && (result.ticket_no || result.created)) card = ticketCard(result);
      if (!card) return false;
      bubbleEl.appendChild(card);
      return true;
    } catch (e) {
      return false; // 渲染失败静默降级，保留文字回答
    }
  }

  global.ToolCards = { render: render };
})(typeof window !== 'undefined' ? window : globalThis);
