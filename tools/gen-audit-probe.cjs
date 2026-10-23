/* 生成 KB/审计链路验证账号的 INSERT（一次性工具，admin+ops 各一；验证后即删） */
const crypto = require('crypto');
const fs = require('fs');
const mk = (role) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const pass = 'KbProbe#2026x' + role;
  const hash = crypto.createHash('sha256').update(salt + pass).digest('hex');
  return { username: 'hb_' + role + '_' + Date.now(), pass, salt, hash, role };
};
const admin = mk('admin');
const ops = mk('ops');
const sqls = [admin, ops].map((u) =>
  "INSERT INTO svc_admin_users (username, salt, pass_hash, role, enabled) VALUES ('" +
  u.username + "', '" + u.salt + "', '" + u.hash + "', '" + u.role + "', true);");
fs.writeFileSync(__dirname + '/_kb_probe.json', JSON.stringify({ admin, ops }, null, 2));
console.log(sqls.join('\n'));
