// 模拟浏览器脚本加载顺序，验证 tools.js 是否能干净加载并跑通退款查询
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const sandbox = {
  console,
  setTimeout, clearTimeout,
  TextEncoder, TextDecoder,
  crypto: globalThis.crypto,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  cloud: createWorkBuddyCloud({
    endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
  }),
  CHAT_MODEL: 'deepseek-v4-flash',
  sessionStorage: { getItem: () => null, setItem: () => {} },
  WorkBuddyCloud: { createWorkBuddyCloud },
  showToast: () => {},
  window: null, // 稍后指向 sandbox 自身，模拟浏览器 window === globalThis
  document: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => ({}) }), apply: () => ({}) }),
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox; // 浏览器中 window 即全局对象
vm.createContext(sandbox);

const base = path.join(__dirname, '..', 'js');
const files = ['config.js', 'retrieval.js', 'pii.js', 'auth.js', 'cards.js', 'mq.js', 'userauth.js', 'tools.js'];
for (const f of files) {
  const code = fs.readFileSync(path.join(base, f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f });
    console.log('LOAD OK :', f);
  } catch (e) {
    console.log('LOAD FAIL:', f, '=>', e.message);
  }
}

(async () => {
  // 浏览器等价调用：issueToken（auth.js 顶层 function 声明 → vm 全局）
  try {
    const token = await vm.runInContext('issueToken(AGENT_ACCOUNT)', sandbox);
    sandbox.AGENT_TOKEN = token;
    const r = await vm.runInContext(`
      (async () => {
        initGateway(cloud);
        const plan = rulePlan('订单SO20261018005退款到哪一步了？', { orderNo: 'SO20261018005', userId: 'U1001' });
        if (!plan) return 'plan null';
        return await executeTool(plan, { token: AGENT_TOKEN, traceId: 'vm-diag-1' });
      })()
    `, sandbox);
    console.log('TOOL RESULT:', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.log('RUNTIME FAIL:', e.message);
  }
})();
