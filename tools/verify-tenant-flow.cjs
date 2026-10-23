/**
 * 跨租户写隔离一次性验证（真实库）：
 * T002 管理员建草稿（归属 T002）→ anon 按租户读验证可见性
 * → T001 管理员跨租户 submit/rollback/delete 一律"条目不存在"
 * → T002 自己 submit/review 发布 → anon 读到 T002 分块 → T002 删除 → 清理账号
 * 凭据读 tools/_tenant_probe.json（结束删除）；种入 SQL 由 gen 命令输出、migrate 执行
 * 用法：node tools/verify-tenant-flow.cjs
 */
const fs = require('fs');
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

(async () => {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, '_tenant_probe.json'), 'utf8'));
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
  const kb = (token, action, args) => db.rpc('kb_write', { p_token: token, p_action: action, p_args: args });
  const chunksOf = (content) => [{ chunk_index: 0, title: '跨租户探针', content, category: 'faq', tags: ['probe'] }];

  // 登录：T002 应返回 tenant=T002
  const l2 = await db.rpc('admin_login', { p_username: probe.a2.username, p_password: probe.a2.pass });
  const l1 = await db.rpc('admin_login', { p_username: probe.a1.username, p_password: probe.a1.pass });
  const t2 = l2.data && l2.data.token; const t1 = l1.data && l1.data.token;
  assert('两管理员登录成功', !!t2 && !!t1, l2.error || l1.error);
  assert('T002 登录返回租户 T002', l2.data && l2.data.tenant === 'T002', l2.data);
  assert('T001 登录返回租户 T001', l1.data && l1.data.tenant === 'T001', l1.data);

  // T002 建草稿 → 条目归属 T002
  const d = await kb(t2, 'save_draft', { payload: { category: 'faq', title: '【探针】跨租户隔离', content: 'T002 内容V1', tags: ['probe'] } });
  assert('T002 建草稿成功', d.data && d.data.ok === true, d.error || d.data);
  const id = d.data && d.data.entry && d.data.entry.id;
  assert('草稿归属 T002（anon 读验证）', d.data && d.data.entry.tenant_id === 'T002', d.data && d.data.entry);

  // T001 跨租户操作一律"条目不存在"
  const x1 = await kb(t1, 'submit', { entry_id: id });
  assert('T001 跨租户 submit 被拒（条目不存在）', x1.data && x1.data.ok === false && /条目不存在/.test(x1.data.error || ''), x1.error || x1.data);
  const x2 = await kb(t1, 'rollback', { entry_id: id, version_no: 1 });
  assert('T001 跨租户 rollback 被拒', x2.data && x2.data.ok === false && /条目不存在/.test(x2.data.error || ''), x2.error || x2.data);
  const x3 = await kb(t1, 'delete', { entry_id: id });
  assert('T001 跨租户 delete 被拒', x3.data && x3.data.ok === false && /条目不存在/.test(x3.data.error || ''), x3.error || x3.data);

  // T002 自己走完发布
  const s = await kb(t2, 'submit', { entry_id: id });
  assert('T002 提交审核成功', s.data && s.data.ok === true, s.error || s.data);
  const rv = await kb(t2, 'review', { entry_id: id, approved: true, chunks: chunksOf('T002 内容V1') });
  assert('T002 审批发布成功', rv.data && rv.data.ok === true && rv.data.entry.status === 'published', rv.error || rv.data);
  const c = await db.from('kb_chunks').select('content, tenant_id').eq('entry_id', id);
  assert('分块归属 T002 且 anon 可读', !c.error && c.data && c.data.length === 1 && c.data[0].tenant_id === 'T002', c.error || c.data);
  const c0 = await db.from('kb_chunks').select('id').eq('entry_id', id).eq('tenant_id', 'T001');
  assert('T001 视角读不到该分块', !c0.error && c0.data && c0.data.length === 0, c0.error || c0.data);

  // 清理：T002 删条目；平台级账号管理删除两个临时账号
  const del = await kb(t2, 'delete', { entry_id: id });
  assert('T002 删除条目成功', del.data && del.data.ok === true, del.error || del.data);
  const z1 = await db.rpc('admin_user_delete', { p_token: t1, p_username: probe.a2.username });
  const z2 = await db.rpc('admin_user_delete', { p_token: t1, p_username: probe.a1.username });
  assert('临时账号已清理', z1.data && z1.data.ok && z2.data && z2.data.ok, z1.error || z2.error);

  console.log('PROBE_T2=' + probe.a2.username);
  console.log('PROBE_T1=' + probe.a1.username);
  console.log(ok ? '跨租户写隔离验证 PASS' : '跨租户写隔离验证 FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
