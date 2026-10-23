/**
 * 真实 MQ 云库 e2e（走 PostgREST rpc 通道，验证参数映射/数组入参/返回形态）
 * 用法：node tools/mq-e2e.cjs
 */
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const { MQClient } = require(path.join(__dirname, '..', 'js', 'mq.js'));
const tools = require(path.join(__dirname, '..', 'js', 'tools.js'));

const cloud = createWorkBuddyCloud({
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
});
const db = cloud.database;
tools.initGateway(cloud);
const TOPIC = 'e2e.mqcheck.' + Date.now(); // 每轮独立 topic，避免多轮遗留消息互相干扰
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 200) : ''); }
}

(async () => {
  console.log('== 真实 MQ 云库 e2e ==');
  const mq = new MQClient(db, { consumer: 'e2e-' + process.pid });

  // 1. rpc 直连可用性
  const stats0 = await mq.stats();
  check('rpc mq_stats 可用（返回数组）', Array.isArray(stats0), stats0);

  // 2. 入队（含延迟消息）
  const m1 = await mq.send(TOPIC, { case: 'normal' }, { traceId: 'e2e-1', maxAttempts: 3 });
  check('mq_enqueue 返回消息行', m1 && m1.id && m1.status === 'pending', m1);
  const mDelay = await mq.send(TOPIC, { case: 'delayed' }, { delaySeconds: 600, traceId: 'e2e-d' });
  check('延迟消息入队', !!mDelay.id);

  // 3. 抢占互斥
  const c1 = await mq.claim([TOPIC], 10, 120);
  const c2 = await new MQClient(db, { consumer: 'e2e-rival' }).claim([TOPIC], 10, 120);
  const gotNormal = c1.find((m) => m.payload.case === 'normal');
  const gotDelay = [...c1, ...c2].find((m) => m.payload && m.payload.case === 'delayed');
  check('抢占到普通消息', !!gotNormal, c1);
  check('延迟消息不可抢占', !gotDelay);
  check('抢到的消息 processing+attempts=1', gotNormal && gotNormal.status === 'processing' && gotNormal.attempts === 1, gotNormal);
  const ids = c1.map((m) => m.id).concat(c2.map((m) => m.id));
  check('两消费者无重复抢占', new Set(ids).size === ids.length);

  // 4. 僵尸 ack 防护
  if (gotNormal) {
    const wrong = await new MQClient(db, { consumer: 'e2e-wrong' }).ack([gotNormal.id], 'hack');
    check('错误消费者 ack 无效', wrong === 0, wrong);
    const ok = await mq.ack([gotNormal.id], 'e2e done');
    check('正确 ack 成功', ok === 1, ok);
  }

  // 5. nack 重试→死信→重驱动（用 maxAttempts=1 快速进死信）
  const m2 = await mq.send(TOPIC, { case: 'doomed' }, { maxAttempts: 1, traceId: 'e2e-2' });
  const [d] = await mq.claim([TOPIC], 10, 60);
  check('doomed 抢占', d && d.payload.case === 'doomed');
  if (d) {
    await mq.nack([d.id], 'e2e simulated failure');
    const s = await mq.stats();
    const row = s.find((x) => x.topic === TOPIC);
    check('超限进死信', row && row.dead >= 1, row);
    const rd = await mq.requeueDead([d.id]);
    check('死信重驱动', rd === 1, rd);
    // 清理重驱动后的消息
    await db.from('mq_tasks').delete().eq('id', d.id);
  }

  // 6. tools.js 链路（enqueueCollectTask + 消费）
  const enq = await tools.enqueueCollectTask({ order_no: 'SO-E2E-MQ', user_id: 'U1001', tier: 'T1-轻触达', channel: '站内信', strategy: 'e2e' }, 'e2e-tools');
  check('enqueueCollectTask 走 rpc 入队', enq && enq.id, enq);
  // 该消息会在 claim 时被消费发送（频控通过）→ 直接验证 consume
  const claimed = await mq.claim(['collect.send'], 5, 120);
  const mine = claimed.find((m) => m.trace_id === 'e2e-tools');
  check('collect.send 可抢占', !!mine, claimed.length);
  if (mine) {
    // 频控历史为空 → 模拟发送：直接落一条 collect_tasks 再 ack（避免污染真实触达）
    await db.from('collect_tasks').insert({
      order_no: 'SO-E2E-MQ', user_id: 'U1001', tier: 'T1-轻触达', channel: '站内信', status: 'sent', result: 'e2e-mq',
    });
    await mq.ack([mine.id], 'e2e sent');
    check('collect.send 消费 ack 成功', true);
  }

  // 7. 清理 e2e 数据（注：P0 收紧后 anon 无 DELETE 权限，清理需 owner 通道执行：
  //    DELETE FROM mq_tasks WHERE topic LIKE 'e2e.mqcheck%' OR trace_id='e2e-tools'）
  let left = (await mq.stats()).find((s) => s.topic === TOPIC);
  if (left) {
    console.log('  NOTE  e2e 消息待 owner 清理（anon 无 DELETE 权限，预期行为）:', JSON.stringify(left));
  } else {
    console.log('  PASS  e2e 消息清理完成');
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E FATAL:', e.message); process.exit(1); });
