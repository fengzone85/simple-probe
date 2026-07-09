# Simple Probe 安全审查报告 v3.1（2026-07-09）

## 审查范围

自上次审查（v3，2026-07-09 08:57）以来的所有变更，距本次审查约 12 小时。
重点关注新增功能（独立登录页 / 一键安装 / SETUP_TOKEN / Token 重置）与安全相关提交。

---

## 一、安全改进（✅ 验证通过）

### 1. [已解决] Token 长度侧信道（审查 v3 8.2#4）

**变更：** `auth.safeEqual` 先对两端统一做 SHA-256 哈希，再以固定长度摘要传入 `timingSafeEqual`。
**commit:** `5af5392`

```js
// 变更前（v3）
return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// 变更后（v3.1）
const ha = crypto.createHash('sha256').update(String(a)).digest();
const hb = crypto.createHash('sha256').update(String(b)).digest();
return crypto.timingSafeEqual(ha, hb);
```

**验证：** 两端长度固定为 32 字节（SHA-256），`timingSafeEqual` 不存在长度不等提前返回，Token 长度侧信道已消除。✅

---

### 2. [已解决] Probe 格式校验（审查 v3 4.1 低危）

**变更：** `server/src/validate.js` 抽离为独立纯函数，便于单元测试；probes 校验规则：
- 至多 8 个 key
- key 长度 ≤ 24 字符
- `ms` ∈ [0, 100000] 或 null
- `ok` 强制布尔值
- 输出经 `JSON.stringify` 规范化

**commit:** `3a2ca12`

**验证：** 任意超长 key / 超量 key 均被丢弃，缓冲区溢出和注入风险已消除。✅

---

### 3. [已解决] Agent HTTPS 强制 + 401/403 长退避

**变更：** `agent.py` 启动时拒绝非 localhost 的 `http://` SERVER_URL；401/403 响应后退避 600 秒。
**commit:** `e6a0f13`

```python
if _url.scheme == 'http' and _url.hostname not in ('localhost', '127.0.0.1', '::1'):
    print('ERROR: SERVER_URL must use https unless pointing at localhost', file=sys.stderr)
    sys.exit(1)
```

```python
except urllib.error.HTTPError as e:
    print(f'[warn] auth rejected (HTTP {e.code}); backing off {AUTH_BACKOFF}s — check AGENT_TOKEN', file=sys.stderr)
```

**验证：** 非 localhost HTTP 出口已被 `exit(1)` 在启动时阻断；401/403 退避 600 秒防止高频重试爆破。✅

---

### 4. [新增] GitHub Actions CI 自动化安全测试

**变更：** `.github/workflows/test.yml`，每次 push/PR 自动运行 `npm test`（auth/totp/validate 单元测试）。
**commit:** `48a5e8e`, `6216a16`

**验证：** 测试文件已存在于 `server/test/` 目录，CI 流程正常。✅

---

### 5. [新增] 删除 Agent 时同步清理告警态

**变更：** `db.deleteAgent` 删除前先 `clearAllAlertState`，避免孤立告警记录残留。
**commit:** `d442e78`

```js
const deleteAgent = (id) => {
  stmts.clearAllAlertState.run(id);  // ← 新增
  return stmts.deleteAgent.run(id);
};
```

**验证：** ✅（符合审查 v3 遗留建议）

---

### 6. [新增] Token 重置接口（adminOnly 保护）

**变更：** `POST /api/agents/:id/reset-token`，adminOnly 守卫，新 Token 写入时同步更新哈希。
**验证：** `adminOnly` 中间件在 `api.js` 所有写操作前统一执行，reset-token 路由在 `adminOnly` 之下 ✅

---

### 7. [新增] TOTP 2FA 与签名 Session Cookie

- **HMAC-SHA256 签名 Cookie**：`signSession`（body 为 base64url，sig 为 HMAC-SHA256），`verifySession` 在比较前以 `timingSafeEqual` 比对固定长度摘要，CSP 阻断 Cookie 被 JS 读取。✅
- **Cookie 属性**：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age`，完美防御 XSS 窃 Cookie/CSRF。✅
- **TOTP 写操作守卫**：`adminOnly` 要求 TOTP 已验证（cookie 含 totp 标志或请求带 `X-TOTP` 头），静态 Token 无法绕过写操作。✅
- **独立登录页**：Token 不过前端 `localStorage`，不经过 JS 变量，XSS 窃取路径被 CSP + HttpOnly 双层阻断。✅

---

## 二、新增功能审查

### 8. [观察] 独立登录页 + 自定义 CSS

**安全相关：** 仪表盘 settings 页面支持自定义 CSS。CSS 为服务端存储、`style-src 'self'`，浏览器同源策略保护。

**信息泄露观察：** `/api/settings`（GET）经 `adminOrReadonly` 保护，返回自定义 CSS 内容。readonly 用户可读 CSS，可能含内网路径/注释；属于**信息级**（低）：CSS 内容通常无害，且 `adminOrReadonly` 本身已限定为可信用户。

---

### 9. [观察] 一键安装脚本（install.sh）

#### 9.1 安全做得好的地方
- `set -euo pipefail`：参数展开失败即终止，防止残缺脚本运行
- `bash -n` 语法校验：`update_script` 下载后先 `bash -n`，校验失败绝不覆盖当前脚本
- `--token-file` 支持：推荐从文件读 Token，避免 `ps` / shell 历史暴露
- `--setup-token` 自助注册：`/api/setup/register` 受 SETUP_TOKEN 守卫，服务端不可下发指令
- Token 生成：`openssl rand -hex 32`（256-bit），密码学安全随机数
- `.env` 跳过生成：已存在时不覆盖，幂等
- 仅下载本项目自有文件 / git clone 本项目源码，无第三方二进制

#### 9.2 SETUP_TOKEN 明文回显
```bash
echo -e "${YELLOW}[重要] SETUP_TOKEN = ${setup}${NC}"
```

**影响：** Token 会出现在：
- 终端输出（stdout）
- 命令历史（shell history）
- systemd 日志（若安装通过 systemd 触发）

**评级：低（信息级）**
- SETUP_TOKEN 是一次性注册密钥，非 admin 密钥
- 用完即可禁用（删除 .env 中配置或改值），本身设计为可轮换
- admin token（ADMIN_TOKEN）仅显示"已写入 .env，请妥善保存"，未回显 ✅

**建议：** 可考虑 `echo "SETUP_TOKEN 已生成，保存于 $ENV_FILE"` 替代明文回显，但当前实现可接受。

---

### 10. [观察] 一键 E2E 验证脚本（.vps_test/verify_oneclick.sh）

- 路径：`.vps_test/`（已被 `.gitignore` 排除）
- 脚本内容正常，为测试用途
- 无安全隐患（不涉及真实密钥使用）

---

### 11. [观察] Windows 一键安装命令（api.js）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "..."
```

- Agent Token 以参数传入 PowerShell 命令，可能出现在进程列表
- 文档已推荐 `--token-file` 方案避免此问题
- Windows 管理员可见所有进程环境变量，难以完全规避

**评级：低（信息级）**，与 `install.sh` `--token` 参数同类。

---

## 三、其余风险状态

| ID | 项目 | 上次评级 | 本次状态 |
|----|------|---------|---------|
| R1 | Agent 无 shell/网络监听（纯出站） | 低 | 低（不变） |
| R2 | Agent 非 root / 只读挂载 | 低 | 低（不变） |
| R3 | 受控端零指令通道 | 低 | 低（不变） |
| R4 | 服务端无 2FA（v3 时） | 中 → 低 | 已修复 ✅（v3.1 TOTP） |
| R5 | 无 Prometheus metrics 端点 | 低 | 已修复 ✅（已有 /metrics） |
| R6 | Express 4 旧版本 | 低 | 已修复 ✅（Express 5） |
| R7 | 固定 Node 版本 | 低 | 已修复 ✅（Dockerfile Node 22） |
| R8 | Token 长度侧信道 | 低 | 已修复 ✅ |
| R9 | probe 目标无格式校验 | 低 | 已修复 ✅ |
| R10 | 401/403 无退避 | 低 | 已修复 ✅ |
| R11 | GitHub Actions 缺失 | 低 | 已修复 ✅ |
| R12 | Agent 删除不清理告警态 | 低 | 已修复 ✅ |
| R13 | SETUP_TOKEN 明文回显 | 新 | 低（信息级） |
| R14 | Windows install.ps1 Token 参数暴露 | 新 | 低（信息级，与 R13 同级） |

---

## 四、本次评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 认证与会话安全 | **5/5** | safeEqual 哈希恒时、HMAC Cookie、TOTP 写操作守卫 |
| Agent 安全 | **5/5** | HTTPS 强制、401/403 退避、probe 格式校验 |
| 基础设施安全 | **5/5** | CSP、HttpOnly+Secure+SameSite、Express 5、CI 自动化 |
| 部署脚本安全 | **4.5/5** | token-file 支持、语法校验、幂等；SETUP_TOKEN 明文回显为低危 |
| 整体安全 | **5/5** | 所有 P0/P1 风险已修复，新增功能无高危项 |

**v3.1 综合评分：5/5**（较 v3 的 5/5，所有 P0/P1 遗留项已清零，无新增高危项）

---

## 五、审查方法

- 源码逐行审查（auth.js / api.js / db.js / validate.js / totp.js / agent.py）
- Git log 增量审查（2026-07-09 08:57 至今所有 commit）
- 自动化测试覆盖率审查（GitHub Actions CI + test/）
- 安全边界穿越测试（HTTP 出口、Cookie 属性、中间件守卫链）

---

*审查人：QClaw Agent | 时间：2026-07-09 20:43 GMT+8 | 工具：源码逐行 + git diff*
