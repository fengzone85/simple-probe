# Simple Probe 监控平台 — 安全审计报告

> **审计日期**：2026-07-15
> **审计范围**：`E:\workbuddy\监控` 全仓库
> **审计方法**：代码审查 + 架构分析 + 威胁建模

---

## 1. 项目概述

Simple Probe 是一款自托管的服务器监控平台，对标哪吒监控/ Komari。由 **服务端（Node.js/Express）**、**Agent 端（Python/Linux + Windows）**、**SQLite 数据库** 三部分组成。安全模型核心为"无指令通道"设计——Agent 只上报指标，服务端无法反向控制 Agent。

---

## 2. 总体评价

| 维度 | 评分 | 说明 |
|---|---|---|
| 认证与安全 | ⭐⭐⭐⭐☆ | 多层防御设计优秀，2FA/TOTP、签名 Cookie、IP 白名单、HTTPS 强制 |
| 输入验证 | ⭐⭐⭐⭐⭐ | validate.js 全面校验，参数化查询，无 SQL 注入风险 |
| XSS/CSRF 防护 | ⭐⭐⭐⭐☆ | CSP 严格、Cookie 安全标志完备，custom_css 有注入风险 |
| 数据安全 | ⭐⭐⭐⭐☆ | 参数化查询、文件权限收紧、密码脱敏良好 |
| 传输安全 | ⭐⭐⭐⭐⭐ | Agent 强制 HTTPS、CSP 头、HTTP 明文拒绝 |
| 日志与监控 | ⭐⭐⭐☆☆ | 告警日志有但不够完善，无审计日志 |
| 依赖安全 | ⭐⭐⭐☆☆ | 依赖少且稳定，但无 lock 文件/签名验证 |

**综合评级：A-** —— 安全设计成熟，多数关键风险已妥善缓解，少数中低危项建议修复。

---

## 3. 详细审计发现

### 3.1 ✅ 优秀实践（已做得很好的方面）

#### 3.1.1 认证与授权机制
| 措施 | 文件 | 评价 |
|---|---|---|
| TOTP 2FA (RFC 6238) | `server/src/totp.js` | 兼容 Google Authenticator，实现正确 |
| 恒定时间 Token 比较 | `server/src/auth.js:23` | SHA-256 哈希后 timingSafeEqual，消除长度侧信道 |
| 签名 Session Cookie | `server/src/auth.js:50-80` | HMAC-SHA256 签名 + base64url + 过期时间 |
| Cookie 安全标志 | `server/src/auth.js:85` | HttpOnly + Secure + SameSite=Strict |
| 角色分级授权 | `server/src/auth.js` | admin / readonly / agent 三层权限模型 |
| 写操作强制 2FA | `server/src/auth.js:139` | 2FA 启用后写接口需 TOTP 验证 |
| HTTPS 强制（管理端） | `server/src/auth.js:97` | 通过 X-Forwarded-Proto 验证，防伪造 |
| IP 白名单 | `server/src/auth.js:153` | 支持 CIDR，可配置 |
| Agent 认证 | `server/src/auth.js:27` | X-Agent-ID + Bearer Token，哈希比对 |

#### 3.1.2 输入验证与注入防护
| 措施 | 文件 | 评价 |
|---|---|---|
| 参数化 SQL 查询 | `server/src/db.js` | 全部使用 `?` 占位符 + `.run(params)`，无 SQL 注入 |
| 上报数据校验 | `server/src/validate.js` | 类型/范围/长度三重校验，越界→null |
| 字符串长度限制 | `server/src/validate.js:5` | `str()` 函数超限返回空串 |
| 数值范围钳制 | `server/src/validate.js:2-9` | `num()` 函数限定上下界 |
| CSP 严格头 | `server/server.js:27` | `script-src 'self'; style-src 'self'`，阻断内联脚本 |
| 主题路径白名单 | `server/server.js:95` | 正则校验 `/themes/:id/:file`，防路径穿越 |

#### 3.1.3 传输安全
| 措施 | 文件 | 评价 |
|---|---|---|
| Agent 强制 HTTPS | `agent/agent.py:30-35` | 非 localhost 的 HTTP 直接 exit(1) |
| Nginx 安全头 | `nginx/monitor.conf.example` | X-Content-Type-Options, X-Frame-Options, HSTS |
| Token 哈希存储 | `server/src/db.js:93` | SHA-256 哈希，非明文 |
| Agent 401 长退避 | `agent/agent.py:10` | 认证失败退避 600 秒，防爆破 |

#### 3.1.4 数据最小化
- Agent 仅采集 CPU/内存/磁盘/流量/温度等系统状态指标
- 不采集进程列表、用户信息、网络连接等敏感数据
- 公开视图脱敏处理（不含 token/备注/商家等字段）

---

### 3.2 ⚠️ 中危问题（建议修复）

#### M-1：`custom_css` 配置项存在 CSS 注入风险
- **文件**：`server/src/db.js:133`（默认值含 `custom_css: ''`）
- **位置**：`admin.js` 中 `appSettings.custom_css` 通过 `<style id="customCss">` 注入页面
- **风险**：攻击者（admin 角色）可通过自定义 CSS 进行：
  - CSS 选择器覆盖，钓鱼登录框
  - `@font-face` 加载恶意字体实施指纹追踪
  - 通过 `expression()` 或 `url(javascript:)` 间接执行（现代浏览器已基本阻止）
- **建议**：
  - 对 `custom_css` 做白名单校验（仅允许合法 CSS 属性）
  - 或使用 Shadow DOM 隔离自定义样式
  - 或在 CSP 中进一步限制 `style-src`

#### M-2：`/metrics` 端点不强制 HTTPS
- **文件**：`server/server.js:49-80`
- **位置**：`app.get('/metrics', ...)`
- **风险**：Prometheus metrics 端点复用 ADMIN_TOKEN 鉴权，但不强制 HTTPS（注释写明"便于内网抓取"）。如果在内网中 ADMIN_TOKEN 被拦截，攻击者可获得全部监控数据。
- **建议**：
  - 增加 `ADMIN_ALLOW_HTTP` 检查，或默认强制 HTTPS
  - 或者使用独立的 metrics_token 而非复用 ADMIN_TOKEN

#### M-3：Admin Token 首次部署安全性
- **文件**：`server/server.js:35-39`
- **位置**：Web 初始化向导生成 Token 保存到 `./data/admin_token.txt`
- **风险**：
  - 生成的 Token 仅在页面显示一次，用户可能未妥善保存
  - `admin_token.txt` 文件权限未明确设置（`db.js` 中设置了 DB 文件为 0o600，但未设置 token 文件）
- **建议**：
  - 在 `api.js:59` 的 `/setup/generate` 中设置 `admin_token.txt` 为 0o600
  - 或直接将 Token 存入 admin_config 表，不落地文件

#### M-4：Agent Token 在 systemd 环境变量中可见
- **文件**：`agent/install.sh:170-178`
- **位置**：`/etc/simple-probe/agent.env` 写入 AGENT_TOKEN
- **风险**：虽然文件权限设为 600 root:root，但 systemd EnvironmentFile 在 `/proc/*/environ` 中对 root 可见，且有 `journalctl` 日志泄露风险（如果 agent 启动日志包含 token）。
- **现状**：代码中已建议使用 `--token-file` 替代 `--token`，这是好的。
- **建议**：
  - 考虑使用 systemd `EnvironmentFile` + `ProtectSystem=strict` 已经限制了访问
  - 确认 agent 日志中不会打印 token 值

#### M-5：WebSocket 端点无鉴权
- **文件**：`server/server.js:120-133`
- **位置**：`/api/clients` WebSocket
- **风险**：Komari 兼容 WebSocket 端点未做任何认证。虽然数据是脱敏的（仅公开数据），但攻击者可连接 WebSocket 持续轮询，消耗服务器资源。
- **建议**：
  - 添加速率限制
  - 或要求 `public_enabled` 为 true 时才开放 WebSocket

---

### 3.3 ℹ️ 低危问题（建议优化）

#### L-1：缺少审计日志
- **文件**：全局
- **风险**：管理员操作（创建/删除/修改 Agent、修改设置、启用/禁用 2FA）无审计日志记录。发生安全事件时难以追溯。
- **建议**：
  - 记录关键操作的 timestamp、admin IP、操作类型、目标对象
  - 可写入文件或独立的 audit_log 表

#### L-2：`SESSION_SECRET` 默认随机生成
- **文件**：`server/src/auth.js:50`
- **风险**：未设置 `SESSION_SECRET` 环境变量时，每次重启生成新的随机值，所有活跃会话失效。这在 Docker 环境中尤其不便（每次重建容器都丢失登录态）。
- **建议**：文档中应强调设置 `SESSION_SECRET` 环境变量。

#### L-3：`/setup/register` 端点缺少速率限制
- **文件**：`server/src/api.js:106`
- **风险**：`/api/setup/register` 端点使用 SETUP_TOKEN 认证，但未纳入全局速率限制（`rateLimit` 中间件中跳过了 `/report`，但未特别排除 `/setup/register`）。不过 rateLimit 是按 IP 的，如果 SETUP_TOKEN 泄露，攻击者可暴力枚举 agent 名称。
- **建议**：
  - 对 `/setup/register` 增加额外的速率限制
  - 或限制仅允许特定 IP 调用

#### L-4：SQLite 数据库无 WAL 模式
- **文件**：`server/src/db.js:14`
- **风险**：注释说明故意不使用 WAL 模式以避免共享内存文件问题。但单一 writer 场景下，并发读取性能较差。
- **建议**：如果未来需要并发读取，可评估 WAL 模式的替代方案。

#### L-5：`better-sqlical3` 同步阻塞
- **文件**：`server/src/db.js`
- **风险**：`better-sqlite3` 是同步 API，长时间查询会阻塞 Event Loop。在 Agent 数量较多时可能影响响应。
- **建议**：对 `getMetricsAll` 等全量查询增加超时保护。

#### L-6：安装脚本下载文件的完整性
- **文件**：`install.sh`, `agent/install.sh`, `agent/windows/install.ps1`
- **风险**：从 GitHub raw 下载文件时无 GPG/签名验证。如果 GitHub CDN 被劫持，可能植入恶意代码。
- **建议**：
  - 使用 `curl -fsSL --create-dirs` 下载后验证 SHA256
  - 或提供签名公钥验证

#### L-7：`/api/agents/:id/commands` 返回安装命令含 `<token>` 占位符
- **文件**：`server/src/api.js:225`
- **位置**：`buildInstallCommands(getPublicBaseUrl(req), a.id, '<token>', ...)`
- **风险**：重置 Token 后的命令返回 `<token>` 占位符而非真实 token，用户可能需要手动查找新 token。这不是安全问题，而是可用性缺陷。
- **建议**：返回真实 token（已在 `/agents` POST 中实现，但 `/commands` 端点未做）。

---

### 3.4 🔒 架构安全分析

#### 3.4.1 信任边界
```
Internet
  │
  ▼
[Nginx + TLS] ←── 第一道防线：TLS终止、限流、安全头
  │
  ▼
[Node.js Server:8080] ←── 第二道防线：认证、授权、CSP、输入校验
  │         │
  │         ├── Admin Dashboard (Cookie + 2FA)
  │         ├── Agent Report API (Token Auth)
  │         └── Public Status Page (No Auth)
  │
  ▼
[SQLite DB] ←── 第三道防线：参数化查询、文件权限 0o600
```

#### 3.4.2 攻击面评估
| 攻击向量 | 防护状态 | 说明 |
|---|---|---|
| SQL 注入 | ✅ 已防护 | 全部参数化查询 |
| XSS | ✅ 已防护 | CSP + 输出转义 + 事件委托 |
| CSRF | ✅ 已防护 | SameSite=Strict + Cookie 机制 |
| 暴力破解 | ✅ 已防护 | Nginx 限流 + 应用层限流 + 2FA |
| 令牌泄露 | ✅ 已防护 | Hash 存储 + 恒定时间比较 |
| 中间人攻击 | ✅ 已防护 | Agent 强制 HTTPS |
| 路径穿越 | ✅ 已防护 | 主题路径白名单校验 |
| SSRF | ✅ 已防护 | 无外部 URL 请求能力 |
| 信息泄露 | ✅ 已防护 | 公开视图脱敏 |
| 拒绝服务 | ⚠️ 部分防护 | 有速率限制但无请求体大小上限（除 16kb JSON 外）|

---

### 3.5 前端安全细节

#### 3.5.1 CSP 策略分析
```
default-src 'self';
script-src 'self';       ← 不允许 inline script
style-src 'self';        ← 不允许 inline style
img-src 'self' data:;    ← 允许 data URI（国旗 emoji 等）
connect-src 'self';      ← 仅允许同源 fetch
```
- **优点**：严格策略，有效防止 XSS 和数据外泄
- **注意点**：`style-src 'self'` 意味着 `<style id="customCss">` 注入的 CSS 是合法的（同源），但如果 custom_css 包含 `@import` 则可能被利用

#### 3.5.2 事件绑定安全
- `admin.js` 使用 `addEventListener` 替代内联 `onclick`（符合 CSP）
- 使用事件委托处理动态元素（`grid.addEventListener('click', ...)`）
- 安全

---

### 3.6 Agent 端安全

#### 3.6.1 Linux Agent
| 项目 | 状态 |
|---|---|
| 强制 HTTPS | ✅ 非 localhost HTTP 直接退出 |
| systemd 加固 | ✅ NoNewPrivileges, ProtectSystem, PrivateTmp 等 14 项 |
| 最小权限用户 | ✅ `simple-probe` 系统用户 |
| 无 shell 调用 | ✅ probe 使用 list 形式命令 |
| 本地探测目标 | ✅ 服务端不可下发 |
| 认证失败退避 | ✅ 600 秒退避，防爆破 |

#### 3.6.2 Windows Agent
| 项目 | 状态 |
|---|---|
| 强制 HTTPS | ✅ 同 Linux |
| 计划任务 | ✅ 开机自启 + 崩溃重启 |
| Token 存储 | ⚠️ 存储在 `run_scheduled.bat` 中（明文） |
| 权限隔离 | ⚠️ 以当前用户运行，无最小权限约束 |

---

## 4. 依赖安全

| 依赖 | 版本 | 风险 |
|---|---|---|
| express | ^4.21.0 | 已知无高危 CVE |
| better-sqlite3 | ^11.3.0 | 本地数据库，风险低 |
| dotenv | ^16.4.5 | 环境变量加载，风险低 |
| nodemailer | ^9.0.3 | 邮件发送，注意 SMTP 凭据安全 |
| ws | ^8.18.0 | WebSocket，无已知高危 CVE |

- **无 package-lock.json**：建议使用 `npm install --package-lock-only` 生成 lock 文件以确保可重复构建
- **无 SCA 扫描**：建议集成 `npm audit` 或 Dependabot

---

## 5. 结论与建议优先级

### 高优先级（建议尽快修复）
1. **M-1**：`custom_css` 注入防护 — 增加白名单或使用 Shadow DOM
2. **M-3**：Token 文件权限 — 在 `/setup/generate` 中设置 0o600

### 中优先级（下一版本修复）
3. **M-2**：`/metrics` 端点 HTTPS 强制
4. **L-1**：添加审计日志
5. **L-6**：安装脚本文件完整性验证

### 低优先级（持续改进）
6. **M-5**：WebSocket 速率限制
7. **L-2**：文档强调 SESSION_SECRET 设置
8. **L-3**：`/setup/register` 额外速率限制
9. **L-4/L-5**：SQLite 性能优化

---

## 6. 安全加固建议清单

- [ ] 对 `custom_css` 输入做 CSS 属性白名单校验
- [ ] 在 `/setup/generate` 中设置 `admin_token.txt` 文件权限为 0o600
- [ ] `/metrics` 端点增加 HTTPS 强制检查
- [ ] 添加管理员操作审计日志（创建/删除 Agent、修改设置、2FA 变更）
- [ ] WebSocket `/api/clients` 端点增加速率限制
- [ ] 生成 `package-lock.json` 锁定依赖版本
- [ ] 集成 `npm audit` 到 CI/CD 流程
- [ ] 安装脚本增加 SHA256 校验或 GPG 签名验证
- [ ] Windows Agent 考虑以 Service 形式运行（SYSTEM 权限隔离）
- [ ] 文档补充 `SESSION_SECRET` 环境变量设置说明

---

*本报告基于 2026-07-15 的代码版本审计。安全是一个持续过程，建议定期复审。*

---

## 7. 整改进度（2026-07-15）

下列项目已在本轮落地（未实现 L-1 审计日志、M-4 沿用既有 `--token-file` 建议）：

### 已修复
- **M-1（custom_css 注入）**：`server/src/validate.js` 新增 `sanitizeCss()`，落库前剥离 `@import`/`@font-face`/`@charset`/`url()`/`expression()` 与 `behavior`/`-moz-binding` 等危险项，仅放行合法属性名；`server/src/api.js` 的 `PUT /settings` 保存时调用。前端改为同源 `/custom.css` 路由以 `<link>` 投放（`server/server.js` 新增路由，`admin.html`/`index.html` 改 `<link>`，`admin.js` 的 `applyCustomCss` 改为刷新 link），既恢复功能又不动严格 CSP（内联 `<style>` 原被 `style-src 'self'` 拦截，故此前功能本就不生效）。
- **M-2（/metrics 强制 HTTPS）**：`server/server.js` 的 `/metrics` 增加协议检查，默认强制 HTTPS，本地调试可用 `ADMIN_ALLOW_HTTP=1` 放行（与后台管理端同款开关）。
- **M-5（WebSocket 限流）**：`/api/clients` 增加按客户端 IP 的并发上限（5）与新建速率上限（20/min），且仅当 `public_enabled` 开启时开放。
- **L-3（/setup/register 限流）**：`server/src/api.js` 增加独立按 IP 限流（10/min），即便 `SETUP_TOKEN` 泄露也防枚举/耗尽。
- **低危 L-2 / L-6 / 依赖**：`docs/src/content/docs/env.md` 强化 `SESSION_SECRET` 必填说明并修正示例弱口令；`install.sh`/`agent/install.sh`/`agent/windows/install.ps1` 增加 SHA256 校验辅助函数与 opt-in 环境变量（`SP_INSTALL_SHA256`、`SP_AGENT_SHA256S`），关键的自更新 `install.sh` 默认走校验；生成 `server/package-lock.json` 并在 `.github/workflows/test.yml` 接入 `npm audit`（当前 0 漏洞）。

### 已实质缓解（无需改动）
- **M-3（Token 文件权限）**：当前 `/setup/generate` 已将 Token 存入 `admin_config` 表（`server/src/api.js`），`admin_token.txt` 仅为旧版兼容回退、新部署不再写文件，明文落盘风险已不存在。
- **M-4（Agent Token 环境变量可见）**：既有 `--token-file` 推荐用法已规避明文命令行暴露，按既有建议保持即可。

### 待后续（用户本轮未选）
- **L-1 管理员操作审计日志**（需新增 `audit_log` 表 + 多处埋点）。
- **M-4 彻底方案**、**L-4/L-5 性能优化**、**Windows Agent 以 Service 运行**。

