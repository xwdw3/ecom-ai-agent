/* codemod：tools.js 多租户接入（一次性；按行精确替换后立即校验语法） */
const fs = require('fs');
const f = __dirname + '/../js/tools.js';
const lines = fs.readFileSync(f, 'utf8').split('\n');
const T = "Tenant.id()";

// 读路径：select(...) 后插入租户过滤（行号 1-based）
const readLines = [137, 143, 151, 155, 160, 173, 179, 194, 229, 233, 237, 241, 251, 261];
// update/delete 过滤：在首个 .eq( 前插入租户过滤（行号区间）
const updLines = [165, 166, 200, 201];
// insert payload 首行：下一行是字段区，在其前面补 tenant_id
const insLines = [184, 208, 215, 222];

for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  if (readLines.includes(n)) {
    lines[i] = lines[i].replace(/\.select\(([^)]*)\)(?!.*tenant_id)/, `.select($1).eq('tenant_id', ${T})`);
  }
}
// insert(payload) 整对象参数（route/tool_audit）
lines[246] = lines[246].replace("insert(payload)", "insert({ ...payload, tenant_id: Tenant.id() })");
lines[256] = lines[256].replace("insert(payload)", "insert({ ...payload, tenant_id: Tenant.id() })");
// 多行 insert：字段区首行前补 tenant_id
for (const n of insLines) {
  const idx = n - 1; // 0-based 指向 insert({ 行，字段区从下一行开始
  if (!/insert\(\{?\s*$/.test(lines[idx].trim())) { console.error('L' + n + ' 不是 insert 结尾:', lines[idx]); process.exit(1); }
  lines[idx + 1] = '            tenant_id: Tenant.id(),\n' + lines[idx + 1];
}
// update 链：在 .eq( 前插租户过滤（只处理目标行）
for (const n of updLines) {
  const i = n - 1;
  if (lines[i].includes('.eq(') && !lines[i].includes('tenant_id')) {
    lines[i] = lines[i].replace('.eq(', `.eq('tenant_id', ${T}).eq(`);
  }
}
fs.writeFileSync(f, lines.join('\n'));
console.log('tools.js codemod 完成');
