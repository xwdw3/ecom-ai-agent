# CI/CD 流水线 与 影子评测体系 说明

> 2026-10-23 上线。发布前置门禁 + 真实流量影子回放，配套能力补齐第二阶段设计说明 §8 的工程化要求。

## 一、CI/CD 流水线

### 本地一键门禁（主入口）

```bash
node tools/pipeline.cjs              # 完整流水线
node tools/pipeline.cjs --skip-cloud # 仅静态+单测（无云凭据环境）
node tools/pipeline.cjs --skip-e2e   # 跳过 MQ e2e（快速迭代）
```

| 阶段 | 内容 | 门禁条件 |
|---|---|---|
| ① static-load | vm 沙箱模拟浏览器逐脚本加载全部 js（抓跨脚本全局命名冲突——第二阶段"不回答问题"事故的回归防线） | 零加载失败 |
| ② unit-tests | 6 个测试文件（unit/phase2/acceptance2/phase3/mq/shadow） | 全部通过 |
| ③ cloud-smoke | 云库连通：published KB 非空 / mq_stats 可用 / 核心表可达 | 三项全通 |
| ④ mq-e2e | 真实 MQ 端到端（rpc 通道 15 项） | 全 PASS |
| ⑤ 报告 | logs/pipeline-report-<ts>.json + 退出码 | 任一失败 exit 1 |

**发布纪律**：门禁通过 ≠ 自动发布。发布仍由人工确认后执行（流水线打印"可执行发布"提示），避免未验证内容覆盖线上。

### 远端 CI（.github/workflows/ci.yml）

- `static-and-unit` job：GitHub runner 上 `node tools/pipeline.cjs --skip-cloud --skip-e2e`（vm 加载 + 全量单测）
- `full-gate` job（可选 self-hosted runner）：完整流水线含云冒烟与 MQ e2e
- 代码推送到 GitHub 后即生效，无需额外配置

### 实测结果（2026-10-23）

static-load 6 脚本零冲突 / unit-tests 113/113 / cloud-smoke kb=12块+mq连通 / mq-e2e 15 PASS → **PASS**，报告在 logs/pipeline-report-*.json

## 二、影子评测体系

### 定位

把**线上真实用户问题**（chat_messages 中 role='user' 的真实流量）在影子链路中重放，对比"基线 vs 候选变体"，为新 KB 配置/检索参数/规划开关提供上线前量化依据。**影子纪律：只读线上数据、不写 chat_messages、不影响真实会话。**

### 组成

- `js/shadow.js`：纯逻辑核心（Node/浏览器双端）——流量采样去重、与 chat.js 同口径的三级路由影子执行（分流→寒暄→工具→RAG）、指标汇总（工具命中率/兜底率/转人工率/平均与p95时延）、基线vs候选对比（指标差+逐题路由差异）
- `tools/shadow-eval.cjs`：执行器
  ```bash
  node tools/shadow-eval.cjs --n 20                          # 基线 vs 候选(ragTopK=6)
  node tools/shadow-eval.cjs --variant '{"llmPlan":false}'   # 自定义变体
  node tools/shadow-eval.cjs --no-llm                        # 结构评测（不调生成模型，快）
  ```
- 变体参数：`ragTopK`（检索条数）/ `llmPlan`（LLM 规划开关）/ `llmAnswer`（是否真实生成，false 时按检索命中近似判定）
- 落库：云库 `shadow_eval_runs` 表（run_id/variant/question/route/latency_ms/is_fallback，RLS 全开）→ 支持跨版本趋势回溯；本地报告 `logs/shadow-eval-<ts>.json`

### 实测结果（2026-10-23）

- 真实流量采样：chat_messages 去重后 5 条真实问题（材质/优惠券/退款进度/寒暄×2）
- 结构评测 + 完整 LLM 生成两轮各基线/候选共 4 组：工具命中、兜底率、路由全部与预期一致，逐题差异 0 处（检索池小，ragTopK 4→6 无命中差异，属预期）
- 结果落库 40/40 条，`SELECT variant, route, COUNT(*), AVG(latency_ms) FROM shadow_eval_runs GROUP BY 1,2` 可查

### 使用场景

1. **改 KB / 检索参数前**：跑影子评测，看兜底率与命中率变化
2. **改规划规则/提示词前**：对比 llmPlan 开/关、新 prompt 的路由差异
3. **回归防线**：CI 门禁保证"不坏"，影子评测保证"变更有效"
