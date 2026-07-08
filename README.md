# 简单探针 · 自托管 Docker 监控（哪吒替代）

> 项目仓库：https://github.com/fengzone85/simple-probe

被控端以 **Docker 容器** 跑在每台受控 VPS 上，**只对外发起 HTTPS 回传**，不在受控端开放任何入站端口、不提供远程执行功能。数据只进入你自己的**独立专用 VPS**，由服务端提供精美仪表盘，并可向 QQ 邮箱推送离线/超阈值告警。

> 设计目标：从根上规避哪吒类漏洞（受控端暴露公网 + 远程执行 RCE）。本方案受控端零入站、零执行接口、全程鉴权 + TLS。

---

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
  agent/        # 被控端（Docker）
    collector.py   采集 CPU/内存/硬盘/负载/流量（含月度累计）
    agent.py       定时上报 + 失败退避重试
    Dockerfile     python:3.12-slim，纯标准库，非 root 运行
    docker-compose.yml
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

**服务端 `.env`**：`PORT`、`ADMIN_TOKEN`、`OFFLINE_THRESHOLD_SEC`(默认60)、`RETENTION_DAYS`(默认30)、`ALERT_CPU_PCT`/`ALERT_MEM_PCT`(默认90)、`ALERT_COOLDOWN_SEC`、`SMTP_*`(QQ邮箱告警)。

**受控端**：`SERVER_URL`、`AGENT_ID`、`AGENT_TOKEN`、`INTERVAL`(秒，默认15)、`DISK_PATH`(默认`/`)。

## 仪表盘功能

- 概览：总数 / 在线 / 离线 / 平均 CPU·内存。
- 客户端卡片：状态点、商家徽章、CPU/内存/负载/流量迷你 sparkline、硬盘进度条、**到期倒计时**（<7天变黄、已过期变红）、备注。
- 详情页：CPU、内存、负载、网络速率、硬盘、本月流量(vs 配额) 的 ECharts 时序图（1h/6h/24h/7d）。
- 编辑/删除客户端；自动每 10s 刷新。

## 告警

- 离线（超过 `OFFLINE_THRESHOLD_SEC` 未上报）、CPU/内存超阈值，通过 QQ 邮箱（`3986232@qq.com`）推送，带冷却去重。
- **数据清理失败告警**：`prune` 连续 3 次失败（如数据库权限/磁盘问题）会推送邮件告警，避免 metrics 表无限膨胀而长期无感知。
- 需在 `.env` 填入 `SMTP_PASS`（QQ 邮箱「设置→账户→生成授权码」，非登录密码）。
