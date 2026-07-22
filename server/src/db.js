const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// 数据库默认落盘位置：容器内若挂载了持久卷 /data（docker-compose 的 server-data），
// 则写入 /data/monitor.db，确保重建容器后数据仍在；否则回退到本地 server/data（开发/裸跑）。
const DB_PATH = process.env.DB_PATH || (() => {
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) return '/data/monitor.db';
  } catch (e) {}
  return path.join(__dirname, '..', 'data', 'monitor.db');
})();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
// 收紧数据库文件权限：仅属主可读写（默认 umask 常为 644，其他用户可读）。
// 库内虽无指纹指标，但含全部监控数据，按最小权限原则限制暴露面。
try { fs.chmodSync(DB_PATH, 0o600); } catch (e) { /* 某些挂载文件系统不支持 chmod，忽略 */ }
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

CREATE TABLE IF NOT EXISTS admin_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- schema migration: add temp / swap columns if missing (existing DBs) ----
// Column names and types below are hardcoded constants (not user input) — no injection risk.
{
  const existing = new Set(db.prepare('PRAGMA table_info(metrics)').all().map((r) => r.name));
  const cols = [
    ['temp', 'REAL'],
    ['swap_used', 'INTEGER'],
    ['swap_total', 'INTEGER'],
    ['swap_pct', 'REAL'],
    ['probes', 'TEXT'],
    ['disk_r_rate', 'REAL'],
    ['disk_w_rate', 'REAL'],
    ['disks', 'TEXT'],
  ];
  for (const [col, type] of cols) {
    if (!existing.has(col)) db.exec(`ALTER TABLE metrics ADD COLUMN ${col} ${type};`);
  }
}

// schema migration: agents 增加分组字段（避免使用 SQL 关键字 group，列名用 grp）
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('grp')) db.exec("ALTER TABLE agents ADD COLUMN grp TEXT DEFAULT ''");
}
// schema migration: agents 增加国家字段（受控端国旗，存 ISO 3166-1 alpha-2 代码，如 CN/US/JP）
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('country')) db.exec("ALTER TABLE agents ADD COLUMN country TEXT DEFAULT ''");
}
// schema migration: agents 增加探测目标(网络质量自测 DNS)列，服务端可配置、按受控端独立存储
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('probe_targets')) db.exec("ALTER TABLE agents ADD COLUMN probe_targets TEXT DEFAULT ''");
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const genId = () => 'agt_' + crypto.randomBytes(6).toString('hex');

const stmts = {
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getAgents: db.prepare('SELECT * FROM agents ORDER BY created_at DESC'),
  insertAgent: db.prepare(`INSERT INTO agents
    (id, name, token_hash, merchant, note, expire_at, monthly_quota_gb, grp, country, probe_targets, created_at, last_seen)
    VALUES (@id, @name, @token_hash, @merchant, @note, @expire_at, @monthly_quota_gb, @grp, @country, @probe_targets, @created_at, 0)`),
  updateAgent: db.prepare(`UPDATE agents SET
    name=@name, merchant=@merchant, note=@note, expire_at=@expire_at, monthly_quota_gb=@monthly_quota_gb, grp=@grp, country=@country, probe_targets=@probe_targets
    WHERE id=@id`),
  deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
  touch: db.prepare('UPDATE agents SET last_seen=?, os=?, hostname=? WHERE id=?'),
  insertMetric: db.prepare(`INSERT INTO metrics
    (agent_id, ts, cpu, mem_used, mem_total, mem_pct, disk_used, disk_total, disk_pct,
     load1, load5, load15, net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, uptime,
     temp, swap_used, swap_total, swap_pct, disk_r_rate, disk_w_rate, probes, disks)
    VALUES (@agent_id, @ts, @cpu, @mem_used, @mem_total, @mem_pct, @disk_used, @disk_total, @disk_pct,
     @load1, @load5, @load15, @net_rx_rate, @net_tx_rate, @net_rx_month, @net_tx_month, @uptime,
     @temp, @swap_used, @swap_total, @swap_pct, @disk_r_rate, @disk_w_rate, @probes, @disks)`),
  latestMetric: db.prepare('SELECT * FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT 1'),
  metricsRange: db.prepare('SELECT * FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
  prune: db.prepare('DELETE FROM metrics WHERE ts < ?'),
  getAlertState: db.prepare('SELECT * FROM alert_state WHERE agent_id=? AND type=?'),
  setAlertState: db.prepare('INSERT OR REPLACE INTO alert_state (agent_id, type, last_sent) VALUES (?,?,?)'),
  clearAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=? AND type=?'),
  clearAllAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=?'),
  resetToken: db.prepare('UPDATE agents SET token_hash=? WHERE id=?'),
  metricsRangeAll: db.prepare('SELECT * FROM metrics WHERE ts>=? ORDER BY agent_id, ts ASC')
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
    grp: fields.grp || '',
    country: (fields.country || '').toUpperCase().slice(0, 2),
    probe_targets: fields.probe_targets || '',
    created_at: Date.now()
  });
  return { id, token };
};

const getAgent = (id) => stmts.getAgent.get(id);
const getAgents = () => stmts.getAgents.all();

// 重置某 Agent 的 Token：生成新 token 并写入哈希，旧 token 立即失效。返回新明文 token。
const resetAgentToken = (id) => {
  const a = stmts.getAgent.get(id);
  if (!a) return null;
  const token = genToken();
  stmts.resetToken.run(hashToken(token), id);
  return token;
};
// 批量取所有 Agent 的时序指标（sparkline 用），按 agent_id 升序返回原始行。
const getMetricsAll = (sinceTs) => stmts.metricsRangeAll.all(sinceTs);

const updateAgent = (id, f) => stmts.updateAgent.run({
  id,
  name: f.name,
  merchant: f.merchant || '',
  note: f.note || '',
  expire_at: f.expire_at || '',
  monthly_quota_gb: Number(f.monthly_quota_gb) || 0,
  grp: f.grp || '',
  country: (f.country || '').toUpperCase().slice(0, 2)
});

const deleteAgent = (id) => {
  stmts.clearAllAlertState.run(id);
  return stmts.deleteAgent.run(id);
};

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

// ---- Admin 2FA (TOTP) 配置（单管理员模型，key-value）----
const _getCfg = db.prepare('SELECT value FROM admin_config WHERE key = ?');
const _setCfg = db.prepare('INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)');
const _setCfgIfAbsent = db.prepare('INSERT OR IGNORE INTO admin_config (key, value) VALUES (?, ?)');
const TWOFA_SECRET = 'admin_2fa_secret';
const TWOFA_ENABLED = 'admin_2fa_enabled';
const getConfig = (k) => { const r = _getCfg.get(k); return r ? r.value : null; };
const setConfig = (k, v) => _setCfg.run(k, String(v));
// 仅当 key 不存在时写入（依赖 key 主键唯一性）。返回 true 表示本次写入成功。
// 用于 /api/setup/generate 防并发竞态：多个请求同时到达时只有一个能落库，其余返回 false。
const setConfigIfAbsent = (k, v) => _setCfgIfAbsent.run(k, String(v)).changes > 0;
const get2FASecret = () => getConfig(TWOFA_SECRET);
const is2FAEnabled = () => getConfig(TWOFA_ENABLED) === '1';
const set2FASecret = (s) => setConfig(TWOFA_SECRET, s);
const set2FAEnabled = (b) => setConfig(TWOFA_ENABLED, b ? '1' : '0');

// ---- UI / 通知设置（持久化到 admin_config 的 key-value）----
const SETTINGS_KEY = 'ui_settings';
const NOTIFY_KEY = 'notify_config';
function getUiSettings() {
  const def = { site_title: '', site_url: '', custom_css: '', default_sort: 'created', group_order: [], agent_server_url: '', admin_allow_ips: '', alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 }, public_enabled: false, home_layout: 'grid', public_theme: 'default', probe_targets: '移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8' };
  try {
    const o = JSON.parse(getConfig(SETTINGS_KEY) || '{}');
    const merged = Object.assign(def, o);
    // 嵌套对象（alert）需单独合并，避免服务端缺字段时整体回退到默认
    merged.alert = Object.assign(def.alert, (o && o.alert) || {});
    return merged;
  }
  catch (e) { return def; }
}
function setUiSettings(o) { setConfig(SETTINGS_KEY, JSON.stringify(o || {})); }
function getNotifyConfigRaw() {
  try { return JSON.parse(getConfig(NOTIFY_KEY) || '{}'); } catch (e) { return {}; }
}
// 通知配置：UI 保存值优先，缺失项回退到 docker-compose 环境变量默认值。
function getNotifyConfig() {
  const def = {
    smtp_host: process.env.SMTP_HOST || 'smtp.qq.com',
    smtp_port: Number(process.env.SMTP_PORT || 465),
    smtp_secure: process.env.SMTP_SECURE !== 'false',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    alert_from: process.env.ALERT_FROM || process.env.SMTP_USER || '',
    alert_to: process.env.ALERT_TO || process.env.SMTP_USER || '',
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || ''
  };
  return Object.assign(def, getNotifyConfigRaw());
}
function setNotifyConfig(incoming) {
  const cur = getNotifyConfigRaw();
  const merged = Object.assign({}, cur, incoming || {});
  // 密码类字段留空表示「保持不变」，避免保存时空字符串误清空已存凭据
  if (incoming && incoming.smtp_pass === '' && cur.smtp_pass) merged.smtp_pass = cur.smtp_pass;
  if (incoming && incoming.telegram_bot_token === '' && cur.telegram_bot_token) merged.telegram_bot_token = cur.telegram_bot_token;
  setConfig(NOTIFY_KEY, JSON.stringify(merged));
}

module.exports = {
  db, hashToken, genToken,
  createAgent, getAgent, getAgents, updateAgent, deleteAgent, resetAgentToken,
  touchAgent, insertMetric, getLatestMetric, getMetrics, getMetricsAll,
  prune, getAlertState, setAlertState, clearAlertState,
  getConfig, setConfig, setConfigIfAbsent, get2FASecret, is2FAEnabled, set2FASecret, set2FAEnabled,
  getUiSettings, setUiSettings, getNotifyConfig, setNotifyConfig
};
