'use strict';
// 适配版 Komari 皮肤：演示将 Komari 社区皮肤的前端请求层指向 simple-probe。
// 数据来源（与 Komari 同源结构）：
//   - GET  /api/public       站点名/描述
//   - GET  /api/nodes        节点元数据（名称/分组/地区/配额）
//   - GET  /api/recent/:uuid 单节点最近实时指标（嵌套结构）
//   - WS   /api/clients      实时快照（与 Komari 主题对接；优先使用，未装 ws 时降级轮询）
const $ = (id) => document.getElementById(id);
const nodes = new Map(); // uuid -> node meta

function fmtBytes(n) {
  n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(2)) + ' ' + u[i];
}
function fmtRate(n) { return fmtBytes(n) + '/s'; }
function fmtUptime(s) {
  s = Number(s) || 0; const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return `${d}天${h}时${m}分`;
}
function pct(used, total) {
  total = Number(total) || 0; used = Number(used) || 0;
  return total > 0 ? Math.min(100, (used / total) * 100) : 0;
}
function barClass(p) { return p >= 90 ? 'crit' : p >= 75 ? 'warn' : ''; }

function render(nodesMeta, realtime) {
  // nodesMeta: array of node meta (from /api/nodes); realtime: {uuid: {...}} 或 null（仅用 meta）
  const list = $('list');
  if (!nodesMeta || !nodesMeta.length) { list.innerHTML = '<div class="card">暂无数据</div>'; return; }
  let online = 0;
  list.innerHTML = nodesMeta.map((nm) => {
    const rt = realtime ? realtime[nm.uuid] : null;
    const off = !rt;
    if (rt) online++;
    const cpu = rt ? rt.cpu.usage : 0;
    const memP = rt ? pct(rt.ram.used, rt.ram.total) : 0;
    const diskP = rt ? pct(rt.disk.used, rt.disk.total) : 0;
    const up = rt ? fmtRate(rt.network.up) : '—';
    const down = rt ? fmtRate(rt.network.down) : '—';
    const totalTraffic = rt ? fmtBytes((rt.network.totalUp || 0) + (rt.network.totalDown || 0)) : '—';
    const uptime = rt ? fmtUptime(rt.uptime) : '—';
    return `<div class="card ${off ? 'off' : ''}">
      <div class="top">
        <span class="dot"></span>
        <span class="flag">${nm.region || ''}</span>
        <span class="nm">${esc(nm.name)}</span>
        <span class="grp">${esc(nm.group || '')}</span>
      </div>
      <div class="row"><span>CPU</span><b>${cpu.toFixed(1)}%</b></div>
      <div class="bar ${barClass(cpu)}"><i style="width:${cpu}%"></i></div>
      <div class="row"><span>内存</span><b>${memP.toFixed(1)}%</b></div>
      <div class="bar ${barClass(memP)}"><i style="width:${memP}%"></i></div>
      <div class="row"><span>硬盘</span><b>${diskP.toFixed(1)}%</b></div>
      <div class="bar ${barClass(diskP)}"><i style="width:${diskP}%"></i></div>
      <div class="meta">
        <span>↑${up} ↓${down}</span>
        <span>流量 ${totalTraffic}</span>
        <span>在线 ${uptime}</span>
      </div>
    </div>`;
  }).join('');
  if ($('ov')) $('ov').textContent = `在线 ${online} / 共 ${nodesMeta.length} 台`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

async function loadMeta() {
  try {
    const r = await fetch('/api/nodes'); const j = await r.json();
    const arr = (j && j.data) || [];
    nodes.clear(); arr.forEach(n => nodes.set(n.uuid, n));
    return arr;
  } catch (e) { return []; }
}

// 轮询降级路径：/api/nodes + 每节点 /api/recent/{uuid}
async function poll() {
  const meta = await loadMeta();
  const realtime = {};
  await Promise.all(meta.map(async (nm) => {
    try {
      const r = await fetch('/api/recent/' + encodeURIComponent(nm.uuid));
      const j = await r.json();
      const arr = (j && j.data) || [];
      if (arr.length) realtime[nm.uuid] = arr[arr.length - 1];
    } catch (e) {}
  }));
  render(meta, realtime);
}

// WebSocket 路径（与 Komari 主题一致）
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/clients`);
  let metaReady = loadMeta().then(m => { if (!window.__rendered) render(m, null); });
  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const snap = (msg && msg.data) || {};
      const meta = (await metaReady) || [];
      render(meta, snap.data || {});
      window.__rendered = true;
    } catch (e) {}
  };
  ws.onopen = () => { try { ws.send('get'); } catch (e) {} };
  ws.onclose = () => { setTimeout(connectWs, 3000); };
  ws.onerror = () => { ws.close(); };
}

(async function init() {
  try {
    const pub = await (await fetch('/api/public')).json();
    const site = (pub && pub.data) || {};
    const name = site.sitename || '状态页';
    document.title = name + ' · Komari-Adapted';
    if ($('title')) $('title').textContent = name;
  } catch (e) {}

  if ('WebSocket' in window) {
    try { connectWs(); setInterval(poll, 15000); return; } catch (e) {}
  }
  poll();
  setInterval(poll, 5000);
})();
