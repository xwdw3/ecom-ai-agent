/**
 * 核心模块单元测试（技术验收4）
 * 运行：node --test tests/unit.test.mjs
 * 覆盖：分词 / BM25 / 向量余弦 / 混合检索与兜底阈值 / 同义词扩展 /
 *       歧义识别 / 自动分块 / 隐私脱敏
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/retrieval.js');
const P = require('../js/pii.js');

// ---------- 分词 ----------
test('tokenize: 英文/数字词 + 中文二元词组 + 单字', () => {
  const t = R.tokenize('保温杯500ml 质保');
  assert.ok(t.includes('500ml'));
  assert.ok(t.includes('保温'));
  assert.ok(t.includes('温杯'));
  assert.ok(t.includes('质'));
});

// ---------- BM25 ----------
test('bm25: 命中词多的文档得分更高，未命中文档得分为0', () => {
  const docs = [
    R.tokenize('优惠券使用规则 每单限用一张'),
    R.tokenize('发货时效说明 48小时内发货'),
    R.tokenize('退换货政策 7天无理由退换'),
  ];
  const scores = R.bm25Scores(R.tokenize('优惠券 怎么用'), docs);
  assert.equal(scores[1], 0, '无关文档应为0分');
  assert.equal(scores[2], 0);
  assert.ok(scores[0] > 0, '相关文档应大于0');
});

// ---------- 字符向量 ----------
test('向量余弦：语义相近文本得分高于无关文本', () => {
  const docs = [R.tokenize('保温杯12小时保温效果'), R.tokenize('优惠券不可与满减叠加')];
  const { vecs } = R.buildVectorIndex(docs);
  const q = R.buildVectorIndex([R.tokenize('保温壶能保温多久')]).vecs[0];
  const q2 = R.buildVectorIndex([R.tokenize('满减能用优惠券吗')]).vecs[0];
  assert.ok(R.cosine(q, vecs[0]) > R.cosine(q2, vecs[0]));
});

// ---------- 同义词扩展 ----------
test('expandQuery: 口语表达扩展出规范词', () => {
  const q = R.expandQuery('这个多少钱');
  assert.ok(q.includes('价格'));
  const q2 = R.expandQuery('邮费多少');
  assert.ok(q2.includes('运费'));
  const q3 = R.expandQuery('你好');
  assert.equal(q3, '你好', '无同义词时原文返回');
});

// ---------- 混合检索：命中与兜底 ----------
const KB = [
  { id: 1, entry_id: 1, chunk_index: 0, title: '纯棉白T恤（TEE-WT-001）', category: 'sku', tags: ['T恤'],
    content: '【商品参数】材质100%纯棉，克重240g。价格79元。' },
  { id: 2, entry_id: 2, chunk_index: 0, title: '发货时效说明', category: 'faq', tags: ['发货'],
    content: '现货付款后48小时内发货，普通地区约2-4天到货。' },
  { id: 3, entry_id: 3, chunk_index: 0, title: '优惠券与满减使用规则', category: 'faq', tags: ['优惠券'],
    content: '每单限用1张优惠券，优惠券与满减不可叠加使用。' },
  { id: 4, entry_id: 4, chunk_index: 0, title: '保温杯质保', category: 'sku', tags: ['保温杯'],
    content: '316不锈钢保温杯自签收起1年质保，配件终身免费补发。' },
];

test('retrieve: 相关问题命中正确知识条目', async () => {
  const { refs } = await R.retrieve('保温杯保修多久', KB, 4);
  assert.ok(refs.length >= 1);
  assert.equal(refs[0].title, '保温杯质保');
});

test('retrieve: 口语化问题经同义词扩展后命中', async () => {
  const { refs } = await R.retrieve('这个多少钱啊', KB, 4); // 扩展出"价格/售价"
  assert.ok(refs.length >= 1, '口语化价格问题应命中商品条目');
  assert.ok(['纯棉白T恤（TEE-WT-001）', '保温杯质保'].includes(refs[0].title));
});

test('retrieve: 无关问题返回空（触发兜底，抑制幻觉）', async () => {
  const { refs } = await R.retrieve('今天股市行情怎么样', KB, 4);
  assert.equal(refs.length, 0, '无关问题不得返回知识引用');
});

test('retrieve: 空知识库直接兜底', async () => {
  const { refs } = await R.retrieve('发货要多久', [], 4);
  assert.equal(refs.length, 0);
});

// ---------- 歧义识别 ----------
test('detectAmbiguity: top2分数接近且不同条目 → 判定歧义', () => {
  const refs = [
    { title: 'A规则', category: 'faq', score: 0.50 },
    { title: 'B规则', category: 'sku', score: 0.42 },
  ];
  const r = R.detectAmbiguity(refs);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});

test('detectAmbiguity: 分差明显 → 不判歧义', () => {
  const refs = [
    { title: 'A规则', category: 'faq', score: 0.60 },
    { title: 'B规则', category: 'sku', score: 0.30 },
  ];
  assert.equal(R.detectAmbiguity(refs).ambiguous, false);
});

test('detectAmbiguity: 单一候选不判歧义', () => {
  assert.equal(R.detectAmbiguity([{ title: 'A', score: 0.5 }]).ambiguous, false);
  assert.equal(R.detectAmbiguity([]).ambiguous, false);
});

// ---------- 自动分块 ----------
test('chunkContent: 长文按段落切分为多块，短文单块', () => {
  const long = Array.from({ length: 6 }, (_, i) => `第${i + 1}段：` + '商品参数说明'.repeat(20)).join('\n\n');
  const chunks = R.chunkContent(long);
  assert.ok(chunks.length >= 2, '长文应切分多块');
  chunks.forEach((c) => assert.ok(c.length <= 420, '单块不超过上限'));
  assert.deepEqual(R.chunkContent('短内容'), ['短内容']);
  assert.deepEqual(R.chunkContent(''), ['']);
});

// ---------- 隐私脱敏 ----------
test('maskPII: 手机号保留前3后4', () => {
  assert.equal(P.maskPII('请打我电话13812345678'), '请打我电话138****5678');
});

test('maskPII: 邮箱与身份证', () => {
  const out = P.maskPII('邮箱zhangsan@qq.com，证件110101199001011234');
  assert.ok(!out.includes('zhangsan@qq.com'));
  assert.ok(!out.includes('199001011234'));
});

test('maskPII: 详细地址掩码但保留省市', () => {
  const out = P.maskPII('寄到浙江省杭州市西湖区文一路100号2栋301室');
  assert.ok(!out.includes('文一路'), '门牌细节不得明文');
  assert.ok(out.includes('【地址已脱敏】'));
});

test('containsPII: 判定准确', () => {
  assert.equal(P.containsPII('电话13812345678'), true);
  assert.equal(P.containsPII('尺码怎么选'), false);
});
