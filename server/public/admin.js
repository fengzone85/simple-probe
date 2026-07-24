'use strict';

const $ = (id) => document.getElementById(id);
let totpRequired = false;
let detailId = null;
let detailRange = '24h';
let liveTimer = null;
let orderedAgentIds = [];
let dragEl = null;
const charts = {};

// ---------- hash router (#/node/:id) ----------
function initRouter() {
  window.addEventListener('hashchange', onHashChange);
  onHashChange(); // bootstrap from current URL
}
function onHashChange() {
  const m = location.hash.match(/^#\/node\/(\d+)$/);
  if (m) { openDetailPanel(m[1]); } else { closeDetailPanel(); }
}
function navigateDetail(id) { location.hash = `#/node/${id}`; }
function closeDetailPanel() {
  const p = $('detailPanel'); const o = $('detailOverlay');
  if (p) p.classList.remove('open');
  if (o) o.classList.remove('show');
  stopLiveTraffic();
  detailId = null;
}
function openDetailPanel(id) {
  if (detailId === id && $('detailPanel') && $('detailPanel').classList.contains('open')) return;
  detailId = id;
  orderedAgentIds = currentAgents.map(a => a.id);
  const p = $('detailPanel'); const o = $('detailOverlay');
  if (p) p.classList.add('open');
  if (o) o.classList.add('show');
  loadDetail();
  startLiveTraffic(id);
  updateNavButtons(id);
}
// 设置中心（站点名 / 自定义 CSS / 默认排序 / 分组顺序）
let appSettings = { site_title: '', custom_css: '', default_sort: 'created', group_order: [] };
let currentAgents = [];

// ---------- helpers ----------
// 进入仪表盘：隐藏登录页、显示应用、加载设置并刷新
function enterApp() {
  const lp = $('loginPage'); if (lp) lp.style.display = 'none';
  const app = $('app'); if (app) app.hidden = false;
  settingsLoaded = false;
  loadAppSettings();
  refresh();
}
// 显示独立登录页
function showLoginPage() {
  const app = $('app'); if (app) app.hidden = true;
  const lp = $('loginPage'); if (lp) lp.style.display = 'flex';
  const err = $('loginErr'); if (err) err.textContent = '';
  if ($('loginToken')) $('loginToken').value = '';
  if ($('loginTotp')) $('loginTotp').value = '';
  if ($('loginTotpField')) $('loginTotpField').style.display = totpRequired ? '' : 'none';
  if ($('loginToken')) $('loginToken').focus();
}
async function doLogin() {
  const token = $('loginToken').value.trim();
  const totp = $('loginTotp').value.trim();
  if (!token) { $('loginErr').textContent = '请输入管理员 Token'; return; }
  try {
    const r = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, totp })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) {
      if (j.need_totp) { totpRequired = true; if ($('loginTotpField')) $('loginTotpField').style.display = ''; $('loginErr').textContent = '请输入动态码'; if ($('loginTotp')) $('loginTotp').focus(); return; }
      $('loginErr').textContent = j.error || '登录失败';
      return;
    }
    totpRequired = !!j.totp;
    enterApp();
  } catch (e) { $('loginErr').textContent = '登录失败：' + (e.message || e); }
}
async function doLogout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  showLoginPage();
}
function showLogin(need) {
  if (need) totpRequired = true;
  showLoginPage();
  toast('登录已过期，请重新登录' + (need ? '（需要动态码）' : ''));
}
// ---- 首次部署初始化向导 ----
function showSetupPage() {
  const app = $('app'); if (app) app.hidden = true;
  const lp = $('loginPage'); if (lp) lp.style.display = 'none';
  const sp = $('setupPage'); if (sp) sp.style.display = 'flex';
}
async function generateSetup() {
  const btn = $('btnSetupGenerate'); btn.disabled = true; btn.textContent = '生成中…';
  $('setupErr').textContent = '';
  try {
    const r = await fetch('/api/setup/generate', { method: 'POST' });
    const j = await r.json();
    if (r.status !== 200) { $('setupErr').textContent = j.error || '生成失败'; btn.disabled = false; btn.textContent = '生成管理员 Token'; return; }
    $('setupTokenDisplay').textContent = j.token;
    $('setupResult').style.display = '';
    btn.style.display = 'none';
  } catch (e) { $('setupErr').textContent = '生成失败：' + (e.message || e); btn.disabled = false; btn.textContent = '生成管理员 Token'; }
}
// ---- 设置中心：加载并应用 ----
async function loadAppSettings() {
  try {
    const s = await api('/api/settings');
    const def = { site_title: '', custom_css: '', default_sort: 'created', group_order: [], alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 } };
    const ui = Object.assign(def, s.ui || {});
    ui.alert = Object.assign(def.alert, (s.ui && s.ui.alert) || {});
    appSettings = ui;
    applyCustomCss();
    applySiteTitle();
    if ($('sortSelect')) $('sortSelect').value = appSettings.default_sort || 'created';
  } catch (e) { /* 未登录或非管理员忽略 */ }
}
function applyCustomCss() {
  // 自定义 CSS 经同源 /custom.css 以 <link> 投放（M-1 修复：避免内联 <style> 被 CSP 拦截、
  // 同时服务端已清洗）。带时间戳强制刷新，使保存后立即生效。
  let link = $('customCssLink');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = 'customCssLink';
    document.head.appendChild(link);
  }
  link.href = '/custom.css?t=' + Date.now();
}
function applySiteTitle() {
  const t = appSettings.site_title || 'Simple Probe';
  document.title = t + ' · Host Monitor';
  if ($('siteTitle')) $('siteTitle').innerHTML = '🛰️ ' + esc(t) + '<span class="dot">.</span>';
  if ($('loginTitle')) $('loginTitle').textContent = t;
  if ($('siteTitleSide')) $('siteTitleSide').textContent = t;
}
function populateGroupDatalist() {
  const dl = $('groupList'); if (!dl) return;
  const set = new Set();
  currentAgents.forEach(a => { const g = (a.group || '').trim(); if (g) set.add(g); });
  // 同时纳入「站点信息」里配置的分组，使新建分组在卡片编辑中可选
  (appSettings.group_order || []).forEach(g => { g = (g || '').trim(); if (g) set.add(g); });
  dl.innerHTML = Array.from(set).map(g => `<option value="${esc(g)}">`).join('');
}
function toast(msg, type) {
  const t = $('toast'); t.textContent = msg;
  t.className = 'toast' + (type ? ' toast-' + type : '');
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function showBanner(msg) { const b = $('banner'); if (b) { b.textContent = msg; b.hidden = false; } }
function hideBanner() { const b = $('banner'); if (b) b.hidden = true; }
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtPct(p) { return (p == null ? '—' : Number(p).toFixed(1)) + '%'; }
// 进度条阈值色 class（加在 <i class="bar-xxx"> 上，CSS 负责着色）
function pctClass(p) {
  if (p == null) return '';
  if (p >= 90) return 'bar-danger';
  if (p >= 75) return 'bar-warn';
  return '';
}
// 告警阈值（来自设置中心，回退默认 90/90/60）。卡片高亮与后端推送共用同一判定基准。
function getAlert() {
  const d = { cpu_pct: 90, mem_pct: 90, offline_sec: 60 };
  return Object.assign(d, (appSettings && appSettings.alert) || {});
}
// 网络质量 probe 阈值色 class
function probeClass(ms) {
  if (ms == null) return 'probe-na';
  if (ms >= 300) return 'probe-bad';
  if (ms >= 100) return 'probe-warn';
  return 'probe-ok';
}
function parseProbes(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (e) { return {}; }
}
// 探测点运营商名缩写，缓解卡片 / 图例拥挤：联通=cu 电信=ct 移动=cm（公共保留）
const PROBE_ABBR = { '联通': 'cu', '电信': 'ct', '移动': 'cm' };
// 探测目标默认模版：用于新建/编辑客户端时预填，给用户一个正确格式的样例，避免格式写错。
// 用户只需替换其中的 IP 即可（格式：标签:IP[:端口]，逗号分隔）。
const DEFAULT_PROBE_TARGETS = '移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8';
function probeLabel(l) { return PROBE_ABBR[l] || l; }
function fmtRate(bps) { return fmtBytes(Number(bps) || 0) + '/s'; }
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
async function api(url, opts = {}) {
  // 凭证由浏览器自动随 Cookie 发送（same-origin），不再在前端持有明文 Token。
  const headers = Object.assign({}, opts.headers || {});
  const res = await fetch(url, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
  if (res.status === 401) {
    let need = false;
    try { const j = await res.json(); need = !!(j && j.need_totp); } catch (e) {}
    showLogin(need);
    toast('未授权：请先登录' + (need ? '（需要动态码）' : ''));
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}
function closeModal(id) { $(id).classList.remove('show'); }
function openModal(id) { $(id).classList.add('show'); }

// ---------- sparkline (SVG) ----------
function sparkline(values, color) {
  values = (values || []).filter((v) => Number.isFinite(v));
  if (values.length === 0) return '';
  const w = 100, h = 26, max = Math.max(...values, 1e-9), min = Math.min(...values, 0);
  const range = (max - min) || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const area = `0,${h} ${pts} ${w},${h}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="${color}22" />
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}
// 双线 sparkline（如磁盘 IO 读/写两条不同颜色线，共用同一纵坐标刻度）
function sparkline2(rArr, wArr, rColor, wColor) {
  const r = (rArr || []).filter(v => Number.isFinite(v));
  const w = (wArr || []).filter(v => Number.isFinite(v));
  if (!r.length && !w.length) return '';
  const all = r.concat(w);
  const max = Math.max(...all, 1e-9), min = Math.min(...all, 0);
  const range = (max - min) || 1;
  const W = 100, H = 26;
  const pts = (arr) => {
    if (!arr.length) return '';
    return arr.map((v, i) => {
      const x = (i / (arr.length - 1 || 1)) * W;
      const y = H - ((v - min) / range) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${r.length ? `<polyline points="${pts(r)}" fill="none" stroke="${rColor}" stroke-width="1.5" />` : ''}
    ${w.length ? `<polyline points="${pts(w)}" fill="none" stroke="${wColor}" stroke-width="1.5" />` : ''}
  </svg>`;
}

// ---------- overview ----------
async function loadOverview() {
  const o = await api('/api/overview');
  $('overview').innerHTML = `
    <div class="stat"><div class="k">客户端总数</div><div class="v">${o.total}</div></div>
    <div class="stat"><div class="k">在线</div><div class="v green">${o.online}</div></div>
    <div class="stat"><div class="k">离线</div><div class="v red">${o.offline}</div></div>
    <div class="stat"><div class="k">平均 CPU<small> (在线)</small></div><div class="v">${o.avg_cpu}<small>%</small></div></div>
    <div class="stat"><div class="k">平均内存<small> (在线)</small></div><div class="v">${o.avg_mem}<small>%</small></div></div>`;

  // 流量概览 + 分组概览（对标 Komari 的流量 / 地区概览区块）
  const usedGB = (o.traffic_used_bytes || 0) / 1024 ** 3;
  const quota = Number(o.total_quota_gb) || 0;
  const pct = quota > 0 ? Math.min(100, (usedGB / quota) * 100) : 0;
  const grp = (o.groups || []).map(g => `<div class="grp-chip"><span class="gc-name">${esc(g.name)}</span><span class="gc-count">${g.online}/${g.total} 在线</span></div>`).join('') || '<div class="empty small">暂无分组</div>';
  $('ovExtra').innerHTML = `
    <div class="ov-block traffic-block">
      <div class="ov-block-h">📶 流量概览 <small>（本月累计 · 仅在线节点）</small></div>
      <div class="ov-traffic">
        <div class="t-num">↓↑ ${fmtBytes(o.traffic_used_bytes || 0)}</div>
        <div class="t-bar"><div class="bar"><i class="${pctClass(pct)}" data-pct="${pct}"></i></div></div>
        <div class="t-quota">${quota > 0 ? ('总配额 ' + quota + ' GB · 已用 ' + pct.toFixed(1) + '%') : '未配置总流量配额'}</div>
      </div>
    </div>
    <div class="ov-block group-block">
      <div class="ov-block-h">🗂️ 分组概览</div>
      <div class="grp-list">${grp}</div>
    </div>`;
  $('ovExtra').querySelectorAll('.bar > i').forEach((el) => {
    const p = Number(el.dataset.pct || 0);
    el.style.width = p + '%';
    const cls = pctClass(p);
    el.className = cls ? 'bar-i ' + cls : 'bar-i';
  });
}

// ---------- grid ----------
async function loadAgents() {
  const agents = await api('/api/agents');
  currentAgents = agents;
  // 批量获取所有 Agent 的 sparkline 历史（单次请求，避免 N+1 触发 Nginx 限流 429）
  let histMap = {};
  try { histMap = await api('/api/agents/sparklines?range=6h'); } catch (e) { histMap = {}; }
  renderGrid(agents, histMap);
  populateGroupDatalist();
}
function sortAgents(list) {
  const by = appSettings.default_sort || 'created';
  const arr = list.slice();
  if (by === 'name') arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else if (by === 'status') arr.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  else if (by === 'cpu') arr.sort((a, b) => (b.latest && b.latest.cpu || 0) - (a.latest && a.latest.cpu || 0));
  else if (by === 'mem') arr.sort((a, b) => (b.latest && b.latest.mem_pct || 0) - (a.latest && a.latest.mem_pct || 0));
  else arr.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return arr;
}
function renderGrid(agents, histMap) {
  const grid = $('grid');
  if (!agents || !agents.length) { grid.innerHTML = '<div class="empty">暂无客户端，点击右上角「新建客户端」。</div>'; return; }
  const sorted = sortAgents(agents);
  // 按 group 分组
  const groups = {};
  for (const a of sorted) {
    const g = (a.group || '').trim() || '未分组';
    (groups[g] || (groups[g] = [])).push(a);
  }
  // 分组显示顺序：设置中的 group_order 优先（含尚未分配客户端的分组），其余按名称，未分组置底
  const order = appSettings.group_order || [];
  const keys = Object.keys(groups);
  const ordered = [];
  for (const g of order) { const t = (g || '').trim(); if (t && !ordered.includes(t)) ordered.push(t); }
  for (const g of keys.filter(k => !order.includes(k)).sort((a, b) => a.localeCompare(b))) if (g !== '未分组') ordered.push(g);
  if (groups['未分组']) ordered.push('未分组');

  const customOrder = appSettings.custom_order || [];
  const html = ordered.map(g => {
    const members = groups[g] || [];
    const cardsArr = members.slice().sort((a, b) => {
      const ia = customOrder.indexOf(a.id), ib = customOrder.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const cards = cardsArr.map(a => cardHtml(a, histMap[a.id] || [])).join('');
    return `<section class="group-section">
      <h3 class="group-title">${esc(g)} <span class="group-count">${members.length}</span></h3>
      <div class="cards">${cards || '<div class="empty small">该分组暂无客户端</div>'}</div>
    </section>`;
  }).join('');
  grid.innerHTML = html;
  initDragSort();
  grid.querySelectorAll('.bar > i').forEach((el) => {
    const p = Number(el.dataset.pct || 0);
    el.style.width = p + '%';
    const cls = pctClass(p);
    el.className = cls ? 'bar-i ' + cls : 'bar-i';
  });
  renderClients();
}

// 客户端列表视图（对标 Komari 的 Clients 列表）：紧凑表格，点击行打开详情面板。
function renderClients() {
  const el = $('clientsTable');
  if (!el) return;
  if (!currentAgents || !currentAgents.length) { el.innerHTML = '<div class="empty">暂无客户端，点击侧栏「+ 新建客户端」。</div>'; $('clientsCount').textContent = ''; return; }
  const al = getAlert();
  const rows = sortAgents(currentAgents);
  let online = 0;
  const body = rows.map((a) => {
    const m = a.latest || {};
    if (a.online) online++;
    const dotCls = a.online ? ((m.cpu >= al.cpu_pct || m.mem_pct >= al.mem_pct) ? 'alert' : 'on') : 'offline';
    const cpuCls = m.cpu >= al.cpu_pct ? 'danger' : (m.cpu >= 75 ? 'warn' : '');
    const memCls = m.mem_pct >= al.mem_pct ? 'danger' : (m.mem_pct >= 75 ? 'warn' : '');
    const diskCls = pctClass(m.disk_pct);
    return `<tr data-id="${a.id}">
      <td><div class="ct-name"><span class="status ${dotCls}"></span>${esc(a.name)}</div><div class="ct-sub">${esc(a.hostname || '')} · ${esc(a.os || '')}</div></td>
      <td>${a.group ? `<span class="ct-tag">${esc(a.group)}</span>` : '<span class="ct-sub">—</span>'}</td>
      <td>${a.country && flagImg(a.country) ? `<span class="flag" title="${esc(countryName(a.country))}">${flagImg(a.country)}</span>` : '<span class="ct-sub">—</span>'}</td>
      <td>${a.online ? `<span class="ct-num ${cpuCls}">${fmtPct(m.cpu)}</span>` : '<span class="ct-sub">离线</span>'}</td>
      <td>${a.online ? `<span class="ct-num ${memCls}">${fmtPct(m.mem_pct)}</span>` : '<span class="ct-sub">—</span>'}</td>
      <td>${a.online ? `<span class="ct-num ${diskCls}">${fmtPct(m.disk_pct)}</span>` : '<span class="ct-sub">—</span>'}</td>
      <td class="ct-num">${fmtBytes((m.net_rx_month || 0) + (m.net_tx_month || 0))}</td>
      <td class="ct-sub">${m.uptime ? fmtUptime(m.uptime) : '—'}</td>
      <td class="ct-actions">
        <button class="ct-action-btn" data-edit="${a.id}">编辑</button>
      </td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="ctable">
    <thead><tr><th>名称</th><th>分组</th><th>国家</th><th>CPU</th><th>内存</th><th>硬盘</th><th>本月流量</th><th>在线时长</th><th>操作</th></tr></thead>
    <tbody>${body}</tbody></table>`;
  $('clientsCount').textContent = `共 ${rows.length} 台 · 在线 ${online}`;
}
// 硬盘条渲染：把所有物理盘(disks 数组)汇总成「一个总容量」单条展示，
// 不再逐盘列出；无 disks 时回退单盘(disk_pct/used/total)。
function diskRowsHtml(m) {
  let used = 0, total = 0;
  const disks = (m && Array.isArray(m.disks) && m.disks.length) ? m.disks : null;
  if (disks) {
    for (const d of disks) { used += Number(d.used) || 0; total += Number(d.total) || 0; }
  } else {
    used = Number(m.disk_used) || 0; total = Number(m.disk_total) || 0;
  }
  const pct = total ? (used / total * 100) : 0;
  const cls = pctClass(pct);
  return `<div class="disk-row">
    <span class="m-lbl">硬盘</span>
    <div class="bar"><i class="bar-i ${cls}" style="width:${pct.toFixed(2)}%"></i></div>
    <span class="m-val ${cls}">${fmtPct(pct)} · ${fmtBytes(used)}/${fmtBytes(total)}</span>
  </div>`;
}
function cardHtml(a, hist) {
  const m = a.latest || {};
  const d = daysUntil(a.expire_at);
  let expireBadge = '';
  if (d != null) {
    const cls = d < 0 ? 'expire' : (d <= 7 ? 'expire-soon' : '');
    const txt = d < 0 ? `已过期 ${-d}天` : `剩 ${d} 天`;
    expireBadge = `<span class="badge ${cls}">${txt}</span>`;
  }
  const merchant = a.merchant ? `<span class="badge">${esc(a.merchant)}</span>` : '';
  const countryBadge = (a.country && flagImg(a.country)) ? `<span class="badge flag" title="${esc(countryName(a.country))}">${flagImg(a.country)} ${esc(countryName(a.country))}</span>` : '';
  // 计算告警态：CPU/内存超过设置阈值，或磁盘 >= 90%
  const al = getAlert();
  const alert = (m.cpu >= al.cpu_pct || m.mem_pct >= al.mem_pct || (m.disk_pct != null && m.disk_pct >= 90));
  const statusCls = a.online ? (alert ? 'alert' : 'on') : '';
  // 历史数组兜底：无 sparkline 历史时，用当前值画一条线，确保 CPU/内存等图形永不消失
  const histOk = Array.isArray(hist) && hist.length > 0;
  const cpuArr = histOk ? hist.map(x => x.cpu) : [m.cpu];
  const memArr = histOk ? hist.map(x => x.mem_pct) : [m.mem_pct];
  const rxArr = histOk ? hist.map(x => +(x.net_rx_rate / 1024).toFixed(1)) : [0];
  const txArr = histOk ? hist.map(x => +(x.net_tx_rate / 1024).toFixed(1)) : [0];
  const loadArr = histOk ? hist.map(x => x.load1) : [m.load1];
  const tempArr = histOk ? hist.map(x => x.temp) : [m.temp];
  const swapArr = histOk ? hist.map(x => x.swap_pct) : [m.swap_pct];
  const diskRArr = histOk ? hist.map(x => +(x.disk_r_rate / 1024 / 1024).toFixed(1)) : [0];
  const diskWArr = histOk ? hist.map(x => +(x.disk_w_rate / 1024 / 1024).toFixed(1)) : [0];
  const probes = parseProbes(m.probes);
  const diskPct = m.disk_pct != null ? m.disk_pct : 0;
  const diskCls = pctClass(diskPct);
  return `<div class="card" data-id="${esc(a.id)}">
    <div class="top">
      <span class="status ${statusCls}"></span>
      <h3>${esc(a.name)}</h3>${merchant}${expireBadge}${countryBadge}
    </div>
    <div class="meta">${esc(a.hostname || '')} · ${esc(a.os || '')}</div>
    ${a.note ? `<div class="note">📝 ${esc(a.note)}</div>` : ''}
    <div class="metrics">
      <div class="metric">
        <div class="m-spark">${sparkline(cpuArr, '#5cb6a5')}</div>
        <div class="m-info">
          <span class="m-lbl">CPU</span>
          <span class="m-val ${pctClass(m.cpu)}">${fmtPct(m.cpu)}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-spark">${sparkline(memArr, '#6c9eff')}</div>
        <div class="m-info">
          <span class="m-lbl">内存</span>
          <span class="m-val ${pctClass(m.mem_pct)}">${fmtPct(m.mem_pct)}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-spark">${sparkline(loadArr, '#ffce5c')}</div>
        <div class="m-info">
          <span class="m-lbl">${a.os && a.os.toLowerCase().includes('windows') ? '进程' : '负载'}</span>
          <span class="m-val">${m.load1 != null ? m.load1.toFixed(2) : '—'}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-spark">${sparkline(tempArr, '#ff7a59')}</div>
        <div class="m-info">
          <span class="m-lbl">温度</span>
          <span class="m-val">${m.temp != null ? m.temp.toFixed(1) + '°C' : '—'}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-spark">${sparkline(swapArr, '#a06bff')}</div>
        <div class="m-info">
          <span class="m-lbl">Swap</span>
          <span class="m-val">${fmtPct(m.swap_pct)}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-spark">${sparkline2(diskRArr, diskWArr, '#4ea5d9', '#ff9f59')}</div>
        <div class="m-info">
          <span class="m-lbl">io</span>
          <span class="m-val">${((m.disk_r_rate || 0) / 1048576).toFixed(2)}/${((m.disk_w_rate || 0) / 1048576).toFixed(2)}</span>
        </div>
      </div>
      <div class="metric metric-wide">
        <div class="m-spark">${sparkline(rxArr, '#4dd591')}</div>
        <div class="m-info">
          <span class="m-lbl">网络</span>
          <span class="m-val">↓ ${fmtRate(m.net_rx_rate)} &nbsp;↑ ${fmtRate(m.net_tx_rate)}</span>
          ${Object.keys(probes).length ? `<div class="probes">${Object.keys(probes).map(l => { const p = probes[l]; return `<span class="probe ${probeClass(p && p.ms)}">${esc(probeLabel(l))} ${p && p.ok ? (p.ms != null ? p.ms + 'ms' : '✓') : '—'}</span>`; }).join('')}</div>` : ''}
        </div>
      </div>
    </div>
    ${diskRowsHtml(m)}
    <div class="foot">
      <span class="uptime">⏱ ${m.uptime ? fmtUptime(m.uptime) : '—'}</span>
      <button class="btn ghost sm" data-edit="${a.id}">编辑</button>
    </div>
  </div>`;
}
function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}天${h}时` : `${h}时${Math.floor((s%3600)/60)}分`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
function copyText(id) {
  const el = $(id); if (!el) return;
  const text = el.textContent;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板')).catch(() => fallbackCopy(text));
  } else { fallbackCopy(text); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('已复制到剪贴板'); }
  catch (e) { toast('复制失败，请手动选择文本'); }
  document.body.removeChild(ta);
}

// ---------- 主题切换（顶部栏 🌙/☀️ 暗 / 亮 快速切换；设置内仍可选跟随系统） ----------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
function updateThemeBtn() {
  const b = $('btnTheme'); if (!b) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  b.textContent = dark ? '☀️' : '🌙';
  b.title = dark ? '切换到亮色' : '切换到暗色';
}
// 顶部栏按钮：在 暗 / 亮 之间一键切换（忽略 auto，保证点一下立即见效）
function quickToggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = (cur === 'dark') ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
  updateThemeBtn();
  toast('主题：' + (next === 'dark' ? '暗色' : '亮色'));
}

// ---------- 拖拽排序（桌面端 HTML5 Drag；移动端仍用排序下拉 default_sort） ----------
function initDragSort() {
  const grid = $('grid'); if (!grid) return;
  grid.querySelectorAll('.cards').forEach(container => {
    container.querySelectorAll('.card').forEach(card => {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => { dragEl = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); persistSortOrder(); });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        const t = e.target.closest('.card');
        if (t && t !== dragEl) { container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); t.classList.add('drag-over'); }
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        const t = e.target.closest('.card');
        if (t && t !== dragEl) {
          const rect = t.getBoundingClientRect();
          const after = (e.clientY - rect.top) > rect.height / 2;
          container.insertBefore(dragEl, after ? t.nextSibling : t);
        }
      });
    });
  });
}
function collectOrder() {
  const ids = [];
  document.querySelectorAll('#grid .cards .card').forEach(c => ids.push(Number(c.dataset.id)));
  return ids;
}
async function persistSortOrder() {
  const ids = collectOrder();
  try {
    await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { custom_order: ids } }) });
    appSettings.custom_order = ids;
  } catch (e) { toast('排序保存失败：' + e.message); }
}

// ---------- detail ----------
async function openDetail(id) {
  const a = await api(`/api/agents/${id}`).catch(() => null);
  if (a) $('dpTitle').textContent = `${a.name} · 详情`;
  navigateDetail(id);
}
async function loadDetail() {
  if (!detailId) return;
  const rows = await api(`/api/agents/${detailId}/metrics?range=${detailRange}`).catch(() => []);
  const a = await api(`/api/agents/${detailId}`).catch(() => null);
  const ts = rows.map(r => new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  const cpu = rows.map(r => r.cpu);
  const mem = rows.map(r => r.mem_pct);
  const load1 = rows.map(r => r.load1), load5 = rows.map(r => r.load5), load15 = rows.map(r => r.load15);
  const rx = rows.map(r => +(r.net_rx_rate / 1024).toFixed(2));
  const tx = rows.map(r => +(r.net_tx_rate / 1024).toFixed(2));
  const disk = rows.map(r => r.disk_pct);
  const temp = rows.map(r => r.temp);
  const swap = rows.map(r => r.swap_pct);
  // 网络质量：动态解析每行的 probes，按 label 聚合为多系列折线
  const probeSet = new Set();
  rows.forEach(r => { Object.keys(parseProbes(r.probes)).forEach(k => probeSet.add(k)); });
  const probeSeries = [...probeSet].map(label => ({
    name: probeLabel(label),
    data: rows.map(r => { const p = parseProbes(r.probes)[label]; return (p && p.ms != null) ? p.ms : null; })
  }));

  drawLine('cCpu', ts, [{ name: 'CPU%', data: cpu }], '%');
  drawLine('cMem', ts, [{ name: '内存%', data: mem }], '%');
  drawLine('cLoad', ts, [{ name: '1m', data: load1 }, { name: '5m', data: load5 }, { name: '15m', data: load15 }], '');
  drawLine('cNet', ts, [{ name: '下行', data: rx }, { name: '上行', data: tx }], 'KB/s');
  drawLine('cDisk', ts, [{ name: '硬盘%', data: disk }], '%');
  drawLine('cTemp', ts, [{ name: '温度°C', data: temp }], '°C');
  drawLine('cSwap', ts, [{ name: 'Swap%', data: swap }], '%');
  drawLine('cProbe', ts, probeSeries, 'ms');

  // traffic gauge
  const quota = a ? Number(a.monthly_quota_gb) || 0 : 0;
  const latest = rows[rows.length - 1];
  const usedGB = latest ? ((latest.net_rx_month + latest.net_tx_month) / 1024 ** 3) : 0;
  const cT = ensureChart('cTraffic');
  if (quota > 0) {
    cT.setOption({
      series: [{ type: 'gauge', radius: '92%', progress: { show: true }, axisLine: { lineStyle: { width: 14 } },
        detail: { formatter: '{value} GB', fontSize: 16 }, data: [{ value: +usedGB.toFixed(1), name: '已用 / ' + quota + 'GB' }],
        max: quota }]
    });
  } else {
    cT.setOption({ series: [{ type: 'gauge', radius: '92%', progress: { show: true }, axisLine: { lineStyle: { width: 14 } },
      detail: { formatter: '{value} GB', fontSize: 16 }, data: [{ value: +usedGB.toFixed(1), name: '本月已用 (不限速)' }] }] });
  }
}
function ensureChart(id) {
  const el = $(id);
  if (!el) return null;
  const old = charts[id];
  // 详情页 DOM 被重写（重新打开/切换 agent）后，缓存实例仍绑在已脱离文档的旧元素上，
  // 须销毁旧实例并在当前元素上重建，否则新图表空白且旧实例持续泄漏。
  if (old && old.getDom() === el && document.contains(el)) return old;
  if (old) { try { old.dispose(); } catch (e) {} }
  const c = echarts.init(el);
  charts[id] = c;
  return c;
}
function drawLine(id, x, series, unit) {
  const c = ensureChart(id);
  if (!c) return;
  c.setOption({
    grid: { left: 44, right: 12, top: 18, bottom: 24 },
    tooltip: { trigger: 'axis' },
    legend: series.length > 1 ? { bottom: 0, textStyle: { color: '#8b93a7', fontSize: 11 } } : undefined,
    xAxis: { type: 'category', data: x, axisLabel: { color: '#8b93a7', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3142' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8b93a7', fontSize: 10 }, splitLine: { lineStyle: { color: '#222838' } } },
    series: series.map((s, i) => ({
      name: s.name, type: 'line', smooth: true, showSymbol: false, data: s.data,
      areaStyle: i === 0 ? { opacity: 0.12 } : undefined,
      lineStyle: { width: 2 }, itemStyle: { color: ['#36d1c4', '#4f8cff', '#ffc24b', '#3ad07a', '#ff7a59', '#a06bff', '#f25f5c', '#e0c34a'][i % 8] }
    }))
  }, true);
}
function setRange(r, el) {
  detailRange = r;
  document.querySelectorAll('#rangeBar .btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  loadDetail();
}

// ---------- test alert ----------
async function sendTestAlert() {
  const btn = $('btnTestAlert');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '发送中…';
  try {
    const r = await api('/api/test-alert', { method: 'POST' });
    toast('已发送：' + (r.message || '请检查邮件 / Telegram'));
  } catch (e) {
    toast('发送失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

// ---------- create ----------
function populateCountrySelect() {
  const opts = '<option value="">不设置</option>' + COUNTRIES.map(c => `<option value="${c.code}">${flagEmoji(c.code)} ${esc(c.name)}</option>`).join('');
  const cs = $('c_country'), es = $('e_country');
  if (cs) cs.innerHTML = opts;
  if (es) es.innerHTML = opts;
}
function openCreate() {
  populateCountrySelect();
  if ($('c_country')) $('c_country').value = '';
  // 预填：优先用「设置」里的全局默认，否则用内置模版，确保用户看到的是正确格式，只需改 IP。
  if ($('c_probe_targets')) $('c_probe_targets').value = appSettings.probe_targets || DEFAULT_PROBE_TARGETS;
  const btn = $('btnCreateSubmit');
  if (btn) { btn.dataset.done = ''; btn.textContent = '创建并生成 Token'; btn.disabled = false; }
  const res = $('createResult'); if (res) res.innerHTML = '';
  disableCreateForm(false);
  openModal('createModal');
}
// 创建成功后禁用表单，避免重复生成第二张客户端卡片
function disableCreateForm(disabled) {
  ['c_name', 'c_merchant', 'c_expire', 'c_quota', 'c_group', 'c_note', 'c_country', 'c_probe_targets'].forEach(id => {
    const el = $(id); if (el) el.disabled = disabled;
  });
}
// Nezha 风格三 tab 一键命令：Linux 原生 / Docker / Windows。
// pfx 用于区分不同弹窗的 cmd 元素 id（创建=c，编辑/重置=e），避免重复 id。
function renderInstallCmds(inst, pfx) {
  const id = s => s + '_' + pfx;
  return `
      <div class="install-cmds">
        <div class="tabs">
          <button class="btn ghost sm active" data-tab="native">Linux 原生版</button>
          <button class="btn ghost sm" data-tab="docker">Docker 版</button>
          <button class="btn ghost sm" data-tab="windows">Windows 版</button>
        </div>
        <div class="tab-pane" data-pane="native">
          <pre class="cmd" id="${id('cmdNative')}">${esc(inst.native_cmd || '')}</pre>
          <button class="btn sm" data-copy="${id('cmdNative')}">复制 Linux 原生版命令</button>
        </div>
        <div class="tab-pane" data-pane="docker" style="display:none">
          <pre class="cmd" id="${id('cmdDocker')}">${esc(inst.docker_cmd || '')}</pre>
          <button class="btn sm" data-copy="${id('cmdDocker')}">复制 Docker 版命令</button>
        </div>
        <div class="tab-pane" data-pane="windows" style="display:none">
          <pre class="cmd" id="${id('cmdWindows')}">${esc(inst.windows_cmd || '')}</pre>
          <button class="btn sm" data-copy="${id('cmdWindows')}">复制 Windows 版命令</button>
        </div>
      </div>`;
}
async function submitCreate() {
  const btn = $('btnCreateSubmit');
  if (btn.disabled) return;
  // 已经生成过 token：本次点击视为「完成 / 关闭」，避免重复创建第二张卡片
  if (btn.dataset.done === '1') { closeModal('createModal'); return; }
  btn.disabled = true; btn.textContent = '创建中…';
  $('createResult').innerHTML = '';
  try {
    const r = await api('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('c_name').value.trim(), merchant: $('c_merchant').value.trim(),
        expire_at: $('c_expire').value, monthly_quota_gb: Number($('c_quota').value) || 0,
        group: $('c_group').value.trim(),
        country: $('c_country').value.trim(),
        note: $('c_note').value.trim(),
        probe_targets: $('c_probe_targets').value.trim()
      })
    });
    const inst = r.install || {};
    $('createResult').innerHTML = `
      <div class="token-show">AGENT_ID: ${r.id}<br>AGENT_TOKEN: ${r.token}</div>
      <p class="hint">在被控端粘贴下面任一条命令即可完成接入（三选一）：</p>
      ${renderInstallCmds(inst, 'c')}`;
    toast('创建成功，请复制安装命令');
    refresh();
    // 标记已完成：按钮变「完成」、表单锁定，再次点击只关闭弹窗
    btn.dataset.done = '1';
    disableCreateForm(true);
  } catch (e) { toast('创建失败：' + e.message); }
  finally {
    if (btn.dataset.done === '1') { btn.disabled = false; btn.textContent = '完成'; }
    else { btn.disabled = false; btn.textContent = '创建并生成 Token'; }
  }
}

// ---------- edit ----------
async function openEdit(id) {
  const a = await api(`/api/agents/${id}`).catch(() => null);
  if (!a) return;
  $('e_id').value = a.id; $('e_name').value = a.name; $('e_merchant').value = a.merchant || '';
  $('e_expire').value = (a.expire_at || '').slice(0, 10); $('e_quota').value = a.monthly_quota_gb || 0;
  $('e_group').value = a.group || '';
  $('e_country').value = a.country || '';
  $('e_note').value = a.note || '';
  // 该客户端已存值优先；无则回退全局默认 / 内置模版，保证输入框永远是可参照的正确格式。
  $('e_probe_targets').value = a.probe_targets || appSettings.probe_targets || DEFAULT_PROBE_TARGETS;
  $('editResult').innerHTML = '';
  openModal('editModal');
}
async function submitEdit() {
  try {
    const r = await api(`/api/agents/${$('e_id').value}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('e_name').value.trim(), merchant: $('e_merchant').value.trim(),
        expire_at: $('e_expire').value, monthly_quota_gb: Number($('e_quota').value) || 0,
        group: $('e_group').value.trim(),
        country: $('e_country').value.trim(),
        note: $('e_note').value.trim(),
        probe_targets: $('e_probe_targets').value.trim()
      })
    });
    closeModal('editModal'); toast('已保存', 'ok');
    // panel 打开时刷新面板数据（同节点保留面板不关）
    if (detailId) { loadDetail(); updateNavButtons(detailId); }
    refresh();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
}
async function submitDelete() {
  if (!confirm('确认删除该客户端？历史数据将一并清除。')) return;
  try {
    await api(`/api/agents/${$('e_id').value}`, { method: 'DELETE' });
    closeModal('editModal'); toast('已删除');
    history.back(); // 面板同步关闭
    refresh();
  } catch (e) { toast('删除失败：' + e.message); }
}
async function resetToken() {
  const id = $('e_id').value;
  if (!confirm('确认重置该客户端 Token？旧 Token 立即失效，受控端需改用新 Token 后重启。')) return;
  try {
    const r = await api(`/api/agents/${id}/reset-token`, { method: 'POST' });
    const inst = r.install || {};
    $('editResult').innerHTML = `
      <div class="token-show">新 AGENT_TOKEN: ${r.token}</div>
      <p class="hint">请将以下三条一键命令之一粘贴到对应被控端重装 / 重启（已自动带入新 Token，无需手改环境变量）：</p>
      ${renderInstallCmds(inst, 'e')}`;
    toast('Token 已重置，请复制安装命令');
  } catch (e) { toast('重置失败：' + e.message); }
}

// 修改探测命令：免 Token 生成 Linux (systemd drop-in) / Windows (改 bat 重启) 一键命令
async function openModify() {
  if (!detailId) return;
  const a = await api(`/api/agents/${detailId}`).catch(() => null);
  const cur = (a && a.probe_targets) || appSettings.probe_targets || DEFAULT_PROBE_TARGETS;
  const ta = $('modTargets');
  ta.value = cur;
  const gen = () => {
    const pt = ta.value.trim();
    const linux =
      'sudo mkdir -p /etc/systemd/system/simple-probe-agent.service.d\n' +
      'sudo tee /etc/systemd/system/simple-probe-agent.service.d/probe.conf >/dev/null <<\'EOF\'\n' +
      '[Service]\n' +
      'Environment="PROBE_TARGETS=' + pt + '"\n' +
      'EOF\n' +
      'sudo systemctl daemon-reload\n' +
      'sudo systemctl restart simple-probe-agent';
    const win =
      "$id='" + detailId + "'; $pt='" + pt + "'\n" +
      '$bat=Join-Path $env:ProgramData "simple-probe-agent\\run_scheduled.bat"\n' +
      '$lines=Get-Content $bat\n' +
      "if ($lines -match '^set PROBE_TARGETS=') {\n" +
      '  ($lines -replace \'^set PROBE_TARGETS=.*\', "set PROBE_TARGETS=' + pt + '") | Set-Content $bat\n' +
      '} else {\n' +
      '  Add-Content $bat "set PROBE_TARGETS=' + pt + '"\n' +
      '}\n' +
      'Stop-ScheduledTask -TaskName "HostMonitorAgent-$id"; Start-ScheduledTask -TaskName "HostMonitorAgent-$id"';
    $('modLinux').textContent = linux;
    $('modWindows').textContent = win;
  };
  ta.oninput = gen;
  gen();
  openModal('cmdModal');
}

// 客户端列表快捷操作（无需打开编辑弹窗）
async function deleteClient(id) {
  if (!confirm('确认删除该客户端？历史数据将一并清除。')) return;
  try {
    await api(`/api/agents/${id}`, { method: 'DELETE' });
    toast('已删除');
    if (detailId && Number(detailId) === Number(id)) history.back();
    refresh();
  } catch (e) { toast('删除失败：' + e.message); }
}
async function resetClientToken(id) {
  if (!confirm('确认重置该客户端 Token？旧 Token 立即失效，受控端需改用新 Token 后重启。')) return;
  try {
    const r = await api(`/api/agents/${id}/reset-token`, { method: 'POST' });
    toast('Token 已重置：' + r.token);
  } catch (e) { toast('重置失败：' + e.message); }
}

// ---------- P3: panel 内直接操作 ----------
function switchTo(id) { navigateDetail(id); }
function switchToPrev() {
  const i = orderedAgentIds.indexOf(Number(detailId));
  if (i > 0) switchTo(orderedAgentIds[i - 1]);
}
function switchToNext() {
  const i = orderedAgentIds.indexOf(Number(detailId));
  if (i < orderedAgentIds.length - 1) switchTo(orderedAgentIds[i + 1]);
}
function updateNavButtons(id) {
  const i = orderedAgentIds.indexOf(Number(id));
  const total = orderedAgentIds.length;
  const $prev = $('dpPrev'); const $next = $('dpNext'); const $idx = $('dpNavIdx');
  if (total <= 1) {
    if ($prev) $prev.style.visibility = 'hidden';
    if ($next) $next.style.visibility = 'hidden';
    if ($idx) $idx.textContent = '';
    return;
  }
  if ($prev) $prev.style.visibility = i > 0 ? 'visible' : 'hidden';
  if ($next) $next.style.visibility = i < total - 1 ? 'visible' : 'hidden';
  if ($idx) $idx.textContent = `${i + 1} / ${total}`;
}

// ---------- 设置中心 ----------
async function openSettings() {
  try {
    const s = await api('/api/settings');
    const def = { site_title: '', custom_css: '', default_sort: 'created', group_order: [], alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 } };
    const ui = Object.assign(def, s.ui || {});
    ui.alert = Object.assign(def.alert, (s.ui && s.ui.alert) || {});
    appSettings = ui;
    const n = s.notify || {};
    $('s_site_title').value = appSettings.site_title || '';
    $('s_site_url').value = appSettings.site_url || '';
    $('s_agent_url').value = appSettings.agent_server_url || '';
    $('s_probe_targets').value = appSettings.probe_targets || '';
    // 前台/后台互跳统一走「项目网址」（套盾公网），避免暴露 Agent 直连地址
    const $home = $('btnHome');
    if ($home) $home.href = (appSettings.site_url || '').trim() || '/';
    $('s_custom_css').value = appSettings.custom_css || '';
    $('s_default_sort').value = appSettings.default_sort || 'created';
    const al = appSettings.alert;
    $('a_cpu').value = al.cpu_pct;
    $('a_mem').value = al.mem_pct;
    $('a_offline').value = al.offline_sec;
    // 数据保留天数（后台设置优先，缺省回退到环境变量默认 30）
    if ($('a_retention')) $('a_retention').value = appSettings.retention_days || 30;
    $('p_enabled').checked = !!appSettings.public_enabled;
    $('s_allow_ips').value = appSettings.admin_allow_ips || '';
    populateThemeSelect();
    const hl = appSettings.home_layout || 'grid';
    document.querySelectorAll('input[name="homelayout"]').forEach(r => { r.checked = (r.value === hl); });
    const th = localStorage.getItem('theme') || 'auto';
    document.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = (r.value === th); });
    $('n_smtp_host').value = n.smtp_host || '';
    $('n_smtp_port').value = n.smtp_port || '';
    $('n_smtp_secure').checked = !!n.smtp_secure;
    $('n_smtp_user').value = n.smtp_user || '';
    $('n_smtp_pass').value = '';
    $('n_alert_from').value = n.alert_from || '';
    $('n_alert_to').value = n.alert_to || '';
    $('n_tg_token').value = '';
    $('n_tg_chat').value = n.telegram_chat_id || '';
    renderGroupOrder();
    await load2FAStatus();
  } catch (e) { toast('加载设置失败：' + e.message); }
}
function renderGroupOrder() {
  const list = appSettings.group_order || [];
  const ul = $('groupOrderList');
  if (!ul) return;
  ul.innerHTML = list.length
    ? list.map((g, i) => `<li><span class="go-name">${esc(g)}</span>
        <span class="go-actions">
          <button class="btn ghost sm" data-go="up" data-i="${i}">↑</button>
          <button class="btn ghost sm" data-go="down" data-i="${i}">↓</button>
          <button class="btn ghost sm" data-go="del" data-i="${i}">✕</button>
        </span></li>`).join('')
    : '<li class="empty">（暂无分组顺序，添加后监控页将按此顺序分组展示）</li>';
}
function moveGroup(i, act) {
  const list = appSettings.group_order || [];
  if (act === 'del') list.splice(i, 1);
  else if (act === 'up' && i > 0) { const t = list[i-1]; list[i-1] = list[i]; list[i] = t; }
  else if (act === 'down' && i < list.length - 1) { const t = list[i+1]; list[i+1] = list[i]; list[i] = t; }
  else return;
  appSettings.group_order = list;
  renderGroupOrder();
}
function addGroup() {
  const v = ($('newGroupName').value || '').trim();
  if (!v) return;
  appSettings.group_order = appSettings.group_order || [];
  if (!appSettings.group_order.includes(v)) appSettings.group_order.push(v);
  $('newGroupName').value = '';
  renderGroupOrder();
}
async function populateThemeSelect() {
  const sel = $('p_theme'); if (!sel) return;
  const cur = (appSettings && appSettings.public_theme) || 'default';
  sel.innerHTML = '<option value="default">built-in（内置默认状态页）</option>';
  try {
    const list = await api('/api/public/themes');
    (list || []).forEach(t => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = (t.name || t.id) + (t.author ? (' · by ' + t.author) : '');
      sel.appendChild(o);
    });
  } catch (e) {}
  sel.value = cur;
}
async function saveSettings() {
  const al = appSettings.alert || { cpu_pct: 90, mem_pct: 90, offline_sec: 60 };
  const ui = {
    site_title: $('s_site_title').value.trim(),
    site_url: $('s_site_url').value.trim(),
    agent_server_url: $('s_agent_url').value.trim(),
    probe_targets: $('s_probe_targets').value.trim(),
    custom_css: $('s_custom_css').value,
    default_sort: $('s_default_sort').value,
    group_order: appSettings.group_order || [],
    public_enabled: $('p_enabled') ? $('p_enabled').checked : false,
    admin_allow_ips: $('s_allow_ips').value.trim(),
    home_layout: (document.querySelector('input[name="homelayout"]:checked') || {}).value || 'grid',
    public_theme: $('p_theme') ? $('p_theme').value : 'default',
    alert: {
      cpu_pct: Number($('a_cpu').value) || al.cpu_pct,
      mem_pct: Number($('a_mem').value) || al.mem_pct,
      offline_sec: Number($('a_offline').value) || al.offline_sec
    },
    // 数据保留天数：写入 ui_settings.retention_days，服务下次清理时自动生效
    retention_days: Math.min(3650, Math.max(7, Math.floor(Number($('a_retention')?.value) || 30)))
  };
  const notify = {
    smtp_host: $('n_smtp_host').value.trim(),
    smtp_port: Number($('n_smtp_port').value) || 465,
    smtp_secure: $('n_smtp_secure').checked,
    smtp_user: $('n_smtp_user').value.trim(),
    smtp_pass: $('n_smtp_pass').value,
    alert_from: $('n_alert_from').value.trim(),
    alert_to: $('n_alert_to').value.trim(),
    telegram_bot_token: $('n_tg_token').value,
    telegram_chat_id: $('n_tg_chat').value.trim()
  };
  try {
    await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui, notify }) });
    appSettings = Object.assign(appSettings, ui);
    applyCustomCss(); applySiteTitle();
    if ($('sortSelect')) $('sortSelect').value = ui.default_sort;
    toast('设置已保存', 'ok');
    refresh();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
}
async function testNotify() {
  try {
    const r = await api('/api/test-alert', { method: 'POST' });
    toast(r.message || '测试告警已发送');
  } catch (e) { toast('发送失败：' + e.message); }
}
async function onSortChange() {
  appSettings.default_sort = $('sortSelect').value;
  try { await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { default_sort: appSettings.default_sort } }) }); } catch (_) {}
  loadAgents();
}

// ---------- 侧栏视图切换（仪表盘 / 客户端 / 各设置项） ----------
let currentView = 'dashboard';
let settingsLoaded = false;
function setView(v) {
  document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === v));
  if ($('viewDashboard')) $('viewDashboard').hidden = (v !== 'dashboard');
  if ($('viewClients')) $('viewClients').hidden = (v !== 'clients');
  const isSet = v.indexOf('set-') === 0;
  if ($('viewSettings')) $('viewSettings').hidden = !isSet;
  if (isSet) {
    activateSettingsPane(v.slice(4)); // basic/theme/notify/alert/security/public/skin
    if (!settingsLoaded) { openSettings(); settingsLoaded = true; }
  }
  if (v === 'clients') renderClients();
  currentView = v;
}
// 左侧设置子项 -> 仅显示对应 pane（不重新拉取，避免覆盖未保存的改动）
function activateSettingsPane(pane) {
  const root = $('viewSettings');
  if (!root) return;
  const titles = { basic: '站点信息', theme: '主题外观', notify: '通知渠道', alert: '告警规则', security: '账户安全', public: '公开与首页', skin: '皮肤模板' };
  if ($('settingsTitle')) $('settingsTitle').textContent = titles[pane] || '设置';
  root.querySelectorAll('[data-spane]').forEach(p => { p.style.display = (p.getAttribute('data-spane') === pane) ? '' : 'none'; });
}

// ---------- live traffic (安全增强：仅前端轮询既有 /api/agents/:id，不新增指令通道) ----------
function updateLiveTraffic(m) {
  if (!m) return;
  $('ltRx').textContent = fmtRate(m.net_rx_rate);
  $('ltTx').textContent = fmtRate(m.net_tx_rate);
}
async function startLiveTraffic(id) {
  stopLiveTraffic();
  const tick = async () => {
    const a = await api(`/api/agents/${id}`).catch(() => null);
    if (a) updateLiveTraffic(a.latest);
  };
  await tick();
  liveTimer = setInterval(tick, 3000);
}
function stopLiveTraffic() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

// ---------- refresh loop ----------
// ---------- event bindings (替代内联 onclick，以适配严格的 CSP) ----------
function bindEvents() {
  $('btnLoginSubmit').addEventListener('click', doLogin);
  $('loginToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('loginTotp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('btnSetupGenerate').addEventListener('click', generateSetup);
  $('btnSetupLogin').addEventListener('click', () => { $('setupPage').style.display = 'none'; showLoginPage(); $('loginToken').focus(); });
  $('btnLogout').addEventListener('click', doLogout);
  $('btnTestAlert').addEventListener('click', sendTestAlert);
  $('navSecurity').addEventListener('click', () => openModal('securityModal'));
  $('btnSettingsBack').addEventListener('click', () => setView('dashboard'));
  populateCountrySelect();
  $('btnTheme').addEventListener('click', quickToggleTheme);
  $('tfaToggle').addEventListener('click', start2FASetup);
  $('btnNew').addEventListener('click', openCreate);
  $('btnCreateSubmit').addEventListener('click', submitCreate);
  $('btnEditSubmit').addEventListener('click', submitEdit);
  $('btnDelete').addEventListener('click', submitDelete);
  $('btnResetToken').addEventListener('click', resetToken);
  $('btnSettingsSave').addEventListener('click', saveSettings);
  $('btnTestNotify').addEventListener('click', testNotify);
  $('btnAddGroup').addEventListener('click', addGroup);
  $('sortSelect').addEventListener('change', onSortChange);
  $('rangeBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (b) setRange(b.getAttribute('data-r'), b);
  });
  $('grid').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openEdit(editBtn.getAttribute('data-edit')); return; }
    const card = e.target.closest('.card[data-id]');
    if (card) openDetail(card.getAttribute('data-id'));
  });
  // 客户端列表视图：点击行打开详情面板
  $('clientsTable').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { e.stopPropagation(); openEdit(ed.getAttribute('data-edit')); return; }
    const rs = e.target.closest('[data-reset]');
    if (rs) { e.stopPropagation(); resetClientToken(rs.getAttribute('data-reset')); return; }
    const dl = e.target.closest('[data-del]');
    if (dl) { e.stopPropagation(); deleteClient(dl.getAttribute('data-del')); return; }
    const row = e.target.closest('tr[data-id]');
    if (row) openDetail(row.getAttribute('data-id'));
  });
  // 侧栏导航：仪表盘 / 客户端 切换视图
  document.querySelectorAll('.nav-item[data-view]').forEach(b => {
    b.addEventListener('click', () => setView(b.getAttribute('data-view')));
  });
  // 主题偏好单选（设置内）：选中即生效并记忆
  document.querySelectorAll('input[name="theme"]').forEach(r => {
    r.addEventListener('change', (e) => {
      const v = e.target.value;
      localStorage.setItem('theme', v);
      applyTheme(v);
      toast('主题：' + ({ auto: '跟随系统', light: '亮色', dark: '暗色' }[v]));
    });
  });
  document.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-close]');
    if (closeEl) {
      const cid = closeEl.getAttribute('data-close');
      closeModal(cid);
      if (cid === 'detailModal') stopLiveTraffic();
      return;
    }
    if (e.target.id === 'detailOverlay' || e.target.closest('#dpBack')) { history.back(); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      moveGroup(Number(go.getAttribute('data-i')), go.getAttribute('data-go'));
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      const container = tab.closest('.install-cmds');
      const t = tab.getAttribute('data-tab');
      container.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === tab));
      container.querySelectorAll('[data-pane]').forEach(p => { p.style.display = (p.getAttribute('data-pane') === t) ? '' : 'none'; });
      return;
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) { copyText(cp.getAttribute('data-copy')); }
  });
}

async function refresh() {
  // overview 与 grid 是独立视图：并发加载、各自独立失败，
  // 任一接口异常都不影响另一视图的更新（失败时保留已加载的旧内容）。
  const [ov, ag] = await Promise.allSettled([loadOverview(), loadAgents()]);
  if (ov.status === 'rejected' && ag.status === 'rejected') {
    const err = ov.reason;
    showBanner('数据加载失败：' + (err && err.message ? err.message : err));
  } else {
    hideBanner();
  }
}
bindEvents();
load2FAStatus();
initLoad();

async function initLoad() {
  try {
    const sr = await fetch('/api/setup/status');
    const sj = await sr.json();
    if (sj.needs_setup) { showSetupPage(); return; }
  } catch (e) {}
  try {
    const r = await fetch('/api/admin/2fa/status', { credentials: 'same-origin' });
    if (r.status === 200) { const st = await r.json(); totpRequired = !!st.enabled; enterApp(); setView('dashboard'); return; }
  } catch (e) {}
  showLoginPage();
}
setInterval(() => { if (detailId && $('detailPanel') && $('detailPanel').classList.contains('open')) loadDetail(); else refresh(); }, 10000);
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));
$('dpBack').addEventListener('click', () => history.back());
$('dpPrev').addEventListener('click', switchToPrev);
$('dpNext').addEventListener('click', switchToNext);
$('dpClose').addEventListener('click', () => history.back());
$('panelEdit').addEventListener('click', () => { if (detailId) openEdit(detailId); });
$('panelReset').addEventListener('click', () => { if (detailId) openEdit(detailId); $('btnResetToken').click(); });
$('panelModify').addEventListener('click', () => { if (detailId) openModify(); });
$('panelDelete').addEventListener('click', () => { if (detailId) openEdit(detailId); setTimeout(() => $('btnDelete').click(), 50); });
initRouter();
applyTheme(localStorage.getItem('theme') || 'auto');
updateThemeBtn();

// ---------- 2FA (TOTP) ----------
async function load2FAStatus() {
  try {
    const st = await api('/api/admin/2fa/status');
    totpRequired = !!st.enabled;
    $('tfaStatus').textContent = st.enabled ? '状态：已启用' : '状态：未启用';
    $('tfaToggle').textContent = st.enabled ? '禁用两步验证' : '启用两步验证';
    $('tfaSetup').style.display = 'none';
  } catch (e) { $('tfaStatus').textContent = '加载失败'; }
}
function start2FASetup() {
  $('tfaCode').value = '';
  $('tfaSetup').style.display = '';
  if (totpRequired) {
    $('tfaSecret').textContent = '请输入 Authenticator 中的动态码以禁用两步验证：';
    $('tfaEnable').textContent = '确认禁用';
    $('tfaEnable').onclick = disable2FA;
  } else {
    $('tfaSecret').textContent = '正在生成密钥…';
    api('/api/admin/2fa/setup').then(r => {
      $('tfaSecret').textContent = '密钥（手动输入到 Authenticator 应用）：\n' + r.secret + '\n\n' + r.otpauth_uri;
    }).catch(e => {
      // 错误直接显示在面板中，让用户看到具体原因（如 HTTPS 要求）
      $('tfaSecret').textContent = '生成失败：' + e.message + '\n\n请确认已通过 HTTPS 访问后台（或设置 ADMIN_ALLOW_HTTP=1），然后重试。';
      toast('设置失败：' + e.message);
    });
    $('tfaEnable').textContent = '确认启用';
    $('tfaEnable').onclick = enable2FA;
  }
}
async function enable2FA() {
  const code = $('tfaCode').value.trim();
  if (!code) { toast('请输入动态码'); return; }
  try {
    await api('/api/admin/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    toast('两步验证已启用');
    await load2FAStatus();
    refresh();
  } catch (e) { toast('启用失败：' + e.message); }
}
async function disable2FA() {
  const code = $('tfaCode').value.trim();
  if (!code) { toast('请输入动态码以禁用'); return; }
  try {
    await api('/api/admin/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    toast('两步验证已禁用');
    await load2FAStatus();
    refresh();
  } catch (e) { toast('禁用失败：' + e.message); }
}
