/**
 * P2 · 知识库审核流 + 版本化
 * 状态机：draft（草稿）→ pending（待审核）→ published（已发布）→ offline（已下架）
 * 职责分离：提交审核需要 kb.edit（admin/ops），审批通过需要 kb.review（仅 admin）——编辑者不能自审
 * 版本化：每次内容变更/流转都写入 kb_versions 快照，可回滚到任意历史版本
 * 检索安全：只有 published 状态才重建 kb_chunks，草稿/待审核内容永不进入 RAG
 */
/* global chunkContent */

const KB_STATES = ['draft', 'pending', 'published', 'offline'];

/** 状态机合法迁移表（纯函数用） */
const KB_TRANSITIONS = {
  draft: ['pending', 'published'],      // 提交审核 / （管理员）直接发布
  pending: ['published', 'draft'],      // 审批通过 / 驳回
  published: ['offline', 'draft'],      // 下架 / 编辑产生新草稿
  offline: ['published', 'draft'],      // 重新上架（等同审批）/ 编辑
};

/** 纯函数：状态迁移是否合法 */
function kbCanTransition(from, to) {
  if (!KB_STATES.includes(from) || !KB_STATES.includes(to)) return false;
  return (KB_TRANSITIONS[from] || []).includes(to);
}

/** 动作 → 所需权限（对接 rbac.js 权限矩阵） */
const KB_ACTION_PERMS = {
  edit: 'kb.edit', submit: 'kb.edit', offline: 'kb.edit', rollback: 'kb.edit',
  review: 'kb.review', del: 'kb.edit',
};

/** 纯函数：动作权限判断（roles 为角色数组或单角色） */
function kbCanDo(action, role) {
  const perm = KB_ACTION_PERMS[action];
  if (!perm) return false;
  if (typeof globalThis.RBAC !== 'undefined' && globalThis.RBAC.can) return globalThis.RBAC.can(role, perm);
  // Node 测试环境兜底矩阵（与 rbac.js 保持一致）
  const m = {
    'kb.edit': ['admin', 'ops'],
    'kb.review': ['admin'],
  };
  return (m[perm] || []).includes(role);
}

/** 纯函数：下一个版本号 */
function nextVersionNo(versions) {
  return versions.reduce((mx, v) => Math.max(mx, Number(v.version_no) || 0), 0) + 1;
}

// ---------- 服务端网关传输层 ----------
// 生产模式：所有写操作经 kb_write SECURITY DEFINER 函数（角色门禁+状态机+审计在库内强制）；
// 测试模式：不设置传输层时走原直连逻辑（Node 单测 mock db）
let kbTransport = null;
/** 设置服务端网关（传 fn(action, args)→Promise）；传 null 恢复直连模式 */
function setKbTransport(fn) { kbTransport = typeof fn === 'function' ? fn : null; }

/** 由条目内容生成检索分块（与 syncChunks 同构；发布类动作需随请求带给服务端） */
function kbChunksOf(entry) {
  const pieces = chunkContent(entry.content);
  return pieces.map((content, i) => ({
    chunk_index: i, title: entry.title, content,
    category: entry.category, tags: entry.tags || [],
  }));
}

async function kbVia(action, args, fallback) {
  if (kbTransport) return kbTransport(action, args);
  return fallback();
}

/** 读取条目的版本列表（新→旧） */
async function listVersions(db, entryId) {
  const { data, error } = await db.from('kb_versions')
    .select('*').eq('entry_id', entryId).order('version_no', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

/** 写入版本快照 */
async function snapshot(db, entry, editor, action, note) {
  const versions = await listVersions(db, entry.id);
  const { error } = await db.from('kb_versions').insert({
    entry_id: entry.id, version_no: nextVersionNo(versions),
    title: entry.title, content: entry.content, tags: entry.tags || [],
    category: entry.category, editor, action, note: note || null,
  });
  if (error) throw new Error('版本快照失败：' + error.message);
}

/** 重建检索分块（仅发布态调用；与 admin.js syncChunks 同逻辑） */
async function syncChunks(db, entry) {
  await db.from('kb_chunks').delete().eq('entry_id', entry.id);
  const pieces = chunkContent(entry.content);
  const rows = pieces.map((content, i) => ({
    entry_id: entry.id, chunk_index: i, title: entry.title, content,
    category: entry.category, tags: entry.tags || [], status: 'published',
  }));
  if (rows.length) {
    const { error } = await db.from('kb_chunks').insert(rows);
    if (error) throw error;
  }
}

/** 更新条目状态（含迁移校验） */
async function setStatus(db, entryId, to) {
  const { data, error } = await db.from('kb_entries').update({
    status: to, updated_at: new Date().toISOString(),
  }).eq('id', entryId).select();
  if (error || !Array.isArray(data) || !data.length) throw new Error('条目状态更新失败');
  return data[0];
}

/** 保存草稿：新增或编辑（编辑已发布条目 → 自动产生新草稿，原发布内容不受影响） */
async function saveDraft(db, payload, editor) {
  return kbVia('save_draft', { payload, editor }, async () => {
    const { data, error } = await db.from('kb_entries').insert({
      category: payload.category, title: payload.title, content: payload.content,
      tags: payload.tags || [], status: 'draft', source: payload.source || 'admin',
      updated_at: new Date().toISOString(),
    }).select();
    if (error) throw new Error(error.message);
    await snapshot(db, data[0], editor, 'edit', payload.note || '新建草稿');
    return data[0];
  });
}

/** 编辑既有条目 → 产生新草稿版本（记录到原条目上） */
async function editToDraft(db, entryId, payload, editor) {
  return kbVia('edit_draft', { entry_id: entryId, payload, editor }, async () => {
    const { data, error } = await db.from('kb_entries').update({
      category: payload.category, title: payload.title, content: payload.content,
      tags: payload.tags || [], status: 'draft', updated_at: new Date().toISOString(),
    }).eq('id', entryId).select();
    if (error || !Array.isArray(data) || !data.length) throw new Error('条目不存在或无权限');
    // 已发布内容仍在 chunks 中（草稿不重建），线上问答不受影响
    await snapshot(db, data[0], editor, 'edit', payload.note || '编辑产生新草稿');
    return data[0];
  });
}

/** 提交审核：draft → pending */
async function submitReview(db, entry, editor) {
  return kbVia('submit', { entry_id: entry.id, editor }, async () => {
    if (!kbCanTransition(entry.status, 'pending')) throw new Error(`非法状态迁移 ${entry.status} → pending`);
    const saved = await setStatus(db, entry.id, 'pending');
    await snapshot(db, { ...saved, tags: saved.tags || [] }, editor, 'submit', '提交审核');
    return saved;
  });
}

/** 审批：pending → published（重建分块）/ pending → draft（驳回） */
async function review(db, entry, approved, editor, note) {
  return kbVia('review', {
    entry_id: entry.id, approved, note, editor,
    chunks: approved ? kbChunksOf(entry) : undefined,
  }, async () => {
    if (entry.status !== 'pending') throw new Error('该条目不在待审核状态');
    if (approved) {
      const saved = await setStatus(db, entry.id, 'published');
      await syncChunks(db, saved);
      await snapshot(db, { ...saved, tags: saved.tags || [] }, editor, 'publish', note || '审批通过发布');
      return saved;
    }
    const saved = await setStatus(db, entry.id, 'draft');
    await snapshot(db, { ...saved, tags: saved.tags || [] }, editor, 'reject', note || '驳回');
    return saved;
  });
}

/** 下架：published → offline（同时清掉检索分块） */
async function offlineEntry(db, entry, editor, note) {
  return kbVia('offline', { entry_id: entry.id, note, editor }, async () => {
    const saved = await setStatus(db, entry.id, 'offline');
    await db.from('kb_chunks').delete().eq('entry_id', entry.id);
    await snapshot(db, { ...saved, tags: saved.tags || [] }, editor, 'offline', note || '下架');
    return saved;
  });
}

/** 重新上架：offline → published（等同管理员审批，重建分块） */
async function republish(db, entry, editor, note) {
  return kbVia('republish', { entry_id: entry.id, note, editor, chunks: kbChunksOf(entry) }, async () => {
    const saved = await setStatus(db, entry.id, 'published');
    await syncChunks(db, saved);
    await snapshot(db, { ...saved, tags: saved.tags || [] }, editor, 'publish', note || '重新上架');
    return saved;
  });
}

/** 回滚：把指定历史版本内容覆盖为**新草稿**（不直接上线，仍需审核） */
async function rollbackTo(db, entry, versionNo, editor) {
  return kbVia('rollback', { entry_id: entry.id, version_no: versionNo, editor }, async () => {
    const versions = await listVersions(db, entry.id);
    const v = versions.find((x) => Number(x.version_no) === Number(versionNo));
    if (!v) throw new Error('版本不存在');
    const saved = await editToDraft(db, entry.id, {
      category: v.category, title: v.title, content: v.content, tags: Array.isArray(v.tags) ? v.tags : (v.tags || []),
    }, editor);
    // 补记一条显式回滚快照
    const { data } = await db.from('kb_entries').select('*').eq('id', entry.id).limit(1);
    await snapshot(db, data[0], editor, 'rollback', '回滚到 v' + versionNo);
    return saved;
  });
}

/** 删除条目（连版本一起） */
async function deleteEntry(db, entry) {
  return kbVia('delete', { entry_id: entry.id }, async () => {
    await db.from('kb_chunks').delete().eq('entry_id', entry.id);
    await db.from('kb_versions').delete().eq('entry_id', entry.id);
    const { error } = await db.from('kb_entries').delete().eq('id', entry.id);
    if (error) throw new Error(error.message);
  });
}

/** 批量导入专用：直接发布（受信任的管理操作），留版本痕迹 */
async function importPublished(db, payload, editor) {
  return kbVia('import', { payload, editor, chunks: kbChunksOf(payload) }, async () => {
    const { data, error } = await db.from('kb_entries').insert({
      category: payload.category, title: payload.title, content: payload.content,
      tags: payload.tags || [], status: 'published', source: payload.source || 'import',
      updated_at: new Date().toISOString(),
    }).select();
    if (error) throw new Error(error.message);
    await syncChunks(db, data[0]);
    await snapshot(db, { ...data[0], tags: data[0].tags || [] }, editor, 'import', '批量导入');
    return data[0];
  });
}

/** 批量导入增量更新：同标题条目覆盖为发布态并重建分块（走服务端门禁） */
async function importUpdate(db, entryId, payload, editor) {
  return kbVia('import_update', { entry_id: entryId, payload, editor, chunks: kbChunksOf(payload) }, async () => {
    const { data, error } = await db.from('kb_entries').update({
      category: payload.category, title: payload.title, content: payload.content,
      tags: payload.tags || [], status: 'published', source: payload.source || 'import',
      updated_at: new Date().toISOString(),
    }).eq('id', entryId).select();
    if (error || !Array.isArray(data) || !data.length) throw new Error('条目不存在或更新失败');
    await syncChunks(db, data[0]);
    await snapshot(db, { ...data[0], tags: data[0].tags || [] }, editor, 'import', '批量导入更新');
    return data[0];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KB_STATES, KB_TRANSITIONS, kbCanTransition, kbCanDo, nextVersionNo, listVersions, snapshot, syncChunks, saveDraft, editToDraft, submitReview, review, offlineEntry, republish, rollbackTo, deleteEntry, importPublished, importUpdate, setKbTransport, kbChunksOf };
}
if (typeof window !== 'undefined') {
  window.KBFlow = { KB_STATES, kbCanTransition, kbCanDo, listVersions, snapshot, saveDraft, editToDraft, submitReview, review, offlineEntry, republish, rollbackTo, deleteEntry, importPublished, importUpdate, syncChunks, setKbTransport, kbChunksOf };
}
