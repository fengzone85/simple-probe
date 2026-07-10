---
title: 环境变量
description: 服务端与受控端环境变量参考
---

# 环境变量

## 服务端

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `SETUP_TOKEN` | 首次 | — | 初始化管理员 Token |
| `DB_PATH` | 否 | `./data/probe.db` | SQLite 数据库路径 |
| `SESSION_SECRET` | 推荐 | 随机 | Session 签名密钥 |
| `ALERT_INTERVAL` | 否 | `300` | 告警检查间隔（秒） |
| `ALERT_OFFLINE_THRESHOLD` | 否 | `90` | 离线告警阈值（秒） |
| `NODE_ENV` | 推荐 | — | 设为 `production` |
| `RATE_LIMIT_WINDOW` | 否 | `60` | 限流窗口（秒） |
| `RATE_LIMIT_MAX` | 否 | `60` | 限流最大请求 |

## 受控端

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `AGENT_TOKEN` | ✅ | — | 节点认证 Token |
| `SERVER_URL` | ✅ | — | 服务端 URL（必须 HTTPS） |

> 填法二选一：**走盾**（Cloudflare 代理域名，隐藏源站 IP）或 **直连**（灰云子域/IP，最稳）。详见 [受控端部署 → 连接地址选型](/agent/)。
| `REPORT_INTERVAL` | 否 | `30` | 上报间隔（秒） |
| `PROBE_TARGETS` | 否 | `1.1.1.1,8.8.8.8` | 网络质量探测目标 |
| `PROBE_METHOD` | 否 | `icmp` | 探测方式（`icmp` / `tcp`） |
| `PROBE_PORT` | 否 | `443` | TCP 探测端口 |

### PROBE_TARGETS 说明

- 多个目标用逗号分隔
- 支持 IP 和域名
- ICMP 优先，失败时自动 TCP 回退
- **本地固定，服务端不可下发** — 这是核心安全设计

### 网络质量探测示例

```bash
# ICMP 优先探测 Cloudflare 和 Google DNS
PROBE_TARGETS=1.1.1.1,8.8.8.8

# 仅 TCP 探测
PROBE_METHOD=tcp
PROBE_TARGETS=1.1.1.1:443,8.8.8.8:443
```

## Docker Compose 完整示例

```yaml
version: '3'
services:
  server:
    image: ghcr.io/fengzone85/simple-probe:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - SETUP_TOKEN=change-me
      - SESSION_SECRET=change-me-too
      - NODE_ENV=production
      - ALERT_INTERVAL=300
    restart: unless-stopped

  agent:
    image: ghcr.io/fengzone85/simple-probe-agent:latest
    environment:
      - AGENT_TOKEN=your-agent-token
      - SERVER_URL=https://monitor.example.com
      - REPORT_INTERVAL=30
      - PROBE_TARGETS=1.1.1.1,8.8.8.8
    volumes:
      - /proc:/host/proc:ro
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges
    restart: unless-stopped
```
