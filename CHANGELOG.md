# Changelog

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
