/* 管理后台逻辑：知识库CRUD+自动分块、对话日志、问题统计、人工工单 */

let ENTRIES = [];
let editingId = null; // null=新增

// ---------- P2：登录身份（审核流权限用） ----------
function kbRole() {
  try {
    const s = JSON.parse(sessionStorage.getItem('gate_session'));
    if (s && s.r && Number(s.exp) > Date.now()) return s.r;
  } catch (e) { /* ignore */ }
  return 'readonly';
}
const KB_STATUS_META = {
  draft: { text: '草稿', cls: 'off' },
  pending: { text: '待审核', cls: 'warn' },
  published: { text: '已发布', cls: 'on' },
  offline: { text: '已下架', cls: 'off' },
};

// ---------- Tab 切换 ----------
document.querySelectorAll('.sidebar .tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.sidebar .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'logs') loadLogs();
    if (tab.dataset.panel === 'stats') loadStats();
    if (tab.dataset.panel === 'tickets') loadTickets();
    if (tab.dataset.panel === 'alerts') loadAlerts();
  };
});

// ---------- 知识库 ----------
async function loadEntries() {
  const { data, error } = await cloud.database
    .from('kb_entries')
    .select('*').eq('tenant_id', Tenant.id())
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) return showToast('知识条目加载失败：' + error.message, 'error');
  ENTRIES = data || [];

  const { data: chunkCounts, error: e2 } = await cloud.database
    .from('kb_chunks')
    .select('entry_id').eq('tenant_id', Tenant.id());
  const countMap = {};
  (chunkCounts || []).forEach((c) => (countMap[c.entry_id] = (countMap[c.entry_id] || 0) + 1));

  renderKb(countMap);
}

function renderKb(countMap) {
  const cat = document.getElementById('kbFilterCat').value;
  const st = document.getElementById('kbFilterStatus').value;
  const kw = document.getElementById('kbSearch').value.trim().toLowerCase();
  const body = document.getElementById('kbBody');

  const rows = ENTRIES.filter((e) =>
    (!cat || e.category === cat) && (!st || e.status === st) &&
    (!kw || (e.title + e.content + (e.tags || []).join('')).toLowerCase().includes(kw))
  );
  if (!rows.length) return (body.innerHTML = '<tr><td colspan="7" class="empty">暂无匹配的知识条目</td></tr>');

  const catName = { sku: '商品SKU', faq: 'FAQ', activity: '活动' };
  const role = kbRole();
  body.innerHTML = rows.map((e) => {
    const meta = KB_STATUS_META[e.status] || KB_STATUS_META.offline;
    let acts = '';
    if (KBFlow.kbCanDo('edit', role)) {
      acts += `<button class="btn small ghost" data-act="edit" data-id="${e.id}">编辑</button>`;
      if (e.status === 'draft') acts += `<button class="btn small blue" data-act="submit" data-id="${e.id}">提交审核</button>`;
      if (e.status === 'pending' && KBFlow.kbCanDo('review', role)) {
        acts += `<button class="btn small blue" data-act="approve" data-id="${e.id}">通过</button>`
          + `<button class="btn small danger" data-act="reject" data-id="${e.id}">驳回</button>`;
      }
      if (e.status === 'published' && KBFlow.kbCanDo('offline', role)) acts += `<button class="btn small blue" data-act="offline" data-id="${e.id}">下架</button>`;
      if (e.status === 'offline' && KBFlow.kbCanDo('review', role)) acts += `<button class="btn small blue" data-act="republish" data-id="${e.id}">重新上架</button>`;
      if (KBFlow.kbCanDo('del', role)) acts += `<button class="btn small danger" data-act="del" data-id="${e.id}">删除</button>`;
    }
    acts += `<button class="btn small ghost" data-act="versions" data-id="${e.id}">版本</button>`;
    return `
    <tr>
      <td><b>${escapeHtml(e.title)}</b></td>
      <td><span class="badge ${e.category}">${catName[e.category] || e.category}</span></td>
      <td>${escapeHtml((e.tags || []).join('、'))}</td>
      <td><span class="badge ${meta.cls}">${meta.text}</span></td>
      <td>${countMap[e.id] || 0} 块</td>
      <td>${fmtTime(e.updated_at)}</td>
      <td>${acts}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const entry = ENTRIES.find((x) => x.id == btn.dataset.id);
      const act = btn.dataset.act;
      if (act === 'edit') openKbModal(entry);
      if (act === 'versions') showVersions(entry);
      if (act === 'del') deleteEntry(entry);
      if (act === 'submit') flowAct(() => KBFlow.submitReview(cloud.database, entry, kbUser()), '已提交审核');
      if (act === 'approve') flowAct(() => KBFlow.review(cloud.database, entry, true, kbUser(), prompt('发布备注（可空）：') || ''), '已发布并同步检索分块');
      if (act === 'reject') {
        const reason = prompt('驳回原因（必填）：');
        if (!reason) return showToast('请填写驳回原因', 'error');
        flowAct(() => KBFlow.review(cloud.database, entry, false, kbUser(), reason), '已驳回，退回草稿');
      }
      if (act === 'offline') flowAct(() => KBFlow.offlineEntry(cloud.database, entry, kbUser()), '已下架');
      if (act === 'republish') flowAct(() => KBFlow.republish(cloud.database, entry, kbUser()), '已重新上架');
    };
  });
}

function kbUser() {
  try { return kbRole() + ':' + (JSON.parse(sessionStorage.getItem('gate_session') || '{}').u || '?'); } catch (e) { return kbRole(); }
}

async function flowAct(fn, okMsg) {
  try { await fn(); showToast(okMsg, 'success'); loadEntries(); }
  catch (e) { showToast((e.message || e.error?.message || '操作失败'), 'error'); }
}

// ---------- 版本历史 ----------
async function showVersions(entry) {
  const pane = document.getElementById('versionPane');
  const body = document.getElementById('versionBody');
  pane.style.display = '';
  document.getElementById('versionTitle').textContent = `版本历史 · ${entry.title}`;
  body.innerHTML = '<tr><td colspan="6" class="empty">加载中…</td></tr>';
  try {
    const versions = await KBFlow.listVersions(cloud.database, entry.id);
    const actName = { edit: '编辑', submit: '提交审核', publish: '发布', reject: '驳回', offline: '下架', rollback: '回滚', import: '导入', backfill: '存量快照' };
    body.innerHTML = versions.length ? versions.map((v) => `
      <tr>
        <td><b>v${v.version_no}</b></td>
        <td>${actName[v.action] || v.action}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.note || v.content.slice(0, 40))}</td>
        <td>${escapeHtml(v.editor)}</td>
        <td>${fmtTime(v.created_at)}</td>
        <td>${entry.status !== 'pending' && KBFlow.kbCanDo('rollback', kbRole())
          ? `<button class="btn small ghost" data-v="${v.version_no}">回滚到此版</button>` : '-'}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无版本记录</td></tr>';
    body.querySelectorAll('button[data-v]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`确认回滚「${entry.title}」到 v${b.dataset.v}？回滚后将生成新草稿，需重新审核发布。`)) return;
        await flowAct(() => KBFlow.rollbackTo(cloud.database, entry, b.dataset.v, kbUser()), '已回滚并生成新草稿');
        showVersions(ENTRIES.find((x) => x.id === entry.id) || entry);
      };
    });
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + escapeHtml(e.message || e) + '</td></tr>';
  }
}
document.getElementById('versionClose').onclick = () => { document.getElementById('versionPane').style.display = 'none'; };

async function syncChunks(entry) {
  // 与条目状态同步重建分块：先删后插
  await cloud.database.from('kb_chunks').delete().eq('entry_id', entry.id);
  const pieces = chunkContent(entry.content);
  const rows = pieces.map((content, i) => ({
    entry_id: entry.id, chunk_index: i, title: entry.title, content,
    category: entry.category, tags: entry.tags || [], status: entry.status,
  }));
  if (rows.length) {
    const { error } = await cloud.database.from('kb_chunks').insert(rows);
    if (error) throw error;
  }
}

async function deleteEntry(entry) {
  if (!confirm(`确定删除「${entry.title}」吗？版本历史将一并删除，不可恢复。`)) return;
  try {
    await KBFlow.deleteEntry(cloud.database, entry);
    showToast('已删除', 'success');
  } catch (e) { return showToast('删除失败：' + (e.message || e), 'error'); }
  loadEntries();
}

function openKbModal(entry) {
  editingId = entry ? entry.id : null;
  document.getElementById('kbModalTitle').textContent = entry ? '编辑知识' : '新增知识';
  document.getElementById('kbCat').value = entry ? entry.category : 'sku';
  document.getElementById('kbTitle').value = entry ? entry.title : '';
  document.getElementById('kbTags').value = entry ? (entry.tags || []).join(',') : '';
  document.getElementById('kbContent').value = entry ? entry.content : '';
  document.getElementById('kbMask').classList.add('show');
}

document.getElementById('kbAdd').onclick = () => openKbModal(null);
document.getElementById('kbCancel').onclick = () => document.getElementById('kbMask').classList.remove('show');
document.getElementById('kbSave').onclick = async () => {
  const title = document.getElementById('kbTitle').value.trim();
  const content = document.getElementById('kbContent').value.trim();
  if (!title || !content) return showToast('标题和内容不能为空', 'error');
  const payload = {
    category: document.getElementById('kbCat').value,
    title,
    content,
    tags: document.getElementById('kbTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  };
  try {
    // P2：保存 → 草稿（新版本）。已发布内容在审批通过前不受影响
    let saved;
    if (editingId == null) {
      saved = await KBFlow.saveDraft(cloud.database, payload, kbUser());
    } else {
      const exist = ENTRIES.find((x) => x.id == editingId);
      saved = await KBFlow.editToDraft(cloud.database, editingId, payload, kbUser());
      void exist;
    }
    document.getElementById('kbMask').classList.remove('show');
    showToast('已保存为草稿，提交审核并通过后生效', 'success');
    loadEntries();
  } catch (e) {
    showToast('保存失败：' + (e.message || e.error?.message), 'error');
  }
};
['kbFilterCat', 'kbFilterStatus'].forEach((id) => document.getElementById(id).onchange = loadEntries);
document.getElementById('kbSearch').oninput = () => {
  const counts = {};
  ENTRIES.forEach((e) => (counts[e.id] = counts[e.id] || 0));
  renderKb(counts); // 仅前端过滤，分块数沿用上次
};

// ---------- 对话日志 ----------
async function loadLogs() {
  const role = document.getElementById('logRole').value;
  const fb = document.getElementById('logFallback').value;
  const sid = document.getElementById('logSession').value.trim();
  let q = cloud.database.from('chat_messages').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(200);
  if (role) q = q.eq('role', role);
  if (fb === '1') q = q.eq('is_fallback', true);
  if (fb === '0') q = q.eq('is_fallback', false);
  if (sid) q = q.eq('session_id', sid);
  const { data, error } = await q;
  const list = document.getElementById('logList');
  if (error) return (list.innerHTML = '<div class="empty">加载失败：' + escapeHtml(error.message) + '</div>');
  if (!data || !data.length) return (list.innerHTML = '<div class="empty">暂无对话记录</div>');

  list.innerHTML = data.map((m) => {
    const refs = m.refs && m.refs.length
      ? ' · 引用: ' + m.refs.map((r) => escapeHtml(r.title)).join(' / ') : '';
    return `<div class="log-item">
      <div class="meta">
        <span>${fmtTime(m.created_at)}</span>
        <span>${m.role === 'user' ? '👤 用户' : '🤖 AI'}</span>
        <span>会话 ${escapeHtml(String(m.session_id).slice(0, 12))}…</span>
        ${m.is_fallback ? '<span class="badge fallback">兜底/未答</span>' : ''}
      </div>
      <div class="content">${escapeHtml(m.content)}${refs}</div>
    </div>`;
  }).join('');
}
['logRole', 'logFallback'].forEach((id) => document.getElementById(id).onchange = loadLogs);
document.getElementById('logSession').onkeydown = (e) => { if (e.key === 'Enter') loadLogs(); };
document.getElementById('logRefresh').onclick = loadLogs;

// ---------- 问题统计 ----------
async function loadStats() {
  const { data, error } = await cloud.database
    .from('chat_messages').select('session_id, role, is_fallback, created_at').eq('tenant_id', Tenant.id()).limit(2000);
  if (error) return showToast('统计加载失败：' + error.message, 'error');
  const msgs = data || [];
  const questions = msgs.filter((m) => m.role === 'user');
  const fallbacks = questions.filter((m) => m.is_fallback).length;
  document.getElementById('stTotal').textContent = questions.length;
  document.getElementById('stFallback').textContent = fallbacks;
  document.getElementById('stRate').textContent =
    questions.length ? ((1 - fallbacks / questions.length) * 100).toFixed(1) + '%' : '-';
  document.getElementById('stSessions').textContent = new Set(msgs.map((m) => m.session_id)).size;

  // 近7日柱状图
  const bars = document.getElementById('statBars');
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ key: d.toISOString().slice(0, 10), label: `${d.getMonth() + 1}/${d.getDate()}`, n: 0 });
  }
  questions.forEach((m) => {
    const k = String(m.created_at).slice(0, 10);
    const day = days.find((x) => x.key === k);
    if (day) day.n++;
  });
  const max = Math.max(...days.map((d) => d.n), 1);
  bars.innerHTML = days.map((d) => `
    <div class="bar-col">
      <div class="val">${d.n}</div>
      <div class="bar" style="height:${(d.n / max) * 100}%"></div>
      <div class="day">${d.label}</div>
    </div>`).join('');
}

// ---------- 人工工单 ----------
async function loadTickets() {
  const st = document.getElementById('tkFilter').value;
  let q = cloud.database.from('support_tickets').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(200);
  if (st) q = q.eq('status', st);
  const { data, error } = await q;
  const body = document.getElementById('tkBody');
  if (error) return (body.innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + escapeHtml(error.message) + '</td></tr>');
  if (!data || !data.length) return (body.innerHTML = '<tr><td colspan="6" class="empty">暂无工单</td></tr>');

  body.innerHTML = data.map((t) => `
    <tr>
      <td>${escapeHtml(t.question)}</td>
      <td>${escapeHtml(t.contact || '-')}</td>
      <td>${t.status === 'open' ? '<span class="badge open">待处理</span>' : '<span class="badge done">已处理</span>'}</td>
      <td>${escapeHtml(t.note || '-')}</td>
      <td>${fmtTime(t.created_at)}</td>
      <td>${t.status === 'open' ? `<button class="btn small blue" data-id="${t.id}">标记处理</button>` : ''}</td>
    </tr>`).join('');

  body.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.onclick = async () => {
      const note = prompt('处理备注（如：已电话回访解决）') || '';
      const { data: upd, error } = await cloud.database.from('support_tickets')
        .update({ status: 'done', note: String(note) }).eq('tenant_id', Tenant.id()).eq('id', btn.dataset.id).select();
      if (error || !Array.isArray(upd) || upd.length === 0) return showToast('更新失败', 'error');
      showToast('已标记处理', 'success');
      loadTickets();
    };
  });
}
document.getElementById('tkFilter').onchange = loadTickets;
document.getElementById('tkRefresh').onclick = loadTickets;

// ---------- 批量导入（文档上传 / 增量更新：按标题 upsert） ----------
// 支持格式：
//   .json → [{category,title,content,tags,status}, ...]
//   .csv  → 表头 category,title,content,tags,status（content 内换行需用双引号包裹）
//   .txt/.md → 用「---」单独一行分隔条目；每条首行为标题，其余为内容，可选「[分类:faq]」「[标签:a,b]」头
document.getElementById('kbImport').onclick = () => document.getElementById('kbImportFile').click();

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
    // txt / md：--- 分隔，首行标题，可选 [分类:xxx] [标签:a,b] 元信息行
    text.split(/\r?\n---\r?\n/).forEach((block) => {
      const lines = block.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return;
      let title = '', category = 'faq', tags = [];
      let i = 0;
      const meta = lines[0].match(/^\[(分类|category):(\w+)\]/i);
      if (meta) { category = meta[2].toLowerCase(); i++; }
      const tagLine = lines[i] && lines[i].match(/^\[(标签|tags):(.+)\]/i);
      if (tagLine) { tags = tagLine[2].split(/[,，]/).map((s) => s.trim()).filter(Boolean); i++; }
      title = (lines[i] || '').replace(/^#+\s*/, '').trim(); i++;
      const content = lines.slice(i).join('\n').trim();
      if (title && content) entries.push({ category, title, content, tags, status: 'published' });
    });
  }
  return entries.filter((e) => e.title && e.content);
}

document.getElementById('kbImportFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  ev.target.value = '';
  let entries;
  try {
    entries = parseImportFile(file.name.toLowerCase(), await file.text());
  } catch (e) {
    return showToast('解析失败：' + e.message, 'error');
  }
  if (!entries.length) return showToast('未解析到有效条目（需含标题与内容）', 'error');

  let added = 0, updated = 0, failed = 0;
  const byTitle = {};
  ENTRIES.forEach((e) => (byTitle[e.title] = e));
  for (const e of entries) {
    const payload = {
      category: ['sku', 'faq', 'activity'].includes(e.category) ? e.category : 'faq',
      title: e.title, content: e.content, tags: e.tags,
      updated_at: new Date().toISOString(),
    };
    try {
      const exist = byTitle[e.title];
      if (exist) {
        // 增量更新：标题相同则覆盖为发布态并重建分块，留版本痕迹（服务端门禁）
        await KBFlow.importUpdate(cloud.database, exist.id, payload, kbUser());
        updated++;
      } else {
        await KBFlow.importPublished(cloud.database, payload, kbUser());
        added++;
      }
    } catch (err) {
      failed++;
      console.warn('导入失败：', e.title, err);
    }
  }
  showToast(`导入完成：新增 ${added}，更新 ${updated}${failed ? `，失败 ${failed}` : ''}`, failed ? 'error' : 'success');
  loadEntries();
};

// ---------- 对话日志导出 CSV ----------
document.getElementById('logExport').onclick = async () => {
  showToast('正在导出…', 'info');
  const { data, error } = await cloud.database.from('chat_messages')
    .select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: true }).limit(2000);
  if (error) return showToast('导出失败：' + error.message, 'error');
  const rows = data || [];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, '\\n') + '"';
  const csv = [
    ['时间', '会话ID', '角色', '内容', '是否兜底', '引用来源'].map(esc).join(','),
    ...rows.map((m) => [
      fmtTime(m.created_at), m.session_id, m.role, m.content,
      m.is_fallback ? '是' : '否',
      m.refs && m.refs.length ? m.refs.map((r) => r.title).join(' / ') : '',
    ].map(esc).join(',')),
  ].join('\r\n');
  // BOM 保证 Excel 打开中文不乱码；库内数据已脱敏，导出不二次泄露
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '对话日志导出_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('已导出 ' + rows.length + ' 条（内容已脱敏）', 'success');
};

// ---------- 错误告警 ----------
async function loadAlerts() {
  const sev = document.getElementById('alertSeverity').value;
  const type = document.getElementById('alertType').value;
  let q = cloud.database.from('alert_logs').select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(100);
  if (sev) q = q.eq('severity', sev);
  if (type) q = q.eq('alert_type', type);
  const { data, error } = await q;
  const list = document.getElementById('alertList');
  if (error) return (list.innerHTML = '<div class="empty">加载失败：' + escapeHtml(error.message) + '</div>');
  if (!data || !data.length) return (list.innerHTML = '<div class="empty">✅ 暂无告警，系统运行正常</div>');
  const typeName = { llm_call_failed: 'LLM调用失败', retrieval_error: '检索异常' };
  list.innerHTML = data.map((a) => `
    <div class="log-item">
      <div class="meta">
        <span>${fmtTime(a.created_at)}</span>
        <span class="badge fallback">${escapeHtml(typeName[a.alert_type] || a.alert_type)}</span>
        <span>${escapeHtml(a.severity || 'error')}</span>
        ${a.session_id ? '<span>会话 ' + escapeHtml(String(a.session_id).slice(0, 12)) + '…</span>' : ''}
      </div>
      <div class="content">${escapeHtml(a.message)}</div>
    </div>`).join('');
}
['alertSeverity', 'alertType'].forEach((id) => document.getElementById(id).onchange = loadAlerts);
document.getElementById('alertRefresh').onclick = loadAlerts;

// ---------- 初始化（登录门禁后执行） ----------
/** KB 写操作统一走服务端网关（kb_write SECURITY DEFINER：角色门禁+状态机+审计在库内强制） */
function setupKbTransport() {
  try {
    const s = JSON.parse(sessionStorage.getItem('gate_session'));
    if (!s || !s.t) return; // 无 token 时写操作将被服务端拒绝（兜底只读）
    KBFlow.setKbTransport(async (action, args) => {
      const { data, error } = await cloud.database.rpc('kb_write', { p_token: s.t, p_action: action, p_args: args || {} });
      if (error) throw new Error(error.message || JSON.stringify(error));
      if (!data || data.ok !== true) throw new Error((data && data.error) || '操作失败');
      return data.entry !== undefined ? data.entry : data;
    });
  } catch (e) { /* ignore */ }
}

gateRequire().then(() => { setupKbTransport(); loadEntries(); loadUsers(); });

// ---------- 账号管理（仅 admin 角色；服务端 admin_user_* 函数强制校验） ----------
const USER_ROLES = ['admin', 'ops', 'agent', 'readonly'];
let USERS = [];
function isAdminUser() { return kbRole() === 'admin'; }
function gateToken() {
  try { return JSON.parse(sessionStorage.getItem('gate_session') || '{}').t || ''; } catch (e) { return ''; }
}
function errMsg(r, fallback) {
  if (!r) return fallback;
  const e = r.error;
  return (typeof e === 'string' ? e : (e && e.message)) || r.reason || fallback;
}

async function loadUsers() {
  const body = document.getElementById('userBody');
  if (!isAdminUser()) {
    body.innerHTML = '<tr><td colspan="5" class="empty">仅管理员可查看/管理账号</td></tr>';
    document.getElementById('userAdd').disabled = true;
    return;
  }
  const r = await governedCall('usermgmt', 'list', { token: gateToken() });
  if (!r || r.ok === false) {
    body.innerHTML = '<tr><td colspan="5" class="empty">加载失败：' + escapeHtml(errMsg(r, '网关异常')) + '</td></tr>';
    return;
  }
  USERS = r.degraded ? [] : (r.users || []);
  const roleText = { admin: '管理员', ops: '运营', agent: '客服', readonly: '只读' };
  const activeAdmins = USERS.filter((u) => u.role === 'admin' && u.enabled).length;
  body.innerHTML = USERS.map((u) => `
    <tr>
      <td><b>${escapeHtml(u.username)}</b></td>
      <td>${escapeHtml(roleText[u.role] || u.role)}</td>
      <td>${u.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge fallback">禁用</span>'}</td>
      <td>${fmtTime(u.created_at)}</td>
      <td>
        <button class="btn small ghost" data-act="reset" data-u="${escapeHtml(u.username)}">重置密码</button>
        <button class="btn small ghost" data-act="toggle" data-u="${escapeHtml(u.username)}" data-en="${u.enabled ? 1 : 0}">${u.enabled ? '禁用' : '启用'}</button>
        <button class="btn small ghost" data-act="del" data-u="${escapeHtml(u.username)}" style="color:#d93025">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无账号</td></tr>';
  // 最后一个启用中的管理员：禁用/删除按钮禁用
  body.querySelectorAll('button[data-act]').forEach((btn) => {
    const row = USERS.find((u) => u.username === btn.dataset.u);
    if (row && row.role === 'admin' && row.enabled && activeAdmins <= 1 && (btn.dataset.act === 'toggle' || btn.dataset.act === 'del')) {
      btn.disabled = true;
      btn.title = '至少保留 1 个启用中的管理员';
    }
  });
  body.querySelectorAll('button[data-act]').forEach((btn) => { btn.onclick = () => userAction(btn.dataset.act, btn.dataset.u); });
}

async function userAction(act, username) {
  if (!isAdminUser()) return showToast('仅管理员可操作', 'error');
  try {
    if (act === 'reset') {
      const pwd = prompt(`为 ${username} 设置新密码（至少 8 位）：`);
      if (!pwd) return;
      const r = await governedCall('usermgmt', 'resetPwd', { token: gateToken(), username, password: pwd });
      if (r && r.ok === false) throw new Error(errMsg(r, '重置失败'));
      showToast(`已重置 ${username} 的密码`, 'success');
    } else if (act === 'toggle') {
      const row = USERS.find((u) => u.username === username);
      const r = await governedCall('usermgmt', 'toggle', { token: gateToken(), username, enabled: !(row && row.enabled) });
      if (r && r.ok === false) throw new Error(errMsg(r, '操作失败'));
      showToast(`${username} 已${row && row.enabled ? '禁用' : '启用'}`, 'success');
    } else if (act === 'del') {
      if (!confirm(`确定删除账号 ${username}？此操作不可恢复`)) return;
      const r = await governedCall('usermgmt', 'delete', { token: gateToken(), username });
      if (r && r.ok === false) throw new Error(errMsg(r, '删除失败'));
      showToast(`已删除 ${username}`, 'success');
    }
    loadUsers();
  } catch (e) {
    showToast('操作失败：' + (e.message || e), 'error');
  }
}

document.getElementById('userAdd').onclick = async () => {
  if (!isAdminUser()) return showToast('仅管理员可操作', 'error');
  const username = (prompt('新账号用户名：') || '').trim();
  if (!username) return;
  if (USERS.some((u) => u.username === username)) return showToast('用户名已存在', 'error');
  const password = prompt(`为 ${username} 设置初始密码（至少 8 位）：`);
  if (!password) return;
  const role = prompt('角色（admin / ops / agent / readonly，默认 readonly）：', 'readonly').trim() || 'readonly';
  if (!USER_ROLES.includes(role)) return showToast('角色无效', 'error');
  try {
    const r = await governedCall('usermgmt', 'create', { token: gateToken(), username, password, role });
    if (r && r.ok === false) throw new Error(errMsg(r, '创建失败'));
    showToast(`账号 ${username}（${role}）已创建，请通知对方尽快登录`, 'success');
    loadUsers();
  } catch (e) {
    showToast('创建失败：' + (e.message || e), 'error');
  }
};
document.getElementById('userRefresh').onclick = loadUsers;
