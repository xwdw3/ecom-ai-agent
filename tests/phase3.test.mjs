/**
 * Phase3 单测：营销 RFM/复购/大促 · 风控规则 · 巡检六项 · 数据分析
 * 需 import 语法（.mjs），用 createRequire 引 CJS 模块
 */
import { createRequire } from 'module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';

const req = createRequire(import.meta.url);
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketing = req(path.join(base, 'js', 'marketing.js'));
const risk = req(path.join(base, 'js', 'risk.js'));
const inspection = req(path.join(base, 'js', 'inspection.js'));
const analytics = req(path.join(base, 'js', 'analytics.js'));

const NOW = new Date('2026-10-23T12:00:00+08:00').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// ---------- 营销 ----------
test('RFM：高频高额近期 → champion', () => {
  const users = [{ user_id: 'U1', nickname: 'A', total_spend: 0 }];
  const orders = [
    { user_id: 'U1', status: 'completed', amount: 800, created_at: daysAgo(3) },
    { user_id: 'U1', status: 'completed', amount: 500, created_at: daysAgo(10) },
  ];
  const [r] = marketing.rfmSegment(users, orders, NOW);
  assert.equal(r.segment, 'champion');
  assert.equal(r.F, 2);
  assert.equal(r.M, 1300);
  assert.ok(r.R <= 14);
});

test('RFM：30天+未购 → lost；待付款不计入', () => {
  const users = [{ user_id: 'U2', nickname: 'B', total_spend: 500 }];
  const orders = [
    { user_id: 'U2', status: 'pending_payment', amount: 999, created_at: daysAgo(1) },
    { user_id: 'U2', status: 'completed', amount: 500, created_at: daysAgo(40) },
  ];
  const [r] = marketing.rfmSegment(users, orders, NOW);
  assert.equal(r.segment, 'lost');
  assert.equal(r.F, 1); // 待付款不算
});

test('RFM：15~30天未购 → sleepy', () => {
  const users = [{ user_id: 'U3', nickname: 'C' }];
  const orders = [{ user_id: 'U3', status: 'completed', amount: 100, created_at: daysAgo(20) }];
  assert.equal(marketing.rfmSegment(users, orders, NOW)[0].segment, 'sleepy');
});

test('RFM：首单14天内 → potential', () => {
  const users = [{ user_id: 'U4', nickname: 'D' }];
  const orders = [{ user_id: 'U4', status: 'completed', amount: 100, created_at: daysAgo(5) }];
  assert.equal(marketing.rfmSegment(users, orders, NOW)[0].segment, 'potential');
});

test('老客唤醒方案：含券额与目标人群', () => {
  const c = marketing.buildCampaign('wake', [{ user_id: 'U1' }, { user_id: 'U2' }], { segment: 'lost', coupon: 10 });
  assert.equal(c.campaign_type, 'wake');
  assert.ok(c.title.includes('老客唤醒'));
  assert.ok(c.content.includes('10 元'));
  assert.deepEqual(c.target_users, ['U1', 'U2']);
});

test('大促方案：日历命中双11', () => {
  const plan = marketing.promotionPlan('2026-11-11', []);
  assert.ok(plan.title.includes('双11'));
  assert.ok(plan.isCalendarHit);
  assert.ok(plan.content.includes('触达节奏'));
});

test('大促方案：未命中日历走通用主题', () => {
  const plan = marketing.promotionPlan('2026-07-01', []);
  assert.equal(plan.isCalendarHit, false);
  assert.ok(plan.title.includes('主题促销'));
});

test('复购提醒：超周期命中、未周期不命中', () => {
  const orders = [
    { user_id: 'U1', sku: 'TEE-WT-001', status: 'completed', amount: 79, created_at: daysAgo(20) },
    { user_id: 'U2', sku: 'TEE-WT-001', status: 'completed', amount: 79, created_at: daysAgo(5) },
  ];
  const cands = marketing.repurchaseCandidates(orders, { 'TEE-WT-001': 15 }, NOW);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].user_id, 'U1');
});

// ---------- 风控 ----------
test('刷单嫌疑：24h≥3单且含取消 → high/block', () => {
  const orders = [
    { user_id: 'X', order_no: 'A1', status: 'completed', amount: 79, created_at: daysAgo(0.2) },
    { user_id: 'X', order_no: 'A2', status: 'cancelled', amount: 79, created_at: daysAgo(0.3) },
    { user_id: 'X', order_no: 'A3', status: 'completed', amount: 79, created_at: daysAgo(0.4) },
  ];
  const events = risk.detectAbnormalOrders(orders, NOW);
  const ev = events.find((e) => e.event_type === 'brushing_suspect');
  assert.ok(ev);
  assert.equal(ev.risk_level, 'high');
  assert.equal(ev.action, 'block');
});

test('恶意下单：7天取消≥2 → medium/review', () => {
  const orders = [
    { user_id: 'Y', order_no: 'B1', status: 'cancelled', amount: 79, created_at: daysAgo(2) },
    { user_id: 'Y', order_no: 'B2', status: 'cancelled', amount: 79, created_at: daysAgo(4) },
  ];
  const ev = risk.detectAbnormalOrders(orders, NOW).find((e) => e.event_type === 'malicious_order');
  assert.ok(ev);
  assert.equal(ev.risk_level, 'medium');
  assert.equal(ev.action, 'review');
});

test('0元购：完成单金额≤1 → high/block', () => {
  const orders = [{ user_id: 'Z', order_no: 'C1', status: 'completed', amount: 0.01, created_at: daysAgo(1) }];
  const ev = risk.detectAbnormalOrders(orders, NOW).find((e) => e.event_type === 'zero_purchase');
  assert.ok(ev);
  assert.equal(ev.risk_level, 'high');
});

test('薅羊毛：同名券领取≥3 → high/block', () => {
  const grants = [
    { user_id: 'W', coupon_name: '新人券', amount: 5 },
    { user_id: 'W', coupon_name: '新人券', amount: 5 },
    { user_id: 'W', coupon_name: '新人券', amount: 5 },
  ];
  const ev = risk.detectWoolUsers(grants, [], NOW).find((e) => e.user_id === 'W');
  assert.ok(ev);
  assert.equal(ev.event_type, 'wool_coupon_abuse');
  assert.equal(ev.action, 'block');
});

test('秒杀限领：超限拦截、未超放行', () => {
  const grants = [{ user_id: 'W' }, { user_id: 'W' }];
  assert.equal(risk.seckillGuard(grants, 'W', 2).allow, false);
  assert.equal(risk.seckillGuard(grants, 'OTHER', 2).allow, true);
});

test('实时评估：羊毛党名单命中 → block', () => {
  const r = risk.assessOrder(
    { user_id: 'W', amount: 100 },
    [],
    { W: true }
  );
  assert.equal(r.risk_level, 'high');
  assert.equal(r.action, 'block');
  assert.ok(r.reasons.some((x) => x.includes('羊毛党')));
});

// ---------- 巡检 ----------
const P = (sku, name, price, stock, status) => ({ sku, name, price, stock, status });

test('巡检：负库存 high、低库存 mid', () => {
  const r = inspection.runInspection({ products: [P('A', '甲', 99, -5, 'on_sale'), P('B', '乙', 99, 3, 'on_sale')] }, NOW);
  const neg = r.findings.find((f) => f.target === 'A');
  const low = r.findings.find((f) => f.target === 'B');
  assert.equal(neg.severity, 'high');
  assert.equal(low.severity, 'mid');
});

test('巡检：价格异常（≤1元在售）→ high', () => {
  const r = inspection.runInspection({ products: [P('C', '丙', 0.01, 100, 'on_sale')] }, NOW);
  assert.equal(r.findings[0].check, 'price');
  assert.equal(r.severity, 'high');
});

test('巡检：在售无货配置错误 → activity_config', () => {
  const r = inspection.runInspection({ products: [P('D', '丁', 99, 0, 'on_sale')] }, NOW);
  assert.ok(r.findings.some((f) => f.check === 'activity_config'));
});

test('巡检：订单积压 48h 未发货（3单 → high）', () => {
  const orders = [
    { order_no: 'O1', status: 'paid', created_at: daysAgo(3) },
    { order_no: 'O2', status: 'paid', created_at: daysAgo(2.5) },
    { order_no: 'O3', status: 'paid', created_at: daysAgo(2.1) },
  ];
  const r = inspection.runInspection({ orders }, NOW);
  const f = r.findings.find((x) => x.check === 'order_backlog');
  assert.ok(f);
  assert.equal(f.severity, 'high');
  assert.ok(f.detail.includes('3 笔'));
});

test('巡检：退款积压 24h+ → mid', () => {
  const orders = [{ order_no: 'R1', status: 'refund_reviewing', created_at: daysAgo(2) }];
  const r = inspection.runInspection({ orders }, NOW);
  const f = r.findings.find((x) => x.check === 'refund_backlog');
  assert.ok(f);
});

test('巡检：物流停滞 72h+ → mid', () => {
  const logistics = [{
    order_no: 'L1', status: 'in_transit', company: '中通', tracking_no: 'T1',
    timeline: [{ desc: '发出', time: '2026-10-18 10:00' }],
  }];
  const r = inspection.runInspection({ logistics }, NOW);
  const f = r.findings.find((x) => x.check === 'logistics_stuck');
  assert.ok(f);
  assert.ok(f.detail.includes('L1'));
});

test('巡检：无异常 → ok', () => {
  const r = inspection.runInspection({
    products: [P('E', '戊', 99, 500, 'on_sale')], orders: [], refunds: [], logistics: [],
  }, NOW);
  assert.equal(r.severity, 'ok');
  assert.equal(r.findings.length, 0);
});

// ---------- 数据分析 ----------
test('热点统计：主题归类与热词', () => {
  const msgs = [
    { role: 'user', content: '订单SO123退款到哪一步了' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '白T恤是什么材质的？' },
    { role: 'user', content: '优惠券能和满减叠加吗' },
  ];
  const r = analytics.hotQuestions(msgs);
  assert.equal(r.totalConsults, 3);
  assert.ok(r.topTopics.some((t) => t.topic === '退款售后'));
  assert.ok(r.topTopics.some((t) => t.topic === '商品咨询'));
  assert.ok(r.topTopics.some((t) => t.topic === '优惠活动'));
});

test('售后归因：质量为首因 + 责任环节', () => {
  const tickets = [
    { question: '收到的杯子是破损的' }, { question: 'T恤开线了质量问题' },
  ];
  const r = analytics.aftersalesAttribution(tickets, []);
  assert.ok(r.topCause.cause.includes('质量'));
  assert.ok(r.topCause.owner.includes('质检'));
  assert.ok(r.conclusion.includes('首因'));
});

test('转化日报：自动解决率与GMV计算', () => {
  const now = NOW;
  const today = new Date(now).toISOString();
  const sessions = [{ created_at: today }, { created_at: today }];
  const messages = [
    { role: 'assistant', content: 'a', is_fallback: false, created_at: today },
    { role: 'assistant', content: 'b', is_fallback: true, created_at: today },
  ];
  const orders = [
    { order_no: 'T1', status: 'completed', amount: 100, created_at: today, paid_at: today },
    { order_no: 'T2', status: 'pending_payment', amount: 50, created_at: today },
  ];
  const r = analytics.conversionReport(sessions, messages, orders, [], now);
  assert.equal(r.ordersToday, 2);
  assert.equal(r.paidToday, 1);
  assert.equal(r.gmvToday, 100);
  assert.equal(r.autoResolveRate, 50.0);
});

// ---------- Phase3 验收补充：恶意售后 / 权益触达 / 黑白名单 / 告警 / RBAC ----------
const rbac = req(path.join(base, 'js', 'rbac.js'));
const alerting = req(path.join(base, 'js', 'alerting.js'));

test('恶意售后：7天内售后≥3 → high/block', () => {
  const tickets = [
    { ticket_no: 'T1', user_id: 'M1', order_no: 'O1', created_at: daysAgo(2), status: 'refunded' },
    { ticket_no: 'T2', user_id: 'M1', order_no: 'O2', created_at: daysAgo(3), status: 'refunded' },
    { ticket_no: 'T3', user_id: 'M1', order_no: 'O3', created_at: daysAgo(5), status: 'refunded' },
  ];
  const ev = risk.detectAftersalesAbuse(tickets, NOW).find((e) => e.user_id === 'M1' && e.event_type === 'aftersales_abuse');
  assert.ok(ev);
  assert.equal(ev.risk_level, 'high');
  assert.equal(ev.action, 'block');
});

test('恶意售后：正常用户不误报', () => {
  const tickets = [{ ticket_no: 'T9', user_id: 'M2', order_no: 'O9', created_at: daysAgo(1), status: 'refunded' }];
  const evs = risk.detectAftersalesAbuse(tickets, NOW).filter((e) => e.user_id === 'M2');
  assert.equal(evs.length, 0);
});

test('会员权益提醒：金牌/银牌各自文案，普通会员不触达', () => {
  const users = [
    { user_id: 'V1', nickname: '金', level: 'gold' },
    { user_id: 'V2', nickname: '银', level: 'silver' },
    { user_id: 'V3', nickname: '普', level: 'normal' },
  ];
  const rems = marketing.vipBenefitReminders(users);
  assert.equal(rems.length, 2);
  assert.ok(rems[0].content.includes('20 元') || rems[0].content.includes('金牌'));
});

test('新品定向推送：仅目标分层 + 内容含新品名', () => {
  const rfmUsers = [
    { user_id: 'A', segment: 'champion' }, { user_id: 'B', segment: 'lost' },
  ];
  const { targets, campaign } = marketing.newArrivalPush([{ sku: 'X', name: '秋冬新款羽绒被', is_new: true }], rfmUsers);
  assert.deepEqual(targets, ['A']);
  assert.ok(campaign.content.includes('羽绒被'));
});

test('黑白名单：黑名单过滤 + 白名单收敛', () => {
  const r1 = marketing.applyListFilter(['U1', 'U2', 'U3'], { blacklist: ['U2'] });
  assert.deepEqual(r1.allowed, ['U1', 'U3']);
  assert.equal(r1.blocked, 1);
  const r2 = marketing.applyListFilter(['U1', 'U2', 'U3'], { whitelist: ['U1'] });
  assert.deepEqual(r2.allowed, ['U1']);
  assert.equal(r2.blocked, 2);
});

test('告警中心：中危以上需推送、格式含等级标签', () => {
  assert.equal(alerting.shouldPush('high'), true);
  assert.equal(alerting.shouldPush('mid'), true);
  assert.equal(alerting.shouldPush('info'), false);
  const text = alerting.formatAlert({ alertType: 'risk_hit', severity: 'high', message: '测试告警' });
  assert.ok(text.includes('risk_hit'));
  assert.ok(text.includes('高危'));
});

test('告警推送：未配置 webhook 时模拟发送成功', async () => {
  const r = await alerting.pushToChannel('dingtalk', '测试');
  assert.equal(r.ok, true);
  assert.equal(r.simulated, true);
});

test('RBAC：权限矩阵判断', () => {
  assert.equal(rbac.can('admin', 'kb.edit'), true);
  assert.equal(rbac.can('readonly', 'kb.edit'), false);
  assert.equal(rbac.can('ops', 'marketing.send'), true);
  assert.equal(rbac.can('agent', 'marketing.send'), false);
  assert.equal(rbac.can('readonly', 'analytics.view'), true);
  assert.equal(rbac.can('ops', 'system.roleManage'), false); // 仅管理员
  const denied = rbac.requirePerm('readonly', 'risk.execute');
  assert.equal(denied.ok, false);
  assert.ok(denied.reason.includes('权限不足'));
});

test('RBAC：未注册权限默认拒绝', () => {
  assert.equal(rbac.can('admin', 'not.exist'), false);
});

// ---------- P0 加固：登录门禁 gate.js 纯函数 ----------
const gate = req(path.join(base, 'js', 'gate.js'));

test('gate：加盐 SHA-256 确定性与格式', async () => {
  const h1 = await gate.sha256Hex('salt123' + 'sample-pass-123');
  const h2 = await gate.sha256Hex('salt123' + 'sample-pass-123');
  const h3 = await gate.sha256Hex('salt999' + 'sample-pass-123');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('gate：会话校验（过期/角色非法/缺字段/缺服务端token）', () => {
  const now = 1700000000000;
  assert.equal(gate.validateSession({ u: 'admin', r: 'admin', t: 'x'.repeat(64), exp: now + 1000 }, now), true);
  assert.equal(gate.validateSession({ u: 'admin', r: 'admin', t: 'x'.repeat(64), exp: now - 1 }, now), false); // 过期
  assert.equal(gate.validateSession({ u: 'x', r: 'hacker', t: 'x'.repeat(64), exp: now + 1000 }, now), false); // 非法角色
  assert.equal(gate.validateSession({ u: 'admin', r: 'admin', exp: now + 1000 }, now), false); // 缺服务端 token（旧会话）
  assert.equal(gate.validateSession(null, now), false);
  assert.equal(gate.validateSession({ u: 'x' }, now), false); // 缺字段
});

test('gate：RBAC 角色降级 fail-closed', () => {
  // currentRole 无会话时必须返回 readonly 而非 admin（在 Node 无 sessionStorage 环境）
  assert.equal(rbac.currentRole(), 'readonly');
});

test('gate：权限矩阵未登录默认拒绝写操作', () => {
  assert.equal(rbac.can('readonly', 'kb.edit'), false);
  assert.equal(rbac.can('readonly', 'marketing.send'), false);
  assert.equal(rbac.can('readonly', 'risk.execute'), false);
  assert.equal(rbac.can('readonly', 'analytics.view'), true); // 只读可见
});

// ---------- P1：告警推送报文与钉钉加签 ----------
test('alerting：钉钉/企微报文构建', () => {
  const d = alerting.buildPayload('dingtalk', '标题行\n正文');
  assert.equal(d.msgtype, 'markdown');
  assert.equal(d.markdown.title, '标题行');
  const w = alerting.buildPayload('wecom', '企微内容');
  assert.equal(w.markdown.content, '企微内容');
});

test('alerting：钉钉加签与 Node HMAC 对拍', async () => {
  const crypto = (await import('node:crypto')).default;
  const secret = 'SECtest', ts = 1699999999999;
  const mine = await alerting.dingSign(secret, ts);
  const ref = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
  assert.equal(mine, ref);
  assert.equal(mine, await alerting.dingSign(secret, ts)); // 确定性
});


// ---------- P2：知识库审核流 + 版本化 ----------
const kbflow = req(path.join(base, 'js', 'kbflow.js'));

// 极简内存数据库（覆盖 kbflow 用到的链式调用）
function makeMockDb() {
  const tables = { kb_entries: [], kb_chunks: [], kb_versions: [] };
  let seq = 1000;
  function from(t) {
    const rows = tables[t];
    const b = { _filters: {}, _op: null, _payload: null };
    b.select = () => { b._op = b._op || 'select'; return b; };
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b; };
    b.update = (p) => { b._op = 'update'; b._payload = p; return b; };
    b.delete = () => { b._op = 'delete'; return b; };
    b.eq = (k, v) => { (b._filters[k] = b._filters[k] || []).push(v); return b; };
    b.order = () => b; b.limit = () => b;
    b.then = (res, rej) => {
      try {
        const match = (r) => Object.entries(b._filters).every(([k, vs]) => vs.includes(r[k]));
        if (b._op === 'insert') {
          const items = Array.isArray(b._payload) ? b._payload : [b._payload];
          const created = items.map((p) => ({ id: ++seq, created_at: new Date().toISOString(), ...p }));
          rows.push(...created);
          return res({ data: created, error: null });
        }
        if (b._op === 'update') {
          const hit = rows.filter(match);
          hit.forEach((r) => Object.assign(r, b._payload));
          return res({ data: hit, error: hit.length ? null : { message: 'no rows' } });
        }
        if (b._op === 'delete') {
          const keep = rows.filter((r) => !match(r));
          rows.length = 0; rows.push(...keep);
          return res({ data: null, error: null });
        }
        const out = rows.filter(match).slice().sort((x, y) => (y.version_no || 0) - (x.version_no || 0));
        return res({ data: out, error: null });
      } catch (e) { rej(e); }
    };
    return b;
  }
  return { database: { from }, _tables: tables };
}

// chunkContent stub（retrieval.js 在 Node 下未加载）
global.chunkContent = (c) => [c];
global.RBAC = { can: (r, p) => ({ admin: ['kb.edit', 'kb.review'], ops: ['kb.edit'], readonly: [] }[r] || []).includes(p) };

test('kbflow：完整生命周期 草稿→提交→审批→分块生效', async () => {
  const mock = makeMockDb();
  const db = mock.database;
  const entry = await kbflow.saveDraft(db, { category: 'faq', title: '测试知识', content: '内容A', tags: ['t'] }, 'ops:xiaoming');
  assert.equal(entry.status, 'draft');
  assert.equal(mock._tables.kb_chunks.length, 0, '草稿不建分块');
  await kbflow.submitReview(db, entry, 'ops:xiaoming');
  await kbflow.review(db, { ...entry, status: 'pending' }, true, 'admin:laowang', '');
  assert.ok(mock._tables.kb_chunks.length >= 1, '发布后分块生成');
  assert.equal(mock._tables.kb_chunks[0].status, 'published');
  const versions = await kbflow.listVersions(db, entry.id);
  assert.equal(versions[0].version_no, 3, '编辑/提交/发布 三次快照');
  assert.equal(versions[0].editor, 'admin:laowang');
  assert.equal(versions.map((v) => v.action).join(','), 'publish,submit,edit');
});

test('kbflow：驳回退回草稿', async () => {
  const mock = makeMockDb();
  const db = mock.database;
  const e = await kbflow.saveDraft(db, { category: 'faq', title: 'K2', content: 'B' }, 'ops:a');
  await kbflow.submitReview(db, e, 'ops:a');
  await kbflow.review(db, { ...e, status: 'pending' }, false, 'admin:b', '内容有误');
  const all = await db.from('kb_entries').select();
  assert.equal(all.data[0].status, 'draft');
  assert.equal(mock._tables.kb_chunks.length, 0, '驳回不产生分块');
  const versions = await kbflow.listVersions(db, e.id);
  assert.equal(versions[0].action, 'reject');
  assert.equal(versions[0].note, '内容有误');
});

test('kbflow：回滚生成新草稿而非直接上线', async () => {
  const mock = makeMockDb();
  const db = mock.database;
  const e = await kbflow.saveDraft(db, { category: 'sku', title: 'K3', content: '旧内容' }, 'ops:a');
  await kbflow.editToDraft(db, e.id, { category: 'sku', title: 'K3', content: '新内容' }, 'ops:a');
  const entry = (await db.from('kb_entries').select()).data[0];
  const saved = await kbflow.rollbackTo(db, entry, 1, 'admin:b');
  assert.equal(saved.content, '旧内容');
  assert.equal(saved.status, 'draft');
  const versions = await kbflow.listVersions(db, entry.id);
  assert.equal(versions[0].action, 'rollback');
});

test('kbflow：权限矩阵 编辑者不能自审', () => {
  assert.equal(kbflow.kbCanDo('submit', 'ops'), true);
  assert.equal(kbflow.kbCanDo('review', 'ops'), false);
  assert.equal(kbflow.kbCanDo('review', 'admin'), true);
  assert.equal(kbflow.kbCanDo('edit', 'readonly'), false);
});

test('kbflow：非法状态迁移被拒绝', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => kbflow.review(db, { id: 1, status: 'published' }, true, 'admin:x', ''),
    /不在待审核状态/,
  );
});

test('kbflow：传输模式下所有写操作路由到服务端网关', async () => {
  const calls = [];
  kbflow.setKbTransport(async (action, args) => {
    calls.push([action, args]);
    return { id: 1, status: 'draft' };
  });
  try {
    const db = makeMockDb();
    await kbflow.saveDraft(db, { category: 'faq', title: 'T', content: 'C' }, 'ops:a');
    await kbflow.submitReview(db, { id: 5, status: 'draft' }, 'ops:a');
    await kbflow.review(db, { id: 5, status: 'pending', title: 'T', content: 'C', category: 'faq', tags: [] }, true, 'admin:b', '');
    await kbflow.offlineEntry(db, { id: 5, status: 'published', title: 'T', content: 'C', category: 'faq', tags: [] }, 'ops:a');
    await kbflow.republish(db, { id: 5, status: 'offline', title: 'T', content: 'C', category: 'faq', tags: [] }, 'admin:b');
    await kbflow.rollbackTo(db, { id: 5 }, 1, 'admin:b');
    await kbflow.deleteEntry(db, { id: 5 });
    await kbflow.importPublished(db, { category: 'faq', title: 'I', content: 'X', tags: [] }, 'admin:b');
    await kbflow.importUpdate(db, 5, { category: 'faq', title: 'I', content: 'Y', tags: [] }, 'admin:b');
    assert.deepEqual(calls.map((c) => c[0]),
      ['save_draft', 'submit', 'review', 'offline', 'republish', 'rollback', 'delete', 'import', 'import_update']);
    // 发布类动作必须携带分块
    assert.ok(Array.isArray(calls[2][1].chunks) && calls[2][1].chunks.length >= 1, 'review 携带分块');
    assert.ok(Array.isArray(calls[4][1].chunks) && calls[4][1].chunks.length >= 1, 'republish 携带分块');
    assert.ok(Array.isArray(calls[7][1].chunks) && calls[7][1].chunks.length >= 1, 'import 携带分块');
    assert.ok(Array.isArray(calls[8][1].chunks) && calls[8][1].chunks.length >= 1, 'import_update 携带分块');
    // 驳回不需要分块
    calls.length = 0;
    await kbflow.review(makeMockDb(), { id: 5, status: 'pending', title: 'T', content: 'C', category: 'faq', tags: [] }, false, 'admin:b', '');
    assert.equal(calls[0][1].chunks, undefined, '驳回不带分块');
  } finally {
    kbflow.setKbTransport(null); // 还原直连模式，避免影响后续测试
  }
});

test('kbflow：传输模式下不再直连写库（mock 库无变化）', async () => {
  kbflow.setKbTransport(async () => ({ id: 1, status: 'draft' }));
  try {
    const mock = makeMockDb();
    await kbflow.saveDraft(mock.database, { category: 'faq', title: 'T2', content: 'C2' }, 'ops:a');
    assert.equal(mock._tables.kb_entries.length, 0, '写操作未触达直连 mock 库');
  } finally {
    kbflow.setKbTransport(null);
  }
});
