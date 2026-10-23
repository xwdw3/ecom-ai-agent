-- 真实 MQ 数据层（pgmq 式）：原子抢占 / 可见性超时 / 重试退避 / 死信 / 重驱动 / 统计
-- 逐条执行（exec-pgsql 不支持多语句）

-- [1] 入队：支持延迟投递（delay_seconds>0 时 next_retry_at 后移，claim 不可见）
CREATE OR REPLACE FUNCTION mq_enqueue(
  p_topic text,
  p_payload jsonb,
  p_delay_seconds int DEFAULT 0,
  p_trace_id text DEFAULT NULL,
  p_max_attempts int DEFAULT 5
)
RETURNS mq_tasks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO mq_tasks (topic, payload, trace_id, max_attempts, status, next_retry_at)
  VALUES (p_topic, p_payload, p_trace_id, p_max_attempts, 'pending',
          now() + make_interval(secs => GREATEST(COALESCE(p_delay_seconds,0), 0)))
  RETURNING *;
$$;

-- [2] 原子抢占：FOR UPDATE SKIP LOCKED，多消费者并发互斥，每个消息只被一个消费者抢到
CREATE OR REPLACE FUNCTION mq_claim(
  p_topics text[] DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_visibility_seconds int DEFAULT 300,
  p_consumer text DEFAULT 'worker'
)
RETURNS SETOF mq_tasks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT id FROM mq_tasks
    WHERE status = 'pending'
      AND next_retry_at <= now()
      AND (p_topics IS NULL OR topic = ANY(p_topics))
    ORDER BY next_retry_at, id
    LIMIT GREATEST(COALESCE(p_limit,20), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE mq_tasks t SET
    status = 'processing',
    claimed_by = COALESCE(p_consumer,'worker'),
    claimed_at = now(),
    attempts = attempts + 1,
    visibility_deadline = now() + make_interval(secs => GREATEST(COALESCE(p_visibility_seconds,300),1))
  WHERE t.id IN (SELECT id FROM candidates)
  RETURNING t.*;
$$;

-- [3] 确认消费：仅本人抢占且仍在 processing 的消息可 ack（防僵尸确认）
CREATE OR REPLACE FUNCTION mq_ack(
  p_ids bigint[],
  p_consumer text,
  p_result text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  UPDATE mq_tasks SET
    status = 'consumed',
    consumed_at = now(),
    result = COALESCE(p_result, 'acked'),
    claimed_by = NULL,
    visibility_deadline = NULL
  WHERE id = ANY(p_ids) AND status='processing' AND claimed_by = COALESCE(p_consumer,'worker');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- [4] 消费失败：未超限→按退避策略回 pending；超限→进死信
CREATE OR REPLACE FUNCTION mq_nack(
  p_ids bigint[],
  p_consumer text,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds int DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  UPDATE mq_tasks SET
    status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
    next_retry_at = CASE WHEN attempts >= max_attempts THEN next_retry_at
                         ELSE now() + make_interval(secs => COALESCE(p_retry_delay_seconds,
                              LEAST(2 ^ attempts, 300))) END,
    last_error = LEFT(COALESCE(p_error, 'nack'), 500),
    claimed_by = NULL,
    visibility_deadline = NULL
  WHERE id = ANY(p_ids) AND status='processing' AND claimed_by = COALESCE(p_consumer,'worker');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- [5] 回收超时：消费者崩溃/失联后，可见性到期的 processing 消息重新可投（at-least-once）
CREATE OR REPLACE FUNCTION mq_reclaim_expired()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  UPDATE mq_tasks SET
    status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
    next_retry_at = now(),
    last_error = 'visibility timeout reclaimed',
    claimed_by = NULL,
    visibility_deadline = NULL
  WHERE status='processing' AND visibility_deadline IS NOT NULL AND visibility_deadline < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- [6] 死信重驱动：dead 消息重置为 pending 重新消费
CREATE OR REPLACE FUNCTION mq_requeue_dead(p_ids bigint[] DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  UPDATE mq_tasks SET
    status = 'pending',
    attempts = 0,
    next_retry_at = now(),
    last_error = 'redrive from DLQ',
    claimed_by = NULL,
    visibility_deadline = NULL
  WHERE status='dead' AND (p_ids IS NULL OR id = ANY(p_ids));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- [7] 队列统计（供看板/巡检）
CREATE OR REPLACE FUNCTION mq_stats()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) FROM (
    SELECT topic,
      COUNT(*) FILTER (WHERE status='pending') AS pending,
      COUNT(*) FILTER (WHERE status='processing') AS processing,
      COUNT(*) FILTER (WHERE status='consumed') AS consumed,
      COUNT(*) FILTER (WHERE status='dead') AS dead,
      MAX(EXTRACT(EPOCH FROM (now()-created_at))::bigint) FILTER (WHERE status='pending') AS oldest_pending_seconds
    FROM mq_tasks GROUP BY topic ORDER BY topic
  ) s;
$$;

-- [8] 放开运行时执行权限
GRANT EXECUTE ON FUNCTION mq_enqueue(text,jsonb,int,text,int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_claim(text[],int,int,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_ack(bigint[],text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_nack(bigint[],text,text,int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_reclaim_expired() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_requeue_dead(bigint[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mq_stats() TO anon, authenticated;
