const express = require('express');
const router = express.Router();
const db = require('./db');
const { agentAuth, adminOrReadonly, adminOnly, requireAdmin, safeEqual, setSessionCookie, clearSessionCookie, SESSION_TTL } = require('./auth');
const totp = require('./totp');
const alerts = require('./alerts');

// 应用层限流（兜底，不依赖 Nginx）：每 IP 每 10s 最多 20 次。
// /report 已由 Nginx 单独限流，此处放行。trust proxy 已在 server.js 启用，req.ip 为真实客户端。
const RATE_WINDOW = 10000, RATE_MAX = 20;
const rateHits = new Map();
setInterval(() => rateHits.clear(), RATE_WINDOW).unref?.();
const rateLimit = (req, res, next) => {
  if (req.path === '/report') return next();
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const rec = rateHits.get(ip);
  if (!rec || now > rec.reset) {
    rateHits.set(ip, { reset: now + RATE_WINDOW, count: 1 });
    return next();
  }
  rec.count++;
  if (rec.count > RATE_MAX) return res.status(429).json({ error: 'too many requests' });
  next();
};
router.use(rateLimit);

// ---- helpers ----
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

// Report payload validation. Rejects malformed/implausible data.
const validateReport = (b) => {
  if (typeof b !== 'object' || b === null) return null;
  return {
    cpu: num(b.cpu, 0, 100),
    mem_used: num(b.mem_used, 0, 1024 * 1024 * 1024 * 1024),
    mem_total: num(b.mem_total, 0, 1024 * 1024 * 1024 * 1024),
    mem_pct: num(b.mem_pct, 0, 100),
    disk_used: num(b.disk_used, 0, 1024 * 1024 * 1024 * 1024),
    disk_total: num(b.disk_total, 0, 1024 * 1024 * 1024 * 1024),
    disk_pct: num(b.disk_pct, 0, 100),
    load1: num(b.load1, 0, 1e6),
    load5: num(b.load5, 0, 1e6),
    load15: num(b.load15, 0, 1e6),
    net_rx_rate: num(b.net_rx_rate, 0, 1e15),
    net_tx_rate: num(b.net_tx_rate, 0, 1e15),
    net_rx_month: num(b.net_rx_month, 0, 1e18),
    net_tx_month: num(b.net_tx_month, 0, 1e18),
    uptime: num(b.uptime, 0, 1e12),
    os: str(b.os, 200),
    hostname: str(b.hostname, 200)
  };
};

// ---- Agent report (push) ----
router.post('/report', agentAuth, (req, res) => {
  const m = validateReport(req.body);
  if (!m || m.cpu === null || m.mem_total === null) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const ts = Date.now();
  db.insertMetric(req.agent.id, Object.assign({ ts }, m));
  db.touchAgent(req.agent.id, m.os, m.hostname);
  res.json({ ok: true });
});

// ---- Admin: list agents + latest metric + online status ----
router.get('/agents', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    return Object.assign({}, a, { online: !!online, latest: latest || null });
  });
  res.json(list);
});

// ---- Admin: batch sparkline history for all agents (avoids N+1 on the frontend) ----
router.get('/agents/sparklines', adminOrReadonly, (req, res) => {
  const sec = RANGES[req.query.range] || 21600;
  const rows = db.getMetricsAll(Date.now() - sec * 1000);
  const byAgent = {};
  for (const r of rows) (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push(r);
  res.json(byAgent);
});

// ---- Admin: single agent info ----
router.get('/agents/:id', adminOrReadonly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const latest = db.getLatestMetric(a.id);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const online = a.last_seen && (Date.now() - a.last_seen) < offlineSec * 1000;
  res.json(Object.assign({}, a, { online: !!online, latest: latest || null }));
});

// ---- Admin: metrics time-series ----
const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
router.get('/agents/:id/metrics', adminOrReadonly, (req, res) => {
  const sec = RANGES[req.query.range] || 3600;
  const rows = db.getMetrics(req.params.id, Date.now() - sec * 1000);
  res.json(rows);
});

// ---- Admin: overview ----
router.get('/overview', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const agents = db.getAgents();
  let online = 0, cpuSum = 0, memSum = 0, cnt = 0;
  for (const a of agents) {
    if (a.last_seen && now - a.last_seen < offlineSec * 1000) {
      online++;
      const m = db.getLatestMetric(a.id);
      if (m) { cpuSum += m.cpu || 0; memSum += m.mem_pct || 0; cnt++; }
    }
  }
  res.json({
    total: agents.length,
    online,
    offline: agents.length - online,
    avg_cpu: cnt ? +(cpuSum / cnt).toFixed(1) : 0,
    avg_mem: cnt ? +(memSum / cnt).toFixed(1) : 0
  });
});

// ---- Admin: create agent ----
router.post('/agents', adminOnly, (req, res) => {
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb
  });
  res.json({ id, token });
});

// ---- Admin: update agent metadata ----
router.put('/agents/:id', adminOnly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  db.updateAgent(req.params.id, {
    name: str(req.body.name, 100) || a.name,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb
  });
  res.json({ ok: true });
});

// ---- Admin: delete agent ----
router.delete('/agents/:id', adminOnly, (req, res) => {
  db.deleteAgent(req.params.id);
  res.json({ ok: true });
});

// ---- Admin: reset an agent's token (returns new token; old one invalidated) ----
router.post('/agents/:id/reset-token', adminOnly, (req, res) => {
  const token = db.resetAgentToken(req.params.id);
  if (!token) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, token });
});

// ---- Admin: send a test alert to verify notify channels (email / Telegram) ----
router.post('/test-alert', adminOnly, async (req, res) => {
  const st = alerts.notifyStatus();
  if (!st.mail && !st.telegram) {
    return res.status(400).json({ error: '未配置任何通知通道（SMTP 或 TELEGRAM）', status: st });
  }
  try {
    await alerts.sendAlert('[监控] 测试告警', '这是一条测试消息，用于验证通知通道（邮件 / Telegram）是否配置正确。若你收到了，说明配置生效。');
    res.json({ ok: true, message: '测试告警已发送，请检查邮件 / Telegram。', status: st });
  } catch (e) {
    res.status(500).json({ error: e.message, status: st });
  }
});

// ---- Admin 登录（签发签名 Session Cookie；若启用 2FA 需 TOTP）----
// 登录后前端不再持有明文 Admin Token，凭证以 HttpOnly+Secure Cookie 维持，降低 XSS 窃取风险。
router.post('/login', async (req, res) => {
  const { token, totp: code } = req.body || {};
  if (!token || !safeEqual(token, process.env.ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'invalid token' });
  }
  const need = db.is2FAEnabled();
  if (need) {
    const secret = db.get2FASecret();
    if (!code || !secret || !totp.verifyTOTP(secret, code)) {
      return res.status(401).json({ error: 'invalid totp', need_totp: true });
    }
  }
  const payload = { role: 'admin', totp: need, exp: Date.now() + SESSION_TTL };
  setSessionCookie(res, payload);
  res.json({ ok: true, totp: need });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- Admin 2FA (TOTP) 管理 ----
router.get('/admin/2fa/status', adminOrReadonly, (req, res) => {
  res.json({ enabled: db.is2FAEnabled() });
});

// 生成密钥（尚未启用）。仅 admin 可调用；返回明文密钥仅此一次，供手动录入 Authenticator。
router.post('/admin/2fa/setup', requireAdmin, (req, res) => {
  if (db.is2FAEnabled()) return res.status(400).json({ error: '2fa already enabled' });
  const secret = totp.generateSecret();
  db.set2FASecret(secret);
  res.json({ secret, otpauth_uri: totp.otpauthUri(secret), enabled: false });
});

router.post('/admin/2fa/enable', requireAdmin, (req, res) => {
  const { code } = req.body || {};
  const secret = db.get2FASecret();
  if (!secret) return res.status(400).json({ error: 'run setup first' });
  if (!code || !totp.verifyTOTP(secret, code)) return res.status(400).json({ error: 'invalid code' });
  db.set2FAEnabled(true);
  res.json({ ok: true, enabled: true });
});

router.post('/admin/2fa/disable', requireAdmin, (req, res) => {
  const { code } = req.body || {};
  if (!db.is2FAEnabled()) return res.status(400).json({ error: '2fa not enabled' });
  const secret = db.get2FASecret();
  if (!code || !secret || !totp.verifyTOTP(secret, code)) return res.status(400).json({ error: 'invalid code' });
  db.set2FAEnabled(false);
  res.json({ ok: true, enabled: false });
});

module.exports = router;
