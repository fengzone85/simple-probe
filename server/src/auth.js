const crypto = require('crypto');
const db = require('./db');

// 恒定时间比较，避免令牌比较的时序侧信道。长度不等直接返回 false（不抛异常）。
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function agentAuth(req, res, next) {
  const id = req.header('X-Agent-ID');
  const auth = req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!id || !token) return res.status(401).json({ error: 'unauthorized' });
  const agent = db.getAgent(id);
  if (!agent) return res.status(403).json({ error: 'unknown agent' });
  if (!safeEqual(db.hashToken(token), agent.token_hash)) return res.status(403).json({ error: 'bad token' });
  req.agent = agent;
  next();
}

function adminAuth(req, res, next) {
  const t = req.header('X-Admin-Token');
  if (!t || !safeEqual(t, process.env.ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
  // 白名单：仅允许经反向代理且原始请求为 HTTPS 时携带 Admin Token。
  // 直连 :8080（无 X-Forwarded-Proto 头、或伪造为 http）一律拒绝，
  // 杜绝伪造该头绕过、以及误暴露 8080 端口的情况。
  // 本地开发/快速测试如需直连 http，可显式设置 ADMIN_ALLOW_HTTP=1（生产切勿设置）。
  const proto = (req.header('X-Forwarded-Proto') || '').toLowerCase();
  if (proto !== 'https' && process.env.ADMIN_ALLOW_HTTP !== '1') {
    return res.status(403).json({ error: 'https required' });
  }
  next();
}

module.exports = { agentAuth, adminAuth, safeEqual };
