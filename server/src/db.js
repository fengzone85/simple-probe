const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'monitor.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
// NOTE: intentionally NOT using WAL mode. WAL requires a -shm shared-memory file
// which fails on some mounted/network filesystems (SQLITE_IOERR_SHMOPEN).
// This app is single-writer, so the default rollback-journal mode is sufficient.

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  merchant        TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  expire_at       TEXT DEFAULT '',
  monthly_quota_gb REAL DEFAULT 0,
  os              TEXT DEFAULT '',
  hostname        TEXT DEFAULT '',
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cpu           REAL,
  mem_used      INTEGER,
  mem_total     INTEGER,
  mem_pct       REAL,
  disk_used     INTEGER,
  disk_total    INTEGER,
  disk_pct      REAL,
  load1         REAL,
  load5         REAL,
  load15        REAL,
  net_rx_rate   REAL,
  net_tx_rate   REAL,
  net_rx_month  INTEGER,
  net_tx_month  INTEGER,
  uptime        REAL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metrics_agent_ts ON metrics(agent_id, ts);

CREATE TABLE IF NOT EXISTS alert_state (
  agent_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  last_sent  INTEGER NOT NULL,
  PRIMARY KEY(agent_id, type)
);
`);

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const genId = () => 'agt_' + crypto.randomBytes(6).toString('hex');

const stmts = {
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getAgents: db.prepare('SELECT * FROM agents ORDER BY created_at DESC'),
  insertAgent: db.prepare(`INSERT INTO agents
    (id, name, token_hash, merchant, note, expire_at, monthly_quota_gb, created_at, last_seen)
    VALUES (@id, @name, @token_hash, @merchant, @note, @expire_at, @monthly_quota_gb, @created_at, 0)`),
  updateAgent: db.prepare(`UPDATE agents SET
    name=@name, merchant=@merchant, note=@note, expire_at=@expire_at, monthly_quota_gb=@monthly_quota_gb
    WHERE id=@id`),
  deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
  touch: db.prepare('UPDATE agents SET last_seen=?, os=?, hostname=? WHERE id=?'),
  insertMetric: db.prepare(`INSERT INTO metrics
    (agent_id, ts, cpu, mem_used, mem_total, mem_pct, disk_used, disk_total, disk_pct,
     load1, load5, load15, net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, uptime)
    VALUES (@agent_id, @ts, @cpu, @mem_used, @mem_total, @mem_pct, @disk_used, @disk_total, @disk_pct,
     @load1, @load5, @load15, @net_rx_rate, @net_tx_rate, @net_rx_month, @net_tx_month, @uptime)`),
  latestMetric: db.prepare('SELECT * FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT 1'),
  metricsRange: db.prepare('SELECT * FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
  prune: db.prepare('DELETE FROM metrics WHERE ts < ?'),
  getAlertState: db.prepare('SELECT * FROM alert_state WHERE agent_id=? AND type=?'),
  setAlertState: db.prepare('INSERT OR REPLACE INTO alert_state (agent_id, type, last_sent) VALUES (?,?,?)'),
  clearAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=? AND type=?')
};

const createAgent = (fields) => {
  const id = genId();
  const token = genToken();
  stmts.insertAgent.run({
    id,
    name: fields.name || id,
    token_hash: hashToken(token),
    merchant: fields.merchant || '',
    note: fields.note || '',
    expire_at: fields.expire_at || '',
    monthly_quota_gb: Number(fields.monthly_quota_gb) || 0,
    created_at: Date.now()
  });
  return { id, token };
};

const getAgent = (id) => stmts.getAgent.get(id);
const getAgents = () => stmts.getAgents.all();

const updateAgent = (id, f) => stmts.updateAgent.run({
  id,
  name: f.name,
  merchant: f.merchant || '',
  note: f.note || '',
  expire_at: f.expire_at || '',
  monthly_quota_gb: Number(f.monthly_quota_gb) || 0
});

const deleteAgent = (id) => stmts.deleteAgent.run(id);

const touchAgent = (id, os, hostname) => stmts.touch.run(Date.now(), os || '', hostname || '', id);

const insertMetric = (agent_id, m) => stmts.insertMetric.run(Object.assign({ agent_id }, m));

const getLatestMetric = (agent_id) => stmts.latestMetric.get(agent_id);
const getMetrics = (agent_id, sinceTs) => stmts.metricsRange.all(agent_id, sinceTs);

const prune = (retentionDays) => {
  const cutoff = Date.now() - retentionDays * 86400000;
  const r = stmts.prune.run(cutoff);
  return r.changes;
};

const getAlertState = (agent_id, type) => stmts.getAlertState.get(agent_id, type);
const setAlertState = (agent_id, type, ts) => stmts.setAlertState.run(agent_id, type, ts);
const clearAlertState = (agent_id, type) => stmts.clearAlertState.run(agent_id, type);

module.exports = {
  db, hashToken, genToken,
  createAgent, getAgent, getAgents, updateAgent, deleteAgent,
  touchAgent, insertMetric, getLatestMetric, getMetrics,
  prune, getAlertState, setAlertState, clearAlertState
};
