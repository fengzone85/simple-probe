const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
const { num, str, validateReport } = require('./validate');
function getAdminToken() {
  if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN !== 'change-me-admin-token' && process.env.ADMIN_TOKEN.length >= 16) return process.env.ADMIN_TOKEN;
  const raw = db.getConfig('admin_token_raw');
  if (raw) return raw;
  // 兼容旧版文件 token（迁移到 DB 后可删）
  try { return fs.readFileSync(path.join(path.dirname(require.resolve('./db')), '..', 'data', 'admin_token.txt'), 'utf-8').trim(); } catch (e) { return ''; }
}

// ---- 首次部署初始化向导 ----
router.get('/setup/status', (req, res) => {
  res.json({ needs_setup: !getAdminToken() });
});
router.post('/setup/generate', (req, res) => {
  if (getAdminToken()) return res.status(400).json({ error: 'already initialized' });
  const token = 'adm_' + crypto.randomBytes(16).toString('hex');
  db.setConfig('admin_token_raw', token);
  console.log('[setup] 管理员 Token 已生成并保存到 DB');
  res.json({ token });
});

// ---- 一键安装命令生成（Nezha 风格：服务端把地址 + 每客户端令牌预填进命令）----
// 三条接入路径：① 原生版（Linux systemd + Python，install.sh 自举下载配套文件）；
// ② Docker 版（现场从源码 git 构建镜像并运行，无需任何仓库账号）；
// ③ Windows 版（PowerShell 一键：下载 install.ps1 → 自举拉取 agent 载荷 → 注册计划任务）。
// 仓库 raw 基址（install.sh 位于根，agent 载荷位于 <base>/agent/）；可用 AGENT_RAW_REPO 覆盖。
const REPO_BASE = (process.env.AGENT_RAW_REPO || 'https://raw.githubusercontent.com/fengzone85/simple-probe/master').replace(/\/+$/, '');
const AGENT_GIT_REPO = process.env.AGENT_GIT_REPO || 'https://github.com/fengzone85/simple-probe.git#master:agent';
const AGENT_INTERVAL_DEFAULT = Number(process.env.AGENT_INTERVAL || 15);

// 受控端接入用的服务端公网地址：优先级为
// ① UI 设置中「Agent 连接地址」② UI 设置中「项目网址」③ 环境变量 PUBLIC_URL ④ 从请求头自动推导。
function getPublicBaseUrl(req) {
  const ui = db.getUiSettings();
  if (ui && ui.agent_server_url) return ui.agent_server_url.replace(/\/+$/, '');
  if (ui && ui.site_url) return ui.site_url.replace(/\/+$/, '');
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim() || 'https';
  const host = req.get('host');
  if (!host) return 'http://localhost:8080';
  return `${proto}://${host}`;
}

// Nezha 风格：一条命令搞定对接。原生版走根 install.sh（自动拉取 agent 载荷并装 systemd）；
// Docker 版现场从源码 git 构建镜像并运行，无需任何仓库账号。
function buildInstallCommands(serverUrl, agentId, agentToken, interval) {
  const iv = interval || AGENT_INTERVAL_DEFAULT;
  // 原生版采用 Komari 风格：先下载成文件、chmod +x、再 sudo 执行（相对 curl|bash 更透明、可审阅）。
  const native = `curl -fsSL ${REPO_BASE}/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh --install-agent --repo ${REPO_BASE} --server ${serverUrl} --id ${agentId} --token ${agentToken} --interval ${iv}`;
  const docker = `docker build -t simple-probe-agent ${AGENT_GIT_REPO} \\\n  && docker run -d --name simple-probe-agent --restart unless-stopped \\\n     -e SERVER_URL=${serverUrl} -e AGENT_ID=${agentId} -e AGENT_TOKEN=${agentToken} -e INTERVAL=${iv} \\\n     -v simple-probe-state:/data \\\n     simple-probe-agent`;
  // Windows 版：一条 PowerShell 命令。外层用双引号、内部一律单引号，避免引号嵌套。
  // install.ps1 会自举下载 windows_agent.py/win_collector.py/requirements.txt 到
  // %ProgramData%\simple-probe-agent，并注册登录自启的计划任务。需以管理员身份运行。
  const windows = `powershell -NoProfile -ExecutionPolicy Bypass -Command "\`$p=Join-Path \`$env:TEMP 'sp-agent-install.ps1'; iwr '${REPO_BASE}/agent/windows/install.ps1' -OutFile \`$p -UseBasicParsing; & \`$p -RegisterTask -Repo '${REPO_BASE}/agent/windows' -ServerUrl '${serverUrl}' -AgentId '${agentId}' -AgentToken '${agentToken}' -Interval ${iv}"`;
  return { server_url: serverUrl, native_cmd: native, docker_cmd: docker, windows_cmd: windows };
}

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

// ---- 一键脚本：受控端自助注册（受 SETUP_TOKEN 守卫）----
// 启用条件：服务端 .env 配置了 SETUP_TOKEN。受控端携带该令牌调用本端点，
// 服务端自动创建客户端并返回 id/token，使 agent 安装做到「只填域名+密钥」。
// 不建立任何指令通道——注册后 agent 仍只上报指标，服务端不持有其任何控制权。
router.post('/setup/register', (req, res) => {
  const setupToken = process.env.SETUP_TOKEN;
  if (!setupToken) {
    return res.status(403).json({ error: '服务端未启用一键注册（未配置 SETUP_TOKEN）' });
  }
  const provided = (req.body && req.body.setup_token) || (req.headers['x-setup-token'] || '').trim();
  if (!provided || !safeEqual(provided, setupToken)) {
    return res.status(401).json({ error: 'invalid setup token' });
  }
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    note: str(req.body.note, 500)
  });
  res.json({ agent_id: id, agent_token: token });
});

// ---- Admin: list agents + latest metric + online status ----
router.get('/agents', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    return Object.assign({}, a, { group: a.grp || '', online: !!online, latest: latest || null });
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
  res.json(Object.assign({}, a, { group: a.grp || '', online: !!online, latest: latest || null }));
});

// ---- Admin: metrics time-series ----
const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
router.get('/agents/:id/metrics', adminOrReadonly, (req, res) => {
  const sec = RANGES[req.query.range] || 3600;
  const rows = db.getMetrics(req.params.id, Date.now() - sec * 1000);
  res.json(rows);
});

// ---- Admin: overview ----
// 在原有「总数/在线/离线/平均 CPU/内存」基础上，补充「流量概览」与「分组概览」，
// 供前端对标 Komari 的流量/地区概览区块直接渲染。
router.get('/overview', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const agents = db.getAgents();
  let online = 0, cpuSum = 0, memSum = 0, cnt = 0;
  let trafficUsedBytes = 0; // 本月累计流量（在线节点 latest 的收+发）
  let totalQuotaGB = 0;
  const groups = {}; // 分组 -> { total, online }
  for (const a of agents) {
    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
    if (isOn) {
      online++;
      const m = db.getLatestMetric(a.id);
      if (m) { cpuSum += m.cpu || 0; memSum += m.mem_pct || 0; cnt++; trafficUsedBytes += (m.net_rx_month || 0) + (m.net_tx_month || 0); }
    }
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++;
    if (isOn) ge.online++;
    totalQuotaGB += Number(a.monthly_quota_gb) || 0;
  }
  res.json({
    total: agents.length,
    online,
    offline: agents.length - online,
    avg_cpu: cnt ? +(cpuSum / cnt).toFixed(1) : 0,
    avg_mem: cnt ? +(memSum / cnt).toFixed(1) : 0,
    traffic_used_bytes: Math.round(trafficUsedBytes),
    total_quota_gb: totalQuotaGB,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online }))
  });
});

// ---- Public（游客）视图：无需登录，受 ui_settings.public_enabled 控制 ----
// 返回脱敏概览（仅总数/在线/离线/分组），不含任何敏感指标均值。
function publicDisabled(res) { return res.status(403).json({ error: 'public view disabled' }); }
router.get('/public/overview', (req, res) => {
  const ui = db.getUiSettings();
  if (!ui.public_enabled) return publicDisabled(res);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const agents = db.getAgents();
  let online = 0;
  const groups = {};
  for (const a of agents) {
    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
    if (isOn) online++;
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++; if (isOn) ge.online++;
  }
  res.json({
    total: agents.length, online, offline: agents.length - online,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online }))
  });
});

// 返回脱敏的公开 agent 列表（不含 token / note / 商家 / 到期 / 配额等敏感字段）。
router.get('/public/agents', (req, res) => {
  const ui = db.getUiSettings();
  if (!ui.public_enabled) return publicDisabled(res);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    const m = online && latest ? latest : null;
    return {
      id: a.id, name: a.name, group: a.grp || '',
      country: a.country || '',
      online: !!online,
      cpu: m ? m.cpu : null,
      mem_pct: m ? m.mem_pct : null,
      disk_pct: m ? m.disk_pct : null,
      disk_used: m ? m.disk_used : 0,
      disk_total: m ? m.disk_total : 0,
      disk_r_rate: m ? m.disk_r_rate : 0,
      disk_w_rate: m ? m.disk_w_rate : 0,
      load1: m ? m.load1 : null,
      temp: m ? m.temp : null,
      swap_pct: m ? m.swap_pct : null,
      net_rx_rate: m ? m.net_rx_rate : 0,
      net_tx_rate: m ? m.net_tx_rate : 0,
      net_rx_month: m ? m.net_rx_month : 0,
      net_tx_month: m ? m.net_tx_month : 0,
      uptime: m ? m.uptime : 0,
      os: (m && m.os) ? m.os : (a.os || ''),
      probes: m ? (m.probes || '') : '',
      hostname: online ? (a.hostname || '') : '',
      merchant: a.merchant || '',
      expire_at: a.expire_at || '',
      note: a.note || '',
      monthly_quota_gb: a.monthly_quota_gb || 0
    };
  });
  res.json(list);
});

// 公开历史曲线（脱敏，仅指标时序，无 token / 备注 / 商家等敏感字段）。
// 供「视觉版」首页卡片渲染 sparkline。受 ui.public_enabled 控制。
router.get('/public/agents/sparklines', (req, res) => {
  const ui = db.getUiSettings();
  if (!ui.public_enabled) return publicDisabled(res);
  const sec = RANGES[req.query.range] || 21600;
  const rows = db.getMetricsAll(Date.now() - sec * 1000);
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push({
      cpu: r.cpu, mem_pct: r.mem_pct, disk_pct: r.disk_pct,
      net_rx_rate: r.net_rx_rate, net_tx_rate: r.net_tx_rate,
      load1: r.load1, temp: r.temp, swap_pct: r.swap_pct, uptime: r.uptime,
      disk_r_rate: r.disk_r_rate, disk_w_rate: r.disk_w_rate
    });
  }
  res.json(byAgent);
});

// 游客视图元信息（无需登录）：站点标题、是否开放、首页默认布局。
router.get('/public/meta', (req, res) => {
  const ui = db.getUiSettings();
  res.json({
    site_title: ui.site_title || '',
    site_url: ui.site_url || '',
    public_enabled: !!ui.public_enabled,
    home_layout: ui.home_layout || 'grid'
  });
});

// 列出 public/themes/ 下的可用皮肤（供后台「皮肤模板」选择）。无需登录。
router.get('/public/themes', (req, res) => {
  const dir = path.join(__dirname, '..', 'public', 'themes');
  const list = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const meta = { id: e.name, name: e.name, author: '', description: '' };
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'manifest.json'), 'utf8'));
        if (m && typeof m === 'object') Object.assign(meta, m);
      } catch (_) {}
      list.push(meta);
    }
  } catch (_) {}
  res.json(list);
});

// ---- Admin: create agent ----
router.post('/agents', adminOnly, (req, res) => {
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2)
  });
  // 创建时一次性把「地址 + 该客户端令牌」预填进两条一键命令返回（令牌仅此刻明文可用）。
  const install = buildInstallCommands(getPublicBaseUrl(req), id, token, AGENT_INTERVAL_DEFAULT);
  res.json({ id, token, install });
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
    monthly_quota_gb: req.body.monthly_quota_gb,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2)
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
  // 重置后同样回带三条一键命令：用户直接复制重装即可，无需手改环境变量。
  const install = buildInstallCommands(getPublicBaseUrl(req), req.params.id, token, AGENT_INTERVAL_DEFAULT);
  res.json({ ok: true, token, install });
});

// ---- Admin: UI + 通知设置（持久化到 admin_config）----
// GET 返回当前设置；密码类字段脱敏（留空表示「保持不变」）。
router.get('/settings', adminOrReadonly, (req, res) => {
  const notify = db.getNotifyConfig();
  const safe = Object.assign({}, notify);
  if (safe.smtp_pass) safe.smtp_pass = '';
  if (safe.telegram_bot_token) safe.telegram_bot_token = '';
  res.json({ ui: db.getUiSettings(), notify: safe });
});
router.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.ui && typeof b.ui === 'object') db.setUiSettings(b.ui);
  if (b.notify && typeof b.notify === 'object') db.setNotifyConfig(b.notify);
  res.json({ ok: true });
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
  if (!token || !safeEqual(token, getAdminToken())) {
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
