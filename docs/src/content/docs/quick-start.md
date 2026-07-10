---
title: 快速开始
description: 5 分钟部署 Simple Probe
---

# 快速开始

## 前置条件

- 一台 VPS（推荐 1C1G，最低 512MB）
- Docker + Docker Compose **或** Node.js 22+
- 一个域名（可选，用于 HTTPS）

## 方式 1：Docker 部署（推荐）

```bash
git clone https://github.com/fengzone85/simple-probe.git
cd simple-probe
docker compose up -d
```

访问 `http://<你的IP>:3000` 即可看到仪表盘。

首次访问时使用 `SETUP_TOKEN` 环境变量完成初始化。

## 方式 2：原生 Node 部署

```bash
git clone https://github.com/fengzone85/simple-probe.git
cd simple-probe/server
npm install
npm start
```

## 添加受控端

### Linux（Docker）

```bash
docker run -d \
  --name simple-probe-agent \
  --restart unless-stopped \
  -e AGENT_TOKEN="<你的Token>" \
  -e SERVER_URL="https://<你的域名>" \
  -v /proc:/host/proc:ro \
  --read-only \
  ghcr.io/fengzone85/simple-probe-agent:latest
```

### Linux（原生 systemd）

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/simple-probe/main/agent/install.sh | bash
```

按提示输入 Server URL 和 Token 即可。

### Windows

下载 `agent/windows/` 下的脚本，以管理员身份运行 `install.ps1`。

## 下一步

- [服务端详细配置](/server/)
- [受控端部署指南](/agent/)
- [安全加固](/security/)
