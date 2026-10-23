/**
 * 把 kb-gate.sql 拆成单条语句并生成 base64（exec 工具不支持多语句）
 * 输出：tools/_kbgate_stmts.json  [{i, head, sql, b64}]
 * 用法：node tools/split-kbgate.cjs
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'kb-gate.sql'), 'utf8');

const stmts = [];
let buf = '', inDollar = false, inLine = false;
for (let i = 0; i < src.length; i++) {
  const two = src.slice(i, i + 2);
  if (inLine) { if (src[i] === '\n') inLine = false; buf += src[i]; continue; }
  if (!inDollar && two === '--') { inLine = true; buf += src[i]; continue; }
  if (!inDollar && two === '$$') { inDollar = true; buf += '$$'; i++; continue; }
  if (inDollar && two === '$$') { inDollar = false; buf += '$$'; i++; continue; }
  if (!inDollar && src[i] === ';') {
    const s = (buf + ';').trim();
    const stripped = s.replace(/--[^\n]*/g, '').trim();
    if (stripped) stmts.push(s);
    buf = '';
    continue;
  }
  buf += src[i];
}
const tail = buf.trim();
if (tail.replace(/--[^\n]*/g, '').trim()) stmts.push(tail);

const out = stmts.map((sql, i) => ({
  i: i + 1,
  head: sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 72),
  sql,
  b64: Buffer.from(sql, 'utf8').toString('base64'),
}));
fs.writeFileSync(path.join(__dirname, '_kbgate_stmts.json'), JSON.stringify(out, null, 2));
console.log(`共 ${out.length} 条语句`);
out.forEach((s) => console.log(String(s.i).padStart(2), s.head));
