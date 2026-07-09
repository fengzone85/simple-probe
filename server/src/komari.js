'use strict';
// Komari 兼容 API 层（PoC）
// 让 simple-probe 的公开数据以 Komari 社区皮肤所期望的接口形状暴露，
// 从而使「适配路线」可行：把 Komari 主题的前端请求层指向本服务即可复用。
// 仅暴露只读、脱敏数据，且同样受 ui_settings.public_enabled 开关约束（与 /api/public/* 一致）。
const express = require('express');
const router = express.Router();
const db = require('./db');

const offlineMs = () => Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000;
const isOnline = (a) => (Date.now() - (a.last_seen || 0)) <= offlineMs();

// ISO 3166-1 alpha-2 -> 国旗 emoji（Komari 的 region 字段用国旗表情）
function flagEmoji(iso) {
  if (!iso || iso.length !== 2) return '';
  const cc = iso.toUpperCase();
  const A = 0x1F1E6;
  const base = 'A'.charCodeAt(0);
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(A + cc.charCodeAt(0) - base) + String.fromCodePoint(A + cc.charCodeAt(1) - base);
}

// simple-probe agent -> Komari node 列表项（/api/nodes）
function toNode(a) {
  const m = db.getLatestMetric(a.id) || {};
  return {
    uuid: a.id,
    name: a.name,
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 0,
    cpu_physical_cores: 0,
    os: a.os || '',
    kernel_version: a.hostname || '',
    gpu_name: 'None',
    region: flagEmoji(a.country),
    mem_total: Number(m.mem_total) || 0,
    swap_total: Number(m.swap_total) || 0,
    disk_total: Number(m.disk_total) || 0,
    weight: 0,
    price: -1,
    billing_cycle: 30,
    auto_renewal: true,
    currency: '$',
    expired_at: a.expire_at ? a.expire_at : '0001-01-01T00:00:00.0000000+00:00',
    group: a.grp || '',
    tags: '',
    hidden: false,
    public_remark: a.note || '',
    traffic_limit: Number(a.monthly_quota_gb) > 0 ? Math.round(a.monthly_quota_gb * 1e9) : 0,
    traffic_limit_type: 'max',
    created_at: new Date(a.created_at).toISOString(),
    updated_at: new Date(a.last_seen || a.created_at).toISOString()
  };
}

// simple-probe metric -> Komari 实时嵌套结构（/api/recent/{uuid} 与 WS 同构）
function toRealtime(m) {
  if (!m) return null;
  return {
    cpu: { usage: Number(m.cpu) || 0 },
    ram: { total: Number(m.mem_total) || 0, used: Number(m.mem_used) || 0 },
    swap: { total: Number(m.swap_total) || 0, used: Number(m.swap_used) || 0 },
    load: { load1: Number(m.load1) || 0, load5: Number(m.load5) || 0, load15: Number(m.load15) || 0 },
    disk: { total: Number(m.disk_total) || 0, used: Number(m.disk_used) || 0 },
    network: {
      up: Number(m.net_tx_rate) || 0,
      down: Number(m.net_rx_rate) || 0,
      totalUp: Number(m.net_tx_month) || 0,
      totalDown: Number(m.net_rx_month) || 0
    },
    connections: { tcp: 0, udp: 0 },
    uptime: Number(m.uptime) || 0,
    process: 0,
    message: '',
    updated_at: new Date(m.ts).toISOString()
  };
}

function publicOpen() {
  const ui = db.getUiSettings();
  return !!(ui && ui.public_enabled);
}

// 全量快照（供 WebSocket /api/clients 使用，结构与 Komari 一致）
function snapshot() {
  if (!publicOpen()) return { data: { online: [], data: {} }, status: 'success' };
  const agents = db.getAgents();
  const online = [];
  const data = {};
  for (const a of agents) {
    if (isOnline(a)) online.push(a.id);
    const rt = toRealtime(db.getLatestMetric(a.id));
    if (rt) data[a.id] = rt;
  }
  return { data: { online, data }, status: 'success' };
}

const guard = (req, res, next) => {
  if (!publicOpen()) return res.status(403).json({ status: 'error', message: 'public page disabled', data: null });
  next();
};

// GET /api/public —— 站点公开属性（主题用）
router.get('/public', guard, (req, res) => {
  const ui = db.getUiSettings();
  res.json({
    status: 'success', message: '',
    data: {
      cors_origin_check_enabled: false,
      custom_body: '', custom_head: '',
      description: '',
      disable_password_login: true,
      oauth_enable: false, oauth_provider: '',
      ping_record_preserve_time: 48,
      private_site: false,
      record_enabled: false, record_preserve_time: 720,
      sitename: ui.site_title || 'simple-probe',
      theme: ui.public_theme || 'Mochi',
      theme_settings: {}
    }
  });
});

// GET /api/version
router.get('/version', (req, res) => {
  res.json({ status: 'success', message: '', data: { hash: '-', version: 'simple-probe-compat' } });
});

// GET /api/nodes —— 节点基础信息列表（不含实时负载）
router.get('/nodes', guard, (req, res) => {
  const agents = db.getAgents();
  res.json({ status: 'success', message: '', data: agents.map(toNode) });
});

// GET /api/recent —— 省略 uuid 时返回空数组（避免 /api/recent/ 触发 404，便于调试）。
router.get('/recent', guard, (req, res) => {
  res.json({ status: 'success', message: '', data: [] });
});

// GET /api/recent/:uuid —— 最近实时指标（取最新一条，嵌套结构）。
router.get('/recent/:uuid', guard, (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.json({ status: 'success', message: '', data: [] });
  const rt = toRealtime(db.getLatestMetric(a.id));
  res.json({ status: 'success', message: '', data: rt ? [rt] : [] });
});

module.exports = { router, snapshot, publicOpen };
