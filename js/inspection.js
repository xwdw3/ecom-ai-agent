/**
 * Phase3 · 每日自动化业务巡检
 * 六项检查：库存异常 / 价格异常 / 活动配置错误 / 订单积压 / 退款积压 / 物流停滞
 * 纯逻辑可单测；报告落库 inspection_reports。
 */

/**
 * @param products [{sku,name,price,stock,status}]
 * @param orders [{order_no,status,created_at,sku}]
 * @param refunds [{order_no,status,created_at}]（可选，订单维度兜底）
 * @param logistics [{order_no,status,timeline:[{desc,time}]}]
 * @returns {findings, severity, summary}
 */
function runInspection(data, nowMs) {
  const now = nowMs || Date.now();
  const { products = [], orders = [], refunds = [], logistics = [] } = data || {};
  const findings = [];

  // 1. 库存异常
  for (const p of products) {
    if (p.stock < 0) findings.push({ check: 'inventory', severity: 'high', target: p.sku, detail: `${p.name}（${p.sku}）库存为负数：${p.stock}`, suggestion: '立即盘点修正库存并暂停该 SKU 售卖' });
    else if (p.stock >= 0 && p.stock < 10 && p.status === 'on_sale') findings.push({ check: 'inventory', severity: 'mid', target: p.sku, detail: `${p.name}（${p.sku}）库存偏低：仅剩 ${p.stock} 件`, suggestion: '及时补货，避免超卖' });
  }

  // 2. 价格异常
  for (const p of products) {
    if (Number(p.price) <= 1 && p.status === 'on_sale') {
      findings.push({ check: 'price', severity: 'high', target: p.sku, detail: `${p.name}（${p.sku}）在售价格异常：¥${p.price}（疑似配置错误/未改价）`, suggestion: '立即下架或改价，防止被批量薅羊毛' });
    }
  }

  // 3. 活动配置错误（状态与库存不一致、在售但无货）
  for (const p of products) {
    if (p.status === 'on_sale' && p.stock === 0) {
      findings.push({ check: 'activity_config', severity: 'mid', target: p.sku, detail: `${p.name}（${p.sku}）在售中但库存为 0，用户下单必失败`, suggestion: '改为缺货状态或补货' });
    }
    if (p.status === 'out_of_stock' && p.stock > 0) {
      findings.push({ check: 'activity_config', severity: 'low', target: p.sku, detail: `${p.name}（${p.sku}）标记缺货但实际库存 ${p.stock} 件，存在可售损失`, suggestion: '核对后恢复在售' });
    }
  }

  // 4. 订单积压：已支付超 48h 未发货
  const backlogOrders = orders.filter((o) => {
    if (o.status !== 'paid') return false;
    const t = new Date(o.created_at).getTime();
    return now - t > 48 * 3600000;
  });
  if (backlogOrders.length) {
    findings.push({
      check: 'order_backlog', severity: backlogOrders.length >= 3 ? 'high' : 'mid', target: `${backlogOrders.length} 单`,
      detail: `已支付超 48 小时未发货订单 ${backlogOrders.length} 笔：${backlogOrders.map((o) => o.order_no).join('、')}`,
      suggestion: '联动仓储优先拣货发货，并向用户补偿安抚',
    });
  }

  // 5. 退款积压：退款审核中超 24h
  const reviewingRefunds = orders.filter((o) => {
    if (o.status !== 'refund_reviewing') return false;
    const t = new Date(o.created_at).getTime();
    return now - t > 24 * 3600000;
  });
  const staleRefundRows = (refunds || []).filter((r) => {
    if (r.status !== 'reviewing') return false;
    const t = new Date(r.created_at).getTime();
    return now - t > 24 * 3600000;
  });
  const refundTotal = Math.max(reviewingRefunds.length, staleRefundRows.length);
  if (refundTotal) {
    findings.push({
      check: 'refund_backlog', severity: refundTotal >= 3 ? 'high' : 'mid', target: `${refundTotal} 单`,
      detail: `退款审核超 24 小时 ${refundTotal} 笔${reviewingRefunds.length ? '（订单维度：' + reviewingRefunds.map((o) => o.order_no).join('、') + '）' : ''}`,
      suggestion: '售后专线加急审核，避免平台介入率上升',
    });
  }

  // 6. 物流停滞：在途超 72h 无更新
  for (const lg of logistics) {
    if (lg.status !== 'in_transit' || !lg.timeline || !lg.timeline.length) continue;
    const last = lg.timeline[lg.timeline.length - 1];
    const lastT = new Date(String(last.time).replace(' ', 'T') + '+08:00').getTime();
    if (now - lastT > 72 * 3600000) {
      findings.push({
        check: 'logistics_stuck', severity: 'mid', target: lg.order_no,
        detail: `订单 ${lg.order_no}（${lg.company} ${lg.tracking_no}）在途已超 72 小时无更新，最后轨迹：${last.desc}`,
        suggestion: '联系承运商核查，必要时补发',
      });
    }
  }

  const severity = findings.some((f) => f.severity === 'high') ? 'high' : findings.length ? 'mid' : 'ok';
  const summary = findings.length
    ? `共发现 ${findings.length} 项异常（高危 ${findings.filter((f) => f.severity === 'high').length} / 中低危 ${findings.filter((f) => f.severity !== 'high').length}），覆盖 ${[...new Set(findings.map((f) => f.check))].length} 类检查项。`
    : '今日巡检全部通过，未发现异常。';
  return { findings, severity, summary };
}

/** 报告落库 */
async function saveInspectionReport(db, report, reportDate) {
  const { error } = await db.from('inspection_reports').insert({
    tenant_id: Tenant.id(),
    report_date: reportDate,
    findings: report.findings || [],
    summary: report.summary,
    severity: report.severity,
  });
  if (error) throw new Error('巡检报告落库失败：' + error.message);
  return true;
}

async function listInspectionReports(db, limit) {
  const { data, error } = await db.from('inspection_reports')
    .select('*').eq('tenant_id', Tenant.id()).order('created_at', { ascending: false }).limit(limit || 10);
  if (error) throw new Error(error.message);
  return data || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runInspection, saveInspectionReport, listInspectionReports };
}
if (typeof window !== 'undefined') {
  window.InspectionAgent = { runInspection, saveInspectionReport, listInspectionReports };
}
