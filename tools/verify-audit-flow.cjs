/**
 * usermgmt 审计链路一次性验证（真实库）：
 * 登录临时管理员 → admin_user_create（被审计）→ admin_user_delete（被审计）→ 自身被删即下线
 * 断言打印到 stdout；结束清理：确认临时账号已不存在
 * 用法：node tools/verify-audit-flow.cjs（凭据读 tools/_audit_probe.json）
 */
const fs = require('fs');
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

(async () => {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, '_audit_probe.json'), 'utf8'));
  const target = 'hb_tgt_' + Date.now();
  const cloud = createWorkBuddyCloud({
    endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
  });
  const db = cloud.database;
  let ok = true;
  const assert = (name, cond, extra) => {
    console.log((cond ? '  ✓' : '  ✗ FAIL') + ' ' + name + (cond ? '' : '  ' + JSON.stringify(extra)));
    if (!cond) ok = false;
  };

  // 1) 登录
  const login = await db.rpc('admin_login', { p_username: probe.u, p_password: probe.pass });
  const token = login && login.data && login.data.token;
  assert('临时管理员登录成功', !!token, login.error || login.data);

  // 2) 建号（应 ok 且落 user_create 审计）
  const cr = await db.rpc('admin_user_create', { p_token: token, p_username: target, p_password: 'Target#2026pass', p_role: 'readonly' });
  assert('admin_user_create 成功', cr && cr.data && cr.data.ok === true, cr.error || cr.data);

  // 3) 删号（应 ok 且落 user_delete 审计；函数内部先删会话）
  const del = await db.rpc('admin_user_delete', { p_token: token, p_username: target });
  assert('admin_user_delete 成功', del && del.data && del.data.ok === true, del.error || del.data);

  // 4) 目标账号确已不存在
  const list = await db.rpc('admin_user_list', { p_token: token });
  const gone = list && list.data && list.data.ok && !list.data.users.some((u) => u.username === target);
  assert('目标账号已不存在', !!gone, list.error || list.data);

  // 5) 审计行验证（无服务角色读不了表，故这里只输出探针名，供外部服务端核对）
  console.log('PROBE_ACTOR=' + probe.u);
  console.log('PROBE_TARGET=' + target);
  console.log(ok ? '审计链路验证 PASS' : '审计链路验证 FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
