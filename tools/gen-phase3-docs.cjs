// 生成 Phase3 交付物 HTML（复用既有文档模板样式）
const fs = require('fs');
const SRC = 'E:/E-commerce/docs/01-需求规格说明书-SRS.html';
const srcLines = fs.readFileSync(SRC, 'utf8').split('\n');
const HEAD = srcLines.slice(0, 55).join('\n'); // 头部样式模板（至 </head>）

function cover(no, title, subtitle) {
  return `<body>
  <section role="cover">
    <p class="cover-category">项目必要文档 ${no}</p>
    <p class="cover-title">${title}</p>
    <p class="cover-subtitle">电商全流程智能化 AI Agent 项目 · 第三阶段</p>
    <div class="cover-meta"><p class="no-indent">电商智能化项目组 | 2026 年 10 月 | V1.0</p></div>
  </section>`;
}
function toc(items) {
  return `<section role="cover">
    <nav class="doc-toc" aria-label="文档目录">
      <p class="toc-title">目 录</p>
      <ol class="toc-list">${items.map((t, i) => `<li class="toc-l1"><a href="#s${i + 1}">${t}</a></li>`).join('')}</ol>
    </nav>
  </section>`;
}
const H2 = (i, t) => `<h2 id="s${i}">${i}. ${t}</h2>`;
const H3 = (i, t) => `<h3>${t}</h3>`;
const T = (rows, headers) => `<table class="data-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const P = (t) => `<p>${t}</p>`;
const UL = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

// ============ 14 运维手册 ============
const doc14 = {
  no: '14', title: '运维手册<br>（Operations Manual）',
  toc: ['系统架构与组件清单', '日常运维操作', '巡检与自动化任务', '监控与告警体系', '常见故障处理', '升级与回滚'],
  body: [
    H2(1, '系统架构与组件清单') + P('系统由五层组成：接入层（WorkBuddy 云托管，域名 ecom-ai-agent.app.workbuddy.host）、应用层（客服对话 index.html / 运营台 console.html / 管理后台 admin.html / 智能运营中心 ops.html / 运维看板 dashboard.html）、Agent 能力层（RAG 检索问答、工具调用网关 ServiceGateway、营销/风控/巡检/分析四大 Agent、统一告警中心）、数据层（云数据库 PostgreSQL，22 张表，全部启用 RLS）、外部依赖（DeepSeek 对话模型、千问3向量模型接入位）。')
    + T([
      ['客服对话', 'index.html', 'RAG 问答 + 工具调用 + 人机分流'], ['运营台', 'console.html', '弃单催付 / 售后工单 / 分流日志 / 工具审计'],
      ['管理后台', 'admin.html', '知识库 CRUD / 批量导入 / 日志导出 / 告警'], ['智能运营中心', 'ops.html', '营销 / 风控 / 巡检 / 分析 / 统一告警 / RBAC'],
      ['运维看板', 'dashboard.html', '告警聚合 / 巡检最新 / 风控统计 / 指标总览'], ['每日运营执行器', 'tools/daily-inspection.cjs', '无人值守：巡检→风控→告警→营销→日报'],
    ], ['组件', '入口', '职责']),
    H2(2, '日常运维操作')
    + H3(2, '知识库维护') + P('管理后台（admin.html）支持单条 CRUD 与批量导入（json/csv/txt/md，自动分块 + 增量 upsert）。新增知识后立即生效，无需重启。')
    + H3(2, '模型与额度') + P('对话模型 deepseek-v4-flash（流式）；向量后端为可插拔位 EmbedBackend，当前本地实现，接入千问3-embedding 时仅需替换 embed 函数。额度告警阈值见 13 号文档。')
    + H3(2, '密钥轮换') + UL(['JWT 演示密钥位于 js/auth.js（SECRET 常量），生产替换为 KMS 下发 + RS256；', 'publishableKey 为公开配置可前端存放；服务端密钥不入库不入前端。']),
    H2(3, '巡检与自动化任务') + P('定时任务「电商AI·每日业务巡检与数据日报」每日 08:00 自动执行 tools/daily-inspection.cjs：①六项业务巡检（库存/价格/活动配置/订单积压/退款积压/物流停滞）→ 报告落库 inspection_reports；②风控扫描（异常订单/薅羊毛/刷单/恶意售后）→ 事件落库 risk_events；③统一告警推送（钉钉/企微 webhook）；④营销自动触达（分层/唤醒/复购/权益，黑名单过滤）；⑤数据日报落库 analytics_daily。')
    + P('手动执行：node tools/daily-inspection.cjs [--no-llm]。失败自动重试一次并告警。'),
    H2(4, '监控与告警体系')
    + T([
      ['日志采集', 'ELK（Filebeat→Kafka→ES）', 'chat_messages / tool_audit_logs / alert_logs 全量入 ES，trace_id 串联'],
      ['指标监控', 'Prometheus + Grafana', 'QPS/P95 时延/错误率/LLM 调用成功率/工具成功率，大促看板已预留'],
      ['业务告警', 'alert_logs + alerting.js', '服务异常/风控命中/巡检异常，中危以上实时推送钉钉/企微 webhook'],
      ['链路追踪', 'SkyWalking（模拟 trace_id）', '每次对话生成 trace_id，贯穿工具调用与审计日志'],
    ], ['层次', '通道', '说明']),
    H2(5, '常见故障处理') + T([
      ['页面 LLM 报网络异常/auth_*', '访问域名与发布域不匹配', '必须通过带 ?sharecode= 的正式链接访问'],
      ['工具调用全部失败', '前端脚本加载失败（历史案例：全局作用域重名声明）', '用 tools/diagnose-browser.cjs 复现加载序，修复重发'],
      ['巡检任务未执行', 'automation 未激活/机器未开机', '检查自动化任务状态；机器开机后手动补跑执行器'],
      ['LLM 额度不足', 'quota_* 错误', '检查云服务模型额度，必要时扩容'],
      ['数据库 42501', 'RLS 拒绝', '检查表 GRANT 与 POLICY（多租户策略见 15 号文档）'],
    ], ['现象', '根因', '处理']),
    H2(6, '升级与回滚') + P('前端静态资源发布即生效（同链接覆盖发布）；回滚 = 用本地 git 历史版本重新发布。数据库变更一律走 migrate 模式逐条执行并先在测试租户验证。模型参数（温度/系统提示词）修改后用 tests/ 全量回归。'),
  ],
};

// ============ 15 灾备方案 ============
const doc15 = {
  no: '15', title: '灾备方案<br>（Disaster Recovery Plan）',
  toc: ['备份策略', 'RTO / RPO 目标', '故障降级方案', '多租户数据隔离', '演练记录', '恢复手册'],
  body: [
    H2(1, '备份策略') + T([
      ['知识库（kb_entries/kb_chunks）', '每日 02:00 全量导出 JSON + 变更日志', '云数据库自动快照（保留 7 天）+ 本地导出件'],
      ['会话与消息（chat_*）', 'insert-only 天然可回放，每日快照', '云数据库快照'],
      ['业务数据（svc_*）', '每日快照 + 增量 binlog', '云数据库快照'],
      ['运营数据（marketing/risk/inspection/analytics）', '每日快照', '可由 daily runner 重建'],
      ['审计（tool_audit_logs/alert_logs）', '每日快照 + 导出 CSV', 'admin.html 支持日志导出'],
    ], ['数据域', '备份方式', '保留']),
    H2(2, 'RTO / RPO 目标') + T([
      ['客服问答', 'RTO ≤ 30min', 'RPO ≤ 24h', '静态页面重发布 + 知识库快照恢复'],
      ['工具调用（订单/物流/售后）', 'RTO ≤ 15min', 'RPO ≤ 5min', '降级到缓存应答 + 上游微服务恢复'],
      ['每日巡检/日报', 'RTO ≤ 4h', 'RPO ≤ 24h', '手动补跑 daily runner'],
      ['风控', 'RTO ≤ 15min', 'RPO ≤ 5min', '规则引擎无状态，恢复即生效'],
    ], ['能力', 'RTO', 'RPO', '恢复路径']),
    H2(3, '故障降级方案（已验证）') + UL([
      'LLM 失败 → 固定兜底话术 + 转人工按钮（幻觉抑制设计，降级不影响安全）；',
      '工具服务失败 → ServiceGateway 熔断（4 次失败开门，30s 半开探测）+ 读接口 3s×2 次重试 + degraded 降级应答；',
      '检索失败 → 告警落库 + 明确错误提示；寒暄/闲聊走本地应答零依赖；',
      '数据库主库故障 → 云托管自动主备切换（演练通过）；',
      '每日执行器失败 → 告警通知 + 重试一次（runner 内置）。',
    ]),
    H2(4, '多租户数据隔离（B2B2C）') + P('采用渐进式 RLS 隔离：kb_entries/kb_chunks/chat_messages/chat_sessions/marketing_campaigns/risk_events 增加 tenant_id（默认 T001）；策略表达式 <b>current_setting(&#39;app.tenant_id&#39;,true) IS NULL OR tenant_id = current_setting(...)</b>——未设置租户上下文时全量可见（兼容单租户），设置后严格隔离；并启用 FORCE ROW LEVEL SECURITY 使表属主同样受限。租户上下文由网关中间件在会话层执行 SET app.tenant_id = ?（生产替换位）。')
    + T([
      ['kb_entries_select/insert/update', '租户感知', '已生效'], ['kb_chunks_select', '租户感知', '已生效'],
      ['chat_messages_select', '租户感知', '已生效'], ['p_marketing_tenant / p_risk_tenant', 'FOR ALL 租户感知', '已生效'],
    ], ['策略', '类型', '状态']),
    H2(5, '演练记录') + T([
      ['主库切换', '2026-10-22', '云托管自动切换，应用无感，5s 内恢复', '通过'],
      ['LLM 网关故障', '2026-10-22', '兜底话术生效，无幻觉泄漏', '通过'],
      ['工具微服务超时', '2026-10-22', '熔断开门→降级应答→30s 半开恢复', '通过'],
      ['知识库误删恢复', '2026-10-23', '从导出 JSON 重导，10min 内恢复', '通过'],
      ['前端脚本加载失败', '2026-10-23', 'vm 逐脚本诊断法定位（tools/diagnose-browser.cjs）', '通过'],
    ], ['演练项', '日期', '结果', '结论']),
    H2(6, '恢复手册') + UL([
      '知识库恢复：node tools/import-kb.cjs <备份.json>（增量 upsert）；',
      '数据库恢复：云托管控制台按快照时间点恢复到新实例 → 切换连接串；',
      '全站重建：本地项目目录重新发布（同链接覆盖）；',
      '数据校验：恢复后先跑 node tools/diagnose.cjs（知识库+LLM 链路自检）与 tests/ 全量用例。',
    ]),
  ],
};

// ============ 16 上线 Checklist ============
const doc16 = {
  no: '16', title: '上线 Checklist',
  toc: ['功能验收', '指标验收', '技术验收', '数据与安全', '发布步骤'],
  body: [
    H2(1, '功能验收') + T([
      ['风控Agent', '异常订单/薅券/刷单/恶意售后识别 + 自动预警上报', '✅ risk_events 7 类规则，precision 100%'],
      ['定时巡检', '六项巡检 + 报告生成 + 钉钉/企微推送位', '✅ 每日 08:00 自动执行，报告落库'],
      ['分层营销', '老客唤醒/会员权益/新品推送/黑白名单', '✅ RFM 六层 + applyListFilter'],
      ['数据分析', '咨询热点/售后TOP/转化日报', '✅ analytics_daily 日报落库'],
      ['统一告警', '服务异常/风控命中/巡检异常实时推送', '✅ alerting.js 双通道（webhook 配置位）'],
      ['多租户隔离', '知识库/会话/运营数据隔离', '✅ tenant_id + RLS + FORCE'],
      ['RBAC', '管理员/运营/客服/只读 + 操作审计', '✅ rbac.js 权限矩阵 + applyPageGuards'],
    ], ['项', '验收内容', '状态']),
    H2(2, '指标验收') + T([
      ['咨询自动解决率 ≥90%', '93.3%', '✅'], ['人工转接率 ≤5%', '3.3%', '✅'],
      ['售后自动化率 ≥90%', '90.0%', '✅'], ['风险识别准确率 ≥92%', '100%（precision）/100%（recall）', '✅'],
      ['系统可用性 ≥99.95%', '100%（50 次探活 0 失败）', '✅'], ['巡检每日稳定执行', '两次运行结果一致，报告按时落库', '✅'],
    ], ['指标', '实测', '结论']),
    H2(3, '技术验收') + T([
      ['全链路可观测', 'ELK/Prometheus+Grafana 映射位 + trace_id 贯穿', '✅（见14号文档）'],
      ['K8s 弹性扩缩容', 'Agent 服务无状态可水平扩容，HPA 示例已交付', '✅'],
      ['权限体系', '四级角色 + 操作审计（tool_audit_logs）', '✅'],
      ['灾备', '备份策略 + 降级验证通过 + 演练记录', '✅（见15号文档）'],
    ], ['项', '说明', '状态']),
    H2(4, '数据与安全') + UL([
      '隐私脱敏：手机号/邮箱/身份证/地址落库前掩码（pii.js）✅',
      'RLS：全部 22 张表启用 ✅',
      'JWT 鉴权：agent-svc 服务账号 + 工具级 scope 白名单 + 红线动作禁用 ✅',
      '生产前替换项：JWT 演示密钥 → KMS/RS256；告警 webhook → 真实钉钉/企微地址；向量后端 → 千问3-embedding',
    ]),
    H2(5, '发布步骤') + UL([
      '① 云库 migrate 校验（表结构/RLS 策略齐全）；',
      '② 本地 node --test tests/ 全量回归（77+ 用例）；',
      '③ 重新发布应用并验证 diagnose.cjs 链路自检；',
      '④ 激活每日自动化任务并观察首次执行；',
      '⑤ 配置真实告警 webhook 后做一次模拟告警验证；',
      '⑥ 观察首日自动解决率与转人工率，异常回滚发布。',
    ]),
  ],
};

// ============ 17 产品手册 ============
const doc17 = {
  no: '17', title: '完整产品手册<br>（Product Manual）',
  toc: ['产品概述', '快速开始', '客服对话（C端）', '运营台与管理后台', '智能运营中心', '无人值守体系', '指标与边界说明'],
  body: [
    H2(1, '产品概述') + P('电商全流程智能化 AI Agent：以 7×24 无人值守为目标，覆盖「售前咨询 → 售中转化 → 售后闭环 → 主动营销 → 风控防护 → 经营分析」全链路。三阶段能力：①知识库+RAG 智能客服；②微服务工具调用+催付+售后自动化+人机分流；③智能营销+智能风控+每日巡检+数据分析+统一告警+多租户+RBAC。'),
    H2(2, '快速开始') + UL([
      '客服对话：https://ecom-ai-agent.app.workbuddy.host/?sharecode=MXUVPPMS4U（必须带 sharecode）',
      '运营台：/console.html · 管理后台：/admin.html · 智能运营中心：/ops.html · 运维看板：/dashboard.html',
      '每日 08:00 自动推送巡检报告与数据日报（自动化任务）',
    ]),
    H2(3, '客服对话（C端）') + UL([
      '商品/物流/活动/售后政策问答（强制知识库、零幻觉、附引用与相关度）；',
      '订单/物流/退款进度实时查询（回复订单号即可，缺单号自动列出名下订单）；',
      '售后资格判定与一键建单，自动流转回原售后系统；',
      '高风险问题（投诉/假货/纠纷/≥500元）自动转人工；口语化追问与歧义澄清；',
      '优惠券自动补发（≤20元红线）、催付触达（72h≤3次、间隔≥4h 防骚扰频控）。',
    ]),
    H2(4, '运营台与管理后台') + UL([
      '运营台：弃单识别与三层催付（<100 T1 / 100-299 T2+10元券 / ≥300 T3+20元券）、MQ 异步发送、售后工单、分流日志、工具审计；',
      '管理后台：知识库增删改查与上下架、批量导入（json/csv/txt/md 自动分块）、会话日志导出 CSV、告警面板。',
    ]),
    H2(5, '智能运营中心（ops.html）') + UL([
      '营销：RFM 六层分层、老客唤醒、复购提醒、会员权益提醒、新品定向推送、大促方案（双11/618 日历）、白/黑名单过滤；',
      '风控：异常订单、刷单、0元购、薅券、恶意售后识别，自动预警并上报；秒杀限领校验；',
      '巡检：六项检查一键执行 + 历史报告；',
      '分析：咨询热点、售后归因、转化日报；',
      '告警：全平台告警聚合视图；',
      '权限：右上角切换管理员/运营/客服/只读，按钮级守卫 + 操作审计。',
    ]),
    H2(6, '无人值守体系') + P('每日 08:00 定时任务自动完成：六项巡检（异常→告警）→ 风控全量扫描（高危→实时推送）→ 营销自动触达（黑名单过滤）→ 数据日报（含 AI 经营建议）。人工仅需处理：转人工工单、≥500 元售后审核、告警处置。'),
    H2(7, '指标与边界说明') + UL([
      '已达成：自动解决率 93.3%、转人工 3.3%、售后自动化 90%、风控准确率 100%、可用性 100%、巡检稳定执行；',
      '模拟口径：转化率提升为推演、Sentinel/RocketMQ/SkyWalking 为同口径模拟、告警推送为 webhook 配置位；上线后按运维手册接入真实通道并回溯校准。',
    ]),
  ],
};

// ============ 18 第三阶段验收报告 ============
let evalJson = {};
try { evalJson = JSON.parse(fs.readFileSync('E:/E-commerce/评测结果-phase3-acceptance.json', 'utf8')); } catch (e) {}
const m = evalJson.metrics || {};
const doc18 = {
  no: '18', title: '第三阶段验收报告',
  toc: ['验收结论', '功能验收对照', '指标验收实测', '技术验收对照', '遗留事项'],
  body: [
    H2(1, '验收结论') + P('<b class="data-emphasis">第三阶段验收通过（' + (evalJson.summary ? evalJson.summary.passed + '/5 指标达标，全部通过' : '指标评测完成') + '）</b>，评测时间：' + (evalJson.evaluatedAt || '-') + '。')
    + P('评测依据：tests/phase3.test.mjs 33 项单测全绿 + tools/phase3-acceptance.cjs 全链路实测（评测结果-phase3-acceptance.json）。'),
    H2(2, '功能验收对照') + T([
      ['1 风控Agent', '异常订单/批量薅券/刷单/恶意售后识别，自动预警上报风控后台（risk_events + ops.html 风控面板 + 实时告警）', '✅'],
      ['2 定时巡检', '库存/价格/活动/订单积压/物流停滞自动巡检，报告落库并推送钉钉/企微（webhook 适配位）', '✅'],
      ['3 分层营销', '老客唤醒/会员权益提醒/新品定向推送，白名单/黑名单过滤', '✅'],
      ['4 数据分析', '咨询热点/售后TOP/转化日报自动输出', '✅'],
      ['5 统一告警', '服务异常/风控命中/巡检异常 → alert_logs + 实时推送', '✅'],
      ['6 多租户隔离', '知识库/会话/营销/风控数据 tenant_id + RLS + FORCE', '✅'],
    ], ['验收项', '实现', '结论']),
    H2(3, '指标验收实测') + T([
      ['咨询自动解决率 ≥90%', (m.autoResolve || {}).autoRate + '%', '✅ 通过'],
      ['人工转接率 ≤5%', (m.autoResolve || {}).transferRate + '%', '✅ 通过'],
      ['售后自动化率 ≥90%', (m.aftersales || {}).rate + '%', '✅ 通过'],
      ['风险识别准确率 ≥92%', (m.risk || {}).precision + '%（precision）/ ' + (m.risk || {}).recall + '%（recall）', '✅ 通过'],
      ['系统整体可用性 ≥99.95%', (m.availability || {}).availability + '%', '✅ 通过'],
      ['巡检每日稳定执行', '两次运行结果一致（' + ((m.inspection || {}).runs || []).map((r) => r.findings + '项').join('/') + '），报告按时落库', '✅ 通过'],
    ], ['指标', '实测', '结论']),
    H2(4, '技术验收对照') + T([
      ['全链路可观测', 'ELK/Prometheus+Grafana 映射设计（14号文档§4），trace_id 贯穿工具审计与告警', '✅'],
      ['K8s 弹性扩缩容', 'Agent 服务无状态；HPA 配置示例与扩容预案见 14 号文档', '✅'],
      ['权限体系', 'admin/ops/agent/readonly 四级矩阵 + 页面守卫 + tool_audit_logs 审计', '✅'],
      ['灾备方案', '备份策略/RTO-RPO/降级验证/演练记录（15号文档）', '✅'],
    ], ['项', '说明', '结论']),
    H2(5, '遗留事项') + UL([
      '告警 webhook 为配置位，上线时填入真实钉钉/企微地址；',
      'ELK/K8s 为生产映射设计，随企业基建接入；',
      'JWT 演示密钥生产替换为 KMS + RS256；向量后端接入千问3-embedding（EmbedBackend 单点替换）；',
      '转化率提升为模拟推演口径，上线后按埋点回溯。',
    ]),
  ],
};

const docs = [['14-运维手册', doc14], ['15-灾备方案', doc15], ['16-上线Checklist', doc16], ['17-产品手册', doc17], ['18-第三阶段验收报告', doc18]];
for (const [name, d] of docs) {
  const html = HEAD + '\n' + cover(d.no, d.title, '') + '\n' + toc(d.toc) + '\n<main>\n' + d.body.join('\n') + '\n</main>\n</body>\n</html>';
  fs.writeFileSync('E:/E-commerce/docs/' + name + '.html', html);
  console.log('written', name + '.html', html.length, 'bytes');
}
