'use strict';

const $ = (id) => document.getElementById(id);
let totpRequired = false;
let detailId = null;
let detailRange = '24h';
let liveTimer = null;
const charts = {};

// ---------- helpers ----------
async function doLogin() {
  const token = $('tokenInput').value.trim();
  const totp = $('totpInput').value.trim();
  if (!token) { toast('请输入管理员 Token'); return; }
  try {
    const r = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, totp })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) { toast(j.error || '登录失败'); return; }
    totpRequired = !!j.totp;
    $('totpInput').value = '';
    $('btnLogout').style.display = '';
    await refresh();
  } catch (e) { toast('登录失败：' + (e.message || e)); }
}
async function doLogout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  location.reload();
}
function showLogin(need) {
  if (need) { totpRequired = true; $('totpInput').style.display = ''; }
  showBanner('请先登录：输入管理员 Token' + (totpRequired ? ' 与动态码' : ''));
  $('tokenInput').focus();
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
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
function parseProbes(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (e) { return {}; }
}
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

// ---------- overview ----------
async function loadOverview() {
  const o = await api('/api/overview');
  $('overview').innerHTML = `
    <div class="stat"><div class="k">客户端总数</div><div class="v">${o.total}</div></div>
    <div class="stat"><div class="k">在线</div><div class="v green">${o.online}</div></div>
    <div class="stat"><div class="k">离线</div><div class="v red">${o.offline}</div></div>
    <div class="stat"><div class="k">平均 CPU<small> (在线)</small></div><div class="v">${o.avg_cpu}<small>%</small></div></div>
    <div class="stat"><div class="k">平均内存<small> (在线)</small></div><div class="v">${o.avg_mem}<small>%</small></div></div>`;
}

// ---------- grid ----------
async function loadAgents() {
  const agents = await api('/api/agents');
  const grid = $('grid');
  if (!agents.length) { grid.innerHTML = '<div class="empty">暂无客户端，点击右上角「新建客户端」。</div>'; return; }
  // 批量获取所有 Agent 的 sparkline 历史（单次请求，避免 N+1 触发 Nginx 限流 429）
  let histMap = {};
  try { histMap = await api('/api/agents/sparklines?range=6h'); } catch (e) { histMap = {}; }
  const hist = agents.map(a => histMap[a.id] || []);
  const html = agents.map((a, i) => {
    const m = a.latest || {};
    const d = daysUntil(a.expire_at);
    let expireBadge = '';
    if (d != null) {
      const cls = d < 0 ? 'expire' : (d <= 7 ? 'expire-soon' : '');
      const txt = d < 0 ? `已过期 ${-d}天` : `剩 ${d} 天`;
      expireBadge = `<span class="badge ${cls}">${txt}</span>`;
    }
    const merchant = a.merchant ? `<span class="badge">${esc(a.merchant)}</span>` : '';
    const cpuArr = hist[i].map(x => x.cpu);
    const memArr = hist[i].map(x => x.mem_pct);
    const rxArr = hist[i].map(x => +(x.net_rx_rate / 1024).toFixed(1));
    const txArr = hist[i].map(x => +(x.net_tx_rate / 1024).toFixed(1));
    const loadArr = hist[i].map(x => x.load1);
    const tempArr = hist[i].map(x => x.temp);
    const swapArr = hist[i].map(x => x.swap_pct);
    const probes = parseProbes(m.probes);
    const probeLabels = Object.keys(probes);
    const probeSummary = probeLabels.length
      ? probeLabels.map(l => `${esc(l)} ${probes[l].ok ? (probes[l].ms != null ? probes[l].ms + 'ms' : '✓') : '✕'}`).join(' · ')
      : '—';
    const diskPct = m.disk_pct != null ? m.disk_pct : 0;
    return `<div class="card" data-id="${a.id}">
      <div class="top">
        <span class="status ${a.online ? 'on' : ''}"></span>
        <h3>${esc(a.name)}</h3>${merchant}${expireBadge}
      </div>
      <div class="meta">${esc(a.hostname || '')} · ${esc(a.os || '未知系统')}${m.uptime ? ' · 在线 ' + fmtUptime(m.uptime) : ''}</div>
      ${a.note ? `<div class="note">📝 ${esc(a.note)}</div>` : ''}
      <div class="metrics">
        <div class="metric"><div class="lbl"><span>CPU</span><span>${fmtPct(m.cpu)}</span></div>${sparkline(cpuArr, '#36d1c4')}</div>
        <div class="metric"><div class="lbl"><span>内存</span><span>${fmtPct(m.mem_pct)}</span></div>${sparkline(memArr, '#4f8cff')}</div>
        <div class="metric"><div class="lbl"><span>负载</span><span>${m.load1 != null ? m.load1.toFixed(2) : '—'}</span></div>${sparkline(loadArr, '#ffc24b')}</div>
        <div class="metric"><div class="lbl"><span>流量 ↓/↑</span><span>${(m.net_rx_rate/1024||0).toFixed(0)}/${(m.net_tx_rate/1024||0).toFixed(0)} KB/s</span></div>${sparkline(rxArr, '#3ad07a')}</div>
        <div class="metric"><div class="lbl"><span>温度</span><span>${m.temp != null ? m.temp.toFixed(1) + '°C' : '—'}</span></div>${sparkline(tempArr, '#ff7a59')}</div>
        <div class="metric"><div class="lbl"><span>Swap</span><span>${fmtPct(m.swap_pct)}</span></div>${sparkline(swapArr, '#a06bff')}</div>
        <div class="metric"><div class="lbl"><span>网络</span><span>${probeSummary}</span></div></div>
      </div>
      <div class="metric disk"><div class="lbl"><span>硬盘</span><span>${fmtPct(diskPct)} · ${fmtBytes(m.disk_used)}/${fmtBytes(m.disk_total)}</span></div>
        <div class="bar"><i data-pct="${diskPct}"></i></div></div>
      <div class="foot">
        <button class="btn ghost sm" data-edit="${a.id}">编辑</button>
      </div>
    </div>`;
  }).join('');
  grid.innerHTML = html;
  grid.querySelectorAll('.bar > i').forEach((el) => { el.style.width = (el.dataset.pct || 0) + '%'; });
}
function fmtUptime(s) {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}天${h}时` : `${h}时${Math.floor((s%3600)/60)}分`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

// ---------- detail ----------
async function openDetail(id) {
  detailId = id;
  openModal('detailModal');
  const a = await api(`/api/agents/${id}`).catch(() => null);
  if (a) $('detailTitle').textContent = `${a.name} · 详情`;
  await loadDetail();
  startLiveTraffic(id);
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
    name: label,
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
  if (!charts[id]) charts[id] = echarts.init($(id));
  return charts[id];
}
function drawLine(id, x, series, unit) {
  const c = ensureChart(id);
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
function openCreate() { openModal('createModal'); }
async function submitCreate() {
  try {
    const r = await api('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('c_name').value.trim(), merchant: $('c_merchant').value.trim(),
        expire_at: $('c_expire').value, monthly_quota_gb: Number($('c_quota').value) || 0,
        note: $('c_note').value.trim()
      })
    });
    $('createResult').innerHTML = `<div class="token-show">AGENT_ID: ${r.id}<br>AGENT_TOKEN: ${r.token}<br><br>请将以上写入受控端 docker run 的环境变量。</div>`;
    toast('创建成功，请复制 Token');
    refresh();
  } catch (e) { toast('创建失败：' + e.message); }
}

// ---------- edit ----------
async function openEdit(id) {
  const a = await api(`/api/agents/${id}`).catch(() => null);
  if (!a) return;
  $('e_id').value = a.id; $('e_name').value = a.name; $('e_merchant').value = a.merchant || '';
  $('e_expire').value = (a.expire_at || '').slice(0, 10); $('e_quota').value = a.monthly_quota_gb || 0;
  $('e_note').value = a.note || '';
  $('editResult').innerHTML = '';
  openModal('editModal');
}
async function submitEdit() {
  try {
    await api(`/api/agents/${$('e_id').value}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('e_name').value.trim(), merchant: $('e_merchant').value.trim(),
        expire_at: $('e_expire').value, monthly_quota_gb: Number($('e_quota').value) || 0,
        note: $('e_note').value.trim()
      })
    });
    closeModal('editModal'); toast('已保存'); refresh();
  } catch (e) { toast('保存失败：' + e.message); }
}
async function submitDelete() {
  if (!confirm('确认删除该客户端？历史数据将一并清除。')) return;
  try {
    await api(`/api/agents/${$('e_id').value}`, { method: 'DELETE' });
    closeModal('editModal'); toast('已删除'); refresh();
  } catch (e) { toast('删除失败：' + e.message); }
}
async function resetToken() {
  const id = $('e_id').value;
  if (!confirm('确认重置该客户端 Token？旧 Token 立即失效，受控端需改用新 Token 后重启。')) return;
  try {
    const r = await api(`/api/agents/${id}/reset-token`, { method: 'POST' });
    $('editResult').innerHTML = `<div class="token-show">新 AGENT_TOKEN: ${r.token}<br><br>请将以上更新到受控端 docker run 的环境变量后重启。</div>`;
    toast('Token 已重置，请复制新 Token');
  } catch (e) { toast('重置失败：' + e.message); }
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
  $('btnLogin').addEventListener('click', doLogin);
  $('btnLogout').addEventListener('click', doLogout);
  $('btnTestAlert').addEventListener('click', sendTestAlert);
  $('btnSecurity').addEventListener('click', async () => { await load2FAStatus(); openModal('securityModal'); });
  $('tfaToggle').addEventListener('click', start2FASetup);
  $('btnNew').addEventListener('click', openCreate);
  $('btnCreateSubmit').addEventListener('click', submitCreate);
  $('btnEditSubmit').addEventListener('click', submitEdit);
  $('btnDelete').addEventListener('click', submitDelete);
  $('btnResetToken').addEventListener('click', resetToken);
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
  document.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-close]');
    if (closeEl) {
      const cid = closeEl.getAttribute('data-close');
      closeModal(cid);
      if (cid === 'detailModal') stopLiveTraffic();
    }
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
    const st = await fetch('/api/admin/2fa/status', { credentials: 'same-origin' }).then(r => r.json());
    totpRequired = !!st.enabled;
    $('totpInput').style.display = totpRequired ? '' : 'none';
  } catch (e) {}
  refresh();
}
setInterval(() => { if (detailId && $('detailModal').classList.contains('show')) loadDetail(); else refresh(); }, 10000);
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));

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
    }).catch(e => toast('设置失败：' + e.message));
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
