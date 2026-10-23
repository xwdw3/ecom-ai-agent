/**
 * 多租户上下文（P2·多租户覆盖补全）
 * - 租户解析优先级：URL ?tenant=XXX → 管理端会话（gate_session.tn）→ 会话缓存 → 默认 T001
 * - SDK 链式约束：过滤必须在 select/update/delete 之后，故助手分三类：
 *   · Tenant.q(db, table, cols)   读：from+select+eq(tenant) 起手，后续可继续链式
 *   · Tenant.row(obj)/rows(arr)   写：insert payload 补 tenant_id
 *   · update/delete：在方法后手动 .eq('tenant_id', Tenant.id())
 * - 不适用租户隔离的表：svc_admin_*（平台级）、svc_audit_logs/svc_login_locks（平台级）、
 *   mq_tasks（平台队列）、user_chat_history（owner_id 个人级）
 */
const TENANT_DEFAULT = 'T001';
const TENANT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TENANT_CACHE_KEY = 'tenant_id';

function tenantResolve() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const q = new URLSearchParams(location.search).get('tenant');
      if (q && TENANT_RE.test(q)) {
        try { sessionStorage.setItem(TENANT_CACHE_KEY, q); } catch (e) { /* ignore */ }
        return q;
      }
    }
  } catch (e) { /* 非浏览器环境 */ }
  try {
    const s = JSON.parse(sessionStorage.getItem('gate_session') || 'null');
    if (s && s.tn && TENANT_RE.test(s.tn)) return s.tn;
  } catch (e) { /* ignore */ }
  try {
    const c = sessionStorage.getItem(TENANT_CACHE_KEY);
    if (c && TENANT_RE.test(c)) return c;
  } catch (e) { /* ignore */ }
  return TENANT_DEFAULT;
}

/** 当前租户 ID */
function tenantId() { return tenantResolve(); }

/** 读助手：from+select+租户过滤起手（cols 缺省 '*'；后续仍可 .eq/.order/.limit/.single） */
function tenantQ(db, table, cols) {
  return db.from(table).select(cols || '*').eq('tenant_id', tenantId());
}

/** 写助手：insert 行对象补 tenant_id */
function tenantRow(obj) { return { ...obj, tenant_id: tenantId() }; }
function tenantRows(arr) { return arr.map((o) => ({ ...o, tenant_id: tenantId() })); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TENANT_DEFAULT, TENANT_RE, tenantResolve, tenantId, tenantQ, tenantRow, tenantRows };
}
if (typeof window !== 'undefined') {
  window.Tenant = { DEFAULT: TENANT_DEFAULT, id: tenantId, resolve: tenantResolve, q: tenantQ, row: tenantRow, rows: tenantRows };
}
