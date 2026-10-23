/**
 * 影子评测单测（tests/shadow.test.mjs）
 * 覆盖：流量采样去重 / 寒暄判定 / 三级路由影子执行（mock deps）/ 指标汇总 / 基线vs候选对比
 * 运行：node --test tests/shadow.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

const testsDir = path.dirname(url.fileURLToPath(import.meta.url));
const base = path.join(testsDir, '..');
const req = (p) => import(url.pathToFileURL(p)).then((m) => m.default ?? m);

const shadow = await req(path.join(base, 'js', 'shadow.js'));

test('shadow: sampleQuestions 去重、倒序采样、上限生效', () => {
  const msgs = [
    { role: 'user', content: '怎么退货', created_at: '2026-10-23T01:00:00Z' },
    { role: 'user', content: '怎么退货', created_at: '2026-10-23T02:00:00Z' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '发什么快递', created_at: '2026-10-23T03:00:00Z' },
    { role: 'user', content: '你好', created_at: '2026-10-23T04:00:00Z' },
    { role: 'user', content: '', created_at: '2026-10-23T05:00:00Z' },
  ];
  const out = shadow.sampleQuestions(msgs, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].question, '你好'); // 倒序取最新
  assert.ok(!out.some((x) => x.question === '怎么退货'), '超出上限的旧消息不采');
  const all = shadow.sampleQuestions(msgs);
  assert.equal(all.length, 3, '去重后3条独立问题');
});

test('shadow: matchSmalltalk 与 chat.js 口径一致', () => {
  assert.ok(shadow.matchSmalltalk('你好'));
  assert.ok(shadow.matchSmalltalk('在吗'));
  assert.ok(shadow.matchSmalltalk('谢谢啦'));
  assert.ok(shadow.matchSmalltalk('你是谁？'));
  assert.ok(!shadow.matchSmalltalk('你好，我想退货')); // 复合句不算寒暄
  assert.ok(!shadow.matchSmalltalk('退款到哪了'));
});

// ---- mock deps：工具链与检索 ----
function makeDeps() {
  const calls = [];
  return {
    calls,
    tools: {
      riskRoute: (q) => (q.includes('投诉') ? { route: 'human', reason: '高风险' } : { route: 'agent' }),
      extractOrderNo: (q) => (q.match(/SO\d+/) || [])[0] || null,
      rulePlan: (q, ctx) => (ctx.orderNo && q.includes('退款') ? { tool: 'query_refund', args: { order_no: ctx.orderNo } } : null),
      buildPlannerPrompt: (q) => 'PLAN:' + q,
      parseAgentPlan: (out) => (out.includes('query_refund') ? { tool: 'query_refund', args: {} } : null),
      executeTool: async (plan, x) => {
        calls.push(plan.tool);
        return plan.args && plan.args.order_no ? { order_no: plan.args.order_no, status: 'returning' } : null;
      },
    },
    retrieval: {
      retrieve: async (q, chunks, topK) => ({
        refs: /材质|运费|快递/.test(q) ? [{ title: '售后知识', score: 0.9, content: '纯棉/运费/快递说明' }] : [],
      }),
    },
    kbChunks: [{ title: '白T恤材质' }],
    token: 'T',
    cloud: {
      llm: { chat: { completions: {
        create: async function* (body) {
          const sys = body.messages[0].content;
          const q = body.messages[body.messages.length - 1].content;
          if (body.messages[0].role === 'user' && String(body.messages[0].content).startsWith('PLAN:')) {
            yield { choices: [{ delta: { content: 'PLAN:query_refund' } }] };
          } else if (q.includes('运费')) {
            yield { choices: [{ delta: { content: '退货运费由商家承担。' } }] };
          } else {
            yield { choices: [{ delta: { content: '抱歉，这个问题暂时' + shadow.FALLBACK_MARK + '，您可以点击下方「转人工客服」，我会为您登记并尽快由人工跟进。' } }] };
          }
        },
      } } },
    },
    model: 'test',
  };
}

test('shadow: runShadowCase 三级路由——寒暄/转人工/工具命中', async () => {
  const deps = makeDeps();
  let r = await shadow.runShadowCase({ question: '你好' }, deps, { llmAnswer: false });
  assert.equal(r.route, 'smalltalk');
  r = await shadow.runShadowCase({ question: '假货我要投诉！' }, deps, {});
  assert.equal(r.route, 'human');
  r = await shadow.runShadowCase({ question: '订单SO123的退款到哪了' }, deps, { llmPlan: false });
  assert.equal(r.route, 'tool');
  assert.equal(r.source, 'query_refund');
  assert.ok(!r.isFallback);
});

test('shadow: runShadowCase RAG 命中与兜底（llmAnswer=false 结构评测）', async () => {
  const deps = makeDeps();
  const r1 = await shadow.runShadowCase({ question: '白T恤什么材质' }, deps, { llmAnswer: false, llmPlan: false });
  assert.equal(r1.route, 'rag');
  assert.equal(r1.isFallback, false);
  assert.equal(r1.refsCount, 1);
  const r2 = await shadow.runShadowCase({ question: '明天天气如何' }, deps, { llmAnswer: false, llmPlan: false });
  assert.equal(r2.isFallback, true, '零命中判兜底');
  assert.equal(r2.source, 'rag-empty');
});

test('shadow: runShadowCase LLM 规划兜底与拒答判定', async () => {
  const deps = makeDeps();
  // 规则规划不中（无单号）→ LLM 规划返回 query_refund（mock args 无单号 → executeTool 返回 null → 降级 RAG）
  const r = await shadow.runShadowCase({ question: '退款到哪一步了' }, deps, { llmPlan: true, llmAnswer: true });
  assert.notEqual(r.route, 'tool', '工具空结果降级RAG');
  // RAG 命中但模型拒答（mock 对非'运费'问题回复兜底话术）
  const r2 = await shadow.runShadowCase({ question: '白T恤什么材质' }, deps, { llmPlan: false, llmAnswer: true });
  assert.equal(r2.isFallback, true, '拒答话术判兜底');
  // 正常生成
  const r3 = await shadow.runShadowCase({ question: '退货运费谁出' }, deps, { llmPlan: false, llmAnswer: true });
  assert.equal(r3.isFallback, false);
  assert.ok(r3.answerPreview.includes('商家承担'));
});

test('shadow: summarizeRun 指标口径', async () => {
  const deps = makeDeps();
  const items = [{ question: '你好' }, { question: '假货投诉' }, { question: '订单SO1的退款到哪了' }, { question: '明天天气如何' }];
  const results = [];
  for (const it of items) results.push(await shadow.runShadowCase(it, deps, { llmAnswer: false, llmPlan: false }));
  const s = shadow.summarizeRun(results);
  assert.equal(s.total, 4);
  assert.equal(s.byRoute.smalltalk, 1);
  assert.equal(s.byRoute.human, 1);
  assert.equal(s.byRoute.tool, 1);
  assert.equal(s.fallbackRate, 0.25);
  assert.equal(s.humanRate, 0.25);
  assert.ok(typeof s.avgLatencyMs === 'number');
});

test('shadow: compareRuns 找出路由差异', async () => {
  const deps = makeDeps();
  const items = [{ question: '订单SO1的退款到哪了' }, { question: '白T恤什么材质' }];
  // 基线：关 LLM 规划；候选：开 LLM 规划（mock 下 executeTool 无单号返回 null，路由不变但 source 变化可测）
  const base = [];
  for (const it of items) base.push(await shadow.runShadowCase(it, deps, { llmAnswer: false, llmPlan: false, ragTopK: 4 }));
  // 构造一个检索变体：候选 topK 不同不影响 mock，改为直接对比不同结果集验证 diff 逻辑
  const cand = base.map((r) => (r.question === '白T恤什么材质'
    ? { ...r, route: 'human', source: 'risk-route', isFallback: false }
    : { ...r }));
  const cmp = shadow.compareRuns(base, cand);
  assert.equal(cmp.diffs.length, 1);
  assert.equal(cmp.diffs[0].type, 'changed');
  assert.equal(cmp.diffs[0].candidate.route, 'human');
  assert.ok(cmp.metrics.fallbackRate.delta !== undefined);
});
