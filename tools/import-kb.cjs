/**
 * 知识库批量导入脚本（交付物：知识库导入脚本）
 *
 * 功能：读取 JSON / CSV / TXT(MD) 知识文件，按标题增量 upsert 到云数据库，
 *       并自动切分检索分块（与条目状态同步）。
 *
 * 用法：
 *   node tools/import-kb.cjs tools/samples/sample-kb.json
 *   node tools/import-kb.cjs tools/samples/sample-kb.csv
 *   node tools/import-kb.cjs tools/samples/sample-kb.txt
 *
 * 文件格式（与管理后台「批量导入」完全一致）：
 *   .json → [{ "category":"sku|faq|activity", "title":"…", "content":"…", "tags":["…"], "status":"published|offline" }]
 *   .csv  → 表头：category,title,content,tags,status（含逗号/换行的字段用双引号包裹）
 *   .txt/.md → 条目之间用单独一行「---」分隔；每条首行可写元信息
 *              [分类:faq] 与 [标签:a,b]，随后一行标题，其余为内容
 *
 * 增量更新规则：标题与库中已有条目相同 → 更新（保留原 id）；否则新增。
 * 保存后自动按段落切分知识分块（kb_chunks），下架条目同步退出检索。
 *
 * 鉴权：使用前端同款 publishable key（公开配置，不含私密密钥）。
 */
const fs = require('fs');
const path = require('path');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const PUBLIC_CONFIG = {
  endpoint: 'https://ecom-ai-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_owgvNddJFLrJ1fTdyIS0PG_81NQEg4QzWUXAQjb9hWzm8wog5vYNxqY',
};
const cloud = createWorkBuddyCloud(PUBLIC_CONFIG);

// ---------- 解析（与 js/admin.js parseImportFile 逻辑一致） ----------
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseImportFile(name, text) {
  const entries = [];
  if (name.endsWith('.json')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('JSON 需为数组');
    arr.forEach((e) => entries.push({
      category: e.category || 'faq', title: String(e.title || '').trim(),
      content: String(e.content || '').trim(), tags: e.tags || [],
      status: e.status || 'published',
    }));
  } else if (name.endsWith('.csv')) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = parseCsvLine(lines.shift() || '');
    const idx = (k) => header.findIndex((h) => h.trim().toLowerCase() === k);
    const iCat = idx('category'), iTitle = idx('title'), iContent = idx('content'), iTags = idx('tags'), iStatus = idx('status');
    lines.forEach((line) => {
      const c = parseCsvLine(line);
      entries.push({
        category: (c[iCat] || 'faq').trim(), title: (c[iTitle] || '').trim(),
        content: (c[iContent] || '').trim(),
        tags: (c[iTags] || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        status: (c[iStatus] || 'published').trim(),
      });
    });
  } else {
    text.split(/\r?\n---\r?\n/).forEach((block) => {
      const lines = block.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return;
      let category = 'faq', tags = [], i = 0;
      const meta = lines[0].match(/^\[(分类|category):(\w+)\]/i);
      if (meta) { category = meta[2].toLowerCase(); i++; }
      const tagLine = lines[i] && lines[i].match(/^\[(标签|tags):(.+)\]/i);
      if (tagLine) { tags = tagLine[2].split(/[,，]/).map((s) => s.trim()).filter(Boolean); i++; }
      const title = (lines[i] || '').replace(/^#+\s*/, '').trim(); i++;
      const content = lines.slice(i).join('\n').trim();
      if (title && content) entries.push({ category, title, content, tags, status: 'published' });
    });
  }
  return entries.filter((e) => e.title && e.content);
}

// ---------- 分块（与 js/retrieval.js chunkContent 逻辑一致） ----------
function chunkContent(content, target = 220, max = 400) {
  const paras = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length > max || buf.length >= target)) {
      chunks.push(buf); buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [String(content || '').trim()];
}

// ---------- 主流程 ----------
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node tools/import-kb.cjs <知识文件.json|.csv|.txt|.md>');
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const entries = parseImportFile(path.basename(file).toLowerCase(), text);
  if (!entries.length) {
    console.error('未解析到有效条目（需含标题与内容）');
    process.exit(1);
  }
  console.log(`解析到 ${entries.length} 条知识，开始增量导入…`);

  const { data: existing, error: e0 } = await cloud.database.from('kb_entries').select('id, title').limit(2000);
  if (e0) { console.error('读取现有条目失败：', e0.message); process.exit(1); }
  const byTitle = {};
  (existing || []).forEach((e) => (byTitle[e.title] = e.id));

  let added = 0, updated = 0, failed = 0;
  for (const e of entries) {
    const payload = {
      category: ['sku', 'faq', 'activity'].includes(e.category) ? e.category : 'faq',
      title: e.title, content: e.content, tags: e.tags,
      status: ['published', 'offline'].includes(e.status) ? e.status : 'published',
      updated_at: new Date().toISOString(),
    };
    try {
      let saved;
      if (byTitle[e.title]) {
        const { data, error } = await cloud.database.from('kb_entries')
          .update(payload).eq('id', byTitle[e.title]).select();
        if (error || !Array.isArray(data) || !data.length) throw new Error(error?.message || '更新失败');
        saved = data[0]; updated++;
      } else {
        const { data, error } = await cloud.database.from('kb_entries').insert(payload).select();
        if (error) throw error;
        saved = data[0]; added++;
        byTitle[e.title] = saved.id;
      }
      // 同步重建分块
      await cloud.database.from('kb_chunks').delete().eq('entry_id', saved.id);
      const rows = chunkContent(saved.content).map((content, i) => ({
        entry_id: saved.id, chunk_index: i, title: saved.title, content,
        category: saved.category, tags: saved.tags || [], status: saved.status,
      }));
      if (rows.length) {
        const { error } = await cloud.database.from('kb_chunks').insert(rows);
        if (error) throw error;
      }
      console.log(`  ✓ [${byTitle[e.title] === saved.id && updated ? '更新' : '新增'}] ${saved.title}（${rows.length} 块）`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${e.title}：`, err.message || err);
    }
  }
  console.log(`\n导入完成：新增 ${added}，更新 ${updated}${failed ? `，失败 ${failed}` : ''}`);
  process.exit(failed ? 2 : 0);
}

main();
