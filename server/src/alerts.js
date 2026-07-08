const nodemailer = require('nodemailer');
const db = require('./db');

let transporter = null;

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

async function sendAlert(subject, text) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.ALERT_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_TO || process.env.SMTP_USER,
      subject,
      text
    });
    console.log('[alerts] sent:', subject);
  } catch (e) {
    console.error('[alerts] mail error:', e.message);
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

let timer = null;
function start() {
  initMail();
  const interval = Math.max(10000, (Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000) / 2);
  timer = setInterval(check, interval);
  console.log('[alerts] checker started');
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, sendAlert };
