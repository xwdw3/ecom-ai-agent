/* 管理端服务端会话 e2e（真实云库，anon rpc 通道） */
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
const db = cloud.database;

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? '' : JSON.stringify(extra) });
  console.log((cond ? '  ✓' : '  ✗ FAIL') + ' ' + name + (cond ? '' : '  ' + JSON.stringify(extra)));
}
const rpc = (fn, args) => db.rpc(fn, args);

(async () => {
// 管理员密码从本地密钥文件/环境变量读取（不入库不入 git）
const ADMIN_PASS = process.env.ADMIN_PASS ||
  JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '.secrets.json'), 'utf8')).ADMIN_PASS;
  // 1. 错误密码拒绝
  let r = await rpc('admin_login', { p_username: 'admin', p_password: 'wrong-pass' });
  check('错误密码拒绝', r.data && r.data.ok === false, r.error || r.data);

  // 2. 正确密码登录，签发 token
  r = await rpc('admin_login', { p_username: 'admin', p_password: ADMIN_PASS });
  check('管理员登录成功且返回 token', r.data && r.data.ok === true && typeof r.data.token === 'string' && r.data.token.length === 64, r.error || r.data);
  const TOKEN = r.data && r.data.token;
  check('返回角色 admin', r.data && r.data.role === 'admin');

  // 3. 无效 token 无权限
  r = await rpc('admin_user_list', { p_token: 'x'.repeat(64) });
  check('无效 token 无权限', r.data && r.data.ok === false, r.error || r.data);

  // 4. 列表（安全列）
  r = await rpc('admin_user_list', { p_token: TOKEN });
  const users = (r.data && r.data.users) || [];
  check('列表返回且不含哈希列', r.data && r.data.ok === true && users.length >= 4 && !('salt' in users[0]) && !('pass_hash' in users[0]), r.error);

  // 5. 新建临时账号
  r = await rpc('admin_user_create', { p_token: TOKEN, p_username: 'e2e_tmp', p_password: 'E2eTest!234', p_role: 'readonly' });
  check('新建账号成功', r.data && r.data.ok === true, r.error || r.data);

  // 6. 重复用户名拒绝
  r = await rpc('admin_user_create', { p_token: TOKEN, p_username: 'e2e_tmp', p_password: 'E2eTest!234', p_role: 'ops' });
  check('重复用户名拒绝', r.data && r.data.ok === false, r.data);

  // 7. 弱密码拒绝
  r = await rpc('admin_user_create', { p_token: TOKEN, p_username: 'e2e_tmp2', p_password: '1234567', p_role: 'ops' });
  check('弱密码拒绝', r.data && r.data.ok === false, r.data);

  // 8. 临时账号登录（readonly），用它的 token 管理账号→拒绝
  r = await rpc('admin_login', { p_username: 'e2e_tmp', p_password: 'E2eTest!234' });
  check('临时账号可登录', r.data && r.data.ok === true && r.data.role === 'readonly', r.error);
  const TMP_TOKEN = r.data && r.data.token;
  r = await rpc('admin_user_create', { p_token: TMP_TOKEN, p_username: 'hacker', p_password: 'HackTest!234', p_role: 'admin' });
  check('非 admin 角色管理操作被拒绝', r.data && r.data.ok === false, r.data);

  // 9. 重置密码 + 旧密码失效新密码生效
  r = await rpc('admin_user_resetpwd', { p_token: TOKEN, p_username: 'e2e_tmp', p_password: 'NewPass!234' });
  check('重置密码成功', r.data && r.data.ok === true, r.data);
  r = await rpc('admin_login', { p_username: 'e2e_tmp', p_password: 'E2eTest!234' });
  check('旧密码已失效', r.data && r.data.ok === false, r.data);
  r = await rpc('admin_login', { p_username: 'e2e_tmp', p_password: 'NewPass!234' });
  check('新密码生效', r.data && r.data.ok === true, r.error);

  // 10. 禁用即踢下线
  r = await rpc('admin_user_toggle', { p_token: TOKEN, p_username: 'e2e_tmp', p_enabled: false });
  check('禁用成功', r.data && r.data.ok === true, r.data);
  r = await rpc('admin_login', { p_username: 'e2e_tmp', p_password: 'NewPass!234' });
  check('禁用后登录拒绝', r.data && r.data.ok === false, r.data);
  r = await rpc('admin_user_list', { p_token: TMP_TOKEN });
  check('禁用后旧会话失效', r.data && r.data.ok === false, r.data);

  // 11. 删除临时账号
  r = await rpc('admin_user_delete', { p_token: TOKEN, p_username: 'e2e_tmp' });
  check('删除账号成功', r.data && r.data.ok === true, r.data);

  // 12. 最后管理员保护：删除 admin 自己→拒绝
  r = await rpc('admin_user_delete', { p_token: TOKEN, p_username: 'admin' });
  check('最后管理员不可删除', r.data && r.data.ok === false && /管理员/.test(r.data.error || ''), r.data);

  // 13. anon 直连管理员表已无权限（SELECT 已收回）
  r = await db.from('svc_admin_users').select('username').limit(1);
  check('anon 直读管理员表已被拒绝', !!r.error, r.data);

  const pass = results.filter((x) => x.pass).length;
  console.log(`\n结果：${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('E2E异常：', e.message || e); process.exit(2); });
