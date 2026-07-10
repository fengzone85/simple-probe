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
git clone https://github.com/fengzone85/simple-probe.git
cd simple-probe
cp .env.example .env
# 编辑 .env 设置 SETUP_TOKEN、域名等
docker compose up -d
```

### 原生部署

```bash
git clone https://github.com/fengzone85/simple-probe.git
cd simple-probe/server
npm install --production
cp .env.example .env
# 编辑 .env
npm start
```

建议配合 systemd 或 PM2 做进程守护。

## 受控端安装

详见 [受控端部署](/agent/) 和 [原生 Linux 部署](/native/)。

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
