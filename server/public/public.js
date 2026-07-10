'use strict';

// 独立游客公开状态页逻辑（与后台 app.js 物理分离，仅调用免登录的 /api/public/*）
const $ = (id) => document.getElementById(id);
const BUILD_TIME = '2026/07/08 00:00:00 (GMT+8)';
let publicAgents = [];
let publicServerOrder = []; // 后台保存的全局卡片顺序（管理员拖拽后生效）
let localOrder = [];        // 本机浏览器拖拽顺序（游客无管理员会话时的本地固定）
let publicLayout = 'grid';
let publicTemplate = 'simple'; // 'simple' = 简约极简卡（无悬停）；'visual' = 视觉版（进度条+曲线+呼吸悬停）
let publicOverview = null;
let publicSparklines = {}; // agentId -> 历史指标数组（仅视觉版使用）

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
// ---------- 探测点 / 速率 辅助（与后台 admin.js 保持一致） ----------
const PROBE_ABBR = { '联通': 'cu', '电信': 'ct', '移动': 'cm', '公共': 'GG' };
function probeLabel(l) { return PROBE_ABBR[l] || l; }
function probeClass(ms) {
  if (ms == null) return 'probe-na';
  if (ms <= 50) return 'probe-ok';
  if (ms <= 200) return 'probe-mid';
  if (ms <= 1000) return 'probe-warn';
  return 'probe-bad';
}
function parseProbes(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (e) { return {}; }
}
function fmtRate(bps) { return fmtBytes(Number(bps) || 0) + '/s'; }
function osIcon(os) {
  if (!os) return null;
  const l = os.toLowerCase();
  if (l.includes('debian'))  return { file: 'os-debian.svg', alt: 'Debian' };
  if (l.includes('ubuntu'))  return { file: 'os-ubuntu.svg', alt: 'Ubuntu' };
  if (l.includes('windows')) return { file: 'os-windows.svg', alt: 'Windows' };
  if (l.includes('centos'))  return { file: 'os-centos.svg', alt: 'CentOS' };
  if (l.includes('alma'))    return { file: 'os-alma.svg', alt: 'AlmaLinux' };
  if (l.includes('rocky'))   return { file: 'os-rocky.svg', alt: 'Rocky' };
  if (l.includes('fedora'))  return { file: 'os-fedora.svg', alt: 'Fedora' };
  if (l.includes('arch'))    return { file: 'os-arch.svg', alt: 'Arch' };
  if (l.includes('alpine'))  return { file: 'os-alpine.svg', alt: 'Alpine' };
  if (l.includes('freebsd')) return { file: 'os-freebsd.svg', alt: 'FreeBSD' };
  if (l.includes('macos') || l.includes('darwin')) return { file: 'os-macos.svg', alt: 'macOS' };
  return null;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
// 公开页暗亮一键切换（忽略 auto，在 light/dark 之间切换）
function currentEffectiveTheme() {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') return t;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function syncThemeIcon() {
  const btn = $('pvTheme');
  if (!btn) return;
  const dark = currentEffectiveTheme() === 'dark';
  btn.textContent = dark ? '🌙' : '☀️';
  btn.title = dark ? '切换到亮色' : '切换到暗色';
}
function quickToggleTheme() {
  const next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
  syncThemeIcon();
}

// ---------- 加载 ----------
async function initPublic() {
  applyTheme(localStorage.getItem('theme') || 'auto');
  syncThemeIcon();
  let meta = null;
  try { meta = await (await fetch('/api/public/meta')).json(); } catch (e) {}
  const enabled = !!(meta && meta.public_enabled);
  publicServerOrder = (meta && Array.isArray(meta.agent_order)) ? meta.agent_order : [];
  try { const lo = JSON.parse(localStorage.getItem('pv_order') || '[]'); if (Array.isArray(lo)) localOrder = lo; } catch (e) {}
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
  publicTemplate = localStorage.getItem('pv_template') || 'simple';
  syncLayoutButtons();
  syncTemplateButtons();
  await loadPublic();
}

async function loadPublic() {
  try {
    const [ov, ag, sp] = await Promise.all([
      fetch('/api/public/overview').then(r => r.json()).catch(() => null),
      fetch('/api/public/agents').then(r => r.json()).catch(() => []),
      (publicTemplate === 'visual')
        ? fetch('/api/public/agents/sparklines?range=6h').then(r => r.json()).catch(() => ({}))
        : Promise.resolve({})
    ]);
    publicOverview = ov; publicAgents = Array.isArray(ag) ? ag : [];
    publicAgents = sortByOrder(publicAgents);
    publicSparklines = sp || {};
  } catch (e) { publicOverview = null; publicAgents = []; publicSparklines = {}; }
  renderPublic();
}

// ---------- 渲染 ----------
function pvStat(k, v, cls) { return `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`; }
// 内联 SVG sparkline（与后台 admin.js 的 sparkline 同源，独立页面自带）
function pubSparkline(values, color) {
  values = (values || []).filter((v) => Number.isFinite(v));
  if (values.length === 0) return '';
  const w = 100, h = 28, max = Math.max(...values, 1e-9), min = Math.min(...values, 0);
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
// 视觉版卡片：与后台仪表盘卡片保持一致（CPU/内存/负载/温度/Swap 曲线 + 网络 + 探测点 + 硬盘条 + 悬停呼吸光晕）
function pubCardHtml(a) {
  const flag = a.country && flagImg(a.country) ? `<span class="flag" title="${esc(countryName(a.country))}">${flagImg(a.country)}</span>` : '';
  const statusCls = a.online ? 'on' : 'offline';
  const cpu = a.cpu, mem = a.mem_pct, disk = a.disk_pct;

  // 视觉版：完整复刻后台卡片
  if (publicTemplate === 'visual') {
    const sp = publicSparklines[a.id] || [];
    const histOk = sp.length > 0;
    const cpuArr = histOk ? sp.map(x => x.cpu) : [cpu];
    const memArr = histOk ? sp.map(x => x.mem_pct) : [mem];
    const rxArr = histOk ? sp.map(x => +(x.net_rx_rate / 1024).toFixed(1)) : [0];
    const txArr = histOk ? sp.map(x => +(x.net_tx_rate / 1024).toFixed(1)) : [0];
    const loadArr = histOk ? sp.map(x => x.load1) : [a.load1];
    const tempArr = histOk ? sp.map(x => x.temp) : [a.temp];
    const swapArr = histOk ? sp.map(x => x.swap_pct) : [a.swap_pct];
    const diskRArr = histOk ? sp.map(x => +(x.disk_r_rate / 1024 / 1024).toFixed(1)) : [0];
    const diskWArr = histOk ? sp.map(x => +(x.disk_w_rate / 1024 / 1024).toFixed(1)) : [0];
    const d = daysUntil(a.expire_at);
    let expireBadge = '';
    if (d != null) {
      const cls = d < 0 ? 'expire' : (d <= 7 ? 'expire-soon' : '');
      const txt = d < 0 ? `已过期 ${-d}天` : `剩 ${d} 天`;
      expireBadge = `<span class="badge ${cls}">${txt}</span>`;
    }
    const merchant = a.merchant ? `<span class="badge">${esc(a.merchant)}</span>` : '';
    const countryBadge = (a.country && flagImg(a.country)) ? `<span class="badge flag" title="${esc(countryName(a.country))}">${flagImg(a.country)} ${esc(countryName(a.country))}</span>` : '';
    const probes = parseProbes(a.probes);
    const diskPct = a.disk_pct != null ? a.disk_pct : 0;
    const diskCls = pctClass(diskPct);
    return `<div class="card pub-card tpl-visual" data-id="${esc(a.id)}" draggable="true">
      <div class="top"><span class="status ${statusCls}"></span><h3>${esc(a.name)}</h3>${merchant}${expireBadge}${countryBadge}</div>
      <div class="meta">${esc(a.online ? (a.hostname || '') : '离线')}${a.online && a.os ? (() => { const o = osIcon(a.os); return ' · ' + (o ? `<img class="os-icon" src="/${o.file}" title="${esc(o.alt)}" /> ` : '') + esc(a.os); })() : ''}</div>
      ${a.note ? `<div class="note">📝 ${esc(a.note)}</div>` : ''}
      <div class="metrics">
        <div class="metric"><div class="m-spark">${pubSparkline(cpuArr, '#5cb6a5')}</div><div class="m-info"><span class="m-lbl">CPU</span><span class="m-val ${pctClass(cpu)}">${fmtPct(cpu)}</span></div></div>
        <div class="metric"><div class="m-spark">${pubSparkline(memArr, '#6c9eff')}</div><div class="m-info"><span class="m-lbl">内存</span><span class="m-val ${pctClass(mem)}">${fmtPct(mem)}</span></div></div>
        <div class="metric"><div class="m-spark">${pubSparkline(loadArr, '#ffce5c')}</div><div class="m-info"><span class="m-lbl">${a.os && a.os.toLowerCase().includes('windows') ? '进程' : '负载'}</span><span class="m-val">${a.load1 != null ? Number(a.load1).toFixed(2) : '—'}</span></div></div>
        <div class="metric"><div class="m-spark">${pubSparkline(tempArr, '#ff7a59')}</div><div class="m-info"><span class="m-lbl">温度</span><span class="m-val">${a.temp != null ? Number(a.temp).toFixed(1) + '°C' : '—'}</span></div></div>
        <div class="metric"><div class="m-spark">${pubSparkline(swapArr, '#a06bff')}</div><div class="m-info"><span class="m-lbl">Swap</span><span class="m-val">${fmtPct(a.swap_pct)}</span></div></div>
        <div class="metric"><div class="m-spark">${pubSparkline(diskRArr, '#4ea5d9')}</div><div class="m-info"><span class="m-lbl">io</span><span class="m-val">${((a.disk_r_rate || 0) / 1048576).toFixed(2)}/${((a.disk_w_rate || 0) / 1048576).toFixed(2)}</span></div></div>
        <div class="metric metric-wide">
          <div class="m-spark">${pubSparkline(rxArr, '#4dd591')}</div>
          <div class="m-info">
            <span class="m-lbl">网络</span>
            <span class="m-val">↓ ${fmtRate(a.net_rx_rate)} &nbsp;↑ ${fmtRate(a.net_tx_rate)}</span>
            ${Object.keys(probes).length ? `<div class="probes">${Object.keys(probes).map(l => { const p = probes[l]; return `<span class="probe ${probeClass(p && p.ms)}">${esc(probeLabel(l))} ${p && p.ok ? (p.ms != null ? p.ms : '✓') : '—'}</span>`; }).join('')}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="disk-row">
        <span class="m-lbl">硬盘</span>
        <div class="bar"><i class="bar-i ${diskCls}" style="width:${diskPct}%"></i></div>
        <span class="m-val ${diskCls}">${fmtPct(diskPct)} · ${fmtBytes(a.disk_used)}/${fmtBytes(a.disk_total)}</span>
      </div>
      <div class="foot"><span class="uptime">⏱ ${a.online ? fmtUptime(a.uptime) : '—'}</span></div>
    </div>`;
  }

  // 简约版：仅基础信息，无任何悬停效果
  return `<div class="card pub-card tpl-simple" data-id="${esc(a.id)}" draggable="true">
    <div class="top"><span class="status ${statusCls}"></span><h3>${esc(a.name)}</h3>${flag}</div>
    <div class="meta">${esc(a.group || '')}${a.online ? (' · ' + esc(a.hostname || '') + (a.os ? (' · ' + (() => { const o = osIcon(a.os); return (o ? `<img class="os-icon" src="/${o.file}" title="${esc(o.alt)}" /> ` : '') + esc(a.os); })()) : '')) : ' · 离线'}</div>
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
    return `<tr data-id="${a.id}">
      <td><div class="ct-name"><span class="status ${statusCls}"></span>${esc(a.name)}</div><div class="ct-sub">${esc(a.group || '')}${a.online ? (' · ' + esc(a.hostname || '')) : ' · 离线'}</div></td>
      <td>${flag || '<span class="ct-sub">—</span>'}</td>
      <td class="ct-num ${a.online && a.cpu >= 90 ? 'danger' : (a.online && a.cpu >= 75 ? 'warn' : '')}">${fmtPct(a.cpu)}</td>
      <td class="ct-num ${a.online && a.mem_pct >= 90 ? 'danger' : (a.online && a.mem_pct >= 75 ? 'warn' : '')}">${fmtPct(a.mem_pct)}</td>
      <td class="ct-num ${pctClass(a.disk_pct)}">${fmtPct(a.disk_pct)}</td>
      <td class="ct-num">${a.online ? fmtUptime(a.uptime) : '—'}</td>
      <td class="ct-sub">${a.online ? (() => { const o = osIcon(a.os); return (o ? `<img class="os-icon" src="/${o.file}" title="${esc(o.alt)}" /> ` : '') + esc(a.os); })() : '—'}</td>
      <td class="ct-num">↓${fmtRate(a.net_rx_rate)} ↑${fmtRate(a.net_tx_rate)}</td>
    </tr>`;
  }).join('');
  return `<table class="ctable"><thead><tr><th>名称</th><th>国家</th><th>CPU</th><th>内存</th><th>硬盘</th><th>在线时长</th><th>系统</th><th>实时网速</th></tr></thead><tbody>${body}</tbody></table>`;
}
// ---------- 列表行点击下方展开详情（Komari 风格）----------
function showPublicDetail(id, tr) {
  // 切换展开/折叠
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('expanded-row')) { next.remove(); tr.classList.remove('expanded'); return; }
  // 移除其他展开行
  document.querySelectorAll('#pvList .expanded-row').forEach(r => r.remove());
  document.querySelectorAll('#pvList tr.expanded').forEach(r => r.classList.remove('expanded'));
  const a = publicAgents.find(x => String(x.id) === String(id));
  if (!a) return;
  tr.classList.add('expanded');
  const probes = parseProbes(a.probes);
  const probeKeys = Object.keys(probes);
  const statusCls = a.online ? 'on' : 'offline';
  const row = document.createElement('tr');
  row.className = 'expanded-row';
  row.innerHTML = `<td colspan="8"><div class="expand-content">
    <div class="ex-header">
      <span class="status ${statusCls}"></span>
      <strong>${esc(a.name)}</strong>
      ${a.merchant ? `<span class="badge">${esc(a.merchant)}</span>` : ''}
      ${a.country && flagImg(a.country) ? `<span class="badge flag">${flagImg(a.country)} ${esc(countryName(a.country))}</span>` : ''}
      <span class="badge">${esc(a.hostname || '')}</span>
      ${a.os ? `<span class="badge">${(() => { const o = osIcon(a.os); return o ? `<img class="os-icon" src="/${o.file}" title="${esc(o.alt)}" /> ` : ''; })()}${esc(a.os)}</span>` : ''}
    </div>
    <div class="ex-stats">
      <div class="ex-stat"><span class="ex-lbl">CPU</span><span class="ex-val ${pctClass(a.cpu)}">${fmtPct(a.cpu)}</span></div>
      <div class="ex-stat"><span class="ex-lbl">内存</span><span class="ex-val ${pctClass(a.mem_pct)}">${fmtPct(a.mem_pct)}</span></div>
      <div class="ex-stat"><span class="ex-lbl">硬盘</span><span class="ex-val ${pctClass(a.disk_pct)}">${fmtPct(a.disk_pct)}</span></div>
      <div class="ex-stat"><span class="ex-lbl">负载</span><span class="ex-val">${a.load1 != null ? Number(a.load1).toFixed(2) : '—'}</span></div>
      <div class="ex-stat"><span class="ex-lbl">温度</span><span class="ex-val">${a.temp != null ? Number(a.temp).toFixed(1) + '°C' : '—'}</span></div>
      <div class="ex-stat"><span class="ex-lbl">Swap</span><span class="ex-val">${fmtPct(a.swap_pct)}</span></div>
    </div>
    <div class="ex-network">
      <div class="ex-net-row">
        <span class="ex-lbl">网络</span>
        <span class="ex-rate" style="color:var(--green)">↓ ${fmtRate(a.net_rx_rate)}</span>
        <span class="ex-rate" style="color:var(--accent2)">↑ ${fmtRate(a.net_tx_rate)}</span>
        <span class="ex-lbl">⏱ ${a.online ? fmtUptime(a.uptime) : '—'}</span>
        <span class="ex-lbl">↓↑ ${fmtBytes((a.net_rx_month || 0) + (a.net_tx_month || 0))}</span>
      </div>
      <div class="ex-probes">${probeKeys.length ? probeKeys.map(l => { const p = probes[l]; return `<span class="probe ${probeClass(p && p.ms)}">${esc(probeLabel(l))} ${p && p.ok ? (p.ms != null ? p.ms : '✓') : '—'}</span>`; }).join('') : '<span class="hint" style="color:var(--muted)">暂无探测数据</span>'}</div>
    </div>
  </div></td>`;
  tr.after(row);
}

function renderPublic() {
  const ov = publicOverview;
  if ($('pvOverview')) {
    if (ov) { const tr = publicAgents.reduce((s,a)=>s+(a.net_rx_rate||0)+(a.net_tx_rate||0),0); $('pvOverview').innerHTML = pvStat('客户端总数', ov.total) + pvStat('在线', ov.online, 'green') + pvStat('离线', ov.offline, 'red') + pvStat('即时网速', `↓↑ ${fmtRate(tr)}`); }
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
function syncTemplateButtons() {
  document.querySelectorAll('[data-pvtemplate]').forEach(b => b.classList.toggle('active', b.getAttribute('data-pvtemplate') === publicTemplate));
}
function setPublicTemplate(v) {
  if (v !== 'simple' && v !== 'visual') return;
  publicTemplate = v;
  localStorage.setItem('pv_template', v);
  syncTemplateButtons();
  loadPublic(); // 视觉版需拉取历史曲线，简约版则清空
}

// ---------- 卡片拖拽排序（固定顺序） ----------
function sortByOrder(list) {
  const order = (localOrder && localOrder.length) ? localOrder : publicServerOrder;
  if (!order || !order.length) return list;
  const m = new Map(order.map((id, i) => [String(id), i]));
  return [...list].sort((a, b) => {
    const ia = m.has(String(a.id)) ? m.get(String(a.id)) : Infinity;
    const ib = m.has(String(b.id)) ? m.get(String(b.id)) : Infinity;
    return ia - ib;
  });
}
function persistOrder() {
  const order = publicAgents.map(a => String(a.id));
  localOrder = order;
  try { localStorage.setItem('pv_order', JSON.stringify(order)); } catch (e) {}
  // 管理员会话存在时同步到服务器（所有人可见固定顺序），否则仅本机固定
  fetch('/api/public/order', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order })
  }).then(r => { if (r.ok) publicServerOrder = order; }).catch(() => {});
}
function bindGridDrag() {
  const grid = $('pvGrid');
  if (!grid) return;
  let dragging = null;
  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.pub-card');
    if (!card) return;
    dragging = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.getAttribute('data-id')); } catch (_) {}
  });
  grid.addEventListener('dragend', e => {
    const card = e.target.closest('.pub-card');
    if (card) card.classList.remove('dragging');
    if (dragging) {
      // 按当前 DOM 顺序回写数组并持久化
      const ids = [...grid.querySelectorAll('.pub-card')].map(el => el.getAttribute('data-id'));
      const map = new Map(publicAgents.map(a => [String(a.id), a]));
      publicAgents = ids.map(id => map.get(id)).filter(Boolean);
      persistOrder();
    }
    dragging = null;
  });
  grid.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragging) return;
    const target = e.target.closest('.pub-card');
    if (!target || target === dragging) return;
    const box = target.getBoundingClientRect();
    const after = (e.clientX - box.left) > box.width / 2 || (e.clientY - box.top) > box.height / 2;
    if (after) grid.insertBefore(dragging, target.nextSibling);
    else grid.insertBefore(dragging, target);
  });
}

// ---------- 事件 ----------
function bindPublic() {
  document.querySelectorAll('[data-pvlayout]').forEach(b => b.addEventListener('click', () => setPublicLayout(b.getAttribute('data-pvlayout'))));
  document.querySelectorAll('[data-pvtemplate]').forEach(b => b.addEventListener('click', () => setPublicTemplate(b.getAttribute('data-pvtemplate'))));
  const tb = $('pvTheme'); if (tb) tb.addEventListener('click', quickToggleTheme);
  bindGridDrag();
  // 列表行点击展开详情
  const pl = $('pvList');
  if (pl) pl.addEventListener('click', e => { const r = e.target.closest('tr[data-id]'); if (r) showPublicDetail(r.getAttribute('data-id'), r); });
}
bindPublic();
initPublic();
// 每 10 秒自动刷新公开数据
setInterval(loadPublic, 10000);
