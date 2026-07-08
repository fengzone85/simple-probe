#!/usr/bin/env node
// 测试通知通道（邮件 / Telegram）是否配置正确。
// 用法：在 server/ 目录下执行 `node scripts/test-notify.js`（需先配置 .env）
require('dotenv').config();
// 测试通知不需要真实数据库，用内存库避免 /data 路径依赖
process.env.DB_PATH = ':memory:';
const alerts = require('../src/alerts');

const st = alerts.notifyStatus();
console.log('通知通道状态:', st);
if (!st.mail && !st.telegram) {
  console.error('错误：未配置任何通知通道。请在 .env 填写 SMTP_* 或 TELEGRAM_*。');
  process.exit(1);
}

(async () => {
  try {
    await alerts.sendAlert('[监控] 测试告警', '这是一条测试消息，用于验证通知通道（邮件 / Telegram）是否配置正确。若你收到了，说明配置生效。');
    console.log('测试告警已发送，请检查邮件 / Telegram。');
    process.exit(0);
  } catch (e) {
    console.error('发送失败:', e.message);
    process.exit(1);
  }
})();
