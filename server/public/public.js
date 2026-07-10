'use strict';

// 独立游客公开状态页逻辑（与后台 app.js 物理分离，仅调用免登录的 /api/public/*）
const $ = (id) => document.getElementById(id);
const BUILD_TIME = '2026/06/21 20:56:11 (GMT+8)';
let publicAgents = [];
let publicLayout = 'grid';
let publicOverview = null;

// ---------- helpers（与后台保持一致，独立页面自带） ----------
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtPct(p) { return (p == null ? '—' : Number(p).toFixed(1)) + '%'; }
function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}天${h}时` : `${h}时${Math.floor((s % 3600) / 60)}分`;
}
function pctClass(p) {
  if (p == null) return '';
  if (p >= 90) return 'bar-danger';
  if (p >= 75) return 'bar-warn';
  return '';
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

// ---------- 加载 ----------
async function initPublic() {
  applyTheme(localStorage.getItem('theme') || 'auto');
  let meta = null;
  try { meta = await (await fetch('/api/public/meta')).json(); } catch (e) {}
  const enabled = !!(meta && meta.public_enabled);
  const title = (meta && meta.site_title) || '自托管监控';
  if ($('pvTitle')) $('pvTitle').textContent = title;
  // 「进入后台」链接统一走「项目网址」（套盾公网），避免暴露 Agent 直连地址
  const $pa = $('pvAdmin');
  if ($pa) {
    const su = (meta && meta.site_url || '').trim();
    $pa.href = su ? (su.replace(/\/+$/, '') + '/admin.html') : '/admin.html';
  }
  document.title = title + ' · 状态页';
  if ($('pvFooter')) $('pvFooter').innerHTML = 'Powered by ' + esc(title) + ' · Build Time: ' + BUILD_TIME;
  if (!enabled) {
    if ($('pvOverview')) $('pvOverview').innerHTML = '';
    if ($('pvGrid')) $('pvGrid').innerHTML = '<div class="empty">本站暂未开放公开状态页</div>';
    if ($('pvList')) $('pvList').innerHTML = '';
    return;
  }
  publicLayout = meta.home_layout || 'grid';
  syncLayoutButtons();
  await loadPublic();
}

async function loadPublic() {
  try {
    const [ov, ag] = await Promise.all([
      fetch('/api/public/overview').then(r => r.json()).catch(() => null),
      fetch('/api/public/agents').then(r => r.json()).catch(() => [])
    ]);
    publicOverview = ov; publicAgents = Array.isArray(ag) ? ag : [];
  } catch (e) { publicOverview = null; publicAgents = []; }
  renderPublic();
}

// ---------- 渲染 ----------
function pvStat(k, v, cls) { return `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`; }
function pubCardHtml(a) {
  const flag = a.country && flagImg(a.country) ? `<span class="flag" title="${esc(countryName(a.country))}">${flagImg(a.country)}</span>` : '';
  const statusCls = a.online ? 'on' : 'offline';
  const cpu = a.cpu, mem = a.mem_pct, disk = a.disk_pct;
  return `<div class="card pub-card">
    <div class="top"><span class="status ${statusCls}"></span><h3>${esc(a.name)}</h3>${flag}</div>
    <div class="meta">${esc(a.group || '')}${a.online ? (' · ' + esc(a.hostname || '')) : ' · 离线'}</div>
    <div class="metrics">
      <div class="metric"><div class="m-info"><span class="m-lbl">CPU</span><span class="m-val ${pctClass(cpu)}">${fmtPct(cpu)}</span></div></div>
      <div class="metric"><div class="m-info"><span class="m-lbl">内存</span><span class="m-val ${pctClass(mem)}">${fmtPct(mem)}</span></div></div>
      <div class="metric"><div class="m-info"><span class="m-lbl">硬盘</span><span class="m-val ${pctClass(disk)}">${fmtPct(disk)}</span></div></div>
    </div>
    <div class="foot"><span class="uptime">⏱ ${a.online ? fmtUptime(a.uptime) : '—'}</span><span class="ct-sub">↓↑ ${fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0))}</span></div>
  </div>`;
}
function pubListHtml(list) {
  if (!list || !list.length) return '<div class="empty">暂无客户端数据</div>';
  const body = list.map(a => {
    const flag = a.country && flagImg(a.country) ? `<span class="flag" title="${esc(countryName(a.country))}">${flagImg(a.country)}</span>` : '';
    const statusCls = a.online ? 'on' : 'offline';
    return `<tr>
      <td><div class="ct-name"><span class="status ${statusCls}"></span>${esc(a.name)}</div><div class="ct-sub">${esc(a.group || '')}${a.online ? (' · ' + esc(a.hostname || '')) : ' · 离线'}</div></td>
      <td>${flag || '<span class="ct-sub">—</span>'}</td>
      <td class="ct-num ${a.online && a.cpu >= 90 ? 'danger' : (a.online && a.cpu >= 75 ? 'warn' : '')}">${fmtPct(a.cpu)}</td>
      <td class="ct-num ${a.online && a.mem_pct >= 90 ? 'danger' : (a.online && a.mem_pct >= 75 ? 'warn' : '')}">${fmtPct(a.mem_pct)}</td>
      <td class="ct-num ${pctClass(a.disk_pct)}">${fmtPct(a.disk_pct)}</td>
      <td class="ct-num">${fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0))}</td>
    </tr>`;
  }).join('');
  return `<table class="ctable"><thead><tr><th>名称</th><th>国家</th><th>CPU</th><th>内存</th><th>硬盘</th><th>本月流量</th></tr></thead><tbody>${body}</tbody></table>`;
}
function renderPublic() {
  const ov = publicOverview;
  if ($('pvOverview')) {
    if (ov) $('pvOverview').innerHTML = pvStat('客户端总数', ov.total) + pvStat('在线', ov.online, 'green') + pvStat('离线', ov.offline, 'red');
    else $('pvOverview').innerHTML = '';
  }
  const grid = $('pvGrid'), list = $('pvList');
  if (!grid || !list) return;
  if (publicLayout === 'list') {
    grid.hidden = true; list.hidden = false;
    list.innerHTML = pubListHtml(publicAgents);
  } else {
    grid.hidden = false; list.hidden = true;
    grid.innerHTML = publicAgents.length ? publicAgents.map(pubCardHtml).join('') : '<div class="empty">暂无客户端数据</div>';
  }
}
function syncLayoutButtons() {
  document.querySelectorAll('[data-pvlayout]').forEach(b => b.classList.toggle('active', b.getAttribute('data-pvlayout') === publicLayout));
}
function setPublicLayout(v) {
  publicLayout = v;
  syncLayoutButtons();
  renderPublic();
}

// ---------- 事件 ----------
function bindPublic() {
  document.querySelectorAll('[data-pvlayout]').forEach(b => b.addEventListener('click', () => setPublicLayout(b.getAttribute('data-pvlayout'))));
}
bindPublic();
initPublic();
// 每 10 秒自动刷新公开数据
setInterval(loadPublic, 10000);
