# 简单探针 · 自托管 Docker 监控（哪吒替代）

> 项目仓库：https://github.com/fengzone85/simple-probe ｜ [English](README_EN.md)

被控端以 **Docker 容器** 跑在每台受控 VPS 上，**只对外发起 HTTPS 回传**，不在受控端开放任何入站端口、不提供远程执行功能。数据只进入你自己的**独立专用 VPS**，由服务端提供精美仪表盘，并可向 QQ 邮箱 / Telegram 推送离线/超阈值告警。

**一键部署（仅服务端，快速测试）**：根目录已提供 `docker-compose.yml`，`cp server/.env.example server/.env` 后 `docker compose up -d` 即可在 `:8080` 启动仪表盘（明文，仅限测试，生产务必加 Nginx + TLS）。

> 设计目标：从根上规避哪吒类漏洞（受控端暴露公网 + 远程执行 RCE）。本方案受控端零入站、零执行接口、全程鉴权 + TLS。

---

## 项目优势

本项目在两次独立安全 / 代码审查中均获 **⭐⭐⭐⭐⭐（5/5）** 评价，审查结论为「可安全用于生产环境」。核心优势如下：

**🔒 安全优先的架构**
- **受控端零入站、零远程执行接口**：从根上规避哪吒类「受控端暴露公网 + 远程执行 → RCE」的暴露面；监控数据只进入你自己的专用 VPS。
- **传输与实现双保险**：HTTPS 强制白名单（仅 `X-Forwarded-Proto: https` 放行，默认拒绝，杜绝伪造协议头绕过）、恒定时间 Token 比较（防时序侧信道）、严格 CSP（无 `unsafe-inline`、无外链脚本）。

**🛡️ 多层身份与访问控制**
- **多因子鉴权**：Agent 双向 Token 上报；服务端管理员 Token + 可选只读 Token（RBAC 最小基础）。
- **凭据不再裸奔**：仪表盘登录改用**签名 `HttpOnly + Secure + SameSite=Strict` Cookie**，前端不再明文存储 Token（消除 XSS 窃取风险）；可启用 **TOTP 两步验证**，所有管理写操作除 Token 外还需动态码，纯静态 Token 单独无法执行危险操作。

**🌐 跨平台、零改动接入**
- **Linux（Docker，纯标准库）+ Windows（psutil 原生）双受控端**，上报字段完全一致，服务端**零改动**即可接收；Windows 受控端可一键注册为「登录即启动、崩溃自启」的开机计划任务。

**📊 可观测性与告警**
- 暴露标准 **Prometheus `/metrics`**（Bearer 鉴权），便于 Grafana 接入；离线 / CPU·内存超阈值告警可推送 **QQ 邮箱与 Telegram**（并行、任一通道失败不影响另一通道），并支持月流量配额与到期倒计时提醒。

**⚡ 轻量、低依赖、易部署**
- TOTP 零依赖实现；ECharts 本地化、无 CDN 外链；Agent 纯标准库、非 root 运行；应用层限流 + Nginx 安全头兜底；弱口令启动拦截、输入校验、构建上下文隔离一应俱全。

## 架构

```
[受控VPS-A] docker agent ──HTTPS+Token──┐
[受控VPS-B] docker agent ──HTTPS+Token──┼──> [专用VPS: server + dashboard]
[受控VPS-N] docker agent ──HTTPS+Token──┘      (Node + SQLite + ECharts / Nginx+TLS 反代)
```

- **Agent 仅出站**：读取 `/proc` 系统指标，POST 到服务端 `/api/report`。受控端防火墙无需放行任何端口，NAT/内网无影响。
- **服务端**：绑定 `localhost:8080`，由专用 VPS 上的 Nginx + TLS 反代，对外仅暴露 443。

## 目录结构

```
监控/
  agent/        # 被控端（Docker，Linux）
    collector.py   采集 CPU/内存/硬盘/负载/流量（含月度累计）
    agent.py       定时上报 + 失败退避重试
    Dockerfile     python:3.12-slim，纯标准库，非 root 运行
    docker-compose.yml
  agent/windows/  # 受控端（Windows 原生，基于 psutil；详见该目录 README）
    win_collector.py  Windows 指标采集（与 Linux 同协议）
    windows_agent.py  定时上报 + 失败退避重试
    install.ps1      安装依赖并注册为计划任务（开机自启）
    run.bat          便捷启动
  server/       # 服务端 + 仪表盘
    server.js / src/{db,auth,api,alerts}.js
    public/     精美仪表盘（ECharts）
    Dockerfile / docker-compose.yml / .env.example
  nginx/monitor.conf.example   # TLS 反代 + 限流示例
```

## 安全设计

1. **受控端零入站** —— 只做出站上报。
2. **无远程执行/Shell** —— Agent 仅读取系统指标，无命令执行接口（哪吒 RCE 主因）。
3. **鉴权** —— 每个 Agent 有 `AGENT_ID` + `AGENT_TOKEN`（服务端生成，DB 内 sha256 存储）；上报需 `X-Agent-ID` + `Bearer`；未知/不匹配拒绝。
4. **传输加密** —— 全程 HTTPS。
5. **输入校验** —— `/api/report` 严格校验数值范围与类型，超限/异常直接 400。
6. **速率限制** —— Nginx 对上报接口限流。
7. **最小暴露面** —— SQLite 本地文件；所有仪表盘/写接口需管理员 Token。
8. **弱口令启动拦截** —— 服务端启动时若 `ADMIN_TOKEN` 为空、等于默认值 `change-me-admin-token` 或长度 < 16，直接拒绝启动（`process.exit(1)`），迫使管理员尽早设置强 Token。
9. **管理接口强制 HTTPS** —— `adminAuth` 校验 `X-Forwarded-Proto`，经反向代理但原始协议非 HTTPS 的请求一律返回 `403`，避免明文传输管理员 Token。注意：仅当 Server 端口不发布到公网、只暴露 Nginx 时才完整生效。
10. **构建上下文隔离** —— `server/.dockerignore` 已排除 `data/`、`.env`、`node_modules` 等，避免 SQLite 数据库与凭据被打进镜像。
11. **Dashboard 两步验证（TOTP）** —— 可在「安全」面板启用。启用后，所有**管理写操作**（建/改/删客户端、重置 Token、测试告警）除静态 Token 外还需动态码，纯静态 Admin Token 单独无法执行写操作；前端登录改由签名 `HttpOnly + Secure + SameSite=Strict` Cookie 维持，**不再在前端明文存储 Token**（消除 XSS 窃取风险）。只读拉取（Grafana、`/metrics`、`READONLY_TOKEN`）保持无感、不强制 2FA。详见下文「两步验证（TOTP）」。

### 两步验证（TOTP）

为进一步提升管理端安全，可在仪表盘「🔒 安全」面板中启用 TOTP 两步验证：

1. 打开「安全」面板，点击**启用两步验证**；系统生成 Base32 密钥（仅显示一次）。
2. 将密钥手动录入 Google Authenticator / 1Password / Authy 等任意 TOTP 应用（本项目不调用任何外部二维码服务，符合 CSP 策略）。
3. 输入应用显示的 6 位动态码，点击**确认启用**。

启用后：

- Dashboard 登录需 **管理员 Token + 动态码**，登录态以签名 Cookie 维持（HttpOnly，不落前端明文）。
- 所有管理写操作（增删改客户端、重置 Token、测试告警）除 Token 外还需动态码；纯静态 Token 单独无法执行写操作。
- 只读监控（Grafana 拉取、`/metrics`、只读 Token）不受影响，保持无感。

**丢失设备恢复**：若丢失 TOTP 设备，可通过 SQLite 清除 2FA 配置后重新绑定：

```bash
sqlite3 data/monitor.db "DELETE FROM admin_config;"
```

（生产环境 `SESSION_SECRET` 应设为固定随机值，否则服务端重启会使所有登录态失效。）

## 安全审查报告落实清单

对仪表盘做了一次安全审查，高中优项已**全部落地**。下表为对应清单（✅ 已落地，⬜ 可选遗留）：

| 优先级 | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| P0 | 关键修复（S1/S2） | ✅ | 早期会话已修复 |
| P1 | 加固项（S5/C5/C4） | ✅ | 早期会话已修复 |
| P2 | 加固项（④⑤⑥⑦） | ✅ | 早期会话已修复 |
| P3 ⑩ | Prometheus `/metrics` | ✅ | `GET /metrics` 暴露 `cpu/mem/disk/net` 等指标，Bearer 或只读 Token 鉴权 |
| P3 ⑪ | 轻量只读账号（RBAC 最小基础） | ✅ | `READONLY_TOKEN`：仅只读 GET，不能增删改 |
| P3 ⑨ | Windows 受控端 | ✅ | `agent/windows/` 基于 psutil，与 Linux Agent **协议完全兼容**，服务端零改动 |
| P3 ⑧ | 管理员两步验证 TOTP | ✅ | 签名 Session Cookie 登录（前端不再明文存 Token）+ 管理写操作强制 TOTP |
| P3 ⑧ | WebAuthn / 硬件密钥 | ⬜ | 可选遗留：TOTP 已消除前端静态 Token 暴露面，WebAuthn 增量价值有限，且需浏览器环境与第三方库实机验证，未做 |

**核心结论**：审查报告关注的「静态 Admin Token 长期驻留前端、可被 XSS 窃取」风险，已由 **HttpOnly 签名 Cookie 登录 + TOTP 第二因素** 彻底解决；跨平台受控端、指标暴露、只读账号等扩展能力均已补齐。

## 第三方依赖与隐私
- **前端零外链**：ECharts 已本地化到 `server/public/vendor/echarts.min.js`，仪表盘不加载任何 CDN 脚本；服务端设置了严格 `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; ...`，**不含 `unsafe-inline`**，前端交互全部用 `addEventListener` 事件委托实现，从根本上阻断 XSS 窃取管理员 Token 的路径。
- **邮件依赖**：告警使用 `nodemailer` v9（QQ 邮箱 SMTP）。升级主版本后已通过 `transporter.verify()` 形态校验；部署时配好真实 `SMTP_PASS` 即可。

## 部署

### 一、服务端（你的独立专用 VPS）

```bash
# 1) 准备环境
apt update && apt install -y docker.io docker-compose nginx certbot python3-certbot-nginx

# 2) 拷贝 server/ 到 VPS，配置环境变量
cd server
cp .env.example .env
# 编辑 .env：设置 ADMIN_TOKEN、SMTP_PASS（QQ邮箱授权码）等
# 注意：ADMIN_TOKEN 不可为空、不可等于示例默认值、长度必须 >= 16，否则服务会拒绝启动。

# 3) 启动
docker compose up -d        # 仅绑定 127.0.0.1:8080（本机回环），数据存于卷 /data；外部无法直接触达

# 4) 申请 TLS 并反代（见 nginx/monitor.conf.example）
#    先把 monitor.conf.example 拷为站点配置（仅 80 端口，nginx -t 必过）：
cp nginx/monitor.conf.example /etc/nginx/conf.d/monitor.conf
nginx -t && systemctl reload nginx
#    再用 certbot 自动补上 443 + 证书（含 /api/report 限流）：
certbot --nginx -d monitor.yourdomain.com
```

> **宝塔面板用户**：不要手写 conf 与宝塔抢配置。请在宝塔「网站 → 新建站点 → 反向代理」把域名指到 `127.0.0.1:8080`，TLS 用宝塔 Let's Encrypt 一键申请；限流 zone（`limit_req_zone`）放到「Nginx 管理 → 配置」（主配置 http 块），站点内只留 `limit_req`。
> 若 Nginx 也是独立 Docker 容器（非宿主机进程），请让 server 与 Nginx 共用一个 Docker 网络、用服务名互访，并删掉 `server/docker-compose.yml` 里的 `127.0.0.1:` 端口映射。

### 隐藏源站 IP（可选，强烈推荐）

即便不上 Cloudflare 的 CDN/WAF（"CF 盾"），上述架构（8080 仅绑回环 + Nginx TLS + 强 token + CSP）已足够安全；但 VPS 公网 IP 仍直接暴露，会被扫描 / 爆破直打 Nginx，也无托管 WAF。

若想**彻底不开放任何入站端口**、让源站 IP 不可见，见 [`TUNNEL-GUIDE.md`](TUNNEL-GUIDE.md)：提供 Cloudflare Tunnel 与 Tailscale 两种方案，附完整命令与证书 / 防火墙注意事项。

### 二、受控端（每台受控 VPS）

1. 打开仪表盘 → 右上角填管理员 Token → 「+ 新建客户端」→ 得到 `AGENT_ID` 和 `AGENT_TOKEN`。
2. 在该 VPS 执行：

```bash
docker run -d --name monitor-agent --restart unless-stopped \
  --network host \
  -e SERVER_URL=https://monitor.yourdomain.com \
  -e AGENT_ID=刚才得到的ID \
  -e AGENT_TOKEN=刚才得到的TOKEN \
  -e INTERVAL=15 \
  -e DISK_PATH=/host \
  -v /:/host:ro \
  -v monitor-agent-data:/data \
  host-monitor-agent:latest
```

> **采集真实宿主机数据的关键参数**：
> - `--network host`：共享宿主机网络命名空间，`/proc/net/dev` 才能反映真实流量（默认 bridge 网络读到的是容器视角）。
> - `-v /:/host:ro` + `-e DISK_PATH=/host`：只读挂载宿主机根目录，使磁盘使用率统计的是 VPS 根盘而非容器 overlay。
> - 若直接在裸机（非 Docker）运行 agent，则 `DISK_PATH` 保持默认 `/` 即可。

> `host-monitor-agent` 镜像需先在受控端构建：进入 `agent/` 目录 `docker build -t host-monitor-agent .`，或推送至私有/公有镜像仓库后 `docker pull`。

3. 仪表盘即出现该客户端卡片，实时刷新 CPU/内存/硬盘/流量/负载，并可编辑**商家、备注、到期时间、月流量配额**。

## 环境变量

**服务端 `.env`**：`PORT`、`ADMIN_TOKEN`、`OFFLINE_THRESHOLD_SEC`(默认60)、`RETENTION_DAYS`(默认30)、`ALERT_CPU_PCT`/`ALERT_MEM_PCT`(默认90)、`ALERT_COOLDOWN_SEC`、`SMTP_*`(QQ邮箱告警)、`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`(可选，Telegram 告警)、`READONLY_TOKEN`(可选，只读账号，见下文)、`SESSION_SECRET`/`SESSION_TTL_MS`(2FA 会话，见「两步验证（TOTP）」)。

**受控端**：`SERVER_URL`、`AGENT_ID`、`AGENT_TOKEN`、`INTERVAL`(秒，默认15)、`DISK_PATH`(默认`/`)。

## 仪表盘功能

- 概览：总数 / 在线 / 离线 / 平均 CPU·内存。
- 客户端卡片：状态点、商家徽章、CPU/内存/负载/流量迷你 sparkline、硬盘进度条、**到期倒计时**（<7天变黄、已过期变红）、备注。
- 详情页：CPU、内存、负载、网络速率、硬盘、本月流量(vs 配额) 的 ECharts 时序图（1h/6h/24h/7d）。
- 编辑/删除客户端；自动每 10s 刷新。

## 告警

- 离线（超过 `OFFLINE_THRESHOLD_SEC` 未上报）、CPU/内存超阈值，通过 QQ 邮箱推送，带冷却去重（收件邮箱在 `.env` 的 `ALERT_TO` 中配置）。
- **数据清理失败告警**：`prune` 连续 3 次失败（如数据库权限/磁盘问题）会推送邮件告警，避免 metrics 表无限膨胀而长期无感知。
- **Telegram 告警（可选）**：在 `.env` 配置 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` 后，以上告警会**同时**推送到 Telegram（与邮件并行，任一通道失败不影响另一通道）。获取方式见 `.env.example` 注释。
- 邮箱需在 `.env` 填入 `SMTP_PASS`（QQ 邮箱「设置→账户→生成授权码」，非登录密码）；Telegram 与邮件可只启用其一。
- **发送测试告警**：配置后可用 `curl -X POST -H 'X-Admin-Token: 你的TOKEN' http://localhost:8080/api/test-alert` 验证（经 Nginx 反代时需带 `-H 'X-Forwarded-Proto: https'`）；或点击仪表盘右上角「📨 测试告警」按钮（需先填写管理员 Token）；也可在 `server/` 目录运行 `node scripts/test-notify.js`。

## 只读账号（READONLY_TOKEN）

为降低「全权限 Admin Token 被到处共享」的风险，可配置一个**仅只读**的账号：

- 在 `.env` 设置可选的 `READONLY_TOKEN`（长度同样建议 ≥ 16）。
- 持有者**仅能调用只读 `GET` 接口**（查看客户端列表、最新指标、sparkline、`/metrics`），所有写操作（`POST /agents`、`PUT/DELETE /agents/:id`、`reset-token`、`/test-alert`）由 `adminOnly` 守卫拦截，返回 `401`。
- 适用于 Grafana / 第三方看板等只读消费场景，无需把 Admin Token 暴露给它们。
- 只读账号**不强制 2FA**（2FA 仅约束 Admin 写操作），保持程序化只读拉取无感。

## Prometheus 指标导出（`/metrics`）

为对接 Prometheus / Grafana 等可观测性栈，服务端暴露标准 exposition 格式指标：

- `GET /metrics` 返回 Prometheus 文本格式，指标名带单位后缀、label 已转义，例如 `probe_cpu_percent{agent="...",host="..."}`、`probe_mem_percent`、`probe_disk_percent`、`probe_net_rx_bytes_per_sec` 等。
- **鉴权**：支持 `Authorization: Bearer <ADMIN_TOKEN | READONLY_TOKEN>`；未带 Token 返回 `401`。
- **设计取舍**：该端点**不强制 HTTPS**，便于内网 Prometheus 直接抓取，靠 Bearer Token 保护；如需公网暴露务必置于 Nginx + TLS 之后。
- 示例：

```bash
curl -H 'Authorization: Bearer <你的READONLY_TOKEN>' http://localhost:8080/metrics
```

## Windows 受控端

除 Linux Docker 受控端外，本项目提供 **Windows 原生受控端**（见 `agent/windows/` 目录），用于监控 Windows 服务器：

- 基于 `psutil`，采集 CPU / 内存 / 磁盘 / 网络速率与月累计 / 开机时长，**上报字段与 Linux Agent 完全一致**，服务端零改动即可接收。
- Windows 无 load average，`load1/load5/load15` 固定占位 `0.0`（仪表盘显示 0，符合预期）。
- 安装：运行 `agent/windows/install.ps1` 自动 `pip install psutil` 并注册「登录即启动、崩溃自动重启」的计划任务（开机自启）；`run.bat` 提供便捷临时启动。详见 `agent/windows/README.md`。
- 安全延续主项目原则：受控端零入站、无远程执行接口、全程 `HTTPS + Token` 鉴权；月流量累计持久化到 `state.json`，重启不丢。
