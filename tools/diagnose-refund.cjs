// 复现浏览器工具链路：rulePlan → executeTool（退款进度查询）
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, 'node_modules', 'x.js'));
const { createWorkBuddyCloud } = req('@tencent-ai/workbuddy-cloud-sdk');

globalThis.cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
globalThis.CHAT_MODEL = 'deepseek-v4-flash';
globalThis.showToast = () => {};

const tools = req(path.join(__dirname, '..', 'js', 'tools.js'));
const auth = req(path.join(__dirname, '..', 'js', 'auth.js'));
Object.assign(globalThis, { issueToken: auth.issueToken, AGENT_ACCOUNT: auth.AGENT_ACCOUNT });

(async () => {
  tools.initGateway(globalThis.cloud);
  const token = await issueToken(AGENT_ACCOUNT);
  console.log('token ok:', !!token);

  const cases = [
    '订单SO20261018005退款到哪一步了？',
    '退款到哪一步了',
    '我的退款什么时候到账',
    '我要退货',
    '订单SO20261015006退款成功了吗',
  ];
  // LLM 兜底规划测试
  const plannerCases = [
    '退款到哪一步了',
    '我的退款什么时候到账',
    '我要退货',
    '订单SO20261015006退款成功了吗',
    '我的订单怎么还没退款',
  ];
  for (const q of plannerCases) {
    let out = '';
    try {
      for await (const ch of cloud.llm.chat.completions.create({
        model: CHAT_MODEL, stream: true, temperature: 0,
        messages: [{ role: 'user', content: tools.buildPlannerPrompt(q) }],
      })) {
        const d = ch.choices?.[0]?.delta?.content;
        if (d) out += d;
      }
      const plan = tools.parseAgentPlan(out);
      console.log('\nPLANNER Q:', q);
      console.log('  raw:', out.replace(/\s+/g, ' ').slice(0, 160));
      console.log('  plan:', plan ? JSON.stringify(plan) : 'null（无工具→走RAG知识库）');
      if (plan && plan.tool) {
        const r = await tools.executeTool(plan, { token, traceId: 'diag-' + Date.now() });
        console.log('  exec:', JSON.stringify(r).slice(0, 150));
      }
    } catch (e) {
      console.log('\nPLANNER Q:', q, '\n  FAIL:', (e.error && JSON.stringify(e.error)) || e.message);
    }
  }
})();
