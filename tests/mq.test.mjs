/**
 * 真实 MQ 单元测试（tests/mq.test.mjs）
 * 用内存版 pgmq 式状态机模拟 db.rpc（与云库 SQL 函数同语义），验证：
 * 原子抢占互斥 / 僵尸ack防护 / 重试退避 / 死信 / 重驱动 / 超时回收 / 延迟投递 / 客户端消费循环 / consumeCollectQueue 链路
 * 运行：node --test tests/mq.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

const testsDir = path.dirname(url.fileURLToPath(import.meta.url));
const base = path.join(testsDir, '..');
const req = (p) => import(url.pathToFileURL(p)).then((m) => m.default ?? m);

const { MQClient } = await req(path.join(base, 'js', 'mq.js'));
const tools = await req(path.join(base, 'js', 'tools.js'));

// ---------- 内存版 MQ（与云库 SQL 函数同语义） ----------
function makeMqDb(initial) {
  const rows = initial || [];
  let seq = 1000;
  const now = () => new Date();
  function backoff(attempts) { return Math.min(Math.pow(2, attempts), 300) * 1000; }

  async function rpc(fn, a) {
    if (fn === 'mq_enqueue') {
      const m = {
        id: ++seq, topic: a.p_topic, payload: a.p_payload, trace_id: a.p_trace_id || null,
        status: 'pending', attempts: 0, max_attempts: a.p_max_attempts || 5,
        next_retry_at: new Date(now().getTime() + (a.p_delay_seconds || 0) * 1000).toISOString(),
        visibility_deadline: null, claimed_by: null, result: null, last_error: null,
        created_at: now().toISOString(),
      };
      rows.push(m);
      return { data: [m], error: null };
    }
    if (fn === 'mq_claim') {
      const limit = a.p_limit || 20;
      const vis = (a.p_visibility_seconds || 300) * 1000;
      const candidates = rows.filter((m) => m.status === 'pending'
        && new Date(m.next_retry_at) <= now()
        && (!a.p_topics || a.p_topics.includes(m.topic)))
        .sort((x, y) => new Date(x.next_retry_at) - new Date(y.next_retry_at))
        .slice(0, limit);
      const claimed = candidates.map((m) => Object.assign(m, {
        status: 'processing', claimed_by: a.p_consumer || 'worker',
        attempts: m.attempts + 1,
        visibility_deadline: new Date(now().getTime() + vis).toISOString(),
      }));
      return { data: claimed.map((m) => ({ ...m })), error: null };
    }
    if (fn === 'mq_ack') {
      let n = 0;
      rows.forEach((m) => {
        if (a.p_ids.includes(m.id) && m.status === 'processing' && m.claimed_by === (a.p_consumer || 'worker')) {
          m.status = 'consumed'; m.result = a.p_result || 'acked'; m.claimed_by = null; m.visibility_deadline = null; n++;
        }
      });
      return { data: n, error: null };
    }
    if (fn === 'mq_nack') {
      let n = 0;
      rows.forEach((m) => {
        if (a.p_ids.includes(m.id) && m.status === 'processing' && m.claimed_by === (a.p_consumer || 'worker')) {
          m.claimed_by = null; m.visibility_deadline = null; m.last_error = a.p_error || 'nack'; n++;
          if (m.attempts >= m.max_attempts) { m.status = 'dead'; }
          else {
            m.status = 'pending';
            const delay = a.p_retry_delay_seconds == null ? backoff(m.attempts) : a.p_retry_delay_seconds * 1000;
            m.next_retry_at = new Date(now().getTime() + delay).toISOString();
          }
        }
      });
      return { data: n, error: null };
    }
    if (fn === 'mq_reclaim_expired') {
      let n = 0;
      rows.forEach((m) => {
        if (m.status === 'processing' && m.visibility_deadline && new Date(m.visibility_deadline) < now()) {
          m.claimed_by = null; m.visibility_deadline = null; m.last_error = 'visibility timeout reclaimed'; n++;
          if (m.attempts >= m.max_attempts) m.status = 'dead';
          else { m.status = 'pending'; m.next_retry_at = now().toISOString(); }
        }
      });
      return { data: n, error: null };
    }
    if (fn === 'mq_requeue_dead') {
      let n = 0;
      rows.forEach((m) => {
        if (m.status === 'dead' && (!a.p_ids || a.p_ids.includes(m.id))) {
          m.status = 'pending'; m.attempts = 0; m.next_retry_at = now().toISOString();
          m.last_error = 'redrive from DLQ'; m.claimed_by = null; n++;
        }
      });
      return { data: n, error: null };
    }
    if (fn === 'mq_stats') {
      const topics = [...new Set(rows.map((m) => m.topic))];
      const out = topics.map((t) => {
        const rs = rows.filter((m) => m.topic === t);
        return {
          topic: t,
          pending: rs.filter((m) => m.status === 'pending').length,
          processing: rs.filter((m) => m.status === 'processing').length,
          consumed: rs.filter((m) => m.status === 'consumed').length,
          dead: rs.filter((m) => m.status === 'dead').length,
        };
      });
      return { data: out, error: null };
    }
    throw new Error('未知 rpc: ' + fn);
  }
  return { rpc, _rows: rows };
}

// ---------- MQClient 基础语义 ----------
test('mq: send→claim→ack 正常消费路径', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'w1' });
  const msg = await mq.send('order.paid', { order_no: 'SO1' }, { traceId: 'T1' });
  assert.equal(msg.status, 'pending');
  const claimed = await mq.claim(['order.paid'], 10, 60);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].claimed_by, 'w1');
  assert.equal(claimed[0].attempts, 1);
  const n = await mq.ack([claimed[0].id], 'ok');
  assert.equal(n, 1);
  const stats = await mq.stats();
  assert.equal(stats[0].consumed, 1);
});

test('mq: 并发抢占互斥——同一消息不会被两个消费者抢到', async () => {
  const db = makeMqDb();
  const mqA = new MQClient(db, { consumer: 'w-a' });
  const mqB = new MQClient(db, { consumer: 'w-b' });
  await mqA.send('t', { k: 1 });
  await mqA.send('t', { k: 2 });
  const a = await mqA.claim(['t'], 10, 60);
  const b = await mqB.claim(['t'], 10, 60);
  assert.equal(a.length + b.length, 2, '两条消息各归一个消费者');
  const ids = [...a.map((m) => m.id), ...b.map((m) => m.id)];
  assert.equal(new Set(ids).size, 2, '无重复抢占');
});

test('mq: 僵尸ack防护——错误消费者无法确认', async () => {
  const db = makeMqDb();
  const mqA = new MQClient(db, { consumer: 'w-a' });
  const mqB = new MQClient(db, { consumer: 'w-b' });
  await mqA.send('t', { k: 1 });
  const [m] = await mqA.claim(['t'], 10, 60);
  assert.equal(await mqB.ack([m.id], 'hack'), 0, '非抢占者ack无效');
  assert.equal(await mqA.ack([m.id], 'ok'), 1);
});

test('mq: nack 重试退避，超限进死信，重驱动复活', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'w1' });
  await mq.send('t', { k: 1 }, { maxAttempts: 2 });
  const [m1] = await mq.claim(['t'], 10, 60);
  await mq.nack([m1.id], 'boom1'); // attempts=1 < 2 → pending 退避
  let row = db._rows.find((r) => r.id === m1.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error, 'boom1');
  assert.ok(new Date(row.next_retry_at) > new Date(), '退避后延后投递');
  // 强制到期再抢→再失败→死信
  row.next_retry_at = new Date(Date.now() - 1000).toISOString();
  const [m2] = await mq.claim(['t'], 10, 60);
  await mq.nack([m2.id], 'boom2'); // attempts=2 >= 2 → dead
  row = db._rows.find((r) => r.id === m1.id);
  assert.equal(row.status, 'dead');
  // 重驱动
  assert.equal(await mq.requeueDead([m1.id]), 1);
  row = db._rows.find((r) => r.id === m1.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, '重驱动重置尝试次数');
});

test('mq: 可见性超时回收（消费者崩溃恢复，at-least-once）', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'crashed' });
  await mq.send('t', { k: 1 }, { maxAttempts: 5 });
  const [m] = await mq.claim(['t'], 10, 1); // 1秒可见性
  db._rows.find((r) => r.id === m.id).visibility_deadline = new Date(Date.now() - 1000).toISOString(); // 模拟时间流逝
  const n = await mq.reclaimExpired();
  assert.equal(n, 1);
  const row = db._rows.find((r) => r.id === m.id);
  assert.equal(row.status, 'pending', '超时消息回到队列');
  assert.equal(row.claimed_by, null);
});

test('mq: 延迟投递——未到期消息不可抢占', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'w1' });
  await mq.send('t', { k: 1 }, { delaySeconds: 3600 });
  const got = await mq.claim(['t'], 10, 60);
  assert.equal(got.length, 0, '延迟消息不可见');
  assert.equal(await mq.stats().then((s) => s[0].pending), 1);
});

// ---------- MQClient 消费循环 ----------
test('mq: consumeOnce 按topic分发 handler，成功ack/失败nack', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'w1' });
  const seen = [];
  mq.on('ok.topic', async (m) => { seen.push(m.payload.v); });
  mq.on('bad.topic', async () => { throw new Error('handler炸了'); });
  await mq.send('ok.topic', { v: 'a' });
  await mq.send('bad.topic', { v: 'b' });
  const out = await mq.consumeOnce();
  assert.equal(out.claimed, 2);
  assert.deepEqual(seen, ['a']);
  assert.equal(out.acked, 1);
  assert.equal(out.retried, 1);
  const bad = db._rows.find((r) => r.topic === 'bad.topic');
  assert.equal(bad.status, 'pending', '失败回队列待重试');
  assert.equal(bad.last_error, 'handler炸了');
});

test('mq: consumeOnce 无handler的消息nack不阻塞', async () => {
  const db = makeMqDb();
  const mq = new MQClient(db, { consumer: 'w1' });
  await mq.send('nobody.topic', { v: 1 });
  const out = await mq.consumeOnce();
  assert.equal(out.retried, 1);
  assert.equal(out.acked, 0);
  assert.ok(db._rows[0].last_error.includes('无 topic 处理器'));
});

// ---------- tools.js consumeCollectQueue 链路（claim→频控复核→发送→ack/nack） ----------
test('mq: consumeCollectQueue 发送成功ack、频控跳过ack、发送失败nack重试', async () => {
  const db = makeMqDb();
  // 伪造 cloud：database.rpc 走内存 MQ；ServiceGateway 用独立 mock adapter
  const cloud = { database: db };
  const sent = [];
  const mockAdapter = {
    async call(service, action, payload) {
      if (service === 'mq') {
        // 复用内存 MQ rpc（与 tools.js adapter 的 rpc 动作同构）
        if (action === 'enqueue') return (await db.rpc('mq_enqueue', {
          p_topic: payload.topic, p_payload: payload.payload,
          p_delay_seconds: payload.delay_seconds || 0, p_trace_id: payload.trace_id || null,
          p_max_attempts: payload.max_attempts || 5,
        })).data[0];
        if (action === 'claim') return (await db.rpc('mq_claim', {
          p_topics: payload.topics, p_limit: payload.limit || 20,
          p_visibility_seconds: payload.visibility_seconds || 300, p_consumer: payload.consumer || 'console',
        })).data;
        if (action === 'ack') return (await db.rpc('mq_ack', {
          p_ids: payload.ids, p_consumer: payload.consumer || 'console', p_result: payload.result || null,
        })).data;
        if (action === 'nack') return (await db.rpc('mq_nack', {
          p_ids: payload.ids, p_consumer: payload.consumer || 'console',
          p_error: payload.error || null, p_retry_delay_seconds: payload.retry_delay_seconds ?? null,
        })).data;
      }
      if (service === 'marketing') {
        if (action === 'listCollectByOrder') return payload.order_no === 'SO-BLOCK'
          ? [{ id: 1, tier: 'T1-轻触达', created_at: new Date().toISOString() },
             { id: 2, tier: 'T1-轻触达', created_at: new Date().toISOString() },
             { id: 3, tier: 'T1-轻触达', created_at: new Date().toISOString() }] : [];
        if (action === 'sendReminder') {
          if (payload.order_no === 'SO-FAIL') throw new Error('下游挂了');
          sent.push(payload.order_no);
          return { id: 'C' + sent.length };
        }
        if (action === 'reissueCoupon') return { ok: true };
      }
      throw new Error('未知 ' + service + '.' + action);
    },
  };
  tools.ServiceGateway.adapters['cloud-db'] = mockAdapter;
  tools.ServiceGateway.adapter = mockAdapter;

  await tools.enqueueCollectTask({ order_no: 'SO-OK', user_id: 'U1', tier: 'T1-轻触达' }, 'T1');
  await tools.enqueueCollectTask({ order_no: 'SO-BLOCK', user_id: 'U2', tier: 'T1-轻触达' }, 'T2');
  await tools.enqueueCollectTask({ order_no: 'SO-FAIL', user_id: 'U3', tier: 'T1-轻触达' }, 'T3');

  const results = await tools.consumeCollectQueue(cloud, 10);
  assert.equal(results.length, 3);
  const byOrder = {};
  results.forEach((r, i) => { byOrder['SO-' + ['OK', 'BLOCK', 'FAIL'][i]] = r; });
  assert.deepEqual(sent, ['SO-OK'], '只发送了未命中频控且下游正常的消息');
  assert.ok(byOrder['SO-OK'].sent);
  assert.ok(byOrder['SO-BLOCK'].skipped, '频控跳过');
  assert.ok(byOrder['SO-FAIL'].retry, '失败转重试');
  const rows = db._rows;
  assert.equal(rows.find((r) => r.trace_id === 'T1').status, 'consumed');
  assert.ok(rows.find((r) => r.trace_id === 'T2').result.startsWith('skipped:'), '跳过原因落库');
  assert.equal(rows.find((r) => r.trace_id === 'T3').status, 'pending', '失败消息回队列');
});
