-- ============================================================
-- 管理端安全强化：登录防爆破 + usermgmt 审计日志
-- 背景（上次体检遗留 P1/P2）：
-- 1) P1 admin_login 无失败次数限制，可被高频试密码（在线爆破）
-- 2) P2 账号增删改密无审计痕迹，出问题无法追溯操作者
-- 方案：
-- - svc_login_locks：按用户名计失败次数，连续失败 5 次锁定 15 分钟；
--   对不存在的用户名同样计数（防用户枚举）；成功登录清零
-- - svc_audit_logs：create/resetpwd/toggle/delete 落审计（actor=会话归属人，
--   action/target/detail）；登录成功/失败也落审计
-- - 两表对 anon/authenticated 全部 REVOKE，仅 SECURITY DEFINER 函数可达
-- 注意：语句须逐条执行（exec 工具不支持多语句）
-- ============================================================

-- [1] 登录锁定表
CREATE TABLE IF NOT EXISTS svc_login_locks (
  username text PRIMARY KEY,
  failed_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- [2] 审计日志表
CREATE TABLE IF NOT EXISTS svc_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  detail jsonb
);

-- [3] RLS 双保险：两表即使权限误配也无法越权读写
ALTER TABLE svc_login_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE svc_audit_logs ENABLE ROW LEVEL SECURITY;

-- [4] 直连权限全部收回（仅函数访问）
REVOKE ALL PRIVILEGES ON TABLE svc_login_locks FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE svc_audit_logs FROM anon, authenticated;

-- [5] 会话归属人助手：token 有效且账号仍为启用中的 admin 时返回用户名，否则 NULL
CREATE OR REPLACE FUNCTION admin_session_actor(p_token text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_username text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 64 THEN RETURN NULL; END IF;
  SELECT s.username INTO v_username FROM svc_admin_sessions s
    WHERE s.token_hash = encode(sha256(p_token::bytea), 'hex') AND s.expires_at > now() LIMIT 1;
  IF v_username IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM svc_admin_users u
             WHERE u.username = v_username AND u.enabled AND u.role = 'admin') THEN
    RETURN v_username;
  END IF;
  RETURN NULL;
END $$;

-- [6] admin_login 改造：防爆破（失败计数 + 临时锁定）+ 登录事件落审计
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

  -- 锁定检查：无论账号是否存在都按提交的用户名判断（防用户枚举）
  SELECT locked_until INTO v_locked_until
    FROM svc_login_locks WHERE username = p_username LIMIT 1;
  IF v_locked_until IS NOT NULL AND v_locked_until <= now() THEN
    DELETE FROM svc_login_locks WHERE username = p_username; -- 锁定已过期，重新计数
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

  -- 成功：清零失败计数，签发会话
  DELETE FROM svc_login_locks WHERE username = p_username;
  DELETE FROM svc_admin_sessions WHERE expires_at < now();
  DELETE FROM svc_admin_sessions WHERE username = p_username;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp := now() + interval '8 hours';
  INSERT INTO svc_admin_sessions (token_hash, username, role, expires_at)
    VALUES (encode(sha256(v_token::bytea), 'hex'), v_user.username, v_user.role, v_exp);
  PERFORM admin_audit(p_username, 'login_ok', p_username, jsonb_build_object('role', v_user.role));
  RETURN jsonb_build_object('ok', true, 'role', v_user.role, 'token', v_token,
    'exp', (extract(epoch FROM v_exp) * 1000)::bigint);
END $$;

-- [6b] 失败计数原子自增（并发安全），达 5 次锁定 15 分钟
CREATE OR REPLACE FUNCTION admin_login_fail(p_username text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO svc_login_locks (username, failed_count, locked_until, updated_at)
    VALUES (p_username, 1, NULL, now())
    ON CONFLICT (username) DO UPDATE SET
      failed_count = svc_login_locks.failed_count + 1,
      locked_until = CASE WHEN svc_login_locks.failed_count + 1 >= 5
        THEN now() + interval '15 minutes' ELSE svc_login_locks.locked_until END,
      updated_at = now();
END $$;

-- [6c] 审计写入助手
CREATE OR REPLACE FUNCTION admin_audit(p_actor text, p_action text, p_target text, p_detail jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO svc_audit_logs (actor, action, target, detail)
    VALUES (p_actor, p_action, p_target, p_detail);
END $$;

-- [7] 账号列表（不变，仅保留在位；安全列不含 salt/pass_hash）
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

-- [8] 新建账号（+审计）
CREATE OR REPLACE FUNCTION admin_user_create(p_token text, p_username text, p_password text, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_salt text; v_exists boolean; v_actor text;
BEGIN
  v_actor := admin_session_actor(p_token);
  IF v_actor IS NULL THEN
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
  PERFORM admin_audit(v_actor, 'user_create', trim(p_username), jsonb_build_object('role', p_role));
  RETURN jsonb_build_object('ok', true, 'username', trim(p_username), 'role', p_role);
END $$;

-- [9] 重置密码（+审计；不落密码明文/哈希）
CREATE OR REPLACE FUNCTION admin_user_resetpwd(p_token text, p_username text, p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_salt text; v_n int; v_actor text;
BEGIN
  v_actor := admin_session_actor(p_token);
  IF v_actor IS NULL THEN
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
  PERFORM admin_audit(v_actor, 'user_resetpwd', p_username, NULL::jsonb);
  RETURN jsonb_build_object('ok', true);
END $$;

-- [10] 启用/禁用（+审计；保护最后一个启用中的管理员）
CREATE OR REPLACE FUNCTION admin_user_toggle(p_token text, p_username text, p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_enabled boolean; v_active_admins int; v_actor text;
BEGIN
  v_actor := admin_session_actor(p_token);
  IF v_actor IS NULL THEN
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
  PERFORM admin_audit(v_actor, 'user_toggle', p_username, jsonb_build_object('enabled', p_enabled));
  RETURN jsonb_build_object('ok', true);
END $$;

-- [11] 删除账号（+审计；保护最后一个启用中的管理员）
CREATE OR REPLACE FUNCTION admin_user_delete(p_token text, p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_enabled boolean; v_active_admins int; v_actor text;
BEGIN
  v_actor := admin_session_actor(p_token);
  IF v_actor IS NULL THEN
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
  PERFORM admin_audit(v_actor, 'user_delete', p_username, jsonb_build_object('role', v_role));
  RETURN jsonb_build_object('ok', true);
END $$;

-- [12] 执行权限
GRANT EXECUTE ON FUNCTION admin_login(text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_session_check(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_session_actor(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_list(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_create(text,text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_resetpwd(text,text,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_toggle(text,text,boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_user_delete(text,text) TO anon, authenticated;
