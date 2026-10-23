/**
 * Phase2 验收补充：鉴权中心（JWT 模拟 + 独立服务账号 + 权限最小化）
 *
 * 功能验收6：JWT 鉴权、网关权限校验生效，Agent 调用业务接口具备独立服务账号，权限最小化
 * 技术验收3：权限隔离 —— Agent 账号无支付、大额退款直接审批权限
 *
 * 生产替换位：把 issueToken/verifyToken 换成对接企业 IAM/网关的真实 JWT（RS256 + JWKS），
 * 账号与权限矩阵由配置中心下发；本模块接口保持不变。
 */
const AGENT_ACCOUNT = {
  caller: 'agent-svc',
  name: '电商AI Agent 服务账号',
  scopes: [
    'user:read', 'product:read', 'order:read', 'logistics:read',
    'refund:read', 'aftersales:write', 'marketing:collect', 'marketing:coupon',
    // 注意：不含 payment:execute / refund:approve_large —— 权限最小化
  ],
};

/** 工具 → 所需最小权限 */
const TOOL_SCOPES = {
  query_user: 'user:read',
  query_product: 'product:read',
  query_order: 'order:read',
  query_logistics: 'logistics:read',
  query_refund_progress: 'refund:read',
  check_aftersales_eligibility: 'order:read',
  create_aftersales_ticket: 'aftersales:write',
  send_collect_task: 'marketing:collect',
  reissue_coupon: 'marketing:coupon',
  create_activity_reminder: 'marketing:coupon',
  query_audit: 'audit:read',
};

/** 业务红线：无论权限矩阵如何配置，以下能力对 Agent 账号永久禁用 */
const FORBIDDEN_ACTIONS = ['payment.execute', 'refund.approve_large', 'order.price_modify'];

const TOKEN_TTL_MS = 30 * 60000; // 30 分钟

// ---------- HMAC-SHA256（浏览器/Node 18+ 通用） ----------
async function hmacSign(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
function fromB64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const SECRET = 'wb-ecom-agent-gateway-secret'; // 演示密钥；生产由 KMS/配置中心下发

/** 签发 JWT（header.payload.signature） */
async function issueToken(account, ttlMs) {
  const now = Date.now();
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: account.caller, name: account.name, scopes: account.scopes,
    iat: now, exp: now + (ttlMs || TOKEN_TTL_MS), iss: 'wb-auth-center',
  };
  const unsigned = b64urlJson(header) + '.' + b64urlJson(payload);
  const sig = await hmacSign(SECRET, unsigned);
  return unsigned + '.' + sig;
}

/**
 * 校验 JWT，返回 { ok, payload, reason }
 */
async function verifyToken(token, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: '令牌格式非法' };
  const unsigned = parts[0] + '.' + parts[1];
  const expect = await hmacSign(SECRET, unsigned);
  if (expect !== parts[2]) return { ok: false, reason: '签名校验失败' };
  let payload;
  try { payload = JSON.parse(fromB64url(parts[1])); } catch (e) { return { ok: false, reason: '载荷解析失败' }; }
  const now = nowMs || Date.now();
  if (!payload.exp || now >= payload.exp) return { ok: false, reason: '令牌已过期' };
  if (payload.iss !== 'wb-auth-center') return { ok: false, reason: '签发方不合法' };
  return { ok: true, payload };
}

/**
 * 网关权限校验：令牌有效 + scope 匹配 + 非红线动作
 * @returns {{ok:boolean, reason:string, caller?:string}}
 */
async function gatewayAuthorize(token, tool, opts) {
  const v = await verifyToken(token, opts && opts.nowMs);
  if (!v.ok) return { ok: false, reason: '鉴权失败：' + v.reason };
  const required = TOOL_SCOPES[tool];
  if (!required) return { ok: false, reason: `工具未注册权限：${tool}（白名单外默认拒绝）` };
  const scopes = v.payload.scopes || [];
  if (!scopes.includes(required)) {
    return { ok: false, reason: `权限不足：需要 ${required}，账号 ${v.payload.sub} 不具备` };
  }
  // 红线动作兜底校验（防止矩阵误配置）
  if (tool === 'execute_payment' || tool === 'approve_large_refund' || tool === 'modify_order_price') {
    return { ok: false, reason: `红线动作禁止 Agent 调用：${tool}` };
  }
  return { ok: true, caller: v.payload.sub };
}

/** 优惠券补发金额红线（Agent 单张 ≤ 20 元） */
function couponAmountAllowed(amount) {
  return Number(amount) <= 20;
}

// Node 单测导出 & 浏览器全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AGENT_ACCOUNT, TOOL_SCOPES, FORBIDDEN_ACTIONS, TOKEN_TTL_MS,
    issueToken, verifyToken, gatewayAuthorize, couponAmountAllowed,
  };
}
if (typeof window !== 'undefined') {
  window.AuthCenter = {
    AGENT_ACCOUNT, TOOL_SCOPES, issueToken, verifyToken, gatewayAuthorize, couponAmountAllowed,
  };
}
