---
title: API 接口
description: Simple Probe REST API 参考
---

# API 接口

Simple Probe 服务端提供 REST API，所有接口需 Bearer Token 鉴权。

## 鉴权

所有 API 请求需在 Header 中携带：

```
Authorization: Bearer <admin_token>
```

或使用 Cookie Session（Web 登录后自动携带）。

## Agent 上报

### POST /api/report

受控端定时上报数据。

```json
{
  "token": "agent-token",
  "hostname": "web-01",
  "os": "linux",
  "cpu": 45.2,
  "mem_pct": 62.8,
  "disk_pct": 71.0,
  "load1": 0.52,
  "load5": 0.48,
  "load15": 0.50,
  "net_rx": 1234567,
  "net_tx": 987654,
  "uptime": 86400,
  "temp": 52.0,
  "swap_pct": 12.0,
  "probe": { "target": "1.1.1.1", "rtt": 12.3 }
}
```

## 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览统计 |
| GET | `/api/agents` | 所有节点列表 |
| GET | `/api/agents/:id` | 节点详情 |
| POST | `/api/agents` | 创建节点 |
| PUT | `/api/agents/:id` | 编辑节点 |
| DELETE | `/api/agents/:id` | 删除节点 |
| POST | `/api/agents/:id/reset-token` | 重置 Token |
| GET | `/api/agents/:id/history?range=24h` | 历史数据 |
| GET | `/api/agents/sparklines?range=6h` | 批量 Sparkline |

## 告警

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/alerts` | 告警列表 |
| DELETE | `/api/alerts` | 清除告警 |
| POST | `/api/alerts/test` | 发送测试告警 |

## Prometheus

### GET /metrics

Prometheus 格式指标输出，可用于接入 Grafana。

```
# HELP simple_probe_agent_online Agent online status (1=online, 0=offline)
# TYPE simple_probe_agent_online gauge
simple_probe_agent_online{id="1",hostname="web-01"} 1
simple_probe_agent_cpu{hostname="web-01"} 45.2
simple_probe_agent_mem{hostname="web-01"} 62.8
```

## 限流

- Agent 上报：每 30 秒 1 次
- 管理接口：每分钟 60 次
- 登录接口：每分钟 5 次，失败后退避 600 秒
