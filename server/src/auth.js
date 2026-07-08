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

// 协议白名单：仅允许经反向代理且原始请求为 HTTPS 时携带管理类 Token。
// 直连 :8080（无 X-Forwarded-Proto 头、或伪造为 http）一律拒绝，
// 杜绝伪造该头绕过、以及误暴露 8080 端口的情况。
// 本地开发/快速测试如需直连 http，可显式设置 ADMIN_ALLOW_HTTP=1（生产切勿设置）。
function requireProto(req, res) {
  const proto = (req.header('X-Forwarded-Proto') || '').toLowerCase();
  if (proto !== 'https' && process.env.ADMIN_ALLOW_HTTP !== '1') {
    res.status(403).json({ error: 'https required' });
    return false;
  }
  return true;
}

// 解析请求角色：admin（X-Admin-Token）或 readonly（X-Readonly-Token，可选）。
// 两者均使用恒定时间比较，避免时序侧信道。未设置 READONLY_TOKEN 时无只读账号。
function resolveRole(req) {
  const at = req.header('X-Admin-Token');
  if (at && safeEqual(at, process.env.ADMIN_TOKEN)) return 'admin';
  const rt = req.header('X-Readonly-Token');
  const roTok = process.env.READONLY_TOKEN;
  if (rt && roTok && safeEqual(rt, roTok)) return 'readonly';
  return null;
}

function adminAuth(req, res, next) {
  if (resolveRole(req) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  next();
}

// 读接口：admin 或 readonly 均可访问（查看数据）。
function adminOrReadonly(req, res, next) {
  const role = resolveRole(req);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  req.role = role;
  next();
}

// 写接口：仅 admin 可访问；携带 readonly Token 返回 403，无 Token 返回 401。
function adminOnly(req, res, next) {
  const role = resolveRole(req);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  if (role !== 'admin') return res.status(403).json({ error: 'admin required' });
  if (!requireProto(req, res)) return;
  req.role = role;
  next();
}

module.exports = { agentAuth, adminAuth, adminOrReadonly, adminOnly, safeEqual };
