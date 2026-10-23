// 诊断脚本：LLM 通道 + 知识库加载 链路自检
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});

(async () => {
  // 1. 知识库加载
  try {
    const { data, error } = await cloud.database.from('kb_chunks').select('id,title').eq('status','published').limit(500);
    console.log('[1] KB chunks:', error ? 'ERROR ' + error.code + ' ' + error.message : (data || []).length);
  } catch (e) {
    console.log('[1] KB chunks: EXCEPTION', e.message || e);
  }

  // 2. LLM 非流式
  try {
    const r = await cloud.llm.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '回复"OK"两个字母即可' }],
      stream: false,
      temperature: 0,
    });
    console.log('[2] LLM non-stream OK:', JSON.stringify(r.choices?.[0]?.message?.content || r).slice(0, 200));
  } catch (e) {
    console.log('[2] LLM non-stream FAIL:', JSON.stringify(e.error || e.message || e).slice(0, 400));
  }

  // 3. LLM 流式
  try {
    let out = '';
    for await (const ch of cloud.llm.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '回复"OK"' }],
      stream: true,
      temperature: 0,
    })) {
      const d = ch.choices?.[0]?.delta?.content;
      if (d) out += d;
    }
    console.log('[3] LLM stream OK:', out.slice(0, 100));
  } catch (e) {
    console.log('[3] LLM stream FAIL:', JSON.stringify(e.error || e.message || e).slice(0, 400));
  }
})();
