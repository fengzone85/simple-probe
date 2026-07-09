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
const { num, str, validateReport } = require('./validate');

// ---- 一键安装命令生成（Nezha 风格：服务端把地址 + 每客户端令牌预填进命令）----
// 三条接入路径：① 原生版（Linux systemd + Python，install.sh 自举下载配套文件）；
// ② Docker 版（现场从源码 git 构建镜像并运行，无需任何仓库账号）；
// ③ Windows 版（PowerShell 一键：下载 install.ps1 → 自举拉取 agent 载荷 → 注册计划任务）。
// 仓库 raw 基址（install.sh 位于根，agent 载荷位于 <base>/agent/）；可用 AGENT_RAW_REPO 覆盖。
const REPO_BASE = (process.env.AGENT_RAW_REPO || 'https://raw.githubusercontent.com/fengzone85/simple-probe/master').replace(/\/+$/, '');
const AGENT_GIT_REPO = process.env.AGENT_GIT_REPO || 'https://github.com/fengzone85/simple-probe.git#master:agent';
const AGENT_INTERVAL_DEFAULT = Number(process.env.AGENT_INTERVAL || 15);

// 受控端接入用的服务端公网地址：优先用 PUBLIC_URL 显式配置（对应 Nezha 的「对接地址」），
// 否则从请求头自动推导（Nginx 已设 X-Forwarded-Proto / Host）。
function getPublicBaseUrl(req) {
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
  const windows = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'sp-agent-install.ps1'; iwr '${REPO_BASE}/agent/windows/install.ps1' -OutFile $p -UseBasicParsing; & $p -RegisterTask -Repo '${REPO_BASE}/agent/windows' -ServerUrl '${serverUrl}' -AgentId '${agentId}' -AgentToken '${agentToken}' -Interval ${iv}"`;
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
    monthly_quota_gb: req.body.monthly_quota_gb,
    grp: str(req.body.group, 60)
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
    grp: str(req.body.group, 60)
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
