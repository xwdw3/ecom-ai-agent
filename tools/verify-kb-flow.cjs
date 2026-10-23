/**
 * KB 门禁全生命周期一次性验证（真实库）：
 * ops 登录 → 建草稿 → 提交审核 →【ops 审批必须被拒：编辑者不能自审】→ admin 审批发布
 * → anon 可读到分块 → admin 下架（分块清空）→ 重新上架 → 回滚 v1 → 删除
 * 附带：ops 尝试 delete（应被允许——kb.edit）、readonly 类角色路径由角色门禁覆盖
 * 结束清理：两个临时账号经 admin_user_delete 删除（留审计）
 * 用法：node tools/verify-kb-flow.cjs（凭据读 tools/_kb_probe.json）
 */
const fs = require('fs');
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

(async () => {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, '_kb_probe.json'), 'utf8'));
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
  const rpc = (name, params) => db.rpc(name, params);
  const kb = (token, action, args) => rpc('kb_write', { p_token: token, p_action: action, p_args: args });
  const chunksOf = (content) => [{ chunk_index: 0, title: '探针条目', content, category: 'faq', tags: ['probe'] }];

  // 登录
  const lo = await rpc('admin_login', { p_username: probe.ops.username, p_password: probe.ops.pass });
  const la = await rpc('admin_login', { p_username: probe.admin.username, p_password: probe.admin.pass });
  const tOps = lo.data && lo.data.token; const tAdm = la.data && la.data.token;
  assert('ops/admin 登录成功', !!tOps && !!tAdm, lo.error || la.error);

  // ops：建草稿 → 提交
  const d1 = await kb(tOps, 'save_draft', { payload: { category: 'faq', title: '【探针】KB门禁生命周期', content: '探针内容V1', tags: ['probe'] } });
  assert('ops 建草稿成功', d1.data && d1.data.ok === true && d1.data.entry.status === 'draft', d1.error || d1.data);
  const id = d1.data && d1.data.entry && d1.data.entry.id;
  const s1 = await kb(tOps, 'submit', { entry_id: id });
  assert('ops 提交审核成功', s1.data && s1.data.ok === true && s1.data.entry.status === 'pending', s1.error || s1.data);

  // ops：审批必须被拒（编辑者不能自审，服务端强制）
  const r1 = await kb(tOps, 'review', { entry_id: id, approved: true, chunks: chunksOf('x') });
  assert('ops 审批被服务端拒绝', r1.data && r1.data.ok === false && /审批/.test(r1.data.error || ''), r1.error || r1.data);

  // admin：审批发布（带分块）
  const r2 = await kb(tAdm, 'review', { entry_id: id, approved: true, note: '探针发布', chunks: chunksOf('探针内容V1') });
  assert('admin 审批发布成功', r2.data && r2.data.ok === true && r2.data.entry.status === 'published', r2.error || r2.data);
  const c1 = await db.from('kb_chunks').select('id, content').eq('entry_id', id);
  assert('发布后 anon 可读到分块', !c1.error && c1.data && c1.data.length === 1 && c1.data[0].content === '探针内容V1', c1.error || c1.data);

  // 分块校验：空分块必须被拒（且线上分块不受影响）
  const r3 = await kb(tAdm, 'republish', { entry_id: id }); // 状态是 published，先下架
  void r3;
  // 正确路径：先下架（清分块），再验证 republish 带空分块被拒
  const o1 = await kb(tOps, 'offline', { entry_id: id });
  assert('ops 下架成功', o1.data && o1.data.ok === true && o1.data.entry.status === 'offline', o1.error || o1.data);
  const c2 = await db.from('kb_chunks').select('id').eq('entry_id', id);
  assert('下架后分块已清空', !c2.error && c2.data && c2.data.length === 0, c2.error || c2.data);
  const r4 = await kb(tAdm, 'republish', { entry_id: id, chunks: [] });
  assert('republish 空分块被拒', r4.data && r4.data.ok === false && /分块/.test(r4.data.error || ''), r4.error || r4.data);
  const o2 = await db.from('kb_entries').select('status').eq('id', id);
  assert('分块校验失败后条目保持 offline', !o2.error && o2.data && o2.data[0] && o2.data[0].status === 'offline', o2.error || o2.data);

  // admin：重新上架（带分块）
  const rp = await kb(tAdm, 'republish', { entry_id: id, chunks: chunksOf('探针内容V1') });
  assert('admin 重新上架成功', rp.data && rp.data.ok === true && rp.data.entry.status === 'published', rp.error || rp.data);

  // admin：回滚到 v1（内容=探针内容V1 的首版，状态回草稿）
  const rb = await kb(tAdm, 'rollback', { entry_id: id, version_no: 1 });
  assert('admin 回滚到 v1 → 新草稿', rb.data && rb.data.ok === true && rb.data.entry.status === 'draft', rb.error || rb.data);

  // admin：删除（连版本）
  const del = await kb(tAdm, 'delete', { entry_id: id });
  assert('admin 删除成功', del.data && del.data.ok === true, del.error || del.data);
  const c3 = await db.from('kb_chunks').select('id').eq('entry_id', id);
  const e3 = await db.from('kb_entries').select('id').eq('id', id);
  assert('删除后分块/条目均不存在', !c3.error && c3.data.length === 0 && !e3.error && e3.data.length === 0, c3.error || e3.error);

  // 清理：两个临时账号（经 admin_user_delete，留审计）
  const x1 = await rpc('admin_user_delete', { p_token: tAdm, p_username: probe.ops.username });
  const x2 = await rpc('admin_user_delete', { p_token: tAdm, p_username: probe.admin.username });
  assert('临时账号已清理', x1.data && x1.data.ok && x2.data && x2.data.ok, x1.error || x2.error);

  console.log('PROBE_ADMIN=' + probe.admin.username);
  console.log('PROBE_OPS=' + probe.ops.username);
  console.log(ok ? 'KB 门禁全生命周期验证 PASS' : 'KB 门禁全生命周期验证 FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
