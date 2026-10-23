/**
 * 电商知识库混合检索引擎（第一阶段）
 *
 * 混合策略 = BM25 关键词检索 + 字符 n-gram TF-IDF 向量语义检索（加权融合）
 *
 * 向量后端可插拔说明：
 *   用户指定的向量模型为千问3（qwen3-embedding），但当前 WorkBuddy 云服务 LLM 网关
 *   仅开放 chat completions 接口、无 embeddings 端点，因此第一阶段使用本地轻量
 *   字符向量算法兜底。后续接入 DashScope qwen3-embedding 时，只需实现下面的
 *   EmbedBackend.embed()（服务端持有 API Key），retrieval 层其余代码零改动。
 */
const EmbedBackend = {
  name: 'local-ngram', // 接入 qwen3-embedding 后改为 'qwen3-embedding'
  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]|null>} 向量数组；null 表示后端不可用，回退本地算法
   * 接入示例：POST https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding
   *           model: 'text-embedding-v3'(Qwen3-embedding 系列)，返回 vectors
   */
  async embed(texts) {
    return null; // 第一阶段：云网关无嵌入接口，回退本地算法
  },
};

// ---------- 分词：英文/数字词 + 中文二元 bigram + 中文单字 ----------
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  for (const w of s.match(/[a-z0-9]+/g) || []) tokens.push(w);
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
  for (const ch of cjk) tokens.push(ch);
  return tokens;
}

// ---------- BM25 ----------
function bm25Scores(queryTokens, docsTokens) {
  const N = docsTokens.length;
  const k1 = 1.5, b = 0.75;
  const avgdl = docsTokens.reduce((a, t) => a + t.length, 0) / (N || 1);
  const df = new Map();
  docsTokens.forEach((tokens) => {
    new Set(tokens).forEach((t) => df.set(t, (df.get(t) || 0) + 1));
  });
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const qSet = new Set(queryTokens);
  return docsTokens.map((tokens) => {
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let score = 0;
    for (const t of qSet) {
      const f = tf.get(t);
      if (!f) continue;
      score += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / avgdl));
    }
    return score;
  });
}

// ---------- 本地字符向量（TF-IDF 加权余弦相似度） ----------
function buildVectorIndex(docsTokens) {
  const vocabDf = new Map();
  docsTokens.forEach((tokens) => {
    new Set(tokens).forEach((t) => vocabDf.set(t, (vocabDf.get(t) || 0) + 1));
  });
  const N = docsTokens.length;
  const vecs = docsTokens.map((tokens) => {
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    const vec = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const idf = Math.log(1 + N / (vocabDf.get(t) || 1));
      const w = f * idf;
      vec.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });
  return { vecs };
}

function cosine(a, b) {
  let dot = 0;
  for (const [t, w] of a) { const w2 = b.get(t); if (w2) dot += w * w2; }
  return dot; // 均已归一化
}

// ---------- 口语化同义词扩展（功能验收3：口语化意图识别） ----------
// 用户口语表达 → 知识库规范词，检索前对查询做等价词扩展
const SYNONYMS = {
  '多少钱': ['价格', '售价'],
  '啥价': ['价格'],
  '贵不贵': ['价格'],
  '便宜': ['优惠', '活动'],
  '打折': ['优惠', '活动', '优惠券'],
  '折扣': ['优惠', '活动'],
  '邮费': ['运费', '快递'],
  '快递费': ['运费'],
  '多久能到': ['到货时间', '时效'],
  '几天到': ['到货时间', '时效'],
  '什么时候发货': ['发货时效'],
  '啥时候发货': ['发货时效'],
  '能退吗': ['退换货'],
  '退货': ['退换货'],
  '退款': ['退换货', '退款时效'],
  '保修': ['质保'],
  '坏了': ['质保', '质量问题'],
  '坏': ['质量问题'],
  '尺寸': ['尺码'],
  '大小': ['尺码'],
  '什么料': ['材质'],
  '什么材质': ['材质'],
  '材料': ['材质'],
  '积分怎么用': ['积分', '兑换'],
  '能便宜点吗': ['优惠', '活动'],
  '有活动吗': ['活动'],
  '优惠': ['优惠券'],
  '叠加': ['叠加规则', '同时使用'],
  '怎么洗': ['洗护'],
  '运输': ['快递', '物流'],
  '物流': ['快递'],
  '送货': ['发货', '快递'],
  '到货': ['到货时间'],
  '补发': ['质保', '配件'],
};

/** 对查询做同义词扩展，返回扩展后的查询文本（原文 + 等价词） */
function expandQuery(query) {
  let q = String(query || '');
  const extra = [];
  for (const [k, vals] of Object.entries(SYNONYMS)) {
    if (q.includes(k)) extra.push(...vals);
  }
  return extra.length ? q + ' ' + extra.join(' ') : q;
}

// ---------- 混合检索主入口 ----------
/**
 * @param {string} query 用户问题
 * @param {Array<{id:number,title:string,content:string,category:string,tags:string[]}>} chunks 已上架分块
 * @param {number} topK
 * @returns {{refs: Array<object>, usedBackend: string}} refs 携带 score（0~1）
 */
async function retrieve(query, chunks, topK = 4) {
  if (!chunks.length) return { refs: [], usedBackend: EmbedBackend.name };

  query = expandQuery(query); // 口语化同义词扩展后再检索
  const docsText = chunks.map((c) => `${c.title} ${c.content} ${(c.tags || []).join(' ')} ${c.category}`);
  const docsTokens = docsText.map(tokenize);
  const qTokens = tokenize(query);

  // 1) 尝试外部向量后端（qwen3-embedding 等）
  if (EmbedBackend.name !== 'local-ngram') {
    try {
      const qv = await EmbedBackend.embed([query]);
      const dv = await EmbedBackend.embed(docsText);
      if (qv && dv) {
        const scored = chunks.map((c, i) => ({
          ref: { ...c, score: cosineSim(qv[0], dv[i]) },
        })).filter((x) => x.ref.score > 0.3)
          .sort((a, b) => b.ref.score - a.ref.score)
          .slice(0, topK);
        return { refs: scored.map((x) => x.ref), usedBackend: EmbedBackend.name };
      }
    } catch (e) {
      console.warn('外部向量后端不可用，回退本地算法', e);
    }
  }

  // 2) 本地混合：BM25 + 字符向量
  // BM25 仅用「英文/数字词 + 中文二元词组」——单字会引入大量噪声命中；
  // 向量通道保留单字（短查询召回用）。
  const docsVec = docsText.map(tokenize);
  const docsBm = docsVec.map((t) => t.filter((x) => x.length > 1));
  const qVecTokens = tokenize(query);
  const qBmTokens = qVecTokens.filter((x) => x.length > 1);

  const bm25Raw = bm25Scores(qBmTokens, docsBm);
  const { vecs } = buildVectorIndex(docsVec);
  const qVec = buildVectorIndex([qVecTokens]).vecs[0];
  const bm25Max = Math.max(...bm25Raw, 0);

  const scored = chunks.map((c, i) => {
    const b = bm25Max > 0 ? bm25Raw[i] / bm25Max : 0;
    const v = Math.max(0, cosine(qVec, vecs[i]));
    return { ref: { ...c, score: 0.55 * b + 0.45 * v, bm25: b, vec: v }, raw: bm25Raw[i] };
  });

  // 绝对相关性门槛（防止归一化把不相关问题抬成高分）：
  // 需有实质关键词命中（raw BM25 ≥ 0.85，约等于一个中频二元词组命中）
  // 或较强语义重叠（字符向量余弦 ≥ 0.30）
  const hits = scored
    .filter((x) => x.raw >= 0.85 || x.ref.vec >= 0.30)
    .sort((a, b) => b.ref.score - a.ref.score)
    .slice(0, topK);

  const top = hits[0];
  if (!top || top.ref.score < 0.18) return { refs: [], usedBackend: 'local-ngram' };
  return { refs: hits.map((x) => x.ref), usedBackend: 'local-ngram' };
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- 知识条目自动分块（管理后台保存时调用） ----------
function chunkContent(content, target = 220, max = 400) {
  const paras = String(content || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length > max || buf.length >= target)) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [String(content || '').trim()];
}

// ---------- 歧义识别（功能验收3：歧义识别） ----------
/**
 * 判断检索结果是否存在歧义：top1 与 top2 分数接近（差距<15%）且分属不同知识条目。
 * 命中歧义时前端应先向用户澄清，而不是直接作答。
 * @returns {{ambiguous: boolean, candidates: Array<{title:string,category:string,score:number}>}}
 */
function detectAmbiguity(refs, closeGap = 0.15) {
  if (!refs || refs.length < 2) return { ambiguous: false, candidates: refs ? refs.slice(0, 1) : [] };
  const top = refs[0], second = refs[1];
  const differentEntries = top.title !== second.title;
  const ambiguous = differentEntries && (top.score - second.score) < closeGap && second.score >= 0.25;
  return {
    ambiguous,
    candidates: ambiguous ? [top, second] : [top],
  };
}

// ---------- Node 单元测试导出 ----------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tokenize, bm25Scores, buildVectorIndex, cosine, cosineSim,
    retrieve, chunkContent, expandQuery, detectAmbiguity, SYNONYMS,
    EmbedBackend,
  };
}
