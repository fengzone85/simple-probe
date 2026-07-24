<h1 align="center">
  <img src="server/public/os-debian.svg" width="40" alt="logo">
  <br>谛听轻量探针 · Simple Probe
</h1>

<p align="center">
  <strong>自托管 Docker 监控 · 受控端零入站 · 无指令通道</strong><br>
  <a href="README_EN.md">English</a> · <a href="docs/src/content/docs/install.md">文档</a> · <a href="https://github.com/fengzone85/diting/issues">反馈</a>
</p>

<p align="center">
  <!-- 版本与构建 -->
  <img src="https://img.shields.io/github/v/release/fengzone85/diting?style=flat-square&color=4ea5d9" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/github/actions/workflow/status/fengzone85/diting/test.yml?branch=master&label=tests&style=flat-square" alt="tests">
  <!-- 技术栈 -->
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js" alt="node">
  <img src="https://img.shields.io/badge/SQLite-3-003b57?style=flat-square&logo=sqlite" alt="sqlite">
  <img src="https://img.shields.io/badge/Python-3.8+-3776AB?style=flat-square&logo=python" alt="python">
  <!-- 平台 -->
  <img src="https://img.shields.io/badge/Linux-Docker-2496ED?style=flat-square&logo=docker" alt="linux">
  <img src="https://img.shields.io/badge/Windows-原生-0078D4?style=flat-square&logo=windows" alt="windows">
</p>

---

## ✨ 核心特性

<table>
<tr>
<td width="50%">

### 🔒 安全优先
- **受控端零入站** — 不监听任何端口，NAT/内网无影响
- **无指令通道** — Agent → Server 单向数据流，服务端无法控制 Agent
- **恒定时间 Token 比较** — 防时序侧信道
- **严格 CSP** — 无 `unsafe-inline`、无外链脚本
- **TOTP 两步验证** — 危险操作需动态码</td>

<td width="50%">

### 📊 监控与告警
- **实时指标** — CPU/内存/硬盘/负载/流量/温度/Swap
- **月流量累计** — 持久化，重启不丢
- **网络质量探测** — 到固定公共 DNS 的延迟
- **告警通知** — QQ 邮箱 + Telegram 并行
- **Prometheus `/metrics`** — Grafana 友好</td>
</tr>
<tr>
<td width="50%">

### 🌐 轻量跨平台
- **Linux（Docker）** — 纯 Python 标准库，65-150MB
- **Windows（原生）** — psutil，登录自启
- **Agent 零耦合** — 彼此不知互存在
- **数据最小化** — 不采内核/GPU/公网IP</td>

<td width="50%">

### ⚡ 一键部署
- **统一 install.sh** — 服务端 + 受控端 + 更新 + 卸载
- **自动依赖安装** — Docker / git / curl 自动补齐
- **交互式菜单** — 引导式配置
- **自助注册** — SETUP_TOKEN 一键建客户端</td>
</tr>
</table>

---

## 🚀 快速开始

```bash
# 一条命令完成部署
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh
```

> 脚本会自动安装 Docker、git 等依赖，引导你完成服务端和受控端的配置。

---

## 🏗️ 架构

```
[受控VPS-A] docker agent ──HTTPS+Token──┐
[受控VPS-B] docker agent ──HTTPS+Token──┼──> [专用VPS: server + dashboard]
[受控VPS-N] docker agent ──HTTPS+Token──┘      (Node + SQLite + ECharts / Nginx+TLS)
```

**关键设计：**
- Agent 仅出站 POST 到 `/api/report`，响应仅用于错误日志，**从不执行**
- 服务端绑定 `localhost:8080`，由 Nginx + TLS 反代对外暴露 443
- 数据库存储 Token 哈希（SHA-256），非明文

---

## 📁 项目结构

```
diting/
├── install.sh              # 一键部署/更新/卸载
├── docker-compose.yml      # 快速启动（测试用）
├── server/                 # 服务端（Node.js + Express + SQLite）
│   ├── public/             # 前端仪表盘 + 公开状态页
│   ├── src/{api,auth,db,alerts,totp,validate}.js
│   └── test/security.test.js
├── agent/                  # 受控端
│   ├── agent.py / collector.py  # Linux（Docker）
│   └── windows/            # Windows 原生
├── docs/                   # 用户技术文档
└── nginx/                  # 反代配置示例
```

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| [安装指南](docs/src/content/docs/install.md) | 各平台安装方式 |
| [快速开始](docs/src/content/docs/quick-start.md) | 5 分钟部署 |
| [服务端配置](docs/src/content/docs/server.md) | 环境变量与部署 |
| [受控端部署](docs/src/content/docs/agent.md) | Linux / Windows |
| [API 参考](docs/src/content/docs/api.md) | REST API 端点 |
| [安全设计](docs/src/content/docs/security.md) | 威胁模型与加固 |
| [常见问题](docs/src/content/docs/faq.md) | FAQ |

---

## 🛡️ 安全设计原则

> **信任隔离比功能丰富更重要。** 安全不是靠叠加防护层，而是靠「不做什么」。

1. **无指令通道** — Agent 不接受任何服务端指令
2. **Agent 零耦合** — 一个 Agent 被攻破不影响其他
3. **数据最小化** — 只采基础状态，不采指纹信息
4. **纵深防御** — HTTPS + Token 哈希 + 签名 Cookie + TOTP
5. **服务端不可信** — 任一方失陷不波及另一方

---

## 📄 许可证

[MIT](LICENSE)
