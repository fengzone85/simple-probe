---
title: 安装指南
description: 各平台安装方式汇总
---

# 安装指南

Simple Probe 支持多种部署方式，按需选择。

## 方式对比

| 方式 | 适用场景 | 资源占用 | 部署时间 |
|---|---|---|---|
| Docker Compose | 有 Docker 环境 | 65-150MB | 5 分钟 |
| 原生 Node + systemd | 无 Docker / 精简 | 30-60MB | 10 分钟 |
| 原生受控端 | 小内存机器 | 12-25MB | 3 分钟 |

## 服务端安装

### Docker 部署

```bash
git clone https://github.com/fengzone85/diting.git
cd simple-probe
cp .env.example .env
# 编辑 .env 设置 SETUP_TOKEN、域名等
docker compose up -d
```

### 原生部署

```bash
git clone https://github.com/fengzone85/diting.git
cd simple-probe/server
npm install --production
cp .env.example .env
# 编辑 .env
npm start
```

建议配合 systemd 或 PM2 做进程守护。

## 受控端安装

详见 [受控端部署](/agent/) 和 [原生 Linux 部署](/native/)。

## 数据库管理

安装脚本集成数据库备份/恢复/统计命令，无需手动定位文件或停服：

```bash
# 备份数据库（默认存到 /var/backups/simple-probe/）
sudo bash install.sh --backup

# 备份到指定路径
sudo bash install.sh --backup /tmp/my-backup.db

# 从备份恢复（恢复前自动备份当前状态，可回滚）
sudo bash install.sh --restore /var/backups/simple-probe/monitor_20260723_141022.db

# 列出已有备份
sudo bash install.sh --backup-list

# 查看数据库统计（大小/记录数/时间范围）
sudo bash install.sh --db-stats
```

**恢复安全机制**：
- 恢复前自动备份当前数据库（`pre_restore_*.db`），误操作可回滚
- 备份文件自动校验 SQLite 完整性（魔数 + `PRAGMA integrity_check`）
- 需输入 `yes` 确认才执行覆盖

**定时备份**（crontab）：

```bash
# 每天凌晨 3 点自动备份
0 3 * * * root bash /usr/local/bin/simple-probe-install.sh --backup
```

## 数据保留与自动清理

服务端每小时自动清理过期的指标数据（`metrics` 表），控制数据库体积。

| 配置方式 | 说明 | 优先级 |
|---|---|---|
| 后台设置（推荐） | 「设置 → 告警规则 → 指标保留天数」，范围 7-3650 天 | 高 |
| 环境变量 | `RETENTION_DAYS`（docker-compose / .env） | 中 |
| 硬编码默认 | 30 天 | 低 |

后台设置保存后 1 小时内自动生效，无需重启服务。

## 反向代理

推荐使用 Nginx 或 Caddy 配置 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name monitor.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
