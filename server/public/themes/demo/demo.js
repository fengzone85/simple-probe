'use strict';
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

async function load() {
  let meta = {};
  try { meta = await (await fetch('/api/public/meta')).json(); } catch (e) {}
  const enabled = !!(meta && meta.public_enabled);
  const title = meta.site_title || '状态页';
  document.title = title + ' · Status';
  if ($('title')) $('title').textContent = title;
  // 「进入后台」链接统一走「项目网址」（套盾公网），避免暴露 Agent 直连地址
  const $da = $('demoAdmin');
  if ($da) {
    const su = (meta && meta.site_url || '').trim();
    $da.href = su ? (su.replace(/\/+$/, '') + '/admin.html') : '/admin.html';
  }
  if (!enabled) { $('list').textContent = '本站暂未开放公开状态页'; if ($('ov')) $('ov').textContent = ''; return; }
  let agents = [], ov = {};
  try {
    [ov, agents] = await Promise.all([
      fetch('/api/public/overview').then(r => r.json()).catch(() => ({})),
      fetch('/api/public/agents').then(r => r.json()).catch(() => [])
    ]);
  } catch (e) {}
  if ($('ov')) $('ov').textContent = `在线 ${ov.online || 0} / 共 ${ov.total || 0} 台`;
  if (!Array.isArray(agents) || !agents.length) { $('list').textContent = '暂无数据'; return; }
  $('list').innerHTML = agents.map(a => {
    const flag = (a.country && window.flagEmoji) ? flagEmoji(a.country) : '';
    const cls = a.online ? 'on' : 'off';
    const cpu = a.online ? (a.cpu != null ? Number(a.cpu).toFixed(1) + '%' : '—') : '离线';
    return `<div class="row ${cls}">
      <span class="dot"></span>
      <span class="nm">${esc(a.name)}${flag ? ' ' + esc(flag) : ''}</span>
      <span class="cpu">${cpu}</span>
    </div>`;
  }).join('');
}
load();
setInterval(load, 10000);
