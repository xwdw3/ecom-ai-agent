/* codemod：chat.js 多租户接入（一次性；按行替换后校验语法） */
const fs = require('fs');
const f = __dirname + '/../js/chat.js';
const lines = fs.readFileSync(f, 'utf8').split('\n');
const T = "Tenant.id()";

// 读路径：select(...) 后插租户过滤（1-based 行号）
const readLines = [80, 201, 208, 672, 699];
for (const n of readLines) {
  const i = n - 1;
  if (lines[i].includes('tenant_id')) continue;
  const re = /\.select\(([^)]*)\)/;
  if (!re.test(lines[i])) { console.error('L' + n + ' 无 select:', lines[i]); process.exit(1); }
  lines[i] = lines[i].replace(re, `.select($1).eq('tenant_id', ${T})`);
}

// 单行 insert({ session_id → 补 tenant_id
for (let i = 0; i < lines.length; i++) {
  if (/\.insert\(\{ session_id:/.test(lines[i]) && !lines[i].includes('tenant_id')) {
    lines[i] = lines[i].replace('.insert({ session_id:', `.insert({ tenant_id: ${T}, session_id:`);
  }
}
// 多行 insert：insert({ 行的下一行前补 tenant_id（1-based 行号）
const insLines = [95, 408, 452, 455, 531, 535, 562];
for (const n of insLines) {
  const idx = n - 1;
  if (!/insert\(\{\s*$/.test(lines[idx].trim())) { console.error('L' + n + ' 不是 insert({ 结尾:', lines[idx]); process.exit(1); }
  lines[idx + 1] = '      tenant_id: Tenant.id(),\n' + lines[idx + 1];
}
fs.writeFileSync(f, lines.join('\n'));
console.log('chat.js codemod 完成');
