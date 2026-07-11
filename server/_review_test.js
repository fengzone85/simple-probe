'use strict';
const db = require('./src/db');
function log(...a){ process.stdout.write(a.join(' ') + '\n'); }
try {
  const { id, token } = db.createAgent({ name: '__t__' });
  log('created agent', id);
  // 模拟 PUT /agents/:id 调用 db.updateAgent（不含 probe_targets）
  db.updateAgent(id, { name: '__t2__', monthly_quota_gb: 0, grp: '', country: '' });
  const a = db.getAgent(id);
  log('updateAgent OK; probe_targets after update =', JSON.stringify(a.probe_targets));
  db.deleteAgent(id);
  log('cleanup done');
} catch (e) {
  log('CAUGHT ERROR:', e && e.message);
}
