/**
 * MQ 独立消费进程（真实 MQ 消费者，生产形态）
 * 持续循环：回收超时消息 → 原子抢占 → 频控复核 → 发送 → ack/nack（失败退避重试，超限死信）
 * 投递语义：at-least-once（进程崩溃后可见性到期自动回收重投）
 * 用法：
 *   node tools/mq-worker.cjs            # 常驻消费（每3s轮询）
 *   node tools/mq-worker.cjs --once     # 消费一轮后退出（供定时任务调用）
 *   node tools/mq-worker.cjs --drain    # 消费直到队列清空后退出
 */
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const tools = require(path.join(__dirname, '..', 'js', 'tools.js'));

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
tools.initGateway(cloud);

const ONCE = process.argv.includes('--once');
const DRAIN = process.argv.includes('--drain');
const POLL_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queueDepth() {
  const stats = await tools.ServiceGateway.call('mq', 'stats', {});
  const row = (stats || []).find((s) => s.topic === 'collect.send');
  return { pending: (row && row.pending) || 0, dead: (row && row.dead) || 0 };
}

async function runRound() {
  // 1. 回收崩溃消费者遗留的超时消息（at-least-once 关键）
  let reclaimed = 0;
  try { reclaimed = (await tools.ServiceGateway.call('mq', 'reclaimExpired', {})) || 0; }
  catch (e) { console.warn('回收超时消息失败(忽略):', e.message); }
  // 2. 抢占并消费一批
  const results = await tools.consumeCollectQueue(cloud, 20);
  const sent = results.filter((r) => r.sent).length;
  const skipped = results.filter((r) => r.skipped).length;
  const retried = results.filter((r) => r.retry).length;
  console.log(`[mq-worker] 回收${reclaimed} 消费${results.length}（发送${sent} 跳过${skipped} 转重试${retried}）`);
  return results.length;
}

(async () => {
  console.log('== MQ 消费进程启动 ==', new Date().toISOString(), ONCE ? '(once)' : DRAIN ? '(drain)' : '(常驻)');
  if (ONCE) {
    await runRound();
    const d = await queueDepth();
    console.log(`[mq-worker] 剩余：待发${d.pending} 死信${d.dead}`);
    return;
  }
  if (DRAIN) {
    while (true) {
      const n = await runRound();
      const d = await queueDepth();
      if (n === 0 && d.pending === 0) { console.log('[mq-worker] 队列已清空，退出'); break; }
      await sleep(POLL_MS);
    }
    return;
  }
  // 常驻模式
  let tick = 0;
  while (true) {
    try { await runRound(); } catch (e) { console.error('[mq-worker] 轮次失败(继续):', e.message); }
    if (++tick % 60 === 0) {
      const d = await queueDepth();
      console.log(`[mq-worker] 心跳：待发${d.pending} 死信${d.dead}`);
    }
    await sleep(POLL_MS);
  }
})();
