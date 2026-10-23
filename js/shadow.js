/**
 * shadow.js —— 影子评测核心（纯逻辑，Node/浏览器双端，无 DOM 依赖）
 * 用途：把线上真实用户问题在"影子链路"中重放，对比 基线 vs 候选变体 的表现，不影响线上
 * 影子链路三级判定与 chat.js 线上流水线一致：分流(riskRoute) → 寒暄 → 工具(rulePlan→executeTool) → RAG(retrieve→LLM)
 * 变体（opts）：ragTopK（检索条数）、llmPlan（是否启用 LLM 规划兜底）、llmAnswer（是否真实生成回答，false 时按检索命中近似判定）
 * 影子纪律：只读线上数据、不写 chat_messages、不影响真实会话
 */
(function (global) {
  'use strict';

  const FALLBACK_MARK = '超出了我的知识范围';

  // 与 chat.js SMALLTALK_REPLIES 保持同步的寒暄判定
  const SMALLTALK_RES = [
    /^(你好|您好|hi|hello|嗨|哈喽|在吗|在么|在不在)(呀|啊|哟|呦)?[\s!！。~～?？]*$/i,
    /^(谢谢|多谢|感谢|辛苦了|thank you|thanks)(啦|了|你|您)?[\s!！。~～]*$/i,
    /^(你是谁|你叫什么|你是什么|介绍一下你自己|你能做什么|你会什么|有什么功能|你能干什么|再见|拜拜)[\s?？!！。]*$/i,
  ];
  function matchSmalltalk(q) {
    const s = String(q || '').trim();
    return SMALLTALK_RES.some((re) => re.test(s));
  }

  /** 从 chat_messages 真实流量采样问题：去重（保留最近）、可选条数 */
  function sampleQuestions(messages, n) {
    const seen = new Set();
    const out = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== 'user' || !m.content) continue;
      const q = String(m.content).trim();
      if (!q || q.length > 100 || seen.has(q)) continue;
      seen.add(q);
      out.push({ question: q, session_id: m.session_id || null, created_at: m.created_at || null });
      if (n && out.length >= n) break;
    }
    return out;
  }

  /**
   * 单题影子执行：完整复刻线上三级流水线
   * deps: { cloud, tools, retrieval, kbChunks, token }
   * opts: { ragTopK=4, llmPlan=true, llmAnswer=true, userId='U1001' }
   */
  async function runShadowCase(item, deps, opts) {
    opts = opts || {};
    const tools = deps.tools;
    const q = item.question;
    const t0 = Date.now();
    const rec = { question: q, session_id: item.session_id || null, route: 'rag', source: '', latencyMs: 0, isFallback: false, answerPreview: '', toolResult: null, refsCount: 0, topScore: 0, error: null };
    try {
      // 1. 分流（高风险词 → 转人工）
      const gate = tools.riskRoute(q, {});
      if (gate.route === 'human') {
        rec.route = 'human'; rec.source = 'risk-route'; rec.isFallback = false;
        rec.answerPreview = gate.reason || '转人工';
        rec.latencyMs = Date.now() - t0;
        return rec;
      }
      // 2. 寒暄本地应答
      if (matchSmalltalk(q)) {
        rec.route = 'smalltalk'; rec.source = 'local'; rec.latencyMs = Date.now() - t0;
        rec.answerPreview = '本地寒暄应答';
        return rec;
      }
      // 3. 工具路径（确定性规则优先 → LLM 规划兜底）
      const orderNo = tools.extractOrderNo(q);
      let plan = tools.rulePlan(q, { orderNo, userId: opts.userId || 'U1001' });
      if (!plan && opts.llmPlan !== false && deps.cloud) {
        let out = '';
        for await (const ch of deps.cloud.llm.chat.completions.create({
          model: deps.model || 'deepseek-v4-flash', stream: true, temperature: 0,
          messages: [{ role: 'user', content: tools.buildPlannerPrompt(q) }],
        })) {
          const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
          if (d) out += d;
        }
        plan = tools.parseAgentPlan(out);
      }
      if (plan && plan.tool && deps.token) {
        const r = await tools.executeTool(plan, { token: deps.token, traceId: 'shadow-' + Date.now() });
        rec.toolResult = r;
        const ok = r && !r.degraded && !r.error;
        if (ok) {
          rec.route = 'tool'; rec.source = plan.tool;
          rec.isFallback = false;
          rec.answerPreview = JSON.stringify(r).slice(0, 160);
          rec.latencyMs = Date.now() - t0;
          return rec;
        }
        // 工具空结果 → 与线上一致降级 RAG
      }
      // 4. RAG（检索 → 可选 LLM 生成）
      const topK = opts.ragTopK || 4;
      const r = await deps.retrieval.retrieve(q, deps.kbChunks || [], topK);
      const refs = (r && r.refs) || [];
      rec.refsCount = refs.length;
      rec.topScore = refs.length ? Number(refs[0].score) || 0 : 0;
      if (!refs.length) {
        rec.route = 'rag'; rec.source = 'rag-empty'; rec.isFallback = true;
        rec.answerPreview = '兜底：知识库零命中';
        rec.latencyMs = Date.now() - t0;
        return rec;
      }
      if (opts.llmAnswer === false) {
        // 结构评测模式：有检索命中即视为可答（不真调用生成模型）
        rec.route = 'rag'; rec.source = 'rag-hit'; rec.isFallback = false;
        rec.answerPreview = '命中：' + refs.map((x) => x.title).slice(0, 3).join('、');
        rec.latencyMs = Date.now() - t0;
        return rec;
      }
      let answer = '';
      const sys = '你是电商客服。仅依据以下知识回答，若不足以回答必须一字不差回复：「抱歉，这个问题暂时' + FALLBACK_MARK + '，您可以点击下方「转人工客服」，我会为您登记并尽快由人工跟进。」\n知识：\n'
        + refs.map((x, i) => `[${i + 1}] ${x.title}: ${x.content || x.snippet || ''}`).join('\n');
      for await (const ch of deps.cloud.llm.chat.completions.create({
        model: deps.model || 'deepseek-v4-flash', stream: true, temperature: 0.3,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: q }],
      })) {
        const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
        if (d) answer += d;
      }
      rec.route = 'rag'; rec.source = refs.length ? 'rag-llm' : 'rag-empty';
      rec.isFallback = !answer || answer.includes(FALLBACK_MARK);
      rec.answerPreview = (answer || '').slice(0, 120);
      rec.latencyMs = Date.now() - t0;
      return rec;
    } catch (e) {
      rec.error = (e && e.message) || String(e);
      rec.route = 'error'; rec.isFallback = true;
      rec.latencyMs = Date.now() - t0;
      return rec;
    }
  }

  /** 单轮指标汇总 */
  function summarizeRun(results) {
    const n = results.length || 1;
    const cnt = (f) => results.filter(f).length;
    const toolTried = cnt((r) => r.source && r.source !== 'risk-route' && r.source !== 'local');
    const byRoute = {};
    results.forEach((r) => { byRoute[r.route] = (byRoute[r.route] || 0) + 1; });
    return {
      total: results.length,
      byRoute,
      toolHitRate: toolTried ? cnt((r) => r.route === 'tool') / toolTried : 0,
      fallbackRate: cnt((r) => r.isFallback) / n,
      humanRate: cnt((r) => r.route === 'human') / n,
      smalltalkRate: cnt((r) => r.route === 'smalltalk') / n,
      avgLatencyMs: Math.round(results.reduce((s, r) => s + (r.latencyMs || 0), 0) / n),
      p95LatencyMs: (function () { const a = results.map((r) => r.latencyMs || 0).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0; })(),
      errorCount: cnt((r) => r.route === 'error'),
    };
  }

  /** 基线 vs 候选对比：指标差 + 逐题路由/结果差异 */
  function compareRuns(baseline, candidate) {
    const bm = summarizeRun(baseline), cm = summarizeRun(candidate);
    const bMap = {}, cMap = {};
    baseline.forEach((r) => { bMap[r.question] = r; });
    candidate.forEach((r) => { cMap[r.question] = r; });
    const diffs = [];
    const questions = Object.keys(cMap);
    for (const q of questions) {
      const b = bMap[q], c = cMap[q];
      if (!b) { diffs.push({ question: q, type: 'new-in-candidate', candidate: { route: c.route, source: c.source, isFallback: c.isFallback } }); continue; }
      if (b.route !== c.route || b.isFallback !== c.isFallback || (b.source || '') !== (c.source || '')) {
        diffs.push({
          question: q, type: 'changed',
          baseline: { route: b.route, source: b.source, isFallback: b.isFallback },
          candidate: { route: c.route, source: c.source, isFallback: c.isFallback },
        });
      }
    }
    for (const q of Object.keys(bMap)) if (!cMap[q]) diffs.push({ question: q, type: 'missing-in-candidate' });
    return {
      baseline: bm, candidate: cm,
      metrics: {
        toolHitRate: { baseline: bm.toolHitRate, candidate: cm.toolHitRate, delta: +(cm.toolHitRate - bm.toolHitRate).toFixed(4) },
        fallbackRate: { baseline: bm.fallbackRate, candidate: cm.fallbackRate, delta: +(cm.fallbackRate - bm.fallbackRate).toFixed(4) },
        humanRate: { baseline: bm.humanRate, candidate: cm.humanRate, delta: +(cm.humanRate - bm.humanRate).toFixed(4) },
        avgLatencyMs: { baseline: bm.avgLatencyMs, candidate: cm.avgLatencyMs, delta: cm.avgLatencyMs - bm.avgLatencyMs },
      },
      diffs,
    };
  }

  const api = { matchSmalltalk, sampleQuestions, runShadowCase, summarizeRun, compareRuns, FALLBACK_MARK };
  global.ShadowEval = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
