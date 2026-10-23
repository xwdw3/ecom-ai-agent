/**
 * Phase2 工具调用层（功能验收1：Agent 自主调用微服务接口）
 *
 * 架构说明：
 *   ServiceGateway 为可插拔服务网关 —— 默认 adapter 'cloud-db' 通过云库 svc_* 表
 *   模拟五大微服务（用户/商品/订单/物流/售后工单）；接入真实 SpringCloud 时，
 *   只需注册 'springcloud' adapter（服务发现 + HTTP 调用），工具层与业务层零改动。
 *
 *   AgentPlan：问题 → 工具规划。两级策略：
 *   ① 确定性意图规则（快、稳、免模型调用）
 *   ② LLM JSON 规划兜底（覆盖规则未命中的长尾问题）
 */
// auth.js 桥接（浏览器走全局 AuthCenter；Node 单测走 require）
const AuthLib = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./auth.js')
  : (typeof AuthCenter !== 'undefined' ? AuthCenter : null);
// 注意：浏览器中 auth.js 已有同名全局 function，此处不可再 const 重名声明（会 SyntaxError 导致整个文件加载失败）
// 默认网关 adapter：云库数据面（由 config.js 提供 cloud 客户端）
const ServiceGateway = {
  name: 'cloud-db',
  adapters: {
    // 接入 SpringCloud 示例（生产替换位）：
    // springcloud: { async call(service, action, payload) {
    //   const r = await fetch(`http://gateway.internal/${service}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
    //   return r.json(); } },
    'cloud-db': null, // 在 initGateway(cloud) 中注入
  },
  adapter: null,
  async call(service, action, payload) {
    if (!this.adapter) throw new Error('ServiceGateway 未初始化');
    return this.adapter.call(service, action, payload);
  },
};

// ---------- 网关治理：限流 / 熔断 / 重试 / 降级 / 链路追踪 ----------
// 技术验收1：Sentinel 风格限流熔断 + 超时自动重试 + 降级兜底
// 技术验收4：trace_id 贯穿一次对话全部工具调用（模拟 SkyWalking 链路）

const GOV = {
  rateLimit: { capacity: 30, refillPerSec: 10, tokens: 30, lastRefill: 0 },
  circuit: {},          // service → { failures, state:'closed'|'open'|'half-open', openedAt }
  failureThreshold: 4,  // 连续失败 N 次熔断
  openMs: 30000,        // 熔断开启 30s 后进入半开
  timeoutMs: 3000,      // 单次调用超时
  maxRetry: 2,          // 幂等动作最多重试 2 次
};

const IDEMPOTENT_SERVICES = new Set(['user', 'product', 'order', 'logistics', 'aftersales']);

/** 令牌桶限流；返回 true=放行 */
function rateLimitAllow(nowMs) {
  const rl = GOV.rateLimit;
  const now = nowMs || Date.now();
  if (!rl.lastRefill) rl.lastRefill = now;
  rl.tokens = Math.min(rl.capacity, rl.tokens + ((now - rl.lastRefill) / 1000) * rl.refillPerSec);
  rl.lastRefill = now;
  if (rl.tokens >= 1) { rl.tokens -= 1; return true; }
  return false;
}

/** 熔断器判定；返回 { allowed, state } */
function circuitAllow(service, nowMs) {
  const c = GOV.circuit[service];
  const now = nowMs || Date.now();
  if (!c || c.state === 'closed') return { allowed: true, state: 'closed' };
  if (c.state === 'open') {
    if (now - c.openedAt >= GOV.openMs) { c.state = 'half-open'; return { allowed: true, state: 'half-open' }; }
    return { allowed: false, state: 'open' };
  }
  return { allowed: true, state: 'half-open' }; // half-open 放行探测请求
}

function circuitRecord(service, ok) {
  let c = GOV.circuit[service];
  if (!c) c = GOV.circuit[service] = { failures: 0, state: 'closed', openedAt: 0 };
  if (ok) {
    c.failures = 0;
    if (c.state !== 'closed') c.state = 'closed'; // 任意状态下成功即恢复（半开探测成功/人工恢复）
    return;
  }
  c.failures += 1;
  if (c.failures >= GOV.failureThreshold || c.state === 'half-open') {
    c.state = 'open'; c.openedAt = Date.now();
  }
}

/** 带超时的单次调用 */
function callWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('下游调用超时 ' + ms + 'ms')), ms)),
  ]);
}

/** 生成链路追踪 ID（模拟 SkyWalking TraceId） */
function newTraceId() {
  return 'TR' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * 治理化调用入口：限流 → 熔断判定 → 超时+重试（仅幂等动作）→ 熔断记录 → 降级兜底
 * @returns 永不抛错的读调用（降级返回 { degraded:true }）；写调用失败抛错
 */
async function governedCall(service, action, payload) {
  if (!rateLimitAllow()) throw Object.assign(new Error('网关限流触发（令牌桶耗尽），请稍后重试'), { code: 'GATEWAY_RATE_LIMITED' });
  const ca = circuitAllow(service);
  if (!ca.allowed) throw Object.assign(new Error(`服务 ${service} 熔断中（${ca.state}），已降级`), { code: 'CIRCUIT_OPEN' });

  const idempotent = IDEMPOTENT_SERVICES.has(service) && !String(action).startsWith('create') && !String(action).startsWith('send') && !String(action).startsWith('push');
  const maxTry = idempotent ? 1 + GOV.maxRetry : 1;
  let lastErr;
  for (let i = 0; i < maxTry; i++) {
    try {
      const r = await callWithTimeout(ServiceGateway.call(service, action, payload), GOV.timeoutMs);
      circuitRecord(service, true);
      return r;
    } catch (e) {
      lastErr = e;
      // 写动作超时后不可盲目重试（防重复建单/重复发券），直接熔断计数
      if (!idempotent) break;
    }
  }
  circuitRecord(service, false);
  if (idempotent) {
    // 读调用降级兜底
    return { degraded: true, service, action, message: lastErr ? lastErr.message : '下游不可用' };
  }
  throw lastErr;
}

function initGateway(cloud) {
  ServiceGateway.adapters['cloud-db'] = {
    async call(service, action, payload) {
      const db = cloud.database;
      if (service === 'user') {
        if (action === 'get') {
          const { data } = await db.from('svc_users').select('*').eq('tenant_id', Tenant.id()).eq('user_id', payload.user_id).limit(1);
          return data && data[0] ? data[0] : null;
        }
      }
      if (service === 'product') {
        if (action === 'get') {
          let q = db.from('svc_products').select('*').eq('tenant_id', Tenant.id());
          q = payload.sku ? q.eq('sku', payload.sku) : q.eq('name', payload.name);
          const { data } = await q.limit(1);
          return data && data[0] ? data[0] : null;
        }
      }
      if (service === 'order') {
        if (action === 'get') {
          const { data } = await db.from('svc_orders').select('*').eq('tenant_id', Tenant.id()).eq('order_no', payload.order_no).limit(1);
          return data && data[0] ? data[0] : null;
        }
        if (action === 'listByUser') {
          const { data } = await db.from('svc_orders').select('*').eq('tenant_id', Tenant.id()).eq('user_id', payload.user_id).order('created_at', { ascending: false }).limit(20);
          return data || [];
        }
        if (action === 'listAbandoned') {
          // 弃单识别：待支付且超阈值分钟数的订单
          const { data } = await db.from('svc_orders').select('*').eq('tenant_id', Tenant.id()).eq('status', 'pending_payment').order('created_at', { ascending: false }).limit(100);
          const cutoff = Date.now() - (payload.minAgeMinutes || 30) * 60000;
          return (data || []).filter((o) => new Date(o.created_at).getTime() < cutoff);
        }
        if (action === 'updateStatus') {
          const { error } = await db.from('svc_orders')
            .update({ status: payload.status, paid_at: payload.paid_at || null })
            .eq('order_no', payload.order_no);
          return { ok: !error, error };
        }
      }
      if (service === 'logistics') {
        if (action === 'get') {
          const { data } = await db.from('svc_logistics').select('*').eq('tenant_id', Tenant.id()).eq('order_no', payload.order_no).limit(1);
          return data && data[0] ? data[0] : null;
        }
      }
      if (service === 'aftersales') {
        if (action === 'getRefund') {
          const { data } = await db.from('svc_refunds').select('*').eq('tenant_id', Tenant.id()).eq('order_no', payload.order_no).order('created_at', { ascending: false }).limit(1);
          return data && data[0] ? data[0] : null;
        }
        if (action === 'createTicket') {
          const ticketNo = 'AT' + Date.now() + String(Math.floor(Math.random() * 90) + 10);
          const { data, error } = await db.from('aftersales_tickets').insert({
            tenant_id: Tenant.id(),
            ticket_no: ticketNo, order_no: payload.order_no, user_id: payload.user_id || '',
            type: payload.type, reason: payload.reason,
            eligible: payload.eligible !== false, auto_processed: !!payload.auto_processed,
            status: payload.auto_processed ? 'auto_done' : 'open',
            note: payload.note || '',
          }).select();
          return error ? { ok: false, error } : data[0];
        }
        if (action === 'listTickets') {
          const { data } = await db.from('aftersales_tickets').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(100);
          return data || [];
        }
        if (action === 'pushToLegacy') {
          // 模拟流转至原有工单系统（legacy-ticket-system）：生成外部单号并回写同步状态
          const extNo = 'LTS' + Date.now() + String(Math.floor(Math.random() * 90) + 10);
          const { error } = await db.from('aftersales_tickets')
            .update({ external_ticket_no: extNo, sync_status: 'synced' })
            .eq('ticket_no', payload.ticket_no);
          return error ? { ok: false, error } : { ok: true, external_ticket_no: extNo, system: 'legacy-ticket-system' };
        }
      }
      if (service === 'marketing') {
        if (action === 'sendReminder') {
          const { data, error } = await db.from('collect_tasks').insert({
            tenant_id: Tenant.id(),
            order_no: payload.order_no, user_id: payload.user_id, tier: payload.tier,
            channel: payload.channel, strategy: payload.strategy, status: 'sent', result: payload.result || '',
          }).select();
          return error ? { ok: false, error } : data[0];
        }
        if (action === 'reissueCoupon') {
          const { data, error } = await db.from('coupon_grants').insert({
            tenant_id: Tenant.id(),
            user_id: payload.user_id, coupon_name: payload.coupon_name,
            amount: payload.amount, reason: payload.reason, valid_days: payload.valid_days || 7,
          }).select();
          return error ? { ok: false, error } : data[0];
        }
        if (action === 'createActivityReminder') {
          const { data, error } = await db.from('activity_reminders').insert({
            tenant_id: Tenant.id(),
            user_id: payload.user_id, activity_name: payload.activity_name,
            expires_at: payload.expires_at, content: payload.content, status: 'pending',
          }).select();
          return error ? { ok: false, error } : data[0];
        }
        if (action === 'listReminders') {
          const { data } = await db.from('activity_reminders').select('*').eq('tenant_id', Tenant.id()).order('expires_at', { ascending: true }).limit(50);
          return data || [];
        }
        if (action === 'listCoupons') {
          const { data } = await db.from('coupon_grants').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(50);
          return data || [];
        }
        if (action === 'listCollectTasks') {
          const { data } = await db.from('collect_tasks').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(100);
          return data || [];
        }
        if (action === 'listCollectByOrder') {
          const { data } = await db.from('collect_tasks').select('*').eq('tenant_id', Tenant.id()).eq('order_no', payload.order_no).order('created_at', { ascending: false }).limit(20);
          return data || [];
        }
      }
      if (service === 'router') {
        if (action === 'logDecision') {
          const { error } = await db.from('route_decisions').insert({ ...payload, tenant_id: Tenant.id() });
          return { ok: !error };
        }
        if (action === 'listDecisions') {
          const { data } = await db.from('route_decisions').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(100);
          return data || [];
        }
      }
      if (service === 'audit') {
        if (action === 'insert') {
          const { error } = await db.from('tool_audit_logs').insert({ ...payload, tenant_id: Tenant.id() });
          return { ok: !error, error };
        }
        if (action === 'list') {
          const { data } = await db.from('tool_audit_logs').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(200);
          return data || [];
        }
      }
      // 真实 MQ：逻辑收口在云库 SQL 函数（pgmq 式），经 db.rpc 调用
      if (service === 'mq') {
        const M = (fn, args) => db.rpc(fn, args);
        if (action === 'enqueue') {
          const { data, error } = await M('mq_enqueue', {
            p_topic: payload.topic, p_payload: payload.payload,
            p_delay_seconds: payload.delay_seconds || 0,
            p_trace_id: payload.trace_id || null, p_max_attempts: payload.max_attempts || 5,
          });
          return error ? { ok: false, error } : data[0] || data;
        }
        if (action === 'claim') {
          const { data, error } = await M('mq_claim', {
            p_topics: payload.topics && payload.topics.length ? payload.topics : null,
            p_limit: payload.limit || 20,
            p_visibility_seconds: payload.visibility_seconds || 300,
            p_consumer: payload.consumer || 'console',
          });
          return error ? { ok: false, error } : (data || []);
        }
        if (action === 'ack') {
          const { data, error } = await M('mq_ack', {
            p_ids: payload.ids, p_consumer: payload.consumer || 'console',
            p_result: payload.result || null,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'nack') {
          const { data, error } = await M('mq_nack', {
            p_ids: payload.ids, p_consumer: payload.consumer || 'console',
            p_error: payload.error || null, p_retry_delay_seconds: payload.retry_delay_seconds ?? null,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'reclaimExpired') {
          const { data, error } = await M('mq_reclaim_expired', {});
          return error ? { ok: false, error } : data;
        }
        if (action === 'requeueDead') {
          const { data, error } = await M('mq_requeue_dead', {
            p_ids: payload.ids && payload.ids.length ? payload.ids : null,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'stats') {
          const { data, error } = await M('mq_stats', {});
          return error ? { ok: false, error } : (data || []);
        }
        if (action === 'listPending') {
          // 仅展示用途：pending 且已到投递时间
          const { data } = await db.from('mq_tasks').select('*')
            .eq('status', 'pending').lte('next_retry_at', new Date().toISOString())
            .order('next_retry_at', { ascending: true }).limit(payload.limit || 50);
          return data || [];
        }
        if (action === 'listAll') {
          const { data } = await db.from('mq_tasks').select('*').order('created_at', { ascending: false }).limit(100);
          return data || [];
        }
      }
      // 后台账号管理（服务端 admin_user_* 函数：token 会话校验 + admin 角色门禁在库内强制）
      if (service === 'usermgmt') {
        const T = payload.token;
        if (!T) return { ok: false, error: '缺少管理员会话，请重新登录' };
        const M = (fn, args) => db.rpc(fn, args);
        if (action === 'list') {
          const { data, error } = await M('admin_user_list', { p_token: T });
          return error ? { ok: false, error } : data;
        }
        if (action === 'create') {
          const { data, error } = await M('admin_user_create', {
            p_token: T, p_username: payload.username, p_password: payload.password, p_role: payload.role,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'resetPwd') {
          const { data, error } = await M('admin_user_resetpwd', {
            p_token: T, p_username: payload.username, p_password: payload.password,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'toggle') {
          const { data, error } = await M('admin_user_toggle', {
            p_token: T, p_username: payload.username, p_enabled: !!payload.enabled,
          });
          return error ? { ok: false, error } : data;
        }
        if (action === 'delete') {
          const { data, error } = await M('admin_user_delete', { p_token: T, p_username: payload.username });
          return error ? { ok: false, error } : data;
        }
      }
      throw new Error(`未知服务动作：${service}.${action}`);
    },
  };
  ServiceGateway.adapter = ServiceGateway.adapters['cloud-db'];
}

// ---------- 纯逻辑：分层催付 ----------
/** 金额 → 催付分层策略 */
function tierFor(amount) {
  const n = Number(amount) || 0;
  if (n < 100) return {
    tier: 'T1-轻触达', channel: '站内信',
    strategy: '柔性提醒：12小时内下单有效，库存紧张提示',
    coupon: null,
  };
  if (n < 300) return {
    tier: 'T2-标准挽回', channel: '站内信+短信',
    strategy: '利益点挽回：发放弃单专享券（10元）+ 24小时有效期',
    coupon: { name: '弃单挽回专享券', amount: 10, valid_days: 3 },
  };
  return {
    tier: 'T3-专属挽回', channel: '专属客服外呼',
    strategy: '高价值订单：专属客服 1v1 跟进，大额券（20元）+ 免费咨询',
    coupon: { name: '高价值弃单专享券', amount: 20, valid_days: 3 },
  };
}

// ---------- 纯逻辑：催付频次控制（防骚扰） ----------
// 功能验收4：触达频次可控 —— 同订单 72h 内最多 3 次、两次触达间隔 ≥4h、T3 每日最多 1 次
/**
 * @param history 该订单历史触达记录 [{created_at, tier}]
 * @param nowMs 当前时间
 * @param tier 本次触达层级（'T1-轻触达'|'T2-标准挽回'|'T3-专属挽回'）
 * @returns {{allowed:boolean, reason:string}}
 */
function frequencyGuard(history, nowMs, tier) {
  const now = nowMs || Date.now();
  const ts = (h) => new Date(h.created_at).getTime();
  const recent = (history || []).filter((h) => now - ts(h) < 72 * 3600000);
  if (recent.length >= 3) return { allowed: false, reason: '72小时内已触达3次，达到频次上限' };
  const sorted = recent.slice().sort((a, b) => ts(b) - ts(a));
  if (sorted.length && now - ts(sorted[0]) < 4 * 3600000) {
    return { allowed: false, reason: '距上次触达不足4小时（防骚扰间隔）' };
  }
  if (tier === 'T3-专属挽回') {
    const todayTouches = (history || []).filter((h) => {
      const d = new Date(ts(h)); const n = new Date(now);
      return h.tier === 'T3-专属挽回' && d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    });
    if (todayTouches.length >= 1) return { allowed: false, reason: 'T3外呼每日最多1次' };
  }
  return { allowed: true, reason: '频控通过' };
}

// ---------- 异步任务队列（真实 MQ：pgmq 式，云库 SQL 函数驱动） ----------
// 技术验收2：催单任务走 MQ 异步解耦削峰，不阻塞对话
// 语义：原子抢占（多消费者互斥）/ 可见性超时回收 / 指数退避重试 / 死信 / at-least-once
const MQ_CONSUMER = 'console';
async function enqueueCollectTask(payload, traceId) {
  return governedCall('mq', 'enqueue', { topic: 'collect.send', payload, trace_id: traceId });
}
/** 消费队列：原子抢占 → 频控复核 → 发送 → ack/nack（运营台/定时器/worker 调用） */
async function consumeCollectQueue(cloud, limit) {
  const claimed = await governedCall('mq', 'claim', {
    topics: ['collect.send'], limit: limit || 20,
    visibility_seconds: 300, consumer: MQ_CONSUMER,
  });
  if (claimed && claimed.ok === false) throw new Error('MQ抢占失败: ' + JSON.stringify(claimed.error));
  const tasks = claimed || [];
  const results = [];
  for (const t of tasks) {
    const p = t.payload || {};
    // 消费时再次过频控（削峰期间订单可能已被其他通道触达）
    const hist = await governedCall('marketing', 'listCollectByOrder', { order_no: p.order_no });
    const guard = frequencyGuard(hist, Date.now(), p.tier);
    if (!guard.allowed) {
      await governedCall('mq', 'ack', { ids: [t.id], consumer: MQ_CONSUMER, result: 'skipped: ' + guard.reason });
      results.push({ id: t.id, skipped: true, reason: guard.reason });
      continue;
    }
    try {
      const r = await governedCall('marketing', 'sendReminder', {
        order_no: p.order_no, user_id: p.user_id, tier: p.tier,
        channel: p.channel, strategy: p.strategy, result: 'MQ消费发送',
      });
      if (!r || r.ok === false) throw new Error('催付发送失败: ' + JSON.stringify(r && r.error));
      if (p.coupon) {
        await governedCall('marketing', 'reissueCoupon', {
          user_id: p.user_id, coupon_name: p.coupon.name, amount: p.coupon.amount,
          reason: '分层催付自动补发', valid_days: p.coupon.valid_days || 3,
        });
      }
      await governedCall('mq', 'ack', { ids: [t.id], consumer: MQ_CONSUMER, result: r && r.id ? 'sent#' + r.id : 'sent' });
      results.push({ id: t.id, sent: true });
    } catch (e) {
      // 失败 nack：自动指数退避重试，超限进死信
      await governedCall('mq', 'nack', { ids: [t.id], consumer: MQ_CONSUMER, error: e.message || String(e) });
      results.push({ id: t.id, sent: false, retry: true, error: e.message || String(e) });
    }
  }
  return results;
}

// ---------- 纯逻辑：退换货资格判定 ----------
/**
 * @param order 订单对象（status/amount/paid_at/sku）
 * @param type 'return_refund' 退货退款 | 'refund_only' 仅退款 | 'exchange' 换货
 */
function checkEligibility(order, type, nowMs) {
  const R = (eligible, reason, auto) => ({ eligible, reason, autoProcess: eligible && auto });
  if (!order) return R(false, '订单不存在，请核对订单号', false);
  if (order.status === 'pending_payment') return R(false, '该订单尚未付款，无需退换，可直接取消订单', false);
  if (order.status === 'refund_reviewing' || order.status === 'refunding') return R(false, '该订单已有进行中的退款申请，请在退款进度中查看', false);
  if (!['paid', 'shipped', 'completed'].includes(order.status)) return R(false, `当前订单状态（${order.status}）暂不支持退换`, false);
  const paid = new Date(order.paid_at || order.created_at).getTime();
  const days = Math.floor(((nowMs || Date.now()) - paid) / 86400000);
  if (days > 15) return R(false, `已超过15天售后窗口（付款后${days}天），无法自动办理，建议转人工咨询`, false);
  if (type === 'exchange' && days > 15) return R(false, '换货需在15天内申请', false);
  if (Number(order.amount) >= 500) return R(false, `订单金额 ${order.amount} 元达到高风险阈值（≥500元），需人工审核确认`, false);
  if (days > 7) return R(true, `已签收 ${days} 天：7天无理由已过，仅支持质量问题退换（需提交凭证）`, false);
  return R(true, `签收后 ${days} 天，符合7天无理由退换政策（商品需吊牌完整未洗涤）`, true);
}

// ---------- 纯逻辑：人机分流 ----------
const HUMAN_KEYWORDS_HIGH = ['投诉', '纠纷', '举报', '假货', '315', '工商', '律师', '法律', '法院', '媒体', '曝光'];
const HUMAN_KEYWORDS_MID = ['赔偿', '泄露', '辱骂', '欺诈', '骗子'];
/**
 * @returns {{route:'ai'|'human', riskLevel:'low'|'medium'|'high', reason:string}}
 */
function riskRoute(question, opts) {
  const q = String(question || '');
  const o = opts || {};
  for (const k of HUMAN_KEYWORDS_HIGH) {
    if (q.includes(k)) return { route: 'human', riskLevel: 'high', reason: `命中高风险词「${k}」` };
  }
  for (const k of HUMAN_KEYWORDS_MID) {
    if (q.includes(k)) return { route: 'human', riskLevel: 'medium', reason: `命中风险词「${k}」` };
  }
  const refundIntent = /(退|换|售后|赔偿)/.test(q);
  if (o.amount != null && Number(o.amount) >= 500 && refundIntent) {
    return { route: 'human', riskLevel: 'high', reason: `涉及金额 ${o.amount} 元（≥500元）的售后诉求` };
  }
  return { route: 'ai', riskLevel: 'low', reason: '常规场景，AI 全自动处理' };
}

// ---------- 纯逻辑：确定性意图 → 工具规划 ----------
function extractOrderNo(text) {
  const m = String(text || '').match(/SO\d{6,}/i);
  return m ? m[0].toUpperCase() : null;
}
/**
 * 确定性意图规则（命中即直接调工具，稳定且零延迟）
 * @returns {{tool:string, args:object, note:string}|null}
 */
function rulePlan(question, ctx) {
  const q = String(question || '');
  const c = ctx || {};
  const orderNo = extractOrderNo(q);
  if (/退款.*(进度|到账|多久|哪一步|流程|成功|状态|退了吗|到哪|了吗|退没)|(进度|到账|成功|状态|退了).*退款|退款.*怎么样|怎么.*还没.*退|退款了吗|退了吗/.test(q)) {
    return orderNo || c.orderNo ? { tool: 'query_refund_progress', args: { order_no: orderNo || c.orderNo }, note: '识别退款进度查询' } : null;
  }
  if (/(物流|快递|包裹).*(哪|到哪|进度|状态|多久)|退回.*(进度|到哪)|发货了吗/.test(q)) {
    return orderNo || c.orderNo ? { tool: 'query_logistics', args: { order_no: orderNo || c.orderNo }, note: '识别物流查询' } : null;
  }
  if (/(退|换).*(资格|能退|能换|可以退|可以换|符合)|资格.*(退|换)|(退|换)货.*条件|(?:能|可以|可否)(?:退|换)货?/.test(q)) {
    return orderNo || c.orderNo ? { tool: 'check_aftersales_eligibility', args: { order_no: orderNo || c.orderNo, type: /换/.test(q) ? 'exchange' : 'return_refund' }, note: '识别退换资格判定' } : null;
  }
  if (/(申请|我要|办理).*(退货|退款|售后)/.test(q)) {
    return orderNo || c.orderNo ? { tool: 'create_aftersales_ticket', args: { order_no: orderNo || c.orderNo, type: /换/.test(q) ? 'exchange' : 'return_refund', reason: q.slice(0, 60) }, note: '识别售后申请' } : null;
  }
  if (/订单.*(状态|哪|怎么样)|我的订单|查.*订单/.test(q)) {
    if (orderNo) return { tool: 'query_order', args: { order_no: orderNo }, note: '识别订单查询' };
    if (c.userId) return { tool: 'query_order', args: { user_id: c.userId }, note: '按用户查订单列表' };
    return null;
  }
  if (/(有货|库存|现货)/.test(q)) {
    if (c.sku) return { tool: 'query_product', args: { sku: c.sku }, note: '识别库存查询' };
    return null;
  }
  return null;
}

// ---------- LLM 工具规划（兜底） ----------
const TOOL_CATALOG = [
  { tool: 'query_user', desc: '查询用户信息（等级/累计消费）', args: 'user_id' },
  { tool: 'query_product', desc: '查询商品信息（价格/库存/状态）', args: 'sku 或 name' },
  { tool: 'query_order', desc: '查询订单（指定单号，或按用户列最近订单）', args: 'order_no 或 user_id' },
  { tool: 'query_logistics', desc: '查询物流/退回进度', args: 'order_no' },
  { tool: 'query_refund_progress', desc: '查询退款进度（步骤明细）', args: 'order_no' },
  { tool: 'check_aftersales_eligibility', desc: '判定退换货资格', args: 'order_no, type(return_refund|refund_only|exchange)' },
  { tool: 'create_aftersales_ticket', desc: '创建售后工单', args: 'order_no, type, reason' },
  { tool: 'send_collect_task', desc: '弃单催付任务（分层+频控+MQ异步）', args: 'order_no, user_id, amount, tier, channel, strategy, coupon' },
  { tool: 'reissue_coupon', desc: '优惠券补发（Agent上限20元）', args: 'user_id, coupon_name, amount, reason' },
  { tool: 'create_activity_reminder', desc: '活动到期提醒', args: 'user_id, activity_name, expires_at, content' },
];
function buildPlannerPrompt(question) {
  const lines = TOOL_CATALOG.map((t) => `- ${t.tool}：${t.desc}；参数：${t.args}`);
  return [
    '你是电商 Agent 的工具规划器。根据用户问题从下列工具中选择一个最合适的，输出严格 JSON（不要输出其他文字）：',
    '{"tool":"<工具名>","args":{...}} 或 {"tool":null}（没有合适工具时）',
    '工具列表：', ...lines,
    '用户问题：' + question,
    '注意：问题中出现 SO 开头编号时必须作为 order_no 传入；退换货类问题中若明确是仅退款用 refund_only。',
  ].join('\n');
}
/** 从 LLM 回复中提取规划 JSON */
function parseAgentPlan(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !obj.tool) return null;
    if (!TOOL_CATALOG.some((t) => t.tool === obj.tool)) return null;
    return { tool: obj.tool, args: obj.args || {}, note: 'LLM 规划' };
  } catch (e) {
    return null;
  }
}

// ---------- 工具执行（鉴权 + 治理 + 审计） ----------
/**
 * 功能验收5：所有工具调用链路留审计日志（调用人/时间/入参/返回/状态/耗时/重试）
 * 功能验收6：JWT 鉴权 + 网关权限校验（auth.js gatewayAuthorize）
 * @param plan {tool, args}
 * @param ctx {token, traceId} —— traceId 缺省自动生成
 */
async function executeTool(plan, ctx) {
  const { tool, args } = plan || {};
  const c = ctx || {};
  const traceId = c.traceId || newTraceId();
  const started = Date.now();

  // 1) 网关鉴权（JWT + scope + 红线）
  const auth = await AuthLib.gatewayAuthorize(c.token, tool);
  if (!auth.ok) {
    await ServiceGateway.call('audit', 'insert', { // 审计直写：不受限流器影响，保证留痕可靠
      trace_id: traceId, caller: 'unknown', tool, service: null, action: null,
      args: args || {}, result: null, status: 'denied', error: auth.reason,
      latency_ms: Date.now() - started, retry_count: 0,
    });
    throw Object.assign(new Error(auth.reason), { code: 'AUTH_DENIED', traceId });
  }

  // 2) 业务红线：Agent 补券单张 ≤20 元（权限最小化兜底）
  if (tool === 'reissue_coupon' && args && !AuthLib.couponAmountAllowed(args.amount)) {
    await ServiceGateway.call('audit', 'insert', { // 审计直写：不受限流器影响，保证留痕可靠
      trace_id: traceId, caller: auth.caller, tool, service: 'marketing', action: null,
      args: args, result: null, status: 'denied', error: '券面金额超 Agent 上限（≤20元）',
      latency_ms: Date.now() - started, retry_count: 0,
    });
    throw Object.assign(new Error('优惠券金额超过 Agent 账号权限上限（≤20元），需人工审批发放'), { code: 'PERMISSION_DENIED', traceId });
  }
  if (tool === 'send_collect_task' && args && args.coupon && !AuthLib.couponAmountAllowed(args.coupon.amount)) {
    await ServiceGateway.call('audit', 'insert', { // 审计直写：不受限流器影响，保证留痕可靠
      trace_id: traceId, caller: auth.caller, tool, service: 'marketing', action: null,
      args: args, result: null, status: 'denied', error: '券面金额超 Agent 上限（≤20元）',
      latency_ms: Date.now() - started, retry_count: 0,
    });
    throw Object.assign(new Error('优惠券金额超过 Agent 账号权限上限（≤20元），需人工审批发放'), { code: 'PERMISSION_DENIED', traceId });
  }

  // 3) 执行（治理化调用）
  let result, status = 'success', errMsg = null;
  try {
    result = await execInner(tool, args || {});
  } catch (e) {
    status = 'failed'; errMsg = e.message;
    throw Object.assign(e, { traceId });
  } finally {
    // 4) 审计落库（无论成败）
    try {
      await ServiceGateway.call('audit', 'insert', { // 审计直写：不受限流器影响，保证留痕可靠
        trace_id: traceId, caller: auth.caller, tool,
        service: TOOL_SERVICE_MAP[tool] || null, action: null,
        args: args || {}, result: status === 'success' ? summarize(result) : null,
        status, error: errMsg, latency_ms: Date.now() - started, retry_count: 0,
      });
    } catch (e) { console.warn('审计落库失败', e); }
  }
  return result;
}

/** 工具 → 所属微服务（审计归档用） */
const TOOL_SERVICE_MAP = {
  query_user: 'user', query_product: 'product', query_order: 'order',
  query_logistics: 'logistics', query_refund_progress: 'aftersales',
  check_aftersales_eligibility: 'order', create_aftersales_ticket: 'aftersales',
  send_collect_task: 'marketing', reissue_coupon: 'marketing', create_activity_reminder: 'marketing',
};

/** 审计结果摘要（截断大对象） */
function summarize(r) {
  try {
    const s = JSON.stringify(r);
    return s && s.length > 800 ? { truncated: s.slice(0, 800) } : JSON.parse(s);
  } catch (e) { return String(r); }
}

async function execInner(tool, args) {
  switch (tool) {
    case 'query_user':
      return governedCall('user', 'get', { user_id: args.user_id });
    case 'query_product':
      return governedCall('product', 'get', { sku: args.sku, name: args.name });
    case 'query_order':
      return args.order_no
        ? governedCall('order', 'get', { order_no: args.order_no })
        : governedCall('order', 'listByUser', { user_id: args.user_id });
    case 'query_logistics':
      return governedCall('logistics', 'get', { order_no: args.order_no });
    case 'query_refund_progress':
      return governedCall('aftersales', 'getRefund', { order_no: args.order_no });
    case 'check_aftersales_eligibility': {
      const order = await governedCall('order', 'get', { order_no: args.order_no });
      if (!order || order.degraded) return { eligible: false, reason: order && order.degraded ? '订单服务暂不可用（已降级），请稍后再试' : '订单不存在，请核对订单号', autoProcess: false };
      return checkEligibility(order, args.type || 'return_refund');
    }
    case 'create_aftersales_ticket': {
      const order = await governedCall('order', 'get', { order_no: args.order_no });
      if (!order || order.degraded) return { created: false, reason: order && order.degraded ? '订单服务暂不可用（已降级）' : '订单不存在，请核对订单号' };
      const el = checkEligibility(order, args.type || 'return_refund');
      if (!el.eligible) return { created: false, reason: el.reason };
      const t = await governedCall('aftersales', 'createTicket', {
        order_no: args.order_no, user_id: order ? order.user_id : '',
        type: args.type || 'return_refund', reason: args.reason || '用户申请',
        eligible: true, auto_processed: el.autoProcess,
        note: el.autoProcess ? '常规售后，AI 自动办理' : '需人工跟进（超7天质量问题类）',
      });
      // 功能验收3：自动流转至原有工单系统
      let sync = null;
      if (t && t.ticket_no) {
        sync = await governedCall('aftersales', 'pushToLegacy', { ticket_no: t.ticket_no });
      }
      return { created: true, ticket: t, autoProcess: el.autoProcess, reason: el.reason, legacySync: sync };
    }
    case 'send_collect_task': {
      // 催付：先频控（防骚扰），通过后走 MQ 异步队列（削峰、不阻塞对话）
      const hist = await governedCall('marketing', 'listCollectByOrder', { order_no: args.order_no });
      const guard = frequencyGuard(hist, Date.now(), args.tier);
      if (!guard.allowed) return { queued: false, reason: guard.reason };
      const tier = args.tier || (tierFor(args.amount || 0).tier);
      const msg = await enqueueCollectTask({
        order_no: args.order_no, user_id: args.user_id, tier,
        channel: args.channel, strategy: args.strategy, coupon: args.coupon || null,
      }, args.traceId);
      return { queued: true, mqTaskId: msg && msg.id, tier, reason: '已入队（MQ异步发送，不阻塞对话）' };
    }
    case 'reissue_coupon': {
      if (!AuthLib.couponAmountAllowed(args.amount)) {
        throw new Error('优惠券金额超过 Agent 账号权限上限（≤20元），需人工审批发放');
      }
      return governedCall('marketing', 'reissueCoupon', {
        user_id: args.user_id, coupon_name: args.coupon_name, amount: args.amount,
        reason: args.reason || '客服补发', valid_days: args.valid_days || 7,
      });
    }
    case 'create_activity_reminder':
      return governedCall('marketing', 'createActivityReminder', {
        user_id: args.user_id, activity_name: args.activity_name,
        expires_at: args.expires_at, content: args.content,
      });
    default:
      throw new Error('工具未注册执行器：' + tool);
  }
}

// Node 单测导出（纯逻辑部分）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ServiceGateway, initGateway, tierFor, checkEligibility, riskRoute,
    rulePlan, extractOrderNo, parseAgentPlan, buildPlannerPrompt, TOOL_CATALOG,
    executeTool, execInner, governedCall, rateLimitAllow, circuitAllow, circuitRecord,
    newTraceId, frequencyGuard, enqueueCollectTask, consumeCollectQueue,
    GOV, TOOL_SERVICE_MAP, summarize,
  };
}
