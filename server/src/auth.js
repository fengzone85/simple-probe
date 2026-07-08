const db = require('./db');

function agentAuth(req, res, next) {
  const id = req.header('X-Agent-ID');
  const auth = req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!id || !token) return res.status(401).json({ error: 'unauthorized' });
  const agent = db.getAgent(id);
  if (!agent) return res.status(403).json({ error: 'unknown agent' });
  if (db.hashToken(token) !== agent.token_hash) return res.status(403).json({ error: 'bad token' });
  req.agent = agent;
  next();
}

function adminAuth(req, res, next) {
  const t = req.header('X-Admin-Token');
  if (!t || t !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  // 仅允许经反向代理且原始请求为 HTTPS 时携带 Admin Token，避免明文传输被嗅探。
  // 注意：Node 本身是纯 HTTP，TLS 在 Nginx 终止；直连 :8080 的请求不会有此头，
  // 因此生产环境务必不要将 server 端口发布到公网，只暴露 Nginx。
  const proto = (req.header('X-Forwarded-Proto') || '').toLowerCase();
  if (proto && proto !== 'https') return res.status(403).json({ error: 'https required' });
  next();
}

module.exports = { agentAuth, adminAuth };
