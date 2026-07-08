const https = require('https');
const nodemailer = require('nodemailer');
const db = require('./db');

let transporter = null;
let telegramEnabled = false;

function initMail() {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.qq.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('[alerts] mail transport ready');
  } else {
    console.log('[alerts] SMTP not configured, alerts disabled');
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 通过 Telegram Bot API 发送消息。返回 Promise，但任何错误都在内部吞掉，
// 绝不让电报故障影响邮件通道或告警主流程。
function sendTelegram(text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) console.error('[alerts] telegram http', res.statusCode, body);
        resolve();
      });
    });
    req.on('error', (e) => { console.error('[alerts] telegram error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

async function sendAlert(subject, text) {
  // 通道一：邮件
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.ALERT_FROM || process.env.SMTP_USER,
        to: process.env.ALERT_TO || process.env.SMTP_USER,
        subject,
        text
      });
      console.log('[alerts] mail sent:', subject);
    } catch (e) {
      console.error('[alerts] mail error:', e.message);
    }
  }
  // 通道二：Telegram（HTML 转义，防止标题/正文里的特殊字符破坏解析）
  if (telegramEnabled) {
    try {
      await sendTelegram(`<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(text)}`);
      console.log('[alerts] telegram sent:', subject);
    } catch (e) {
      console.error('[alerts] telegram error:', e.message);
    }
  }
}

async function alertThreshold(agent, type, msg, now, cooldown) {
  const st = db.getAlertState(agent.id, type);
  if (!st || now - st.last_sent > cooldown * 1000) {
    db.setAlertState(agent.id, type, now);
    await sendAlert(`[监控] ${agent.name} ${type} 告警`, `客户端 ${agent.name}(${agent.id}) ${msg}。`);
  }
}

async function check() {
  const agents = db.getAgents();
  const now = Date.now();
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const cpuAlert = Number(process.env.ALERT_CPU_PCT || 90);
  const memAlert = Number(process.env.ALERT_MEM_PCT || 90);
  const cooldown = Number(process.env.ALERT_COOLDOWN_SEC || 1800);

  for (const a of agents) {
    try {
      const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
      if (!online) {
        const st = db.getAlertState(a.id, 'offline');
        if (!st || now - st.last_sent > cooldown * 1000) {
          db.setAlertState(a.id, 'offline', now);
          await sendAlert(`[监控] ${a.name} 离线`, `客户端 ${a.name}(${a.id}) 已超过 ${offlineSec}s 未上报，可能已宕机或断网。`);
        }
        continue;
      }
      // recovered -> allow future offline alerts
      db.clearAlertState(a.id, 'offline');
      const m = db.getLatestMetric(a.id);
      if (!m) continue;
      if (m.cpu >= cpuAlert) await alertThreshold(a, 'cpu', `CPU ${m.cpu.toFixed(1)}% >= ${cpuAlert}%`, now, cooldown);
      if (m.mem_pct >= memAlert) await alertThreshold(a, 'mem', `内存 ${m.mem_pct.toFixed(1)}% >= ${memAlert}%`, now, cooldown);
    } catch (e) {
      // 单个 agent 异常（如 DB 读取失败）不应中断其余 agent 的告警检查
      console.error(`[alerts] check failed for agent ${a.id}:`, e.message);
    }
  }
}

function initTelegram() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    telegramEnabled = true;
    console.log('[alerts] telegram ready');
  } else {
    console.log('[alerts] TELEGRAM not configured, telegram alerts disabled');
  }
}

let timer = null;
function start() {
  initMail();
  initTelegram();
  const interval = Math.max(10000, (Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000) / 2);
  timer = setInterval(check, interval);
  console.log('[alerts] checker started');
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, sendAlert };
