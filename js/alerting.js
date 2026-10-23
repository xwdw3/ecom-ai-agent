/**
 * Phase3 · 全平台统一告警中心
 * 服务异常 / 风控命中 / 巡检异常 → 统一入 alert_logs + 实时推送（钉钉/企微 webhook 适配位）
 * 生产替换位：把 WEBHOOK 换成真实钉钉/企微机器人地址，或对接 PagerDuty/值班系统。
 */

const CHANNEL_WEBHOOKS = {
  dingtalk: null, // 例：https://oapi.dingtalk.com/robot/send?access_token=xxx
  wecom: null,    // 例：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
};

const SEVERITY_RANK = { info: 1, low: 2, mid: 3, error: 4, high: 5 };

/** 告警是否需要实时推送（中危以上） */
function shouldPush(severity) {
  return (SEVERITY_RANK[severity] || 0) >= SEVERITY_RANK.mid;
}

/** 格式化推送文本 */
function formatAlert(alert) {
  const tag = { high: '🔴 高危', error: '🔴 错误', mid: '🟡 中危', low: '🔵 低危', info: 'ℹ️ 提示' }[alert.severity] || '🔔 告警';
  return `${tag}【${alert.alertType}】\n${alert.message}${alert.context ? '\n上下文：' + JSON.stringify(alert.context).slice(0, 200) : ''}`;
}

/**
 * 推送报文构建（纯函数，便于测试）
 */
function buildPayload(channel, text) {
  return channel === 'wecom'
    ? { msgtype: 'markdown', markdown: { content: text } }
    : { msgtype: 'markdown', markdown: { title: text.split('\n')[0].slice(0, 20), text: text.replace(/\n/g, '\n\n') } };
}

/** 钉钉加签：HMAC-SHA256(secret, `${ts}\n${secret}`) → base64（纯函数） */
async function dingSign(secret, timestamp) {
  const enc = new TextEncoder().encode(String(timestamp) + '\n' + secret);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** 渠道 CRUD（配置存 alert_channels 表） */
async function listChannels(db) {
  const { data, error } = await db.from('alert_channels').select('*').order('id');
  if (error) throw new Error(error.message);
  return data || [];
}
async function saveChannel(db, ch) {
  const row = {
    name: ch.name, type: ch.type, webhook_url: ch.webhook_url,
    secret: ch.secret || null, enabled: ch.enabled !== false,
  };
  if (ch.id) {
    const { error } = await db.from('alert_channels').update(row).eq('id', ch.id);
    if (error) throw new Error(error.message);
    return { ok: true, id: ch.id };
  }
  const { data, error } = await db.from('alert_channels').insert(row).select();
  if (error) throw new Error(error.message);
  return { ok: true, id: data[0].id };
}
async function deleteChannel(db, id) {
  const { error } = await db.from('alert_channels').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * 推送到单渠道
 * - 传入 db 时读取 alert_channels 中已启用的配置（真实推送，钉钉自动加签）
 * - 未配置时模拟发送（simulated: true），保持演示可用
 * - 浏览器端可能因 webhook 域名 CORS 限制失败，Node 端（每日任务）不受限
 */
async function pushToChannel(channel, text, db) {
  let cfg = null;
  if (db) {
    try {
      const { data } = await db.from('alert_channels').select('*').eq('type', channel).eq('enabled', true).limit(1);
      cfg = (data || [])[0] || null;
    } catch (e) { /* 配置读取失败按未配置处理 */ }
  }
  const url = cfg ? cfg.webhook_url : CHANNEL_WEBHOOKS[channel];
  if (!url) return { channel, ok: true, simulated: true, reason: '未配置 webhook（演示环境模拟推送）' };
  try {
    let finalUrl = url;
    if (channel === 'dingtalk' && cfg && cfg.secret) {
      const ts = Date.now();
      finalUrl = url + (url.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(await dingSign(cfg.secret, ts));
    }
    const res = await fetch(finalUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(channel, text)) });
    const bodyText = await res.text().catch(() => '');
    let errcode = null;
    try { errcode = JSON.parse(bodyText).errcode; } catch (e) { /* 非 JSON 响应 */ }
    const ok = res.ok && (errcode === null || errcode === 0);
    return { channel, ok, simulated: false, detail: ok ? '已推送' : `HTTP ${res.status}${errcode !== null ? ' errcode ' + errcode : ''}` };
  } catch (e) {
    return { channel, ok: false, simulated: false, reason: String(e.message || e) };
  }
}

/**
 * 统一告警入口：落库 alert_logs + 实时推送
 * @returns {logged:boolean, pushed:Array}
 */
async function raiseAlert(db, alert) {
  const a = {
    alertType: alert.alert_type || alert.alertType,
    severity: alert.severity || 'mid',
    message: String(alert.message || '').slice(0, 500),
    context: alert.context || null,
  };
  let logged = false;
  try {
    const { error } = await db.from('alert_logs').insert({
      alert_type: a.alertType, severity: a.severity, message: a.message,
      context: a.context, session_id: alert.session_id || null,
    });
    logged = !error;
  } catch (e) { /* 落库失败不阻塞推送 */ }
  const pushed = [];
  if (shouldPush(a.severity)) {
    const text = formatAlert(a);
    for (const ch of ['dingtalk', 'wecom']) {
      pushed.push(await pushToChannel(ch, text, db));
    }
  }
  return { logged, pushed };
}

/** 便捷封装：服务异常 / 风控命中 / 巡检异常 */
async function notifyServiceError(db, where, err, extra) {
  return raiseAlert(db, { alert_type: 'service_error', severity: 'error', message: `服务异常@${where}: ${err && (err.message || err)}`, context: extra || null });
}
async function notifyRiskHit(db, ev) {
  return raiseAlert(db, {
    alert_type: 'risk_hit', severity: ev.risk_level === 'high' ? 'high' : 'mid',
    message: `风控命中[${ev.event_type}] 用户:${ev.user_id || '-'} 订单:${ev.order_no || '-'} 处置:${ev.action}`,
    context: ev.detail || null,
  });
}
async function notifyInspectionFinding(db, finding) {
  return raiseAlert(db, {
    alert_type: 'inspection_finding', severity: finding.severity === 'high' ? 'high' : 'mid',
    message: `巡检异常[${finding.check}] ${finding.detail}`, context: { suggestion: finding.suggestion },
  });
}

/** 告警列表（运维看板用） */
async function listAlerts(db, limit) {
  const { data, error } = await db.from('alert_logs')
    .select('*').order('created_at', { ascending: false }).limit(limit || 30);
  if (error) throw new Error(error.message);
  return data || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { raiseAlert, notifyServiceError, notifyRiskHit, notifyInspectionFinding, pushToChannel, shouldPush, formatAlert, listAlerts, listChannels, saveChannel, deleteChannel, buildPayload, dingSign, CHANNEL_WEBHOOKS };
}
if (typeof window !== 'undefined') {
  window.AlertCenter = { raiseAlert, notifyRiskHit, notifyInspectionFinding, notifyServiceError, pushToChannel, shouldPush, formatAlert, listAlerts, listChannels, saveChannel, deleteChannel, buildPayload, dingSign };
}
