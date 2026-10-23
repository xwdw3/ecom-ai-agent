/**
 * Phase3 · RBAC 权限体系 + 操作审计
 * 四级角色：管理员 admin / 运营 ops / 客服 agent / 只读 readonly
 * 前端页面守卫 + 权限矩阵 + 操作审计（tool_audit_logs / alert_logs 之外独立审计痕迹）
 * 生产替换位：对接企业 IAM/SSO，角色由后端签发的 JWT scope 决定。
 */

const ROLES = {
  admin: { name: '管理员', desc: '全部权限（含权限管理）' },
  ops: { name: '运营', desc: '营销/巡检/分析/知识库管理，不可用户与权限管理' },
  agent: { name: '客服', desc: '客服对话与售后处理，只读数据看板' },
  readonly: { name: '只读', desc: '仅查看，不可执行任何写操作' },
};

/** 权限矩阵：模块.动作 → 允许的角色 */
const PERMISSIONS = {
  'kb.view': ['admin', 'ops', 'agent', 'readonly'],
  'kb.edit': ['admin', 'ops'],
  'chat.answer': ['admin', 'ops', 'agent'],
  'chat.transfer': ['admin', 'ops', 'agent'],
  'marketing.view': ['admin', 'ops', 'agent', 'readonly'],
  'marketing.send': ['admin', 'ops'],
  'risk.view': ['admin', 'ops', 'readonly'],
  'risk.execute': ['admin', 'ops'],
  'risk.unblock': ['admin'],
  'inspection.view': ['admin', 'ops', 'readonly'],
  'inspection.execute': ['admin', 'ops'],
  'analytics.view': ['admin', 'ops', 'readonly'],
  'analytics.export': ['admin', 'ops'],
  'system.userManage': ['admin'],
  'system.roleManage': ['admin'],
};

/**
 * 权限判断
 * @param role 'admin'|'ops'|'agent'|'readonly'
 * @param perm 'kb.edit' 等
 */
function can(role, perm) {
  const allowed = PERMISSIONS[perm];
  if (!allowed) return false; // 未注册权限默认拒绝
  return allowed.includes(role);
}

/** 断言：无权限时抛错（返回错误对象便于 UI 提示） */
function requirePerm(role, perm) {
  if (can(role, perm)) return { ok: true };
  return { ok: false, reason: `权限不足：角色「${(ROLES[role] || {}).name || role}」无「${perm}」权限（需要：${(PERMISSIONS[perm] || []).join('/')}）` };
}

/** 页面守卫：按当前角色隐藏/禁用无权限按钮（data-perm 属性约定） */
function applyPageGuards(role) {
  document.querySelectorAll('[data-perm]').forEach((el) => {
    const perm = el.getAttribute('data-perm');
    el.disabled = !can(role, perm);
    el.title = el.disabled ? '当前角色无此权限' : '';
    el.style.opacity = el.disabled ? '0.5' : '';
  });
}

/** 操作审计：落库 tool_audit_logs（caller=角色:用户） */
async function auditLog(db, actor, action, detail, status) {
  try {
    await db.from('tool_audit_logs').insert({
      trace_id: 'rbac-' + Date.now().toString(36),
      caller: actor, tool: 'rbac', service: 'rbac', action,
      args: detail ? JSON.stringify(detail).slice(0, 300) : null,
      result: status || 'ok', status: status || 'ok',
    });
  } catch (e) { console.warn('审计落库失败', e); }
}

// 浏览器端当前角色：优先取登录会话（P0），缺失时 fail-closed 为只读
function currentRole() {
  try {
    const s = JSON.parse(sessionStorage.getItem('gate_session'));
    if (s && ROLES[s.r] && Number(s.exp) > Date.now()) return s.r;
  } catch (e) { /* ignore */ }
  return 'readonly';
}
function setRole(role) {
  if (typeof localStorage !== 'undefined') localStorage.setItem('ops_role', role);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROLES, PERMISSIONS, can, requirePerm, auditLog, currentRole, setRole };
}
if (typeof window !== 'undefined') {
  window.RBAC = { ROLES, PERMISSIONS, can, requirePerm, auditLog, currentRole, setRole, applyPageGuards };
}
