/**
 * 影子评测执行器：真实流量回放 对比 基线 vs 候选变体
 * 数据：chat_messages 中 role='user' 的线上真实问题（只读，不写线上会话）
 * 用法：
 *   node tools/shadow-eval.cjs                                   # 基线 vs 默认候选（ragTopK=6）
 *   node tools/shadow-eval.cjs --n 20                            # 采样条数
 *   node tools/shadow-eval.cjs --variant '{"ragTopK":8}'         # 自定义候选变体
 *   node tools/shadow-eval.cjs --variant '{"llmPlan":false}' --no-llm   # 结构评测（不调生成模型）
 * 输出：logs/shadow-eval-<ts>.json + 控制台对比摘要；结果落云库 shadow_eval_runs
 */
const fs = require('fs');
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const shadow = require(path.join(__dirname, '..', 'js', 'shadow.js'));
const retrieval = require(path.join(__dirname, '..', 'js', 'retrieval.js'));
const tools = require(path.join(__dirname, '..', 'js', 'tools.js'));
const auth = require(path.join(__dirname, '..', 'js', 'auth.js'));

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
const db = cloud.database;
const CHAT_MODEL = 'deepseek-v4-flash';

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);
const N = parseInt(argVal('--n', '30'), 10);
const NO_LLM = has('--no-llm');
const BASELINE_OPTS = { ragTopK: 4, llmPlan: true, llmAnswer: !NO_LLM };
let CANDIDATE_OPTS;
try {
  CANDIDATE_OPTS = Object.assign({ ragTopK: 4, llmPlan: true, llmAnswer: !NO_LLM }, JSON.parse(argVal('--variant', '{"ragTopK":6}')));
} catch (e) { console.error('--variant JSON 解析失败:', e.message); process.exit(1); }

async function runOne(tag, items, deps, opts) {
  const out = [];
  for (const it of items) {
    const r = await shadow.runShadowCase(it, deps, opts);
    out.push(r);
    console.log(`  [${tag}] ${r.route}/${r.source || '-'}${r.isFallback ? '/兜底' : ''} ${r.latencyMs}ms  ${it.question.slice(0, 30)}${r.error ? '  ⚠' + r.error : ''}`);
  }
  return out;
}

async function saveToDb(runId, variantName, results) {
  let ok = 0;
  for (const r of results) {
    try {
      const { error } = await db.from('shadow_eval_runs').insert({
        run_id: runId, variant: variantName, question: r.question.slice(0, 200),
        route: r.route, source: r.source || '', latency_ms: r.latencyMs || 0,
        is_fallback: !!r.isFallback, answer_preview: (r.answerPreview || '').slice(0, 200),
      });
      if (!error) ok++;
    } catch (_) { /* 逐条容错 */ }
  }
  return ok;
}

(async () => {
  console.log('== 影子评测（真实流量回放）==', new Date().toISOString());
  console.log('变体：baseline', JSON.stringify(BASELINE_OPTS), 'vs candidate', JSON.stringify(CANDIDATE_OPTS), NO_LLM ? '（结构评测，不调生成模型）' : '');

  // 1. 采样真实流量 + 加载知识库 + 服务账号 token
  const { data: msgs } = await db.from('chat_messages').select('content,role,session_id,created_at').eq('role', 'user').order('created_at', { ascending: false }).limit(500);
  const items = shadow.sampleQuestions(msgs || [], N);
  console.log(`采样 ${items.length} 条真实问题（chat_messages 共 ${(msgs || []).length} 条候选）`);
  if (!items.length) { console.log('无真实流量可回放（可先在对话页产生一些提问）；退出'); process.exit(0); }
  const { data: kb } = await db.from('kb_chunks').select('*').eq('status', 'published').limit(500);
  tools.initGateway(cloud);
  const token = await auth.issueToken(auth.AGENT_ACCOUNT);
  const deps = { cloud, tools, retrieval, kbChunks: kb || [], token, model: CHAT_MODEL };

  // 2. 两轮影子回放
  const runId = 'SE' + Date.now();
  console.log('\n--- 基线 baseline ---');
  const baseline = await runOne('BASE', items, deps, BASELINE_OPTS);
  console.log('\n--- 候选 candidate ---');
  const candidate = await runOne('CAND', items, deps, CANDIDATE_OPTS);

  // 3. 对比与报告
  const report = shadow.compareRuns(baseline, candidate);
  console.log('\n===== 指标对比 =====');
  console.log('基线  :', JSON.stringify(report.baseline));
  console.log('候选  :', JSON.stringify(report.candidate));
  console.log('指标差:', JSON.stringify(report.metrics));
  console.log('逐题差异:', report.diffs.length, '处');
  report.diffs.slice(0, 10).forEach((d) => console.log('  -', JSON.stringify(d).slice(0, 220)));

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `shadow-eval-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify({
    runId, at: new Date().toISOString(), no_llm: NO_LLM,
    baseline_opts: BASELINE_OPTS, candidate_opts: CANDIDATE_OPTS,
    sample: items.map((x) => x.question),
    report, baseline, candidate,
  }, null, 2));
  console.log('\n报告已写入', file);

  // 4. 落云库 shadow_eval_runs（供看板/趋势回溯）
  try {
    const ok1 = await saveToDb(runId, 'baseline', baseline);
    const ok2 = await saveToDb(runId, JSON.stringify(CANDIDATE_OPTS), candidate);
    console.log(`影子结果落库 shadow_eval_runs：${ok1 + ok2}/${baseline.length + candidate.length}（run_id=${runId}）`);
  } catch (e) {
    console.log('落库失败（不影响本地报告）:', e.message);
  }
})().catch((e) => { console.error('SHADOW FATAL:', e.message); process.exit(1); });
