// 国家 / 地区映射（用于受控端国旗选择）。
// flagEmoji 由 ISO 3166-1 alpha-2 代码动态生成 emoji 国旗（与 Komari 同款视觉，无需额外图片资源）。
// 如需替换为本地面画 SVG 国旗库，仅需把 flagEmoji 改为查表返回 <img src="/flags/xx.svg"> 即可。
const COUNTRIES = [
  { code: 'CN', name: '中国' },
  { code: 'HK', name: '中国香港' },
  { code: 'TW', name: '中国台湾' },
  { code: 'MO', name: '中国澳门' },
  { code: 'US', name: '美国' },
  { code: 'JP', name: '日本' },
  { code: 'KR', name: '韩国' },
  { code: 'SG', name: '新加坡' },
  { code: 'MY', name: '马来西亚' },
  { code: 'TH', name: '泰国' },
  { code: 'VN', name: '越南' },
  { code: 'IN', name: '印度' },
  { code: 'GB', name: '英国' },
  { code: 'DE', name: '德国' },
  { code: 'FR', name: '法国' },
  { code: 'NL', name: '荷兰' },
  { code: 'RU', name: '俄罗斯' },
  { code: 'CA', name: '加拿大' },
  { code: 'AU', name: '澳大利亚' },
  { code: 'NZ', name: '新西兰' },
  { code: 'BR', name: '巴西' },
  { code: 'ZA', name: '南非' },
  { code: 'AE', name: '阿联酋' },
  { code: 'SA', name: '沙特阿拉伯' },
  { code: 'TR', name: '土耳其' },
  { code: 'ID', name: '印度尼西亚' },
  { code: 'PH', name: '菲律宾' },
  { code: 'ES', name: '西班牙' },
  { code: 'IT', name: '意大利' },
  { code: 'SE', name: '瑞典' },
  { code: 'CH', name: '瑞士' },
  { code: 'FI', name: '芬兰' },
  { code: 'NO', name: '挪威' },
  { code: 'DK', name: '丹麦' },
  { code: 'PL', name: '波兰' },
  { code: 'UA', name: '乌克兰' },
  { code: 'KP', name: '朝鲜' },
  { code: 'KZ', name: '哈萨克斯坦' }
];

// 由两位国家代码生成 emoji 国旗（Regional Indicator Symbols）。
function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt()));
}
function countryName(code) {
  const f = COUNTRIES.find((c) => c.code === (code || '').toUpperCase());
  return f ? f.name : (code || '');
}
// 真实国旗图片（本地离线，不依赖外部 CDN）：Windows 不渲染 emoji 国旗（区域指示符），
// 故改用打包在 public/flags/<code>.svg 的 SVG 国旗。加载失败时回退为两位国家代码文本。
function flagImg(code, size) {
  code = (code || '').toUpperCase();
  if (!code || code.length !== 2) return '';
  const lo = code.toLowerCase();
  return `<img class="flag-img" loading="lazy" alt="${code}" title="${code}" src="/flags/${lo}.svg"` +
    ` onerror="this.outerHTML='<span class=&quot;flag-code&quot;>${code}</span>'">`;
}
