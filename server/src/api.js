const express = require('express');
const router = express.Router();
const db = require('./db');
const { agentAuth, adminAuth } = require('./auth');

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
router.get('/agents', adminAuth, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    return Object.assign({}, a, { online: !!online, latest: latest || null });
  });
  res.json(list);
});

// ---- Admin: single agent info ----
router.get('/agents/:id', adminAuth, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const latest = db.getLatestMetric(a.id);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const online = a.last_seen && (Date.now() - a.last_seen) < offlineSec * 1000;
  res.json(Object.assign({}, a, { online: !!online, latest: latest || null }));
});

// ---- Admin: metrics time-series ----
const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
router.get('/agents/:id/metrics', adminAuth, (req, res) => {
  const sec = RANGES[req.query.range] || 3600;
  const rows = db.getMetrics(req.params.id, Date.now() - sec * 1000);
  res.json(rows);
});

// ---- Admin: overview ----
router.get('/overview', adminAuth, (req, res) => {
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
router.post('/agents', adminAuth, (req, res) => {
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
router.put('/agents/:id', adminAuth, (req, res) => {
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
router.delete('/agents/:id', adminAuth, (req, res) => {
  db.deleteAgent(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
