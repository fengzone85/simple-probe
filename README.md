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
12. **受控端上报通道加固** —— Agent（Linux / Windows）在客户端侧**强制 HTTPS**：`SERVER_URL` 为非 localhost 的 `http://` 直接启动失败，避免 Token 以明文外发（服务端 `X-Forwarded-Proto` 白名单之外的纵深防御）；收到 `401/403` 时进入 **10 分钟长退避且不立即重试**（静态 Token 无法自愈，避免坏 Token 刷日志 / 暴力探测），其余瞬时错误仍走指数退避重试。

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

## 威胁模型：信任边界分析（设计理念）

> 一句话：**信任隔离比功能丰富更重要。** 本项目的安全不是靠叠加防护层实现的，而是靠「不做什么」实现的——不建指令通道、不采主机指纹、不让 Agent 互感知。攻击者无法利用不存在的东西。

### 我们的隐含假设：服务端不可信，Agent 也不可信

很多监控系统的隐含假设是「服务端是可信的」。一旦服务端被攻破，所有 Agent 随之沦陷——因为 Agent 接受服务端指令、执行下发的任务、信任服务端的一切。

本项目的设计假设相反：**服务端可能被攻破，单个 Agent 也可能被攻破，任一方失陷都不能影响另一方。** 下面逐条用代码验证这一假设。

### 三大支柱（均经代码核实）

**① 无指令通道（Agent → Server 单向）**
- Agent 只向 `/api/report` 发送 `POST`；响应体仅用于错误日志（`e.read()`），**从不解析、从不执行**。Agent 不监听任何端口，无 `subprocess`/`Popen`/`eval`/`exec`。
- 服务端唯一面向 Agent 的端点就是 `POST /report`，`agentAuth` 仅做「验令牌 + 存指标」并返回 `{ok:true}`；全工程无 WebSocket / SSE / 任何下行推送，管理端仪表盘靠浏览器侧轮询，与 Agent 无关。
- 这是**刻意不实现**指令通道——不是「还没做」。带双向 WebSocket 通信的监控就是反面：功能更强，但信任边界被打破。

**② Agent 之间零耦合**
- 每个 Agent 只知道自己的 `SERVER_URL` + `Token`，不知道其他 Agent 的存在。
- 指标按 `agent_id` 分表存储；所有跨 Agent 聚合（`getAgents`/`getMetricsAll`）都是管理员只读查询、用于仪表盘，而非下发给某个 Agent。即便服务端被攻破，也没有任何「让 Agent A 联系 Agent B」的机制。

**③ 采集数据不含可利用信息**
- 仅采集 6 类基础状态：在线、负载、CPU、内存、硬盘、流量（含月累计）。
- **不采集**内核版本、`GPU`、公网 IP、连接数。即便服务端被拖库，泄露的只是「某机器某时刻 CPU/内存多少」，攻击者无法据此定向攻击（无内核版本→无 CVE 定向、无公网 IP→无直接目标、无 GPU→无挖矿利用）。

### 三种攻破场景对照

| 场景 | 攻击者能做什么 | 本项目 | 带指令通道 / 指纹采集的监控 |
| --- | --- | --- | --- |
| ① 服务端被攻破 | 读取上报数据 | ✅（仅 6 项状态，无指纹） | ✅（含内核/GPU/公网IP/连接数） |
| | 伪造数据误导 Agent | 无影响（Agent 不接受指令） | 无影响 |
| | 下发恶意指令 / 探测任务 | ❌ 做不到（无指令通道） | ✅ 可下发，Agent 成跳板 |
| | 横向移动到其他 Agent | ❌ 做不到 | ⚠️ 可借探测任务探测其他网络 |
| ② 某 Agent 被攻破 | 读取本机 Token | ✅（docker env 可见） | ✅（ps/cmdline 可见） |
| | 伪造本机数据 | ✅（仅影响该 Agent） | ✅ |
| | 横向移动 / 攻击服务端 | ❌ 做不到（只发 POST，服务端不执行 Agent 指令） | ❌ 做不到 |
| ③ 服务端 + 某 Agent 同时被攻破 | 拿其他 Agent 的 Token | ⚠️ 可（见下方细化） | ⚠️ 可 |
| | 伪造其他 Agent 数据 | ⚠️ 可 | ⚠️ 可 |
| | 在其他 Agent 上执行/下发任务 | ❌ 做不到（无指令通道） | ✅ 可（探测任务，但非 RCE） |

### 场景 ③ 的细化（我们的设计更乐观）

Token 在数据库中以 **SHA-256 哈希**存储（`token_hash`），**不存明文**。鉴权时比较的是 `sha256(提交 token)` 与存储哈希（恒定时间比较）。因此：

- **仅「读到 DB」（如只读拖库、未获写权限）拿不到任何 Agent 的明文 Token**；要伪造其他 Agent 数据，必须暴力破解 24 字节随机 Token（不可行），或直接改写 `token_hash` 为已知值。
- 换言之，「服务端被攻破」若只是只读泄露，**无法立即伪造**；只有拿到 DB **写权限**才行。这是一处对上表 ⚠️ 项的实质加固。

在最坏情况下（服务端 + 一个 Agent 都被攻破），攻击者能做的极限是**伪造其他 Agent 的上报数据**——仪表盘显示假数据，但**没有任何机器被控制**。

### 诚实标注的两个细微点

1. **严格说不止「6 项」**：除基础状态外，`hostname` 与 `os`（发行版名，如 "Ubuntu 22.04"）也会入库。它们属轻量标识，**不是攻击指纹**（无内核版本/CVE 定向、无公网 IP、无 GPU），但上表的「无指纹」应理解为「无可用于定向攻击的指纹」。
2. **Token 哈希将「明文泄露」降级为「需 DB 写权限才能伪造」**，而非完全免疫——这一点在评估场景 ③ 时应明确。

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
