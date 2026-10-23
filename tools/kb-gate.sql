-- ============================================================
-- KB 管理写服务端门禁（SECURITY DEFINER）
-- 背景：知识库三表的写操作此前仅靠前端 RBAC（kbflow.js 直连 kb_entries/
--       versions/chunks），而发布页的 anon key 人人可得——可绕过前端直写库
-- 方案：
-- 1) 收回 anon 对三表的全部写权限（authenticated 上轮已收回；SELECT 保留供聊天检索）
-- 2) 新增 kb_write(p_token, p_action, p_args) 单函数分发 10 类写操作：
--    save_draft/edit_draft/submit/offline/rollback/delete → admin+ops（kb.edit）
--    review/republish/import/import_update → 仅 admin（kb.review，编辑者不能自审）
-- 3) 状态机在库内强制（非法迁移拒绝）；行锁 FOR UPDATE 防并发版本号冲突
-- 4) 分块由前端 chunkContent 生成后传入，服务端校验数量(1-300)/单块长度(<=10000)，
--    且"先校验后删除"（校验失败不影响线上已发布分块）
-- 5) 全部操作落 svc_audit_logs（复用 admin_audit），操作者取自会话而非前端传参
-- 语句须逐条执行（exec 工具不支持多语句）
-- ============================================================

-- [1] 收回 anon 写权限（聊天检索所需的 SELECT 保留）
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kb_entries, kb_versions, kb_chunks FROM anon;

-- [1b] authenticated 同样收回（双保险）
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kb_entries, kb_versions, kb_chunks FROM authenticated;

-- [2] 会话 → {username, role}（有效且账号启用才返回，否则 NULL）
CREATE OR REPLACE FUNCTION kb_session_role(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 64 THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('username', u.username, 'role', u.role) INTO v
    FROM svc_admin_sessions s JOIN svc_admin_users u ON u.username = s.username
    WHERE s.token_hash = encode(sha256(p_token::bytea), 'hex')
      AND s.expires_at > now() AND u.enabled
    LIMIT 1;
  RETURN v;
END $$;

-- [3] 分块校验（只读，供写入前与同步前调用；返回错误文本或 NULL=通过）
CREATE OR REPLACE FUNCTION kb_validate_chunks(p_chunks jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c jsonb; n int := 0;
BEGIN
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' THEN
    RETURN '分块数据缺失';
  END IF;
  IF jsonb_array_length(p_chunks) = 0 OR jsonb_array_length(p_chunks) > 300 THEN
    RETURN '分块数量非法（1-300）';
  END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
    n := n + 1;
    IF COALESCE(length(COALESCE(c->>'content','')), 0) = 0 THEN
      RETURN '第 ' || n || ' 块内容为空';
    END IF;
    IF length(c->>'content') > 10000 THEN
      RETURN '第 ' || n || ' 块内容过长（上限 1 万字符）';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- [4] 分块同步：先校验后删除重建（校验失败不动线上已发布分块）
CREATE OR REPLACE FUNCTION kb_sync_chunks(p_entry_id bigint, p_chunks jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c jsonb; v_err text;
BEGIN
  v_err := kb_validate_chunks(p_chunks);
  IF v_err IS NOT NULL THEN RETURN v_err; END IF;
  DELETE FROM kb_chunks WHERE entry_id = p_entry_id;
  FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
    INSERT INTO kb_chunks (entry_id, chunk_index, title, content, category, tags, status)
      VALUES (p_entry_id, COALESCE((c->>'chunk_index')::int, 0),
              left(COALESCE(c->>'title',''), 200), c->>'content',
              left(COALESCE(c->>'category','faq'), 40),
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(c->'tags')), ARRAY[]::text[]),
              'published');
  END LOOP;
  RETURN NULL;
END $$;

-- [5] 版本快照（version_no 取 max+1，调用方持行锁防并发冲突）
CREATE OR REPLACE FUNCTION kb_snapshot(p_entry_id bigint, p_title text, p_content text,
  p_tags jsonb, p_category text, p_editor text, p_action text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO kb_versions (entry_id, version_no, title, content, tags, category, editor, action, note)
    VALUES (p_entry_id,
            COALESCE((SELECT max(version_no) FROM kb_versions WHERE entry_id = p_entry_id), 0) + 1,
            left(p_title, 200), p_content, p_tags, left(p_category, 40), p_editor, p_action, p_note);
END $$;

-- [6] KB 写操作统一入口（10 类动作分发；角色门禁 + 状态机 + 审计）
CREATE OR REPLACE FUNCTION kb_write(p_token text, p_action text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sess jsonb; v_actor text; v_role text;
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
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  p_args := COALESCE(p_args, '{}'::jsonb);

  -- 角色门禁：编辑类 admin/ops；发布类仅 admin（编辑者不能自审）
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

  -- payload 校验（涉及内容的动作共用）
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
      INSERT INTO kb_entries (category, title, content, tags, status, source, updated_at)
        VALUES (v_cat, v_title, v_content, ARRAY(SELECT jsonb_array_elements_text(v_tags)),
                'draft', v_src, now())
        RETURNING id INTO v_id;
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'edit',
        COALESCE(nullif(v_note,''), '新建草稿'));

    WHEN 'edit_draft' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      UPDATE kb_entries SET category = v_cat, title = v_title, content = v_content,
        tags = ARRAY(SELECT jsonb_array_elements_text(v_tags)), status = 'draft', updated_at = now()
        WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'edit',
        COALESCE(nullif(v_note,''), '编辑产生新草稿'));

    WHEN 'submit' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'draft' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → pending');
      END IF;
      UPDATE kb_entries SET status = 'pending', updated_at = now() WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'submit', COALESCE(nullif(v_note,''), '提交审核'));

    WHEN 'review' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'error', '该条目不在待审核状态');
      END IF;
      v_approved := COALESCE((p_args->>'approved')::boolean, false);
      IF v_approved THEN
        v_err := kb_sync_chunks(v_id, p_args->'chunks');
        IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
        UPDATE kb_entries SET status = 'published', updated_at = now() WHERE id = v_id;
        PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
          v_actor, 'publish', COALESCE(nullif(v_note,''), '审批通过发布'));
      ELSE
        UPDATE kb_entries SET status = 'draft', updated_at = now() WHERE id = v_id;
        PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
          v_actor, 'reject', COALESCE(nullif(v_note,''), '驳回'));
      END IF;

    WHEN 'offline' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'published' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → offline');
      END IF;
      UPDATE kb_entries SET status = 'offline', updated_at = now() WHERE id = v_id;
      DELETE FROM kb_chunks WHERE entry_id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'offline', COALESCE(nullif(v_note,''), '下架'));

    WHEN 'republish' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      IF v_e.status <> 'offline' THEN
        RETURN jsonb_build_object('ok', false, 'error', '非法状态迁移 ' || v_e.status || ' → published');
      END IF;
      v_err := kb_sync_chunks(v_id, p_args->'chunks');
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
      UPDATE kb_entries SET status = 'published', updated_at = now() WHERE id = v_id;
      PERFORM kb_snapshot(v_id, v_e.title, v_e.content, to_jsonb(v_e.tags), v_e.category,
        v_actor, 'publish', COALESCE(nullif(v_note,''), '重新上架'));

    WHEN 'rollback' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
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
        COALESCE(v_ver.category, v_e.category), v_actor, 'rollback', '回滚到 v' || v_vno);

    WHEN 'delete' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
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
      INSERT INTO kb_entries (category, title, content, tags, status, source, updated_at)
        VALUES (v_cat, v_title, v_content, ARRAY(SELECT jsonb_array_elements_text(v_tags)),
                'published', COALESCE(nullif(v_src,'admin'), 'import'), now())
        RETURNING id INTO v_id;
      PERFORM kb_sync_chunks(v_id, p_args->'chunks');
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'import',
        COALESCE(nullif(v_note,''), '批量导入'));

    WHEN 'import_update' THEN
      v_id := (p_args->>'entry_id')::bigint;
      SELECT * INTO v_e FROM kb_entries WHERE id = v_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', '条目不存在'); END IF;
      v_err := kb_validate_chunks(p_args->'chunks');
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
      UPDATE kb_entries SET category = v_cat, title = v_title, content = v_content,
        tags = ARRAY(SELECT jsonb_array_elements_text(v_tags)), status = 'published',
        source = COALESCE(nullif(v_src,'admin'), 'import'), updated_at = now()
        WHERE id = v_id;
      PERFORM kb_sync_chunks(v_id, p_args->'chunks');
      PERFORM kb_snapshot(v_id, v_title, v_content, v_tags, v_cat, v_actor, 'import',
        COALESCE(nullif(v_note,''), '批量导入更新'));
  END CASE;

  -- 统一审计 + 返回最新条目
  SELECT * INTO v_e FROM kb_entries WHERE id = v_id;
  PERFORM admin_audit(v_actor, 'kb_' || p_action, v_id::text,
    jsonb_build_object('title', v_e.title, 'status', v_e.status));
  RETURN jsonb_build_object('ok', true, 'entry', to_jsonb(v_e));
END $$;

-- [7] 执行权限（助手函数仅内部调用，不对外授权）
GRANT EXECUTE ON FUNCTION kb_write(text,text,jsonb) TO anon, authenticated;
