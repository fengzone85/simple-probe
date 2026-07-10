---
title: 服务端部署
description: 服务端配置与管理
---

# 服务端部署

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `PORT` | 否 | 监听端口 | `3000` |
| `SETUP_TOKEN` | 首次 | 初始化管理员 Token | — |
| `DB_PATH` | 否 | SQLite 数据库路径 | `./data/probe.db` |
| `SESSION_SECRET` | 推荐 | Session 签名密钥 | 随机生成 |
| `ALERT_INTERVAL` | 否 | 告警间隔（秒） | `300` |

## Docker Compose 配置

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
      - SETUP_TOKEN=your-setup-token
      - SESSION_SECRET=your-session-secret
    restart: unless-stopped
```

## 数据库

服务端使用 SQLite 单文件数据库，位于 `data/probe.db`。

**备份**：直接复制 `data/` 目录即可。

**迁移**：停止服务端 → 复制 `data/` 到新服务器 → 启动。

## 进程守护

### systemd

```ini
[Unit]
Description=Simple Probe Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/simple-probe/server
ExecStart=/usr/bin/node app.js
Environment=NODE_ENV=production
Restart=always
User=simple-probe

[Install]
WantedBy=multi-user.target
```

## HTTPS 配置

受控端强制 HTTPS（非 localhost 请求 `exit(1)`），服务端需配置有效证书。

推荐使用 Caddy 自动申请 Let's Encrypt 证书：

```
monitor.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## 安全加固清单

- [ ] 修改默认 `SETUP_TOKEN`
- [ ] 启用 TOTP 2FA
- [ ] 配置 HTTPS
- [ ] 设置 CSP 头
- [ ] 限制访问 IP（可选）
- [ ] 定期备份 `data/` 目录
