require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./src/db');
const api = require('./src/api');
const alerts = require('./src/alerts');
const { safeEqual } = require('./src/auth');

const app = express();
// 信任前置反代（Nginx）的 X-Forwarded-*，使 req.ip 取到真实客户端 IP，
// 供应用层限流按客户端区分（而非全部归到 127.0.0.1）。Nginx 已设置 X-Forwarded-For。
app.set('trust proxy', true);

// 安全响应头：所有资源仅限同源，且禁止任何内联脚本/样式，
// 从根本上阻断 XSS 窃取 Admin Token 的路径。前端已改为 addEventListener + 事件委托。
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
  );
  next();
});

// 启动期安全校验：Admin Token 过弱等于把后台钥匙留在门上，越早发现越好。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN || ADMIN_TOKEN === 'change-me-admin-token' || ADMIN_TOKEN.length < 16) {
  console.error('[fatal] ADMIN_TOKEN 未设置或过于薄弱（默认值 / 长度 < 16），拒绝启动。');
  console.error('        请在 .env 中设置一个足够随机、至少 16 位的管理员 Token。');
  process.exit(1);
}

app.use(express.json({ limit: '16kb' }));

// ---- Prometheus /metrics 导出（P3：可观测性）----
// 通过 Bearer Token 鉴权（复用 ADMIN_TOKEN，恒定时间比较），不强制 https，便于内网抓取。
// 例：curl -H "Authorization: Bearer $ADMIN_TOKEN" http://host:8080/metrics
function promEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
const METRIC_DEFS = [
  { name: 'monitor_agent_cpu_percent',       desc: 'CPU 使用率（百分比）',           get: m => m && m.cpu },
  { name: 'monitor_agent_mem_used_bytes',    desc: '内存已用（字节）',               get: m => m && m.mem_used },
  { name: 'monitor_agent_mem_total_bytes',   desc: '内存总量（字节）',               get: m => m && m.mem_total },
  { name: 'monitor_agent_mem_percent',       desc: '内存使用率（百分比）',           get: m => m && m.mem_pct },
  { name: 'monitor_agent_disk_used_bytes',   desc: '磁盘已用（字节）',               get: m => m && m.disk_used },
  { name: 'monitor_agent_disk_total_bytes',  desc: '磁盘总量（字节）',               get: m => m && m.disk_total },
  { name: 'monitor_agent_disk_percent',      desc: '磁盘使用率（百分比）',           get: m => m && m.disk_pct },
  { name: 'monitor_agent_load1',             desc: '系统负载 1 分钟',                get: m => m && m.load1 },
  { name: 'monitor_agent_load5',             desc: '系统负载 5 分钟',                get: m => m && m.load5 },
  { name: 'monitor_agent_load15',            desc: '系统负载 15 分钟',               get: m => m && m.load15 },
  { name: 'monitor_agent_net_rx_rate_bytes', desc: '网络接收速率（字节/秒）',         get: m => m && m.net_rx_rate },
  { name: 'monitor_agent_net_tx_rate_bytes', desc: '网络发送速率（字节/秒）',         get: m => m && m.net_tx_rate },
  { name: 'monitor_agent_net_rx_total_bytes',desc: '当月累计接收（字节）',            get: m => m && m.net_rx_month },
  { name: 'monitor_agent_net_tx_total_bytes',desc: '当月累计发送（字节）',            get: m => m && m.net_tx_month },
  { name: 'monitor_agent_uptime_seconds',    desc: '系统运行时长（秒）',             get: m => m && m.uptime },
  { name: 'monitor_agent_last_seen_seconds', desc: '最近一次上报的 Unix 时间戳（秒）', get: m => m ? Math.floor((m.ts || 0) / 1000) : null },
];
app.get('/metrics', (req, res) => {
  const auth = req.header('Authorization') || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t || !safeEqual(t, process.env.ADMIN_TOKEN)) {
    return res.status(401).set('Content-Type', 'text/plain').send('401 Unauthorized');
  }
  const agents = db.getAgents();
  const now = Date.now();
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const lines = [];
  lines.push('# HELP monitor_up Agent 是否在线（最近上报在阈值内为 1）');
  lines.push('# TYPE monitor_up gauge');
  for (const a of agents) {
    const up = (now - (a.last_seen || 0)) <= offlineSec * 1000 ? 1 : 0;
    lines.push(`monitor_up{agent="${promEscape(a.id)}",name="${promEscape(a.name)}"} ${up}`);
  }
  for (const def of METRIC_DEFS) {
    lines.push(`# HELP ${def.name} ${def.desc}`);
    lines.push(`# TYPE ${def.name} gauge`);
    for (const a of agents) {
      const m = db.getLatestMetric(a.id);
      const v = def.get(m);
      if (v === null || v === undefined) continue;
      lines.push(`${def.name}{agent="${promEscape(a.id)}",name="${promEscape(a.name)}"} ${v}`);
    }
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
});

app.use('/api', api);

// 公开状态页（首页 /）：支持第三方主题皮肤
// 若 ui_settings.public_theme 指向 public/themes/<id> 下的皮肤，则投放该皮肤首页；
// 否则回退到内置默认 public/index.html。主题目录名经白名单校验，杜绝路径穿越。
const THEMES_DIR = path.join(__dirname, 'public', 'themes');
app.get('/', (req, res, next) => {
  const theme = (db.getUiSettings().public_theme || 'default');
  if (theme && theme !== 'default' && /^[A-Za-z0-9_-]+$/.test(theme)) {
    const fp = path.join(THEMES_DIR, theme, 'index.html');
    if (fs.existsSync(fp)) return res.sendFile(fp);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// periodic prune of old metrics
const retentionDays = Number(process.env.RETENTION_DAYS || 30);
let pruneFails = 0;
setInterval(() => {
  try {
    const n = db.prune(retentionDays);
    if (n > 0) console.log(`[prune] removed ${n} old metrics`);
    pruneFails = 0;
  } catch (e) {
    console.error('[prune] error', e.message);
    pruneFails++;
    // 持续失败（默认每 3 小时一次）才发告警，避免瞬态失败刷屏；长期不清理会导致 metrics 表无限膨胀。
    if (pruneFails >= 3) {
      alerts.sendAlert('[监控] 数据清理(prune)持续失败', `metrics 清理已连续 ${pruneFails} 次失败：${e.message}。若长期不清理，metrics 表将持续膨胀，请检查数据库权限/磁盘空间。`);
      pruneFails = 0;
    }
  }
}, 3600 * 1000);

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[monitor] server listening on :${PORT}`);
  alerts.start();
});
