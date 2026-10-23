/**
 * KB 门禁 e2e（真实库，匿名通道可重复执行）：
 *  1) kb_write 无 token / 伪造 token → 一律拒绝
 *  2) anon 直写 kb_entries / kb_versions / kb_chunks（insert/update/delete）→ 全部被拒
 *  3) anon 仍可 SELECT kb_chunks（聊天检索读取路径不受影响）
 * 说明：带真实会话的全生命周期（草稿→审核→发布→分块生效→下架→删除）由
 *       verify-kb-flow.cjs 一次性验证（需临时管理员/运营账号）
 * 输出契约：最后一行 "结果：X/Y PASS"
 */
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  ✓' : '  ✗ FAIL') + ' ' + name + (cond ? '' : '  ' + JSON.stringify(extra)));
}

(async () => {
  const cloud = createWorkBuddyCloud({
    endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
  });
  const db = cloud.database;
  const fakeTok = 'a'.repeat(64);

  // [1] kb_write 门禁
  const r0 = await db.rpc('kb_write', { p_token: null, p_action: 'save_draft', p_args: {} });
  check('无 token 被拒', r0 && r0.data && r0.data.ok === false && /无权限/.test(r0.data.error || ''), r0.error || r0.data);
  const r1 = await db.rpc('kb_write', { p_token: fakeTok, p_action: 'save_draft', p_args: {} });
  check('伪造 token 被拒', r1 && r1.data && r1.data.ok === false && /无权限/.test(r1.data.error || ''), r1.error || r1.data);
  const r2 = await db.rpc('kb_write', { p_token: fakeTok, p_action: 'delete', p_args: { entry_id: 1 } });
  check('delete 动作伪造 token 被拒', r2 && r2.data && r2.data.ok === false, r2.error || r2.data);
  const r3 = await db.rpc('kb_write', { p_token: fakeTok, p_action: 'not_an_action', p_args: {} });
  check('未知动作伪造 token 被拒', r3 && r3.data && r3.data.ok === false, r3.error || r3.data);

  // [2] anon 直写三表必须被拒
  const w1 = await db.from('kb_entries').insert({ category: 'faq', title: 'e2e_probe', content: 'x', tags: [], status: 'draft' });
  check('anon 直插 kb_entries 被拒', !!w1.error, w1.error && w1.error.message);
  const w2 = await db.from('kb_entries').update({ title: 'hack' }).eq('id', 1);
  check('anon 直改 kb_entries 被拒', !!w2.error, w2.error && w2.error.message);
  const w3 = await db.from('kb_versions').insert({ entry_id: 1, version_no: 999, title: 'x', content: 'x', editor: 'x', action: 'x' });
  check('anon 直插 kb_versions 被拒', !!w3.error, w3.error && w3.error.message);
  const w4 = await db.from('kb_chunks').delete().eq('entry_id', 1);
  check('anon 直删 kb_chunks 被拒', !!w4.error, w4.error && w4.error.message);

  // [3] 读取路径保持畅通（聊天检索依赖）
  const rd = await db.from('kb_chunks').select('id').eq('status', 'published').limit(3);
  check('anon 仍可读 kb_chunks（published）', !rd.error && Array.isArray(rd.data) && rd.data.length >= 1, rd.error || rd.data);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('E2E FATAL:', e && e.message);
  console.log(`\n结果：${results.filter((r) => r.ok).length}/${results.length} PASS`);
  process.exit(1);
});
