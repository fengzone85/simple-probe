# Changelog

## 单元测试：核心安全函数覆盖（2026-07-09）
- 落实安全审查 v3.1「推荐后续关注 #2：为核心安全函数增加单元测试」。
- 新增 `server/test/security.test.js`（Node 内置 `node:test`，零第三方依赖），覆盖：
  - `totp.js`：RFC 6238 标准向量（8 位 SHA1，t=59/1111111109/…/20000000000）逐条比对；`verifyTOTP` 接受当前码与 ±1 窗口、拒绝越界/非数字、去除空格；`generateSecret` 输出合法 base32。
  - `auth.js`：`safeEqual` 先哈希再比较、不同长度正确判否（验证长度侧信道已消除）；`signSession/verifySession` 往返一致、篡改签名与过期均拒绝。
  - `validate.js`：正常负载、缺失核心字段返回字段为 `null`（拒绝逻辑在 `/report` 路由）、越界/非有限数归 `null`、字符串数字强制、probes 约束（≤8 键 / label≤24 / ms 范围 / ok 强制布尔 / 非对象与数组退回 `{}`）、`os`/`hostname` 超长归空串；`num`/`str` 边界。
- 重构：`api.js` 中内联的 `num`/`str`/`validateReport` 抽离到独立 `server/src/validate.js`（纯函数、无 I/O/DB 依赖），`api.js` 改为引用，便于独立审计与测试；`package.json` 增加 `"test": "node --test test/security.test.js"`。

## 安全加固：Token 比较消除长度侧信道（2026-07-09）
- 落实安全审查 v3.1 的 8.2#4（可选低危）：`auth.js` 的 `safeEqual()` 原实现在两端长度不等时提前 `return false`，会泄露 Token 长度（长度侧信道）。改为先对两端统一做 SHA-256 哈希，再对固定长度摘要做 `timingSafeEqual`，彻底消除长度差异带来的时序泄漏。哈希确定且等长，`timingSafeEqual` 不再可能因长度不同而抛错。

## 遗留项修复：ECharts 实例释放 + SQLite 文件权限收敛（2026-07-09）
- ECharts 实例未释放（审查观察项）：重写 `ensureChart()`，在每次取用时检测缓存实例是否已脱离文档（详情页 DOM 重写 / 切换 agent 场景），脱离则 `dispose()` 旧实例并在当前 DOM 上重建，修复「图表空白 + 实例泄漏」；`drawLine()` 增加 `ensureChart` 返回 `null` 的保护。
- SQLite 明文（审查观察项）：`db.js` 打开数据库后将文件权限 `chmod 0o600`（仅属主可读写），按最小权限原则收敛监控数据的暴露面；挂载文件系统不支持 chmod 时静默忽略。

## 受控端网络质量自测加固：探测目标格式校验（2026-07-09）
- 落实安全审查 v3 的 4.1 建议：在 `parse_probe_targets()`（Linux `collector.py` / Windows `win_collector.py`）增加基础格式校验——`host` 非空且长度 ≤ 253（域名上限）、`port` 落在 [1,65535]、`label` 超限截断到 24（与服务端 `api.js` 校验一致）。防御 operator 误配（空 host / 超长字符串导致 ping 异常）；因 host 来自本地 `PROBE_TARGETS` 配置、非服务端下发，无注入面。其余审查发现（4.2 线程阻塞、4.3 psutil 依赖、4.4 iputils-ping）均判定为信息级/可接受，未改动。

## 受控端网络质量自测（固定公共目标，本地配置，无指令通道）（2026-07-09）
- 受控端（Linux `collector.py` / Windows `win_collector.py`）新增本地网络质量自测：从本机 ping / TCP 探测**写死在本地配置**的固定公共基础设施（默认联通/电信/移动 DNS + 8.8.8.8）。目标是"集中式主动探测"越界功能的安全等价物——探测目标来自 Agent 本地 `PROBE_TARGETS` 环境变量、服务端永不可下发，故**指令通道不复存在**，三大安全支柱（无指令通道 / Agent 零耦合 / 数据最小化）完全不受影响。
- 采集逻辑：`probe_one()` 优先 ICMP（系统 `ping -c 1` / Windows `ping -n 1`），解析 RTT（Linux 取 avg、Windows 取平均）；若 `ping` 不可用或被禁，自动回退到目标端口（默认 53）的 TCP 握手测延迟。各目标用 `ThreadPoolExecutor` 并行探测，单次采集额外耗时约 1–2 秒；`parse_probe_targets()` 解析 `label:host[:port]` 格式。
- 服务端：`metrics` 表启动时自动迁移新增 `probes TEXT` 列（存 JSON，列名/类型硬编码，无注入风险）；`/api/report` 对 `probes` 做受控校验（对象、键≤8、label≤24 字符、ms∈[0,100000] 或 null、ok 布尔）。
- 前端：客户端卡片新增「网络」一行（如 `移动 18ms · 电信 23ms · 联通 ✕`）；详情页新增「网络质量（到探测点延迟 ms）」多系列 ECharts 折线图（动态解析每行的 `probes` 按 label 聚合）；`drawLine` 调色板扩展到 8 色。
- 部署：Linux Agent `Dockerfile` 增加 `iputils-ping` 安装（其 `/bin/ping` 自带 `cap_net_raw`，monitor 非 root 用户亦可执行 ICMP；无 ping 时自动回退 TCP）。
- 文档同步：中英文 README 在「环境变量 / 仪表盘功能 / 主动探测小节 / 网络质量自测专节 / 威胁模型表 / 对比表」处新增并统一表述；原"刻意不实现集中式主动探测"小节补充"本地固定目标自测"这一安全等价物的说明。
- Agent 自述与启动脚本补强：在 `agent/docker-compose.yml`（注释示例）、`agent/windows/run.bat`（默认开启三家 DNS）、`agent/windows/install.ps1`（新增 `-ProbeTargets` 参数并透传进计划任务脚本）与 `agent/windows/README.md`（环境变量表 + 安装示例）补齐 `PROBE_TARGETS` 说明。此前 Windows 启动/计划任务脚本未透传该变量，会导致其在计划任务场景下不生效——本次一并修复。

## 受控端新增温度 / Swap / 开机时长非指纹指标（2026-07-09）
- 受控端（Linux `collector.py` / Windows `win_collector.py`）新增本地采集：温度（Linux 读 `/sys/class/thermal/thermal_zone*/temp` 毫摄氏度转 °C 取最高值；Windows 用 `psutil.sensors_temperatures()`）、Swap 使用量/总量/百分比、开机时长（`uptime` 已含）。三者均为**非指纹**指标（无内核版本/CVE 定向、无公网 IP、无 GPU），不触碰任何安全支柱（无指令通道、Agent 零耦合、数据最小化）。
- 服务端：`metrics` 表在启动时自动迁移新增 `temp` / `swap_used` / `swap_total` / `swap_pct` 四列（兼容已有数据库；列名与类型为硬编码常量，无注入风险）；`/api/report` 校验新增字段，其中 `temp` 允许 `null`（无传感器时）。
- 前端：详情页新增「温度」「Swap 使用率」两张 ECharts 折线图；客户端卡片新增温度与 Swap 读数（含 sparkline，无传感器时温度显示「—」）；`sparkline` 增加非有限值过滤以容错。
- 文档同步：中英文 README 将「数据最小化 / 支柱③ / 诚实标注 / 指纹小节 / 仪表盘功能」处的「6 类/6 项」表述更新为「基础状态（含温度/Swap/开机时长等非指纹指标）」，并明确坚决反对的仍是内核/GPU/公网IP/连接数/进程数等指纹。

## 前端新增「即时流量」实时速率读数（2026-07-09）
- 详情页新增实时上下行速率读数（每 3 秒用轻量 `/api/agents/:id` 轮询刷新，展示于既有「网络速率」折线图上方）。
- 速率数据由受控端在本地基于自身两次采样计算（`collector.py` 的 `net_rx_rate`/`net_tx_rate`），经既有 `/api/report` 上报通道入库，前端仅做轮询展示——不新增指令通道、不采集指纹、不改动 Agent，完全落在已有安全边界内。
- 该增强作为「可安全实现的功能」范例，同步写入两份 README「为什么我们刻意不实现这些功能」收尾说明。

## README 新增「为什么我们刻意不实现这些功能」（2026-07-09）
- 两份 README 在「关于其它 agent 类探针的澄清」之后新增「为什么我们刻意不实现这些功能」小节，以「不做的原因」而非「可复制性」视角，逐条说明四类刻意不实现的功能及其安全理由：① 集中式主动探测（需指令通道 → 破坏无指令通道保障，服务端沦陷则成探测跳板）；② 主机指纹采集（内核/GPU/公网IP/连接数 → 拖库即暴露攻击面）；③ 服务端实时下发采样/策略（指令通道变体）；④ 把 Agent 当跳板探测第三方（前三项推论）。并说明仪表盘/历史图表/分组/告警/多用户+TOTP 等纯服务端能力完整提供，因其只读取已上报的 6 项数据、不依赖下行指令。

## README 新增「关于其它 agent 类探针的澄清」（源码级证据）（2026-07-09）
- 两份 README 在「与 Nezha 信任边界对照」之后新增「关于其它 agent 类探针的澄清（源码级证据）」小节，基于某开源 agent 类探针项目的 `agent/main.go` 真实源码逐条反驳两种常见误判：
  - 误判一「Agent 会被 RCE」：ICMP 路径为 `executeICMPPing` → `resolvePublicIPs`（DNS+黑名单）→ `ips[0].String()` → `exec.Command("ping",...)`，参数恒为 `net.IP.String()` 输出、且 `exec.Command` 走 `execve` 不过 shell，故非 RCE，仅为参数类型受限的命令调用；TCP/HTTP 路径用已校验 `net.IP` 直连 `dialResolvedTCP`，无 DNS rebinding/TOCTOU。
  - 误判二「加任务签名即可修复服务端沦陷」：在「服务端不可信」威胁模型下，服务端即签名私钥持有者，签名只能防传输途中篡改、防不了服务端自身为攻击者；唯一根治是移除指令通道（即本项目做法）。
- 明确界定：这类 agent 类探针在服务端沦陷后是「分布式探测跳板 / 受限受控探测代理」，非 RCE 肉鸡；其探测能力是核心功能、架构内无法消除，只有无指令通道才彻底。

## README 设计理念文档化增强（2026-07-09）
- 两份 README 顶部新增「设计原则（5 条）」短清单（信任隔离优先 / 无指令通道 / Agent 零耦合 / 数据最小化 / 服务端不可信+凭据不裸奔），便于快速阅读。
- 两份 README 威胁模型章节之后新增「与主流监控的信任边界对照（以 Nezha 为例）」表，从受控端入站、通信方向、远程执行、Agent 耦合、采集内容、最坏情况、信任模型 7 个维度横向对比指令通道型监控，说明本项目以「功能减法」换取「安全加法」。

## 威胁模型：信任边界分析（设计理念）文档化（2026-07-09）
- 在 `README.md` 与 `README_EN.md` 新增「威胁模型：信任边界分析（设计理念）」章节，向公众说明项目核心设计原则：**信任隔离比功能丰富更重要**，安全靠「不做什么」实现。
- 三大支柱（均经代码核实）：① 无指令通道（Agent→Server 单向，`/api/report` 仅 POST，响应体只用于日志、无 WebSocket/SSE 下行）；② Agent 之间零耦合（每 Agent 仅知自身 URL+Token，指标按 `agent_id` 分表，无跨 Agent 通信机制）；③ 采集数据不含可利用信息（仅 6 类基础状态，不采内核版本/GPU/公网IP/连接数）。
- 三种攻破场景对照表（服务端被攻破 / 某 Agent 被攻破 / 服务端+某 Agent 同时被攻破），并细化场景 ③：Token 以 SHA-256 哈希存储（非明文），只读拖库拿不到明文 Token，伪造需 DB 写权限。
- 诚实标注两个细微点：`hostname`/`os` 仍入库（轻量标识，非攻击指纹）；Token 哈希将「明文泄露」降级为「需 DB 写权限才能伪造」，非完全免疫。

## Agent 上报通道加固（2026-07-09）
- **受控端客户端强制 HTTPS**：`agent/agent.py` 与 `agent/windows/windows_agent.py` 启动时对 `SERVER_URL` 校验——非 `localhost` 的 `http://` 直接 `exit(1)` 拒绝，避免 Token 明文外发（服务端 `X-Forwarded-Proto` 白名单之外的纵深防御）；`localhost` 的 `http` 仅用于本地测试。
- **401/403 长退避**：上报收到 `401/403` 时不再立即重试（静态 Agent Token 无法自愈），进入 `AUTH_BACKOFF=600s` 长退避后返回，避免坏 Token 刷日志与对服务端暴力探测；其余瞬时错误（5xx、网络抖动）仍走原有指数退避重试（上限 3 次）。
- 验证：stub 平台采集模块后实跑，Linux / Windows 两端均通过「拒绝非 localhost http / 放行 https / 放行 localhost http / 401→False / 403→False / 500→重试后 False」共 12 项。

## P3：管理员两步验证 TOTP（⑧）（2026-07-09）

- **TOTP 第二因素（RFC 6238，零依赖）**（`server/src/totp.js`）：新增 `/api/admin/2fa/{status,setup,enable,disable}`。启用后，所有管理**写操作**（`POST /agents`、`PUT/DELETE /agents/:id`、`reset-token`、`/test-alert`）除静态 Token 外还需动态码——`adminOnly` 守卫在 `is2FAEnabled()` 时要求 `cookie.totp` 或 `X-TOTP` 头，纯静态 Admin Token 单独调用写接口将返回 `401 {need_totp:true}`。
- **登录态改为签名 Session Cookie**（`server/src/auth.js`）：Dashboard 登录 `POST /api/login` 校验 Token（+TOTP）后签发 `HttpOnly; Secure; SameSite=Strict` 签名 Cookie，前端**不再明文存储 Admin Token**（`localStorage` 方案改为 Cookie），从根本上消除前端 XSS 窃取 Token 的风险；`/api/logout` 清除会话。
- **兼容性**：只读拉取（Grafana、`/metrics` Bearer、`READONLY_TOKEN`）不强制 2FA，保持无感；旧式 `X-Admin-Token` 头仍被接受（用于程序化访问，但不满足 2FA 时写操作仍被拒）。
- **前端**（`public/index.html`、`public/app.js`）：登录/退出按钮 + 动态码输入；「安全」面板内新增 2FA 启用/禁用流程（密钥手动录入，不依赖外部二维码服务，符合 CSP）。
- **配置**（`server/.env.example`）：新增 `SESSION_SECRET`（Cookie 签名密钥，建议固定随机值）、`SESSION_TTL_MS`（默认 12h）。
- 单测：TOTP 算法通过 RFC 6238 标准测试向量校验。

## P3：Windows 受控端（⑨）（2026-07-09）

- **新增 `agent/windows/`**：与 Linux Docker Agent **协议完全兼容**的 Windows 原生受控端（基于 `psutil`），上报相同字段结构，服务端无需任何改动即可接收。
- `win_collector.py`：采集 CPU / 内存 / 磁盘 / 网络速率与月累计 / 开机时长；Windows 无 load average，`load1`/`load5`/`load15` 固定占位 `0.0`（仪表盘显示 0，已在文档说明）。
- `windows_agent.py`：HTTP `Bearer` 上报 + 指数退避重试（逻辑与 Linux `agent.py` 一致）。
- `install.ps1`：自动 `pip install psutil` 并注册「登录即启动、崩溃自动重启」的计划任务（`HostMonitorAgent-<AgentId>`），实现开机自启；`run.bat` 提供便捷临时启动。
- 安全：延续主项目原则——受控端零入站、无远程执行接口、全程 `HTTPS + Token` 鉴权；月流量累计持久化到 `state.json`，重启不丢。

## P3：轻量只读账号（READONLY_TOKEN）（2026-07-09）

- **独立只读 Token**（`server/src/auth.js` + `server/src/api.js` + `.env.example`）：新增可选 `READONLY_TOKEN`，通过 `X-Readonly-Token` 头携带。读接口（`GET /agents`、`/agents/sparklines`、`/agents/:id`、`/agents/:id/metrics`、`/overview`）改由 `adminOrReadonly` 守卫，admin 与 readonly 均可访问；写接口（`POST /agents`、PUT/DELETE `/agents/:id`、`reset-token`、`/test-alert`）改由 `adminOnly` 守卫，readonly 访问返回 `403`、无 Token 返回 `401`。避免给查看者共享全量管理 Token，是 RBAC 的最小可用基础。
- admin/readonly 均走恒定时间比较与 `X-Forwarded-Proto` 白名单（https 强制）；`req.role` 透传供后续扩展。

## P3：Prometheus /metrics 导出（2026-07-09）

- **`GET /metrics`（Prometheus 文本格式）**（`server/server.js`）：导出每个 Agent 的最新 CPU / 内存 / 磁盘 / 负载 / 网络速率与累计量 / 运行时长，以及 `monitor_up`（复用 `OFFLINE_THRESHOLD_SEC` 判定在线）。便于直接喂给 Grafana + Prometheus 做仪表盘与告警，无需轮询 JSON API。
- **鉴权**：`/metrics` 与后台一致使用 `Authorization: Bearer <ADMIN_TOKEN>`（恒定时间比较），不强制 https，方便内网抓取；未携带有效 Token 返回 401。
- 指标名带单位后缀（`_bytes` / `_percent` / `_seconds`），label 为 `agent` 与 `name`（已转义），符合 Prometheus exposition 规范。

## P2 改进：Express 5 / 镜像固定 / 变量化邮箱 / 应用层限流（2026-07-09）

- **升级 Express 5**（`server/package.json`）：`express` 由 `^4.19.2` 升到 `^5.0.0`（Express 4 已 EOL）。本项目仅使用稳定 API（简单 `:id` 路由、`express.json`、静态托管），迁移无破坏性改动；需 `npm install` 重新安装依赖并重建镜像。
- **Dockerfile 固定基础镜像版本**（`server/Dockerfile`）：`FROM node:22-slim` → `node:22.21.1-slim`，避免不同时间构建的镜像 Node 小版本漂移。
- **compose 邮箱占位符变量化**（`server/docker-compose.yml`）：`SMTP_USER/ALERT_FROM/ALERT_TO` 改为 `${...}`（与现有 `ADMIN_TOKEN` 一致），由运行环境 / `.env` 注入，消除硬编码占位。`cp .env.example .env` 后 compose 会自动插值，行为不变。
- **应用层 Admin 限流（兜底）**（`server/src/api.js` + `server.js`）：新增每 IP 每 10s 20 次的固定窗口限流，作用于除 `/report` 外的全部 `/api` 路由；并设 `app.set('trust proxy', true)` 使 `req.ip` 在 Nginx 后取真实客户端 IP，不再完全依赖 Nginx 限流（S7）。

## P1 改进：Token 重置 / 告警态清理 / sparkline 批量（2026-07-09）

- **Agent Token 重置接口**（`server/src/api.js` + `server/src/db.js` + 前端）：新增 `POST /agents/:id/reset-token`，返回新 token 并使旧 token 立即失效，避免 token 泄露只能删库重建（S5）；仪表盘编辑弹窗新增「重置 Token」按钮并即时展示新 token。
- **删除 Agent 清理 `alert_state`**（`server/src/db.js`）：`deleteAgent` 现同步清除该 Agent 的告警冷却记录，避免残留影响后续告警判断（C5）。
- **sparkline 批量接口**（`server/src/api.js` + 前端 `app.js`）：新增 `GET /api/agents/sparklines?range=6h`，一次返回所有 Agent 的历史，前端由 N+1 并发改为单请求，消除 Agent 数量多时被 Nginx 限流 429 导致 sparkline 为空的问题（C4）。

## 安全修复 P0：令牌比较与 HTTPS 白名单（2026-07-09）

- **恒定时间令牌比较**（`server/src/auth.js`）：`agentAuth` / `adminAuth` 改用 `crypto.timingSafeEqual()`（新增 `safeEqual` 辅助，长度不等直接返回 false），消除令牌比较的时序侧信道（`S1`）。
- **`X-Forwarded-Proto` 改为白名单**（`server/src/auth.js`）：原逻辑为"有头且非 https 才拒绝"，会漏掉直连 :8080 的空头请求、且头可被伪造；现改为默认拒绝、仅 `proto === 'https'` 放行（`S2`）。本地明文测试可显式设 `ADMIN_ALLOW_HTTP=1`（生产切勿设置）。
- **quick-start 兼容**（`docker-compose.yml` 根目录）：因上述白名单，明文 http 直连会 403，故为该示例显式加 `ADMIN_ALLOW_HTTP=1`，保持快速测试可用。

## 前端可靠性与安全可观测性（2026-07-09）

- **概览/卡片独立刷新**（`server/public/app.js`）：`refresh()` 改用 `Promise.allSettled` 并发加载 `loadOverview()` 与 `loadAgents()`，任一接口异常不再阻断另一视图更新；仅当两者都失败时才显示错误横幅，并顺带由串行改并发、首屏加载更快。
- **仪表盘「测试告警」按钮**（`server/public/index.html` + `app.js`）：右上角新增「📨 测试告警」，点击校验 Token 后调用 `POST /api/test-alert`，按钮进入「发送中…」禁用态；`api()` 失败时优先回显服务端 `error` 字段。
- **「安全」说明弹窗**（`server/public/index.html` + 样式）：新增「🔒 安全」按钮，打开部署/安全说明（源站不直连、TLS、强口令、CSP、独立鉴权、/api 限流、CF 盾非必需、Tunnel 隐藏源站），提升安全实践可发现性。
- **Nginx 加固**（`nginx/monitor.conf.example`）：新增 `apilimit` 限流 zone 覆盖 `/api/` 后台接口，并补充 `X-Content-Type-Options` / `X-Frame-Options` / `HSTS` 安全响应头。
- **隐藏源站指南**（`TUNNEL-GUIDE.md` 新建）：提供 Cloudflare Tunnel 与 Tailscale 两种零入站端口方案及完整命令；README 中/英均已链接。

## 安全加固（2026-07-09）

针对代码审查报告的高/中优项及部分低优项完成一轮安全加固。

### 安全（修复）
- **CSP 收紧**（`server/server.js`）：移除 `script-src`/`style-src` 中的 `'unsafe-inline'`，改为 `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'`。前端所有 `onclick` 改为 `addEventListener` 事件委托，内联 `style=` 改为 CSS class / JS 赋值（`.v.green`/`.v.red`、`.metric.disk`、`data-pct` 磁盘条宽度）。
- **弱口令启动拦截**（`server/server.js`）：启动时校验 `ADMIN_TOKEN`，空值 / 等于 `change-me-admin-token` / 长度 < 16 直接 `process.exit(1)`。
- **管理接口强制 HTTPS**（`server/src/auth.js`）：`adminAuth` 校验 `X-Forwarded-Proto`，非 `https` 返回 `403 https required`。
- **告警循环隔离**（`server/src/alerts.js`）：`check()` 按 Agent 包裹 `try/catch`，单个 Agent 的 DB 异常不再中断整轮、饿死其余 Agent 的告警。
- **`.dockerignore`**（`server/.dockerignore` 新增）：排除 `data/`、`.env`、`node_modules` 等，避免 SQLite 数据库与凭据进入镜像构建上下文。
- **`sendAlert` 改为 await**（`server/src/alerts.js`）：`alertThreshold`/`check` 改为 `async`，三处告警发送均 `await`，不再 fire-and-forget。
- **prune 失败告警**（`server/server.js`）：`prune` 连续 3 次失败推送邮件告警，避免 metrics 表无限膨胀无感知。

### 前端可靠性的提升
- **错误态横幅**（`server/public/app.js` + `index.html` + `style.css`）：`refresh()` 改为 `async` 统一捕获 API 错误并显示 `#banner` 横幅（常驻、不刷屏），原 `loadOverview`/`loadAgents` 的静默空 `catch` 已移除。

### 审查结论（未改动 / 维持原状）
- 告警定时器「静默停止」前提不成立（Node `setInterval` 回调异常不会停止定时器），故仅修复循环隔离（#2b）。
- `PUT /agents/:id` 的 `name` 空值问题为误报（`str("",100) || a.name` 回退旧值），非安全问题。
- 低优项（admin 限流依赖 Nginx、Agent 重试退避注释、Token 恒定时间比较、默认邮箱运行时校验、SQLite WAL 模式）风险可控，暂未处理。

### 部署注意
- 服务现已拒绝弱/默认 `ADMIN_TOKEN`，部署前务必在 `.env` 设置足够随机、≥16 位的管理员 Token。
- 修改后需**重建镜像**（`docker compose build`）以使 `.dockerignore` 生效。
- 务必保持 Server 端口不发布到公网、只暴露 Nginx，HTTPS 强制检查才完整生效。
