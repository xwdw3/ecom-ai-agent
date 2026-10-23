-- ============================================================
-- 多租户覆盖补全
-- 现状：tenant_id 仅覆盖 6 张表且代码从未使用（纯摆设）
-- 本轮：
-- 1) 17 张租户级业务表补 tenant_id（NOT NULL DEFAULT 'T001'，存量数据自动归入 T001）
--    平台级表不适用：svc_admin_sessions/svc_audit_logs/svc_login_locks/mq_tasks；
--    个人级表不适用：user_chat_history（owner_id 隔离）
-- 2) svc_admin_users 绑定租户：管理员/运营账号属于某租户，KB 写操作按会话租户隔离
-- 3) kb_session_role 返回租户；kb_write 全链路按租户过滤（跨租户条目一律"不存在"）
-- 4) admin_login 返回租户（前端会话缓存，管理端查询用）
-- 语句须逐条执行
-- ============================================================

-- [1] 业务表补列（17 张）
ALTER TABLE kb_versions ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE svc_products ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE svc_users ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE svc_orders ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE svc_logistics ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE svc_refunds ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE aftersales_tickets ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE coupon_grants ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE route_decisions ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE analytics_daily ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE collect_tasks ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE activity_reminders ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE tool_audit_logs ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE alert_channels ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';
ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';

-- [2] 管理员账号绑定租户
ALTER TABLE svc_admin_users ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'T001';

-- [3] kb_session_role：返回 {username, role, tenant}（租户取自账号）
CREATE OR REPLACE FUNCTION kb_session_role(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 64 THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('username', u.username, 'role', u.role, 'tenant', u.tenant_id) INTO v
    FROM svc_admin_sessions s JOIN svc_admin_users u ON u.username = s.username
    WHERE s.token_hash = encode(sha256(p_token::bytea), 'hex')
      AND s.expires_at > now() AND u.enabled
    LIMIT 1;
  RETURN v;
END $$;

-- [4] kb_sync_chunks：带租户写入分块
CREATE OR REPLACE FUNCTION kb_sync_chunks(p_entry_id bigint, p_chunks jsonb, p_tenant text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c jsonb; v_err text;
BEGIN
  v_err := kb_validate_chunks(p_chunks);
  IF v_err IS NOT NULL THEN RETURN v_err; END IF;
  DELETE FROM kb_chunks WHERE entry_id = p_entry_id;
  FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
    INSERT INTO kb_chunks (entry_id, chunk_index, title, content, category, tags, status, tenant_id)
      VALUES (p_entry_id, COALESCE((c->>'chunk_index')::int, 0),
              left(COALESCE(c->>'title',''), 200), c->>'content',
              left(COALESCE(c->>'category','faq'), 40),
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(c->'tags')), ARRAY[]::text[]),
              'published', COALESCE(p_tenant, 'T001'));
  END LOOP;
  RETURN NULL;
END $$;

-- [5] kb_snapshot：快照带租户
CREATE OR REPLACE FUNCTION kb_snapshot(p_entry_id bigint, p_title text, p_content text,
  p_tags jsonb, p_category text, p_editor text, p_action text, p_note text, p_tenant text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO kb_versions (entry_id, version_no, title, content, tags, category, editor, action, note, tenant_id)
    VALUES (p_entry_id,
            COALESCE((SELECT max(version_no) FROM kb_versions WHERE entry_id = p_entry_id), 0) + 1,
            left(p_title, 200), p_content, p_tags, left(p_category, 40), p_editor, p_action, p_note,
            COALESCE(p_tenant, 'T001'));
END $$;

-- [6] kb_write：全链路按会话租户隔离（跨租户条目一律"不存在"；写入自动归属本租户）
CREATE OR REPLACE FUNCTION kb_write(p_token text, p_action text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sess jsonb; v_actor text; v_role text; v_tenant text;
  v_id bigint;
  v_e kb_entries%ROWTYPE;
  v_ver kb_versions%ROWTYPE;
  v_payload jsonb;
  v_title text; v_content text; v_cat text; v_tags jsonb; v_src text;
  v_note text; v_vno int; v_approved boolean; v_err text;
BEGIN
  v_sess := kb_session_role(p_token);
  v_actor := v_sess->>'username';
  v_role := v_sess->>'role';
  v_tenant := COALESCE(v_sess->>'tenant', 'T001');
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  p_args := COALESCE(p_args, '{}'::jsonb);

  IF p_action IN ('save_draft','edit_draft','submit','offline','rollback','delete') THEN
    IF v_role NOT IN ('admin','ops') THEN
      RETURN jsonb_build_object('ok', false, 'error', '当前角色无编辑权限');
    END IF;
  ELSIF p_action IN ('review','republish','import','import_update') THEN
    IF v_role <> 'admin' THEN
      RETURN jsonb_build_object('ok', false, 'error', '当前角色无审批/发布权限');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', '未知操作');
  END IF;

  v_payload := p_args->'payload';
  IF v_payload IS NOT NULL THEN
    v_title := left(btrim(COALESCE(v_payload->>'title','')), 200);
    v_content := COALESCE(v_payload->>'content','');
    v_cat := left(COALESCE(nullif(btrim(COALESCE(v_payload->>'category','')),''), 'faq'), 40);
    v_tags := v_payload->'tags';
    IF jsonb_typeof(v_tags) IS DISTINCT FROM 'array' THEN v_tags := '[]'::jsonb; END IF;
    v_src := left(COALESCE(v_payload->>'source','admin'), 40);
    IF v_title = '' OR btrim(v_content) = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', '标题和内容不能为空');
    END IF;
    IF length(v_content) > 50000 THEN
      RETURN jsonb_build_object('ok', false, 'error', '内容过长（上限 5 万字符）');
    END IF;
  END IF;
  v_note := left(COALESCE(p_args->>'note',''), 200);

  CASE p_action
    WHEN 'save_draft' THEN
      INSERT INTO kb_entries (category, title, content, tags, status, source, updated_at, tenant_id)
        VALUES (v_cat, v_title, v_content, ARRAY(SELECT jsonb_array_elements_text(v_tags)),
                'draft', v_src, now(), v_tenant)
        RETURNING id INTO v_id;
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'edit',
        COALESCE(nullif(v_note,''), '新建草稿'), v_tenant);

    WHEN 'edit_draft' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      UPDATE kb_entries SET category = v_cat, title = v_title, content = v_content,
        tags = ARRAY(SELECT jsonb_array_elements_text(v_tags)), status = 'draft', updated_at = now()
        WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'edit',
        COALESCE(nullif(v_note,''), '编辑产生新草稿'), v_tenant);

    WHEN 'submit' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'draft' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → pending');
      END IF;
      UPDATE kb_entries SET status = 'pending', updated_at = now() WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'submit', COALESCE(nullif(v_note,''), '提交审核'), v_tenant);

    WHEN 'review' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'error', '该条目不在待审核状态');
      END IF;
      v_approved := COALESCE((p_args->>'approved')::boolean, false);
      IF v_approved THEN
        v_err := kb_sync_chunks(v_id, p_args->'chunks', v_tenant);
        IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
        UPDATE kb_entries SET status = 'published', updated_at = now() WHERE id = v_id;
        PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
          v_actor, 'publish', COALESCE(nullif(v_note,''), '审批通过发布'), v_tenant);
      ELSE
        UPDATE kb_entries SET status = 'draft', updated_at = now() WHERE id = v_id;
        PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
          v_actor, 'reject', COALESCE(nullif(v_note,''), '驳回'), v_tenant);
      END IF;

    WHEN 'offline' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'published' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → offline');
      END IF;
      UPDATE kb_entries SET status = 'offline', updated_at = now() WHERE id = v_id;
      DELETE FROM kb_chunks WHERE entry_id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'offline', COALESCE(nullif(v_note,''), '下架'), v_tenant);

    WHEN 'republish' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'offline' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → published');
      END IF;
      v_err := kb_sync_chunks(v_id, p_args->'chunks', v_tenant);
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
      UPDATE kb_entries SET status = 'published', updated_at = now() WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'publish', COALESCE(nullif(v_note,''), '重新上架'), v_tenant);

    WHEN 'rollback' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      v_vno := (p_args->>'version_no')::int;
      SELECT * INTO v_ver FROM kb_versions WHERE entry_id = v_id AND version_no = v_vno;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '版本不存在'); END IF;
      UPDATE kb_entries SET category = COALESCE(v_ver.category, v_e.category),
        title = v_ver.title, content = v_ver.content,
        tags = COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_ver.tags, '[]'::jsonb))), ARRAY[]::text[]),
        status = 'draft', updated_at = now()
        WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_ver.title, v_ver.content, COALESCE(v_ver.tags, '[]'::jsonb),
        COALESCE(v_ver.category, v_e.category), v_actor, 'rollback', '回滚到 v' || v_vno, v_tenant);

    WHEN 'delete' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      DELETE FROM kb_chunks WHERE entry_id = v_id;
      DELETE FROM kb_versions WHERE entry_id = v_id;
      DELETE FROM kb_entries WHERE id = v_id;
      PERFORM admin_audit(v_actor, 'kb_delete', v_id::text,
        jsonb_build_object('title', v_e.title, 'status', v_e.status));
      RETURN jsonb_build_object('ok', true);

    WHEN 'import' THEN
      IF v_payload IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', '缺少 payload'); END IF;
      v_err := kb_validate_chunks(p_args->'chunks');
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
      INSERT INTO kb_entries (category, title, content, tags, status, source, updated_at, tenant_id)
        VALUES (v_cat, v_title, v_content, ARRAY(SELECT jsonb_array_elements_text(v_tags)),
                'published', COALESCE(nullif(v_src,'admin'), 'import'), now(), v_tenant)
        RETURNING id INTO v_id;
      PERFORM kb_sync_chunks(v_id, p_args->'chunks', v_tenant);
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'import',
        COALESCE(nullif(v_note,''), '批量导入'), v_tenant);

    WHEN 'import_update' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      v_err := kb_validate_chunks(p_args->'chunks');
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
      UPDATE kb_entries SET category = v_cat, title = v_title, content = v_content,
        tags = ARRAY(SELECT jsonb_array_elements_text(v_tags)), status = 'published',
        source = COALESCE(nullif(v_src,'admin'), 'import'), updated_at = now()
        WHERE id = v_id;
      PERFORM kb_sync_chunks(v_id, p_args->'chunks', v_tenant);
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'import',
        COALESCE(nullif(v_note,''), '批量导入更新'), v_tenant);
  END CASE;

  SELECT * INTO v_e FROM kb_entries WHERE id = v_id;
  PERFORM admin_audit(v_actor, 'kb_' || p_action, v_id::text,
    jsonb_build_object('title', v_e.title, 'status', v_e.status));
  RETURN jsonb_build_object('ok', true, 'entry', to_jsonb(v_e));
END $$;

-- [7] admin_login：返回租户（前端管理端查询过滤用）
CREATE OR REPLACE FUNCTION admin_login(p_username text, p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user svc_admin_users%ROWTYPE;
  v_token text;
  v_exp timestamptz;
  v_locked_until timestamptz;
  v_fail_msg text := '用户名或密码错误';
BEGIN
  IF p_username IS NULL OR p_password IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_fail_msg);
  END IF;

  SELECT locked_until INTO v_locked_until
    FROM svc_login_locks WHERE username = p_username LIMIT 1;
  IF v_locked_until IS NOT NULL AND v_locked_until <= now() THEN
    DELETE FROM svc_login_locks WHERE username = p_username;
    v_locked_until := NULL;
  END IF;
  IF v_locked_until IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', '失败次数过多，账号已临时锁定，请稍后再试');
  END IF;

  SELECT * INTO v_user FROM svc_admin_users WHERE username = p_username LIMIT 1;
  IF NOT FOUND OR NOT v_user.enabled OR v_user.role NOT IN ('admin','ops','agent','readonly') THEN
    PERFORM admin_login_fail(p_username);
    PERFORM admin_audit(p_username, 'login_fail', p_username,
      jsonb_build_object('why', 'no_such_user_or_disabled'));
    RETURN jsonb_build_object('ok', false, 'reason', v_fail_msg);
  END IF;
  IF encode(sha256((v_user.salt || p_password)::bytea), 'hex') <> v_user.pass_hash THEN
    PERFORM admin_login_fail(p_username);
    PERFORM admin_audit(p_username, 'login_fail', p_username, jsonb_build_object('why', 'bad_password'));
    RETURN jsonb_build_object('ok', false, 'reason', v_fail_msg);
  END IF;

  DELETE FROM svc_login_locks WHERE username = p_username;
  DELETE FROM svc_admin_sessions WHERE expires_at < now();
  DELETE FROM svc_admin_sessions WHERE username = p_username;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + interval '8 hours';
  INSERT INTO svc_admin_sessions (token_hash, username, role, expires_at)
    VALUES (encode(sha256(v_token::bytea), 'hex'), v_user.username, v_user.role, v_exp);
  PERFORM admin_audit(p_username, 'login_ok', p_username,
    jsonb_build_object('role', v_user.role, 'tenant', v_user.tenant_id));
  RETURN jsonb_build_object('ok', true, 'role', v_user.role, 'token', v_token,
    'tenant', v_user.tenant_id,
    'exp', (extract(epoch FROM v_exp) * 1000)::bigint);
END $$;
