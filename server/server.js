require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./src/db');
const api = require('./src/api');
const alerts = require('./src/alerts');

const app = express();

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
app.use('/api', api);
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
