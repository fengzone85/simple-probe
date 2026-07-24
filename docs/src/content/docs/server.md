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

服务端使用 SQLite 单文件数据库，Docker 部署位于命名卷 `server-data` 内（容器内 `/data/monitor.db`），原生部署位于 `$SRC_DIR/server/data/monitor.db`。

### 备份与恢复

通过 `install.sh` 管理命令操作，无需手动定位文件或停服：

```bash
# 热备份（通过 sqlite3 .backup，不中断服务）
sudo bash install.sh --backup

# 从备份恢复（自动先备份当前状态，可回滚）
sudo bash install.sh --restore /var/backups/simple-probe/monitor_20260723.db

# 列出备份
sudo bash install.sh --backup-list

# 查看统计
sudo bash install.sh --db-stats
```

### 数据保留（自动清理）

服务端每小时自动清理过期的指标数据，控制数据库体积。保留天数可配置：

- **后台设置**（推荐）：「设置 → 告警规则 → 指标保留天数」，范围 7-3650 天，保存后 1 小时内自动生效
- **环境变量**：`RETENTION_DAYS`（默认 30 天），后台未设置时生效
- **优先级**：后台设置 > 环境变量 > 默认 30 天

```bash
# docker-compose.yml 环境变量示例（后台未设置时生效）
environment:
  - RETENTION_DAYS=60   # 保留 60 天
```

### 数据迁移

将备份文件复制到新服务器后执行恢复：

```bash
# 新服务器上
sudo bash install.sh --restore /path/to/monitor_backup.db
```

### 定时备份

```bash
# crontab 每天凌晨 3 点自动备份
0 3 * * * root bash /usr/local/bin/simple-probe-install.sh --backup
```

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
