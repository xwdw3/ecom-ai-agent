/* codemod：管理端 7 文件多租户接入（一次性；按行替换后逐文件校验语法） */
const fs = require('fs');
const T = "Tenant.id()";

function edit(file, fn) {
  const p = __dirname + '/../js/' + file;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  fn(lines, (msg) => `${file}:${msg}`);
  fs.writeFileSync(p, lines.join('\n'));
  new Function(fs.readFileSync(p, 'utf8')); // 语法校验
  console.log(file + ' OK');
}

// 读路径：select(...) 后插租户过滤（容忍 from 与 select 跨行/插行偏移：n 或 n+1）
function readAt(lines, ns, tag) {
  for (const n of ns) {
    let done = false;
    for (const i of [n - 1, n]) {
      const line = lines[i] || '';
      if (line.includes('tenant_id') && /\.select\(/.test(lines[i - 1] || '') + line) { done = true; break; }
      if (/\.select\(([^)]*)\)/.test(line) && !line.includes('tenant_id')) {
        lines[i] = line.replace(/\.select\(([^)]*)\)/, `.select($1).eq('tenant_id', ${T})`);
        done = true; break;
      }
    }
    if (!done) throw new Error(tag + ' L' + n + ' 附近无 select: ' + (lines[n - 1] || ''));
  }
}
// 多行 insert：insert({ 行下一行前补 tenant_id
function insAt(lines, ns, tag, indent) {
  for (const n of ns) {
    const idx = n - 1;
    if (!/insert\(\{?\s*$/.test(lines[idx].trim())) throw new Error(tag + ' L' + n + ' 非 insert 结尾');
    lines[idx + 1] = indent + 'tenant_id: Tenant.id(),\n' + lines[idx + 1];
  }
}
// update 链：首个 .eq( 前插租户过滤
function updAt(lines, ns, tag) {
  for (const n of ns) {
    const i = n - 1;
    if (lines[i].includes('tenant_id')) continue;
    if (lines[i].includes('.eq(')) {
      lines[i] = lines[i].replace('.eq(', `.eq('tenant_id', ${T}).eq(`);
    } else throw new Error(tag + ' L' + n + ' 无 .eq(');
  }
}

edit('ops.js', (lines, tag) => {
  readAt(lines, [151, 152, 188, 203, 204, 244, 245, 246, 247], 'ops');
  updAt(lines, [323], 'ops');
});
edit('admin.js', (lines, tag) => {
  // 38/46 是多行 .from('t')\n.select(...)：select 行号 39/47
  readAt(lines, [39, 47, 231, 262, 298, 439, 465], 'admin');
  updAt(lines, [319], 'admin');
});
edit('marketing.js', (lines, tag) => {
  insAt(lines, [194], 'marketing', '    ');
  readAt(lines, [209], 'marketing');
});
edit('analytics.js', (lines, tag) => {
  insAt(lines, [113], 'analytics', '    ');
  readAt(lines, [126], 'analytics');
});
edit('seat.js', (lines, tag) => {
  readAt(lines, [17, 41], 'seat');
  updAt(lines, [65, 75], 'seat');
  // 单行 insert({ session_id
  for (let i = 0; i < lines.length; i++) {
    if (/\.insert\(\{ session_id:/.test(lines[i]) && !lines[i].includes('tenant_id')) {
      lines[i] = lines[i].replace('.insert({ session_id:', `.insert({ tenant_id: ${T}, session_id:`);
    }
  }
});
edit('inspection.js', (lines, tag) => {
  insAt(lines, [99], 'inspection', '    ');
  readAt(lines, [110], 'inspection');
});
edit('console.js', (lines, tag) => {
  readAt(lines, [125], 'console');
  updAt(lines, [154], 'console');
});
console.log('全部完成');
