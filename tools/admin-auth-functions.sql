-- ============================================================
-- 管理端服务端会话体系（SECURITY DEFINER）
-- 背景：
-- 1) P0 收紧后 svc_admin_users 对 anon 仅 SELECT，账号管理写操作 42501
-- 2) anon 可 SELECT 整表（盐+哈希离线爆破风险）；登录校验仅在前端
-- 3) 用户侧接入云登录后出现 authenticated 角色（聊天登录用户），
--    而该角色对 svc_admin_users / kb_* 有全量写权限——越权暴露
-- 方案：登录/账号管理收口到函数，函数内校验凭据与 admin 角色；
--      会话 token 落 svc_admin_sessions（仅存 sha256(token)）；
--      全部直连表权限收回。
-- ============================================================

-- [1] 会话表权限锁死（仅函数访问）
REVOKE ALL PRIVILEGES ON TABLE svc_admin_sessions FROM anon;

-- [2] 管理员表：收回 authenticated 全部权限（聊天登录用户不得触碰）
REVOKE ALL PRIVILEGES ON TABLE svc_admin_users FROM authenticated;

-- [3] 知识库三表：收回 authenticated 写权限（管理走 anon 门禁页；聊天用户只读）
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kb_entries FROM authenticated;

-- [3b] kb_versions
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kb_versions FROM authenticated;
-- [3c] kb_chunks
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kb_chunks FROM authenticated;

-- [4] 会话表：收回 authenticated 全部权限
REVOKE ALL PRIVILEGES ON TABLE svc_admin_sessions FROM authenticated;

-- [5] 管理员表：收回 anon SELECT（登录改走函数，直连读不再需要）
REVOKE SELECT ON TABLE svc_admin_users FROM anon;

-- [6] 登录：校验凭据，签发服务端会话（返回 token 一次，库中仅存哈希）
CREATE OR REPLACE FUNCTION admin_login(p_username text, p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user svc_admin_users%ROWTYPE;
  v_token text;
  v_exp timestamptz;
BEGIN
  SELECT * INTO v_user FROM svc_admin_users WHERE username = p_username LIMIT 1;
  IF NOT FOUND OR NOT v_user.enabled OR v_user.role NOT IN ('admin','ops','agent','readonly') THEN
    RETURN jsonb_build_object('ok', false, 'reason', '用户名或密码错误');
  END IF;
  IF encode(sha256((v_user.salt || p_password)::bytea), 'hex') <> v_user.pass_hash THEN
    RETURN jsonb_build_object('ok', false, 'reason', '用户名或密码错误');
  END IF;
  DELETE FROM svc_admin_sessions WHERE expires_at < now();
  DELETE FROM svc_admin_sessions WHERE username = p_username;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + interval '8 hours';
  INSERT INTO svc_admin_sessions (token_hash, username, role, expires_at)
    VALUES (encode(sha256(v_token::bytea), 'hex'), v_user.username, v_user.role, v_exp);
  RETURN jsonb_build_object('ok', true, 'role', v_user.role, 'token', v_token,
    'exp', (extract(epoch FROM v_exp) * 1000)::bigint);
END $$;

-- [6] 会话校验助手：token 有效且其账号仍是启用中的 admin
CREATE OR REPLACE FUNCTION admin_session_check(p_token text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_username text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 64 THEN RETURN false; END IF;
  SELECT role, username INTO v_role, v_username FROM svc_admin_sessions
    WHERE token_hash = encode(sha256(p_token::bytea), 'hex') AND expires_at > now() LIMIT 1;
  IF v_role IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM svc_admin_users u
    WHERE u.username = v_username AND u.enabled AND u.role = 'admin'
  );
END $$;

-- [7] 账号列表（安全列，不含 salt/pass_hash）
CREATE OR REPLACE FUNCTION admin_user_list(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT admin_session_check(p_token) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  RETURN jsonb_build_object('ok', true, 'users', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', u.id, 'username', u.username, 'role', u.role,
      'enabled', u.enabled, 'created_at', u.created_at) ORDER BY u.id), '[]'::jsonb)
    FROM svc_admin_users u
  ));
END $$;

-- [8] 新建账号
CREATE OR REPLACE FUNCTION admin_user_create(p_token text, p_username text, p_password text, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_salt text; v_exists boolean;
BEGIN
  IF NOT admin_session_check(p_token) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  IF p_username IS NULL OR length(trim(p_username)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', '用户名至少 2 位');
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', '密码至少 8 位');
  END IF;
  IF p_role NOT IN ('admin','ops','agent','readonly') THEN
    RETURN jsonb_build_object('ok', false, 'error', '角色无效');
  END IF;
  SELECT EXISTS(SELECT 1 FROM svc_admin_users WHERE username = trim(p_username)) INTO v_exists;
  IF v_exists THEN
    RETURN jsonb_build_object('ok', false, 'error', '用户名已存在');
  END IF;
  v_salt := encode(gen_random_bytes(16), 'hex');
  INSERT INTO svc_admin_users (username, salt, pass_hash, role, enabled)
    VALUES (trim(p_username), v_salt, encode(sha256((v_salt || p_password)::bytea), 'hex'), p_role, true);
  RETURN jsonb_build_object('ok', true, 'username', trim(p_username), 'role', p_role);
END $$;

-- [9] 重置密码
CREATE OR REPLACE FUNCTION admin_user_resetpwd(p_token text, p_username text, p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_salt text; v_n int;
BEGIN
  IF NOT admin_session_check(p_token) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', '密码至少 8 位');
  END IF;
  v_salt := encode(gen_random_bytes(16), 'hex');
  UPDATE svc_admin_users SET salt = v_salt,
    pass_hash = encode(sha256((v_salt || p_password)::bytea), 'hex')
    WHERE username = p_username;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'error', '账号不存在'); END IF;
  DELETE FROM svc_admin_sessions WHERE username = p_username; -- 重置后踢下线
  RETURN jsonb_build_object('ok', true);
END $$;

-- [10] 启用/禁用（保护最后一个启用中的管理员）
CREATE OR REPLACE FUNCTION admin_user_toggle(p_token text, p_username text, p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_enabled boolean; v_active_admins int;
BEGIN
  IF NOT admin_session_check(p_token) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  SELECT role, enabled INTO v_role, v_enabled FROM svc_admin_users WHERE username = p_username LIMIT 1;
  IF v_role IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', '账号不存在'); END IF;
  IF v_role = 'admin' AND v_enabled AND NOT p_enabled THEN
    SELECT count(*) INTO v_active_admins FROM svc_admin_users WHERE role = 'admin' AND enabled;
    IF v_active_admins <= 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', '至少保留 1 个启用中的管理员');
    END IF;
  END IF;
  UPDATE svc_admin_users SET enabled = p_enabled WHERE username = p_username;
  IF NOT p_enabled THEN
    DELETE FROM svc_admin_sessions WHERE username = p_username; -- 禁用即踢下线
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- [11] 删除账号（保护最后一个启用中的管理员）
CREATE OR REPLACE FUNCTION admin_user_delete(p_token text, p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_enabled boolean; v_active_admins int;
BEGIN
  IF NOT admin_session_check(p_token) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限或会话已过期');
  END IF;
  SELECT role, enabled INTO v_role, v_enabled FROM svc_admin_users WHERE username = p_username LIMIT 1;
  IF v_role IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', '账号不存在'); END IF;
  IF v_role = 'admin' AND v_enabled THEN
    SELECT count(*) INTO v_active_admins FROM svc_admin_users WHERE role = 'admin' AND enabled;
    IF v_active_admins <= 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', '至少保留 1 个启用中的管理员');
    END IF;
  END IF;
  DELETE FROM svc_admin_sessions WHERE username = p_username;
  DELETE FROM svc_admin_users WHERE username = p_username;
  RETURN jsonb_build_object('ok', true);
END $$;

-- [12] 执行权限
GRANT EXECUTE ON FUNCTION admin_login(text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_session_check(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_list(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_create(text,text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_resetpwd(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_toggle(text,text,boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_delete(text,text) TO anon, authenticated;
