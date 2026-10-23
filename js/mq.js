/**
 * MQClient —— 真实消息队列客户端（云库 pgmq 式实现）
 * 能力：原子抢占（FOR UPDATE SKIP LOCKED）/ 可见性超时 / 指数退避重试 / 死信队列 / 重驱动 / 延迟投递 / 统计
 * 传输层：云库 SQL 函数（mq_enqueue/mq_claim/mq_ack/mq_nack/mq_reclaim_expired/mq_requeue_dead/mq_stats）经 db.rpc() 调用
 * 投递语义：at-least-once（消费者崩溃后可见性到期自动回收重投），handler 需幂等
 * 可插拔：生产切换 RocketMQ/AMQP 只需替换 transport（构造时传入 opts.transport），上层零改动
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    visibilitySeconds: 300, // 抢占后处理时限，超时自动回收
    batchSize: 20,          // 单次抢占条数
    maxAttempts: 5,         // 最大投递次数，超过进死信
    pollMs: 5000,           // 消费轮询间隔
    consumer: 'worker',     // 消费者标识（ack/nack 只对本消费者抢占的消息生效）
  };

  function MQClient(db, opts) {
    if (!db || typeof db.rpc !== 'function') throw new Error('MQClient 需要支持 rpc 的 db 客户端');
    this.db = db;
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.transport = this.opts.transport || defaultTransport;
    this.handlers = {};
    this.running = false;
    this._timer = null;
  }

  // 默认传输：云库 SQL 函数（SECURITY DEFINER，绕过 anon 直写限制，逻辑收口在数据库层）
  function defaultTransport(fn, args) {
    return this.db.rpc(fn, args);
  }

  // 注册 topic 处理器
  MQClient.prototype.on = function (topic, handler) {
    this.handlers[topic] = handler;
    return this;
  };

  /** 发送消息（delaySeconds>0 为延迟投递） */
  MQClient.prototype.send = async function (topic, payload, o) {
    o = o || {};
    var r = await this.transport('mq_enqueue', {
      p_topic: topic,
      p_payload: payload,
      p_delay_seconds: o.delaySeconds || 0,
      p_trace_id: o.traceId || null,
      p_max_attempts: o.maxAttempts || this.opts.maxAttempts,
    });
    if (r.error) throw new Error('MQ入队失败: ' + (r.error.message || JSON.stringify(r.error)));
    var d = r.data;
    return Array.isArray(d) ? d[0] : d;
  };

  /** 原子抢占一批消息（多消费者并发互斥，单条消息只会被一个消费者抢到） */
  MQClient.prototype.claim = async function (topics, limit, visibilitySeconds) {
    var r = await this.transport('mq_claim', {
      p_topics: topics && topics.length ? topics : null,
      p_limit: limit || this.opts.batchSize,
      p_visibility_seconds: visibilitySeconds || this.opts.visibilitySeconds,
      p_consumer: this.opts.consumer,
    });
    if (r.error) throw new Error('MQ抢占失败: ' + (r.error.message || JSON.stringify(r.error)));
    if (Array.isArray(r.data)) return r.data;
    return r.data ? [r.data] : [];
  };

  /** 确认消费成功（仅本消费者抢占且仍在处理中的消息生效） */
  MQClient.prototype.ack = async function (ids, result) {
    var r = await this.transport('mq_ack', {
      p_ids: ids, p_consumer: this.opts.consumer,
      p_result: result === undefined ? null : String(result),
    });
    if (r.error) throw new Error('MQ ack失败: ' + (r.error.message || JSON.stringify(r.error)));
    return r.data;
  };

  /** 消费失败：未超限→退避重试；超限→死信 */
  MQClient.prototype.nack = async function (ids, err, retryDelaySeconds) {
    var r = await this.transport('mq_nack', {
      p_ids: ids, p_consumer: this.opts.consumer,
      p_error: err === undefined ? null : String(err),
      p_retry_delay_seconds: retryDelaySeconds === undefined ? null : retryDelaySeconds,
    });
    if (r.error) throw new Error('MQ nack失败: ' + (r.error.message || JSON.stringify(r.error)));
    return r.data;
  };

  /** 回收超时消息（消费者崩溃恢复），返回回收条数 */
  MQClient.prototype.reclaimExpired = async function () {
    var r = await this.transport('mq_reclaim_expired', {});
    if (r.error) throw new Error('MQ回收失败: ' + (r.error.message || JSON.stringify(r.error)));
    return r.data;
  };

  /** 死信重驱动（ids 为空重驱动全部） */
  MQClient.prototype.requeueDead = async function (ids) {
    var r = await this.transport('mq_requeue_dead', { p_ids: ids && ids.length ? ids : null });
    if (r.error) throw new Error('MQ重驱动失败: ' + (r.error.message || JSON.stringify(r.error)));
    return r.data;
  };

  /** 队列统计（按 topic：pending/processing/consumed/dead/积压时长） */
  MQClient.prototype.stats = async function () {
    var r = await this.transport('mq_stats', {});
    if (r.error) throw new Error('MQ统计失败: ' + (r.error.message || JSON.stringify(r.error)));
    return r.data || [];
  };

  /**
   * 消费一轮：抢占 → 按 topic 分发 handler → ack/nack
   * @returns {claimed, acked, retried, dead} 本轮结果
   */
  MQClient.prototype.consumeOnce = async function (topics) {
    var msgs = await this.claim(topics);
    var out = { claimed: msgs.length, acked: 0, retried: 0, dead: 0, errors: [] };
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var handler = this.handlers[m.topic];
      if (!handler) {
        await this.nack([m.id], '无 topic 处理器: ' + m.topic);
        out.retried++;
        continue;
      }
      try {
        await handler(m, this);
        await this.ack([m.id]);
        out.acked++;
      } catch (e) {
        await this.nack([m.id], (e && e.message) || String(e));
        if (m.attempts + 1 >= (m.max_attempts || this.opts.maxAttempts)) out.dead++;
        else out.retried++;
        out.errors.push({ id: m.id, error: (e && e.message) || String(e) });
      }
    }
    return out;
  };

  /** 启动后台消费循环（返回 stop 函数式句柄：client.stop()） */
  MQClient.prototype.start = function (topics) {
    var self = this;
    if (this.running) return;
    this.running = true;
    (async function loop() {
      while (self.running) {
        try { await self.consumeOnce(topics); } catch (e) { /* 轮询失败不打断循环 */ }
        await new Promise(function (res) { self._timer = setTimeout(res, self.opts.pollMs); });
      }
    })();
  };

  MQClient.prototype.stop = function () {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
  };

  global.MQClient = MQClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MQClient: MQClient };
})(typeof window !== 'undefined' ? window : globalThis);
