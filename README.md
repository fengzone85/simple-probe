<h1 align="center">
  <img src="server/public/os-debian.svg" width="40" alt="logo">
  <br>谛听轻量探针 · DiTing Lite
</h1>

<p align="center">
  <strong>自托管 Docker 监控 · 受控端零入站 · 无指令通道</strong><br>
  <a href="README_EN.md">English</a> · <a href="docs/src/content/docs/install.md">文档</a> · <a href="https://github.com/fengzone85/diting/issues">反馈</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/fengzone85/diting?style=flat-square&color=4ea5d9" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/github/actions/workflow/status/fengzone85/diting/test.yml?branch=master&label=tests&style=flat-square" alt="tests">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js" alt="node">
  <img src="https://img.shields.io/badge/SQLite-3-003b57?style=flat-square&logo=sqlite" alt="sqlite">
  <img src="https://img.shields.io/badge/Python-3.8+-3776AB?style=flat-square&logo=python" alt="python">
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
- **TOTP 两步验证** — 危险操作需动态码
- **IP 白名单** — 支持 IPv4/IPv6/CIDR</td>

<td width="50%">

### 📊 监控与告警
- **实时指标** — CPU/内存/硬盘/负载/流量/温度/Swap
- **月流量累计** — 持久化，重启不丢
- **网络质量探测** — 到固定公共 DNS 的延迟（着色：绿/黄/红）
- **告警通知** — QQ 邮箱 + Telegram 并行，带冷却去重
- **Prometheus `/metrics`** — Grafana 友好
- **到期倒计时** — <7天变黄、已过期变红</td>
</tr>
<tr>
<td width="50%">

### 🌐 轻量跨平台
- **Linux（Docker）** — 纯 Python 标准库，65-150MB
- **Windows（原生）** — psutil，登录自启计划任务
- **Agent 零耦合** — 彼此不知互存在
- **数据最小化** — 不采内核/GPU/公网IP/连接数
- **多盘支持** — 自动识别物理磁盘（过滤 tmpfs/proc）</td>

<td width="50%">

### ⚡ 一键部署
- **统一 install.sh** — 服务端 + 受控端 + 更新 + 卸载 + 数据库管理
- **自动依赖安装** — Docker / git / curl 自动补齐
- **交互式菜单** — 引导式配置，中英文双语
- **自助注册** — SETUP_TOKEN 一键建客户端
- **数据库管理** — 备份/恢复/统计（`--backup` / `--restore` / `--db-stats`）</td>
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

**非交互模式（CI / 批量）：**
```bash
# 安装服务端
sudo bash install.sh --install-server

# 安装受控端（手动模式）
sudo bash install.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

# 安装受控端（自助注册）
sudo bash install.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>
```

---

## 🏗️ 架构

```
[受控VPS-A] docker agent ──HTTPS+Token──┐
[受控VPS-B] docker agent ──HTTPS+Token──┼──> [专用VPS: server + dashboard]
[受控VPS-N] docker agent ──HTTPS+Token──┘      (Node + SQLite + ECharts / Nginx+TLS)
```

**关键设计：**
- Agent 仅出站 POST 到 `/api/report`，响应仅用于错误日志，**从不执行**
- 服务端绑定 `localhost:8081`，由 Nginx + TLS 反代对外暴露 443
- 数据库存储 Token 哈希（SHA-256），非明文
- 登录态用签名 `HttpOnly + Secure + SameSite=Strict` Cookie

---

## 📁 项目结构

```
diting/
├── install.sh              # 一键部署/更新/卸载/数据库管理
├── docker-compose.yml      # 快速启动（测试用）
├── server/                 # 服务端（Node.js + Express + SQLite）
│   ├── server.js           # 入口 + 路由 + WebSocket
│   ├── src/
│   │   ├── api.js          # REST API（客户端/设置/告警）
│   │   ├── auth.js         # 鉴权 + Session + IP 白名单
│   │   ├── db.js           # SQLite + 迁移 + 配置
│   │   ├── alerts.js       # 阈值检查 + 邮件/Telegram 通知
│   │   ├── totp.js         # RFC 6238 TOTP（零依赖）
│   │   ├── validate.js     # 输入校验 + CSS 清洗
│   │   └── komari.js       # Komari 兼容 API 层
│   ├── public/             # 前端（仪表盘 + 公开页 + i18n）
│   └── test/security.test.js  # 安全单元测试
├── agent/                  # 受控端
│   ├── agent.py / collector.py  # Linux（Docker，纯标准库）
│   ├── windows/            # Windows 原生（psutil）
│   └── install.sh          # 受控端独立安装脚本
├── docs/                   # 用户技术文档（14 篇）
└── nginx/monitor.conf.example  # TLS 反代 + 限流示例
```

---

## ⚙️ 环境变量

### 服务端（`.env`）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8081` | HTTP 监听端口 |
| `ADMIN_TOKEN` | 首次 | — | 管理员 Token（≥16 位） |
| `SETUP_TOKEN` | 否 | — | 受控端自助注册令牌 |
| `SESSION_SECRET` | 推荐 | 随机 | Session 签名密钥（固定则重启不失效） |
| `DB_PATH` | 否 | `/data/monitor.db` | SQLite 路径 |
| `RETENTION_DAYS` | 否 | `30` | 指标保留天数（7-3650） |
| `OFFLINE_THRESHOLD_SEC` | 否 | `60` | 离线判定阈值（秒） |
| `ALERT_CPU_PCT` | 否 | `90` | CPU 告警阈值（%） |
| `ALERT_MEM_PCT` | 否 | `90` | 内存告警阈值（%） |
| `ALERT_COOLDOWN_SEC` | 否 | `1800` | 告警冷却时间（秒） |
| `SMTP_HOST` | 否 | `smtp.qq.com` | SMTP 服务器 |
| `SMTP_PORT` | 否 | `465` | SMTP 端口 |
| `SMTP_USER` | 否 | — | SMTP 用户名 |
| `SMTP_PASS` | 否 | — | SMTP 密码（QQ 邮箱用授权码） |
| `ALERT_TO` | 否 | — | 告警收件人 |
| `TELEGRAM_BOT_TOKEN` | 否 | — | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 否 | — | Telegram Chat ID |
| `READONLY_TOKEN` | 否 | — | 只读 Token（仅查看，不可写） |
| `ADMIN_ALLOW_HTTP` | 否 | — | 设为 `1` 允许 HTTP（仅内网测试） |

### 受控端

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | 服务端 URL（必须 HTTPS） |
| `AGENT_ID` | ✅ | — | 节点标识 |
| `AGENT_TOKEN` | ✅ | — | 认证令牌 |
| `INTERVAL` | 否 | `15` | 上报间隔（秒） |
| `DISK_PATH` | 否 | `/` | 磁盘统计路径 |
| `PROBE_TARGETS` | 否 | 移动/电信/联通 DNS + 8.8.8.8 | 网络质量探测目标（`label:host[:port]`，逗号分隔） |

---

## 📊 仪表盘功能

- **概览**：总数 / 在线 / 离线 / 平均 CPU·内存 / 流量概览 / 分组概览
- **客户端卡片**：状态点 / 国旗 / 商家徽章 / CPU/内存/负载/温度/Swap 迷你 sparkline / 硬盘进度条 / 到期倒计时 / 网络质量探测
- **详情页**：CPU/内存/负载/网络速率/硬盘/温度/Swap/网络质量/本月流量 ECharts 时序图（1h/6h/24h/7d）
- **客户端列表**：表格视图，点击行展开详情
- **拖拽排序**：管理员可自定义卡片顺序
- **分组显示**：按分组归类，顺序可配置

---

## 🔔 告警

- **离线告警**：超过 `OFFLINE_THRESHOLD_SEC` 未上报
- **阈值告警**：CPU/内存超过设定值
- **通知通道**：QQ 邮箱（SMTP）+ Telegram Bot（并行，任一失败不影响另一通道）
- **冷却去重**：默认 30 分钟内不重复发送同类告警
- **数据清理告警**：`prune` 连续 3 次失败时发送邮件
- **测试按钮**：后台「📨 测试告警」或 API `POST /api/test-alert`

---

## 🔑 只读账号（READONLY_TOKEN）

为降低「全权限 Admin Token 被到处共享」的风险，可配置一个**仅只读**的账号：

- 在 `.env` 设置可选的 `READONLY_TOKEN`（长度建议 ≥ 16）
- 持有者**仅能调用只读 GET 接口**（查看客户端列表、最新指标、sparkline、`/metrics`）
- 所有写操作（增删改客户端、重置 Token、测试告警）被 `adminOnly` 守卫拦截，返回 401
- 适用于 Grafana / 第三方看板等只读消费场景

---

## 📈 Prometheus 指标导出（`/metrics`）

- `GET /metrics` 返回 Prometheus 文本格式
- 鉴权：`Authorization: Bearer <ADMIN_TOKEN | READONLY_TOKEN>`
- 指标：`monitor_agent_cpu_percent`、`monitor_agent_mem_percent`、`monitor_agent_disk_percent`、`monitor_agent_net_rx_rate_bytes` 等
- 示例：`curl -H 'Authorization: Bearer TOKEN' http://localhost:8081/metrics`

---

## 🖥️ Windows 受控端

- 基于 `psutil`，采集 CPU/内存/磁盘/网络/开机时长
- 上报字段与 Linux Agent 完全一致，服务端零改动
- 安装：运行 `agent/windows/install.ps1` 自动安装依赖并注册计划任务
- Windows 无 load average，`load1/load5/load15` 固定占位 `0.0`

---

## 🛡️ 安全加固清单

- [ ] 通过 Nginx + TLS 反代，源站 8081 仅绑 `127.0.0.1`
- [ ] 设置强随机 `ADMIN_TOKEN`（≥16 位）
- [ ] 设置 `SESSION_SECRET`（固定随机值，防重启失效）
- [ ] 启用 TOTP 两步验证（设置 → 账户安全）
- [ ] 配置 IP 白名单（支持 IPv4/IPv6/CIDR）
- [ ] 定期备份数据库（`sudo bash install.sh --backup`）
- [ ] 配置告警通知（邮件 / Telegram）
- [ ] 使用 Cloudflare Tunnel 或 Tailscale 隐藏源站 IP（可选）

---

## 🔄 更新

```bash
# 更新安装脚本自身
sudo bash install.sh --update-script

# 更新服务端（git pull + 重建容器）
sudo bash install.sh --update-server

# 更新受控端（保留已注册身份）
sudo bash install.sh --update-agent
```

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| [安装指南](docs/src/content/docs/install.md) | 各平台安装方式 |
| [快速开始](docs/src/content/docs/quick-start.md) | 5 分钟部署 |
| [服务端配置](docs/src/content/docs/server.md) | 环境变量与部署 |
| [受控端部署](docs/src/content/docs/agent.md) | Linux / Windows |
| [原生 Linux 部署](docs/src/content/docs/native.md) | systemd 方式 |
| [Windows 代理](docs/src/content/docs/windows.md) | Windows 原生 |
| [API 参考](docs/src/content/docs/api.md) | REST API 端点 |
| [环境变量](docs/src/content/docs/env.md) | 完整变量参考 |
| [安全设计](docs/src/content/docs/security.md) | 安全特性与加固 |
| [隧道指南](docs/src/content/docs/tunnel-guide.md) | Cloudflare Tunnel / Tailscale |
| [常见问题](docs/src/content/docs/faq.md) | FAQ |

---

## 🛡️ 安全设计原则

> **信任隔离比功能丰富更重要。** 安全不是靠叠加防护层，而是靠「不做什么」。

1. **无指令通道** — Agent 不接受任何服务端指令，只上报
2. **Agent 零耦合** — 一个 Agent 被攻破不影响其他
3. **数据最小化** — 只采基础状态，不采指纹信息（内核/GPU/公网IP）
4. **纵深防御** — HTTPS + Token 哈希 + 签名 Cookie + TOTP + IP 白名单
5. **服务端不可信** — 任一方失陷不波及另一方

---

## 📄 许可证

[MIT](LICENSE)
