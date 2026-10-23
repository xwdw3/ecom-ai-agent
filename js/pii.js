/**
 * 隐私脱敏模块（技术验收2：日志脱敏）
 * 手机号、邮箱、详细地址、身份证等隐私信息在落库前掩码，不明文存储。
 * 兼容浏览器与 Node（供单元测试引用）。
 */
function maskPhone(text) {
  // 手机号：保留前3后4
  return String(text || '').replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
}

function maskEmail(text) {
  // 邮箱：保留首字符与域名
  return String(text || '').replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '$1***@***');
}

function maskIdCard(text) {
  // 身份证：保留前3后2
  return String(text || '').replace(/(?<!\d)\d{15}(\d{2}[\dXx])?(?!\d)/g, (m) => m.slice(0, 3) + '***************');
}

function maskAddress(text) {
  // 详细地址：省/市保留，门牌细节（路弄巷街道+数字号/栋/室/单元/楼）整段掩码
  return String(text || '').replace(
    /([\u4e00-\u9fa5]{1,8}(?:省|市|自治区))?[\u4e00-\u9fa5]{0,10}(?:新区|开发区|园区)?[\u4e00-\u9fa5]{1,12}(?:路|街|巷|弄|道|大道|镇|村)[\u4e00-\u9fa50-9A-Za-z]{0,20}?\d{0,5}(?:号|栋|幢|楼|室|单元|座)[\u4e00-\u9fa50-9A-Za-z]{0,10}/g,
    (m) => {
      const provinceMatch = m.match(/[\u4e00-\u9fa5]{1,8}(?:省|市|自治区)/);
      return (provinceMatch ? provinceMatch[0] : '') + '【地址已脱敏】';
    }
  );
}

function maskLandline(text) {
  // 固话：区号-号码，保留区号与后4位
  return String(text || '').replace(/(?<!\d)(0\d{2,3})-?(\d{4})(\d{3,4})(?!\d)/g, '$1-$2****'.replace('****', '****'));
}

/** 综合脱敏：对任意文本按序执行全部规则 */
function maskPII(text) {
  if (text == null) return text;
  let s = String(text);
  s = maskIdCard(s);
  s = maskPhone(s);
  s = maskEmail(s);
  s = maskAddress(s);
  return s;
}

/** 判断文本是否包含隐私信息（用于统计与审计） */
function containsPII(text) {
  if (!text) return false;
  return maskPII(text) !== String(text);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { maskPII, maskPhone, maskEmail, maskIdCard, maskAddress, containsPII };
}
