'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const totp = require('./totp');
const ADMIN_TOKEN_FILE = path.join(__dirname, '..', 'data', 'admin_token.txt');
function getAdminToken() {
  if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== 'change-me-admin-token' && process.env.ADMIN_TOKEN.length >= 16) return process.env.ADMIN_TOKEN;
  try { return fs.readFileSync(ADMIN_TOKEN_FILE, 'utf-8').trim(); } catch (e) { return ''; }
}

// 恒定时间比较，避免令牌比较的时序侧信道。
// 先对两端统一做 SHA-256 哈希再比较固定长度摘要，消除「长度不等提前返回」暴露的
// Token 长度侧信道（审查 v3.1 8.2#4：攻击者原可据此探测 Token 长度）。
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function agentAuth(req, res, next) {
  const id = req.header('X-Agent-ID');
  const auth = req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!id || !token) return res.status(401).json({ error: 'unauthorized' });
  const agent = db.getAgent(id);
  if (!agent) return res.status(403).json({ error: 'unknown agent' });
  if (!safeEqual(db.hashToken(token), agent.token_hash)) return res.status(403).json({ error: 'bad token' });
  req.agent = agent;
  next();
}

// ---- 签名 Session Cookie（替代前端长期持有明文 Admin Token）----
// 默认 SESSION_SECRET 随机生成（重启即失效，建议 .env 固定）。Cookie 为 HttpOnly+Secure+SameSite=Strict。
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 12 * 3600 * 1000);
const COOKIE_NAME = 'hm_session';

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(cookieVal) {
  if (!cookieVal || !cookieVal.includes('.')) return null;
  const [body, sig] = cookieVal.split('.');
  let expected;
  try { expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url'); }
  catch { return null; }
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}
function setSessionCookie(res, payload) {
  const cookie = signSession(payload);
  const attrs = `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookie}; ${attrs}`);
}
function clearSessionCookie(res) {
  const attrs = `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${attrs}`);
}

// 协议白名单：仅允许经反向代理且原始请求为 HTTPS 时携带管理类凭证。
// 直连 :8080（无 X-Forwarded-Proto 头、或伪造为 http）一律拒绝，
// 杜绝伪造该头绕过、以及误暴露 8080 端口的情况。
// 本地开发/快速测试如需直连 http，可显式设置 ADMIN_ALLOW_HTTP=1（生产切勿设置）。
function requireProto(req, res) {
  const proto = (req.header('X-Forwarded-Proto') || '').toLowerCase();
  if (proto !== 'https' && process.env.ADMIN_ALLOW_HTTP !== '1') {
    res.status(403).json({ error: 'https required' });
    return false;
  }
  return true;
}

// 解析请求角色。返回 {role, totp, via} 或 null。
// 优先级：签名 Session Cookie（dashboard 登录态） > X-Admin-Token > X-Readonly-Token。
function resolveRole(req) {
  const sess = getSession(req);
  if (sess && sess.role === 'admin') return { role: 'admin', totp: !!sess.totp, via: 'cookie' };
  const at = req.header('X-Admin-Token');
  if (at && safeEqual(at, getAdminToken())) return { role: 'admin', totp: false, via: 'token' };
  const rt = req.header('X-Readonly-Token');
  const roTok = process.env.READONLY_TOKEN;
  if (rt && roTok && safeEqual(rt, roTok)) return { role: 'readonly', totp: false, via: 'token' };
  return null;
}

function adminAuth(req, res, next) {
  const r = resolveRole(req);
  if (!r || r.role !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  next();
}

// 读接口：admin 或 readonly 均可访问（查看数据）。不强制 2FA，兼容 Grafana / 只读 Token / /metrics 拉取。
function adminOrReadonly(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  next();
}

// 写接口：仅 admin 可访问；若已启用 2FA，则要求 TOTP 已验证（cookie 内含 totp 标志）或本次提供 X-TOTP 头。
// 静态 Admin Token 单独调用写接口将被拒绝（need_totp），真正保护危险写操作。
function adminOnly(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (r.role !== 'admin') return res.status(403).json({ error: 'admin required' });
  if (db.is2FAEnabled()) {
    const ok = r.totp || verifyTotpHeader(req);
    if (!ok) return res.status(401).json({ error: 'totp required', need_totp: true });
  }
  if (!requireProto(req, res)) return;
  req.role = r.role;
  next();
}

// 仅 admin（不强制 2FA），供 2FA 管理端点使用；这些端点自身会校验 TOTP code，避免被静态 Token 绕过。
function requireAdmin(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (r.role !== 'admin') return res.status(403).json({ error: 'admin required' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  next();
}

function verifyTotpHeader(req) {
  const code = req.header('X-TOTP');
  const secret = db.get2FASecret();
  if (!code || !secret) return false;
  return totp.verifyTOTP(secret, code);
}

// IP 白名单中间件。ADMIN_ALLOW_IPS=1.2.3.4,5.6.7.0/24 逗号分隔 IP 或 CIDR，未配置则全部放行。
function ipWhitelist(req, res, next) {
  const raw = process.env.ADMIN_ALLOW_IPS || '';
  const ips = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (ips.length === 0) return next();
  const ip = req.ip || req.socket.remoteAddress;
  if (ips.includes(ip)) return next();
  for (const entry of ips) {
    if (entry.includes('/')) {
      const [range, bits] = entry.split('/');
      const n = parseInt(bits);
      if (ipInCIDR(ip, range, n)) return next();
    }
  }
  return res.status(403).json({ error: 'ip not allowed' });
}
function ipInCIDR(ip, cidr, bits) {
  const ipN = ipToInt(ip);
  const cidrN = ipToInt(cidr);
  if (ipN === null || cidrN === null) return false;
  const mask = bits === 0 ? 0 : ~(2 ** (32 - bits) - 1);
  return (ipN & mask) === (cidrN & mask);
}
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

module.exports = {
  agentAuth, adminAuth, adminOrReadonly, adminOnly, requireAdmin, ipWhitelist,
  safeEqual, signSession, verifySession, getSession,
  setSessionCookie, clearSessionCookie, COOKIE_NAME, SESSION_TTL,
  verifyTotpHeader,
};
