'use strict';
// 上报负载校验逻辑（纯函数，无 I/O、无 DB 依赖），便于独立审计与单元测试。
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

// 管理员自定义 CSS 清洗：仅放行样式能力，杜绝外联资源加载与脚本注入。
// 威胁模型（见安全审计 M-1）：admin 角色可写入 custom_css，需防止
//   - @import / @font-face 外链、字体指纹追踪
//   - url() 加载远程资源 / 数据外泄
//   - expression() / javascript: 等历史 XSS 向量
//   - behavior / -moz-binding 等危险属性
// 做法：先剥离外链与脚本向量，再逐条声明校验属性名，丢弃非法/危险项。
const CSS_MAX = 20000;
const CSS_DANGEROUS_PROP = /^(|-moz-)?(behavior|binding)$/i;
function sanitizeCss(input) {
  if (typeof input !== 'string') return '';
  let css = input.slice(0, CSS_MAX);
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');          // 注释
  css = css.replace(/@import\b[^;]*;?/gi, '');          // @import 外链
  css = css.replace(/@charset\b[^;]*;?/gi, '');         // @charset
  css = css.replace(/@namespace\b[^;]*;?/gi, '');       // @namespace
  css = css.replace(/@font-face\s*\{[^}]*\}/gi, '');    // @font-face 块（字体指纹）
  css = css.replace(/url\(\s*[^)]*\)/gi, '');           // 所有 url(...) 外链/数据
  css = css.replace(/expression\s*\(/gi, '');           // IE expression 向量
  const blocks = css.split('}');
  const out = [];
  for (const raw of blocks) {
    const t = raw.trim();
    if (!t) continue;
    const i = t.indexOf('{');
    if (i < 0) { out.push(t); continue; }               // 游离片段/at-rule 续接
    const selector = t.slice(0, i).trim();
    if (selector.startsWith('@')) { out.push(t + '}'); continue; } // @media/@keyframes：已去 url/字体，整体放行
    const decls = t.slice(i + 1).split(';')
      .map(s => s.trim()).filter(Boolean)
      .map((decl) => {
        const c = decl.indexOf(':');
        if (c < 0) return null;
        const prop = decl.slice(0, c).trim().toLowerCase();
        const value = decl.slice(c + 1).trim();
        if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) return null;   // 非法属性名
        if (CSS_DANGEROUS_PROP.test(prop)) return null;       // 危险属性
        if (/javascript:|vbscript:|data:\s*(?!image\/)/i.test(value)) return null; // 危险值
        return decl;
      }).filter(Boolean);
    if (decls.length && selector) out.push(`${selector}{${decls.join(';')}}`);
  }
  return out.join(' ').slice(0, CSS_MAX);
}

// Report payload validation. Rejects malformed/implausible data.
const validateReport = (b) => {
  if (typeof b !== 'object' || b === null) return null;
  return {
    cpu: num(b.cpu, 0, 100),
    mem_used: num(b.mem_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    mem_total: num(b.mem_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    mem_pct: num(b.mem_pct, 0, 100),
    disk_used: num(b.disk_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    disk_total: num(b.disk_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    disk_pct: num(b.disk_pct, 0, 100),
    load1: num(b.load1, 0, 1e6),
    load5: num(b.load5, 0, 1e6),
    load15: num(b.load15, 0, 1e6),
    net_rx_rate: num(b.net_rx_rate, 0, 1e15),
    net_tx_rate: num(b.net_tx_rate, 0, 1e15),
    net_rx_month: num(b.net_rx_month, 0, 1e18),
    net_tx_month: num(b.net_tx_month, 0, 1e18),
    disk_r_rate: num(b.disk_r_rate, 0, 1e15),
    disk_w_rate: num(b.disk_w_rate, 0, 1e15),
    uptime: num(b.uptime, 0, 1e12),
    // temp: null means "no sensor" — allowed; otherwise clamp to a plausible range.
    temp: (b.temp === null || b.temp === undefined) ? null : num(b.temp, -50, 200),
    swap_used: num(b.swap_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    swap_total: num(b.swap_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    swap_pct: num(b.swap_pct, 0, 100),
    // 网络质量自测结果（固定公共目标，Agent 本地写死，服务端不可下发）。
    // 校验为受控对象：键≤8、label≤24 字符，值含 ms(0..100000 或 null) 与 ok(bool)。
    probes: (() => {
      const p = b.probes;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return '{}';
      const out = {};
      let n = 0;
      for (const k of Object.keys(p)) {
        if (n >= 8) break;
        if (typeof k !== 'string' || k.length > 24) continue;
        const v = p[k];
        if (!v || typeof v !== 'object') continue;
        const ms = (v.ms === null || v.ms === undefined) ? null : num(v.ms, 0, 100000);
        out[k] = { ms, ok: v.ok === true };
        n++;
      }
      return JSON.stringify(out);
    })(),
    os: str(b.os, 200),
    hostname: str(b.hostname, 200),
    // 多盘使用率（可选）：Agent 遍历 /proc/mounts 上报，每项含 mount/used/total/pct。
    // 宽松校验，非法项丢弃，最多 32 块盘，避免异常负载撑爆数据库。
    disks: (() => {
      const d = b.disks;
      if (!Array.isArray(d)) return '[]';
      const out = [];
      for (const it of d) {
        if (!it || typeof it !== 'object') continue;
        const mount = typeof it.mount === 'string' ? it.mount.slice(0, 200) : '';
        const used = num(it.used, 0, 1024 * 1024 * 1024 * 1024 * 1024);
        const total = num(it.total, 0, 1024 * 1024 * 1024 * 1024 * 1024);
        const pct = num(it.pct, 0, 100);
        if (used === null || total === null || pct === null) continue;
        out.push({ mount, used, total, pct: +pct.toFixed(2) });
        if (out.length >= 32) break;
      }
      return JSON.stringify(out);
    })()
  };
};

module.exports = { num, str, validateReport, sanitizeCss };
