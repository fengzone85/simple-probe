const https = require('https');
const nodemailer = require('nodemailer');
const db = require('./db');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 邮件通道：从「设置中心 / 环境变量」读取，每次发送时动态构建（使 UI 改动即时生效，无需重启）。
function mailTransport() {
  const c = db.getNotifyConfig();
  if (!c.smtp_user || !c.smtp_pass) return null;
  return nodemailer.createTransport({
    host: c.smtp_host || 'smtp.qq.com',
    port: Number(c.smtp_port || 465),
    secure: c.smtp_secure !== false,
    auth: { user: c.smtp_user, pass: c.smtp_pass }
  });
}

// 通过 Telegram Bot API 发送消息。返回 Promise，但任何错误都在内部吞掉，
// 绝不让电报故障影响邮件通道或告警主流程。
function sendTelegram(text) {
  return new Promise((resolve) => {
    const c = db.getNotifyConfig();
    if (!c.telegram_bot_token || !c.telegram_chat_id) return resolve();
    const payload = JSON.stringify({
      chat_id: c.telegram_chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${c.telegram_bot_token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c2) => { body += c2; });
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
  const c = db.getNotifyConfig();
  // 通道一：邮件
  const transporter = mailTransport();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: c.alert_from || c.smtp_user,
        to: c.alert_to || c.smtp_user,
        subject,
        text
      });
      console.log('[alerts] mail sent:', subject);
    } catch (e) {
      console.error('[alerts] mail error:', e.message);
    }
  }
  // 通道二：Telegram（HTML 转义，防止标题/正文里的特殊字符破坏解析）
  if (c.telegram_bot_token && c.telegram_chat_id) {
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

function notifyStatus() {
  const c = db.getNotifyConfig();
  return {
    mail: !!(c.smtp_user && c.smtp_pass),
    telegram: !!(c.telegram_bot_token && c.telegram_chat_id)
  };
}

let timer = null;
function start() {
  const interval = Math.max(10000, (Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000) / 2);
  timer = setInterval(check, interval);
  console.log('[alerts] checker started');
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, sendAlert, notifyStatus };
