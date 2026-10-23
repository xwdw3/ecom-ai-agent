/**
 * CI/CD 流水线（本地一键门禁）
 * 阶段：①静态加载检查（vm 沙箱模拟浏览器逐脚本加载）→ ②全量单测 → ③云库连通冒烟 → ④MQ e2e → ⑤报告与门禁
 * 通过门禁后才允许发布（发布本身仍由人工在会话中确认执行）
 * 用法：
 *   node tools/pipeline.cjs                # 完整流水线
 *   node tools/pipeline.cjs --skip-cloud   # 仅 ①②（远端 CI 无云凭据时用）
 *   node tools/pipeline.cjs --skip-e2e     # 跳过 MQ e2e（较快）
 * 退出码：0=门禁通过，1=任一阶段失败（可作发布前置钩子）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JS = ['config.js', 'tenant.js', 'retrieval.js', 'pii.js', 'auth.js', 'cards.js', 'mq.js', 'tools.js'];
const TESTS = ['unit.test.mjs', 'phase2.test.mjs', 'acceptance2.test.mjs', 'phase3.test.mjs', 'mq.test.mjs', 'shadow.test.mjs', 'cards.test.mjs', 'userauth.test.mjs', 'tenant.test.mjs'];

const SKIP_CLOUD = process.argv.includes('--skip-cloud');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const stages = [];
let failed = false;

function stage(name, fn) {
  console.log(`\n== [${name}] ==`);
  const t0 = Date.now();
  const s = { stage: name, ok: false, ms: 0, detail: '' };
  try {
    const detail = fn();
    s.ok = true; s.detail = detail || '';
  } catch (e) {
    failed = true; s.detail = (e && e.message) || String(e);
    console.log('  ✗ FAIL:', s.detail);
  }
  s.ms = Date.now() - t0;
  stages.push(s);
  console.log(`  ${s.ok ? '✓ PASS' : '✗ FAIL'} (${s.ms}ms)${s.detail ? '  ' + s.detail.slice(0, 160) : ''}`);
  return s.ok;
}

/** ① vm 沙箱逐脚本加载（复现浏览器全局作用域，抓跨脚本命名冲突） */
function staticLoad() {
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    sessionStorage: { getItem: () => null, setItem: () => {} },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({}) },
    CHAT_MODEL: 'test', showToast: () => {}, document: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => ({}) }) }),
  };
  sandbox.globalThis = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of JS) {
    const code = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  return `${JS.length} 个脚本 vm 加载零冲突`;
}

/** ② 全量单测（子进程，汇总 pass/fail） */
function unitTests() {
  let total = 0, pass = 0, fail = 0;
  for (const t of TESTS) {
    const p = spawnSync(process.execPath, ['--test', path.join(ROOT, 'tests', t)], { encoding: 'utf8', timeout: 120000 });
    const m = (p.stdout || '').match(/# tests (\d+)\n[\s\S]*# pass (\d+)\n# fail (\d+)/);
    if (!m) throw new Error(`${t} 无法解析结果（exit=${p.status}）: ${(p.stderr || p.stdout || '').slice(0, 200)}`);
    total += +m[1]; pass += +m[2]; fail += +m[3];
    if (+m[3] > 0) throw new Error(`${t} 有 ${m[3]} 项失败`);
  }
  return `${TESTS.length} 个测试文件 ${pass}/${total} 全绿`;
}

/** ③ 云库连通冒烟在 stageAsync('cloud-smoke', cloudSmokeAsync) 中执行 */

(async () => {
  console.log('== CI/CD 流水线启动 ==', new Date().toISOString());
  stage('static-load', staticLoad);
  stage('unit-tests', unitTests);
  if (SKIP_CLOUD) {
    console.log('\n== [cloud-smoke] SKIPPED (--skip-cloud) ==');
    stages.push({ stage: 'cloud-smoke', ok: true, ms: 0, detail: 'SKIPPED (--skip-cloud)' });
  } else {
    await stageAsync('cloud-smoke', cloudSmokeAsync);
  }
  if (SKIP_E2E) {
    console.log('\n== [mq-e2e] SKIPPED (--skip-e2e) ==');
    stages.push({ stage: 'mq-e2e', ok: true, ms: 0, detail: 'SKIPPED (--skip-e2e)' });
  } else {
    await stageAsync('mq-e2e', mqE2e);
    await stageAsync('admin-auth-e2e', adminAuthE2e);
    await stageAsync('admin-hardening-e2e', adminHardeningE2e);
    await stageAsync('kb-gate-e2e', kbGateE2e);
    await stageAsync('tenant-e2e', tenantE2e);
  }

  // ⑤ 报告与门禁
  const report = {
    at: new Date().toISOString(),
    result: failed ? 'FAIL' : 'PASS',
    stages,
  };
  const logsDir = path.join(ROOT, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `pipeline-report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\n===== 流水线结果：' + report.result + ' =====');
  stages.forEach((s) => console.log(`  ${s.ok ? '✓' : '✗'} ${s.stage} (${s.ms}ms)`));
  console.log('报告：', file);
  if (!failed) console.log('门禁通过：可执行发布（发布需人工确认后进行）');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('PIPELINE FATAL:', e); process.exit(1); });

// ---- 辅助：异步阶段 ----
async function cloudSmokeAsync() {
  const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
  const cloud = createWorkBuddyCloud({
    endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
  });
  const db = cloud.database;
  const { data: kb, error: e1 } = await db.from('kb_chunks').select('id').eq('status', 'published').limit(500);
  if (e1) throw new Error('kb_chunks 查询失败: ' + e1.message);
  if (!kb || !kb.length) throw new Error('published 知识库为空');
  const mq = await db.rpc('mq_stats', {});
  if (mq.error) throw new Error('mq_stats 不可用: ' + JSON.stringify(mq.error));
  const { error: e3 } = await db.from('svc_orders').select('order_no').limit(1);
  if (e3) throw new Error('svc_orders 查询失败: ' + e3.message);
  return `kb=${kb.length}块, mq topics=${(mq.data || []).length}, 订单表连通`;
}

async function mqE2e() {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'mq-e2e.cjs')], { encoding: 'utf8', timeout: 120000 });
  const m = (p.stdout || '').match(/结果：(\d+) PASS \/ (\d+) FAIL/);
  if (!m) throw new Error('e2e 输出异常: ' + ((p.stderr || p.stdout || '').slice(-300)));
  if (+m[2] > 0) throw new Error(`mq e2e ${m[2]} 项失败（详见上方输出）`);
  return `mq e2e ${m[1]} 项全 PASS`;
}

/** ⑤ 管理端服务端会话 e2e（登录/越权/账号管理全链路，真实库） */
function adminAuthE2e() {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'admin-auth-e2e.cjs')], { encoding: 'utf8', timeout: 120000 });
  const m = (p.stdout || '').match(/结果：(\d+)\/(\d+) PASS/);
  if (!m) throw new Error('admin-auth e2e 输出异常: ' + ((p.stderr || p.stdout || '').slice(-300)));
  if (+m[1] !== +m[2]) throw new Error(`admin-auth e2e ${+m[2] - +m[1]} 项失败（详见上方输出）`);
  return `admin-auth e2e ${m[1]} 项全 PASS`;
}

/** ⑤ 管理端安全强化 e2e（登录防爆破 + 审计表防护，真实库） */
function adminHardeningE2e() {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'admin-hardening-e2e.cjs')], { encoding: 'utf8', timeout: 120000 });
  const m = (p.stdout || '').match(/结果：(\d+)\/(\d+) PASS/);
  if (!m) throw new Error('admin-hardening e2e 输出异常: ' + ((p.stderr || p.stdout || '').slice(-300)));
  if (+m[1] !== +m[2]) throw new Error(`admin-hardening e2e ${+m[2] - +m[1]} 项失败（详见上方输出）`);
  return `admin-hardening e2e ${m[1]} 项全 PASS`;
}

/** ⑤ KB 门禁 e2e（三表写权限收回 + kb_write 函数门禁，真实库） */
function kbGateE2e() {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'kb-gate-e2e.cjs')], { encoding: 'utf8', timeout: 120000 });
  const m = (p.stdout || '').match(/结果：(\d+)\/(\d+) PASS/);
  if (!m) throw new Error('kb-gate e2e 输出异常: ' + ((p.stderr || p.stdout || '').slice(-300)));
  if (+m[1] !== +m[2]) throw new Error(`kb-gate e2e ${+m[2] - +m[1]} 项失败（详见上方输出）`);
  return `kb-gate e2e ${m[1]} 项全 PASS`;
}

/** ⑤ 多租户 e2e（读隔离 + 服务端写门禁，真实库） */
function tenantE2e() {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'tenant-e2e.cjs')], { encoding: 'utf8', timeout: 120000 });
  const m = (p.stdout || '').match(/结果：(\d+)\/(\d+) PASS/);
  if (!m) throw new Error('tenant e2e 输出异常: ' + ((p.stderr || p.stdout || '').slice(-300)));
  if (+m[1] !== +m[2]) throw new Error(`tenant e2e ${+m[2] - +m[1]} 项失败（详见上方输出）`);
  return `tenant e2e ${m[1]} 项全 PASS`;
}

async function stageAsync(name, fn) {
  console.log(`\n== [${name}] ==`);
  const t0 = Date.now();
  const s = { stage: name, ok: false, ms: 0, detail: '' };
  try {
    s.detail = (await fn()) || '';
    s.ok = true;
  } catch (e) {
    failed = true; s.detail = (e && e.message) || String(e);
  }
  s.ms = Date.now() - t0;
  stages.push(s);
  console.log(`  ${s.ok ? '✓ PASS' : '✗ FAIL'} (${s.ms}ms)${s.detail ? '  ' + s.detail.slice(0, 160) : ''}`);
  return s.ok;
}
