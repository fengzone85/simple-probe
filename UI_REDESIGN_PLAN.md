# Simple Probe UI 重设计方案 v1.0

**目标**：借鉴 Komari 等成熟监控工具的视觉与交互体验，**安全边界一行不改**。
**范围**：`server/public/`（前端三件套 index.html / style.css / app.js）
**当前规模**：HTML 223 行、CSS 161 行、JS 703 行、ECharts 1MB（vendor，不动）

---

## 实施状态（2026-07-09 更新）

> 本文件为**规划文档**，以下为实际落地情况，避免与最终实现混淆。

| 阶段 | 计划内容 | 实际状态 |
|------|----------|----------|
| P0 | 流量单位换算 + 进度条阈值色 + Toast + 网络质量色块 | ✅ 已落地（见 `P0_DELIVERY.md`） |
| P1 | 卡片内部重设计（Komari 风格） | ✅ 已落地（commit `7919700`） |
| P2 | 节点详情页 hash 路由化（替代 modal） | ✅ 已落地（commit `4e0ea16`） |
| P3 | 面板内节点切换器 + 编辑/重置/删除 | ✅ 已落地（commit `1b08d7c`） |
| P3 | 主题切换（🌗 暗/亮/跟随系统 + 自定义 JSON） | ❌ 未实施 |
| P3 | 拖拽排序（HTML5 Drag + 持久化到 settings） | ❌ 未实施 |
| — | `server/src/ui_helpers.js` 抽离 + 单元测试 | ❌ 未实施（helpers 直接内联在 app.js） |

**命名偏离说明**：实际实现使用 `fmtBytes`（方案写 `formatBytes`）、`.bar-i` + `.bar-i.bar-warn/.bar-danger`（方案写 `.bar > i` + `.warn/.danger`）、`pctClass` 返回 `''/bar-warn/bar-danger`。以 `P0_DELIVERY.md` 为准。

---

## 〇、现状分析

### 0.1 已有资产（不重做）
- ✅ ECharts 1.0MB（图表引擎）
- ✅ TOTP 2FA、签名 Cookie、CSP、HttpOnly 登录页
- ✅ 节点表格布局（`#grid`）
- ✅ 详情弹窗 + 时间范围切换（1h / 6h / 24h / 7d）
- ✅ 设置中心（站点名 / 自定义 CSS / 默认排序 / 通知渠道）
- ✅ 节点分组（已有 `group_order` 字段）
- ✅ Agent 主动 Ping 上报（已有 `probes` 字段，比 Komari 更优）

### 0.2 待优化点
- ❌ 节点展示是表格，移动端体验差
- ❌ 流量 / 速率单位硬编码（直接显示字节数，1288490188 看着头大）
- ❌ 一键安装命令无复制按钮，需手动选中
- ❌ 主题：仅暗色，无明色 / 跟随系统
- ❌ 排序：下拉选择，Komari 是拖拽
- ❌ 详情页：所有图表塞在一个 modal，太挤
- ❌ 暗色调过深（`#0f1117` 接近纯黑），不如 Komari 的"小清新"
- ❌ 颜色分级：CPU 100% 与 CPU 90% 都是红色，缺少中间过渡色

---

## 一、设计系统（Design Tokens）

### 1.1 颜色（CSS 变量驱动，支持主题切换）

```css
/* 暗色主题（默认，保持现状但提亮） */
:root[data-theme="dark"] {
  --bg:        #1a1d29;     /* 主背景（从 #0f1117 提亮） */
  --bg-soft:   #232737;     /* 次背景 */
  --card:      #282d3f;     /* 卡片 */
  --card-hi:   #2f3548;     /* 卡片悬停 */
  --border:    #353c52;     /* 边框 */
  --text:      #e6e9f0;     /* 主文字 */
  --muted:     #9ba3b8;     /* 次文字 */
  --accent:    #5cb6a5;     /* 主色（从 #36d1c4 调柔） */
  --accent2:   #6c9eff;     /* 辅色 */
  --green:     #4dd591;
  --yellow:    #ffce5c;
  --red:       #ff6b7e;
  --shadow:    0 4px 14px rgba(0,0,0,.25);
  --radius:    10px;        /* 统一圆角 */
}

/* 亮色主题（新增） */
:root[data-theme="light"] {
  --bg:        #f5f7fb;
  --bg-soft:   #ffffff;
  --card:      #ffffff;
  --card-hi:   #f0f3f9;
  --border:    #e3e8f0;
  --text:      #1f2937;
  --muted:     #6b7280;
  --accent:    #4ca89a;
  --accent2:   #5b8def;
  --green:     #2faa6a;
  --yellow:    #d49b25;
  --red:       #e34960;
  --shadow:    0 2px 10px rgba(31,41,55,.06);
  --radius:    10px;
}

/* 跟随系统（默认） */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) { /* 浅色变量 */ }
}
```

### 1.2 间距 & 排版

| Token | 值 | 用途 |
|---|---|---|
| `--space-1` | 4px | 紧凑 |
| `--space-2` | 8px | 元素内距 |
| `--space-3` | 12px | 卡片内边距 |
| `--space-4` | 16px | 卡片间距 |
| `--space-5` | 24px | 区块间距 |
| `--space-6` | 32px | 页面边距 |

字体不变：`-apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif`

### 1.3 状态色分级（CPU / 内存 / 磁盘）

| 数值 | 颜色 | 用途 |
|---|---|---|
| 0-50% | `--green` | 健康 |
| 50-75% | `--accent` | 正常 |
| 75-90% | `--yellow` | 注意 |
| 90-100% | `--red` | 告警 |

通过 `hsl(from var(--green) calc(h + 30) s l)` 自动派生过渡色（CSS 4，Chrome 111+），老浏览器回退到硬编码。

---

## 二、P0：立即可见效果（1-2 小时，~80 行 JS）

### 2.1 流量 / 速率自动单位换算

**新增** `app.js` helpers：

```js
// 字节数 → 自适应单位（B/KB/MB/GB/TB）
function formatBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

// 字节/秒 → 自适应速率（区别于累计流量：加 /s）
function formatRate(n) {
  if (n == null || isNaN(n)) return '—';
  return formatBytes(n) + '/s';
}

// 百分比 → 状态色 class
function pctClass(p) {
  if (p == null) return 'muted';
  if (p < 50) return 'ok';
  if (p < 75) return 'accent';
  if (p < 90) return 'warn';
  return 'danger';
}
```

**改用位置**：
- `app.js` 节点卡片渲染：所有 `m.net_rx_month` / `m.net_tx_month` 用 `formatBytes`
- 所有 `m.net_rx_rate` / `m.net_tx_rate` 用 `formatRate`
- 所有 `m.cpu` / `m.mem_pct` / `m.disk_pct` 进度条加 `pctClass`

### 2.2 一键复制安装命令 + Toast 反馈

**新增** `index.html`（已有"新建客户端"弹窗）按钮：

```html
<button class="btn ghost sm" data-copy="dockerCmd">📋 复制 Docker</button>
<button class="btn ghost sm" data-copy="nativeCmd">📋 复制 原生</button>
<button class="btn ghost sm" data-copy="windowsCmd">📋 复制 Windows</button>
```

**新增** `app.js`（~30 行）：

```js
async function copyCmd(type) {
  const cmd = $(type === 'dockerCmd' ? 'dockerCmd' :
                type === 'nativeCmd' ? 'nativeCmd' : 'windowsCmd').textContent;
  try {
    await navigator.clipboard.writeText(cmd);
    toast('已复制到剪贴板', 'ok');
  } catch (e) {
    // 降级：选中文本
    const r = document.createRange();
    r.selectNodeContents($(type));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    toast('已选中，按 Ctrl+C 复制', 'warn');
  }
}

// Toast（统一消息提示）
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2400);
}
```

### 2.3 Toast 组件（`index.html` 末尾）

```html
<div id="toast" class="toast" hidden></div>
```

CSS：

```css
.toast {
  position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
  background: var(--card); border: 1px solid var(--border); color: var(--text);
  padding: 10px 18px; border-radius: var(--radius); box-shadow: var(--shadow);
  font-size: 13px; z-index: 1000; opacity: 0; transition: opacity .2s;
}
.toast:not([hidden]) { opacity: 1; }
.toast.ok    { border-color: var(--green); }
.toast.warn  { border-color: var(--yellow); }
.toast.danger{ border-color: var(--red); }
```

### 2.4 验收

- [ ] 节点卡片显示 "12.34 GB" 而非 "12884901888"
- [ ] 速率显示 "1.23 MB/s" 而非 "1289345"
- [ ] 点击"复制 Docker" → Toast "已复制到剪贴板"
- [ ] 复制失败时降级为"已选中"提示

---

## 三、P1：视觉重设计（半天，~200 行 CSS）

### 3.1 节点卡片网格布局

**现状**：`<section class="grid">` 应该是 CSS Grid，但效果像表格。
**改造**：明确的 3-4 列响应式卡片网格。

```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
  padding: var(--space-5);
}
.node-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: transform .15s, border-color .15s, background .15s;
}
.node-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  background: var(--card-hi);
}
```

### 3.2 节点卡片内部结构（重写 `renderGrid`）

```html
<div class="node-card" data-id="...">
  <header class="nc-head">
    <span class="nc-status online"></span>
    <h3 class="nc-name">vps-01.example.com</h3>
    <span class="nc-group">生产环境</span>
  </header>
  <div class="nc-bars">
    <div class="bar-row">
      <span class="bar-label">CPU</span>
      <div class="bar"><i data-pct="42"></i></div>
      <span class="bar-val">42%</span>
    </div>
    <div class="bar-row">
      <span class="bar-label">内存</span>
      <div class="bar"><i data-pct="68"></i></div>
      <span class="bar-val">68%</span>
    </div>
    <div class="bar-row">
      <span class="bar-label">磁盘</span>
      <div class="bar"><i data-pct="55"></i></div>
      <span class="bar-val">55%</span>
    </div>
  </div>
  <footer class="nc-foot">
    <span class="nc-metric">↑ 1.23 MB/s</span>
    <span class="nc-metric">↓ 4.56 MB/s</span>
    <span class="nc-metric">⏱ 12天 03时</span>
  </footer>
  <div class="nc-probes">
    <span class="probe ok">google.com 23ms</span>
    <span class="probe warn">github.com 156ms</span>
    <span class="probe danger">cf.com 320ms</span>
  </div>
</div>
```

### 3.3 进度条颜色分级

```css
.bar i { background: var(--green); transition: width .3s; }
.bar i.warn    { background: var(--yellow); }
.bar i.danger  { background: var(--red); }
```

`app.js` 在 `grid.querySelectorAll('.bar > i').forEach` 处加 class：

```js
grid.querySelectorAll('.bar > i').forEach(el => {
  const p = Number(el.dataset.pct || 0);
  el.style.width = p + '%';
  el.classList.remove('warn', 'danger');
  if (p >= 90) el.classList.add('danger');
  else if (p >= 75) el.classList.add('warn');
});
```

### 3.4 状态点（在线 / 离线 / 告警）

```css
.nc-status {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
  background: var(--muted);
}
.nc-status.online { background: var(--green); box-shadow: 0 0 0 3px rgba(77,213,145,.2); }
.nc-status.offline { background: var(--muted); }
.nc-status.alert { background: var(--red); box-shadow: 0 0 0 3px rgba(255,107,126,.2); }
```

### 3.5 概览区（顶部 5 卡片）

保持现有 5 列，但优化排版（数字加粗、单位用 muted 灰、间距统一）。

### 3.6 验收

- [ ] 桌面端 ≥ 1280px 显示 3-4 列卡片
- [ ] 768px - 1280px 显示 2 列
- [ ] < 768px 显示 1 列
- [ ] 鼠标悬停卡片有 2px 上浮 + 边框高亮
- [ ] CPU ≥ 90% 进度条变红，75-90% 变黄
- [ ] 离线节点状态点变灰
- [ ] 卡片内显示流量自适应单位

---

## 四、P2：节点详情页（半天，~150 行 JS + 50 行 HTML）

### 4.1 路由化（hash-based，不引第三方路由）

```js
function parseRoute() {
  const m = location.hash.match(/^#\/node\/([^/]+)(?:\?(.*))?/);
  if (m) return { type: 'node', id: m[1], query: new URLSearchParams(m[2] || '') };
  return { type: 'dashboard' };
}
```

主入口：

```js
window.addEventListener('hashchange', handleRoute);
function handleRoute() {
  const r = parseRoute();
  if (r.type === 'node') { showNodeDetail(r.id, r.query.get('range') || '24h'); }
  else { showDashboard(); }
}
```

### 4.2 节点详情页布局

**改造**：`#detailModal` → `#nodePage`（不再是 modal，是整页）

```
+------------------------------------------------------+
| ← 返回   vps-01.example.com · 生产环境    🟢 在线   |
+------------------------------------------------------+
| 实时数据                                              |
| +-------+ +-------+ +-------+ +-------+ +-------+    |
| | CPU   | | 内存  | | 磁盘  | | 网络  | | 温度  |    |
| | 42%   | | 68%   | | 55%   | |1.2MB/s| | 45°C  |    |
| +-------+ +-------+ +-------+ +-------+ +-------+    |
|                                                      |
| 时间范围:  [1h] [6h] [24h] [7d] [30d]               |
|                                                      |
| +--------------------------------------------------+ |
| | CPU 折线图                                        | |
| +--------------------------------------------------+ |
| +--------------------------------------------------+ |
| | 内存折线图                                        | |
| +--------------------------------------------------+ |
| +--------------------------------------------------+ |
| | 网络流量（rx / tx 双线）                          | |
| +--------------------------------------------------+ |
| +--------------------------------------------------+ |
| | 网络质量（多个目标的延迟热力）                    | |
| +--------------------------------------------------+ |
+------------------------------------------------------+
```

### 4.3 新增 30 天范围

`app.js` `loadDetail()` 加 `30d` 分支：

```js
const RANGE_SECS = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
```

服务端 `api.js` 已支持任意 `sinceTs`，无需改动。

### 4.4 URL 持久化

```js
// 点击节点卡片时
location.hash = `#/node/${id}?range=${detailRange}`;
// 用户直接访问 URL 也能进入
```

### 4.5 验收

- [ ] 点击节点卡片 → URL 变成 `#/node/vps-01`
- [ ] 浏览器后退 → 返回仪表盘
- [ ] 直接打开 `#/node/vps-01` → 显示该节点详情
- [ ] 时间范围切换 → URL query 更新
- [ ] 30 天范围可用

---

## 五、P3：主题切换（1 天，~100 行 CSS + 30 行 JS）

### 5.1 主题按钮（顶部 toolbar）

```html
<button class="btn ghost" id="btnTheme" title="切换主题">🌗</button>
```

### 5.2 切换逻辑

```js
const THEMES = ['auto', 'light', 'dark'];
function cycleTheme() {
  const cur = localStorage.getItem('theme') || 'auto';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  localStorage.setItem('theme', next);
  applyTheme(next);
}
function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
// 初始化
applyTheme(localStorage.getItem('theme') || 'auto');
```

### 5.3 自定义主题 JSON 导入

设置中心（已有）新增"主题代码"输入框，格式：

```json
{
  "name": "我的主题",
  "tokens": {
    "--bg": "#1a1d29",
    "--accent": "#5cb6a5"
  }
}
```

存储：复用 `settings.custom_css` 字段（用 JSON 包装）OR 新增 `settings.theme_json` 字段。
**推荐**新字段，避免与 CSS 字符串混入。

### 5.4 验收

- [ ] 点击 🌗 循环切换 自动 → 亮 → 暗
- [ ] 选择"自动"时跟随系统
- [ ] 刷新页面后主题保持
- [ ] 自定义主题 JSON 生效

---

## 六、P3：拖拽排序（半天，~80 行 JS）

### 6.1 引入原生 HTML5 Drag API（不引第三方库）

```js
function initDragSort(grid) {
  let dragEl = null;
  grid.querySelectorAll('.node-card').forEach(card => {
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      dragEl = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      const target = e.target.closest('.node-card');
      if (target && target !== dragEl) {
        grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        target.classList.add('drag-over');
      }
    });
    card.addEventListener('drop', e => {
      e.preventDefault();
      const target = e.target.closest('.node-card');
      if (target && target !== dragEl) {
        const rect = target.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        target.parentNode.insertBefore(dragEl, after ? target.nextSibling : target);
        persistSortOrder();
      }
    });
  });
}
```

### 6.2 持久化到 settings

```js
async function persistSortOrder() {
  const ids = [...grid.querySelectorAll('.node-card')].map(c => c.dataset.id);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ui: { custom_order: ids } }) });
}
```

**新字段**：`settings.ui.custom_order`（数组），`renderGrid` 优先按此顺序排序。

### 6.3 验收

- [ ] 拖拽节点卡片可改变顺序
- [ ] 拖拽中显示视觉反馈
- [ ] 顺序持久化到服务端
- [ ] 刷新后顺序保持

---

## 七、安全约束清单（**所有阶段必须遵守**）

| # | 约束 | 实现位置 | 验证 |
|---|------|---------|------|
| S1 | 任何用户输入必须用 `textContent` 或 `escapeHtml()` 渲染，**禁止 innerHTML** | `app.js` | grep 检查 |
| S2 | 自定义 CSS / 主题 JSON 必须在 `<style>` 标签内注入，**禁止内联到 style 属性** | `app.js` `applyCustomCss` | 保持现状 |
| S3 | 主题切换不引入新的 fetch URL / CDN / 第三方库 | `app.js` `style.css` | `grep 'http'` 检查 |
| S4 | CSP 头不得放宽（保持 `style-src 'self' 'unsafe-inline'` 因为已用 `applyCustomCss` 动态注入） | `server.js` | 不动 |
| S5 | 不引入 localStorage 存储 Token（Token 仅在 HMAC 签名 Cookie） | `app.js` | 主题偏好可存，其他敏感字段不存 |
| S6 | 详情页路由不绕过鉴权（仍走 `apiOrLogin` 检查） | `app.js` 路由切换时 | 单元测试 |
| S7 | 拖拽 API 不暴露内部 ID（仅用 `data-id`） | `app.js` | 保持 |
| S8 | 主题 JSON 解析失败时静默回退默认主题 | `app.js` `applyTheme` | try-catch |

---

## 八、不做的事（**明确边界**）

| 项 | 不做原因 |
|---|---|
| 远程命令执行 | Simple Probe 核心原则：无指令通道 |
| Web 终端 | 远程 shell = RCE 风险 |
| 进程列表 | 信息泄露 + 性能开销 |
| WebSocket 双向通道 | 单向上报 + 必要时 SSE |
| 多用户系统 | 2FA 解决单点风险 |
| GPU 监控 | Simple Probe 用户多为 VPS |
| 第三方 CSS 框架（Tailwind / Bootstrap） | 增加体积 + 供应链风险 |
| 第三方 JS 库（SortableJS / Vue） | 违反"零依赖"原则 |
| 任何需要服务端下发的"动态测速目标" | 违反"Agent 固定目标"安全模型 |

---

## 九、测试方案

### 9.1 单元测试（已有 `server/test/`）

新增 `server/test/ui_helpers.test.js`：

```js
const { formatBytes, formatRate, pctClass } = require('../src/ui_helpers');

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0.00 B');
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1024)).toBe('1.00 KB');
  expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
  expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
  expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
  expect(formatBytes(null)).toBe('—');
  expect(formatBytes(NaN)).toBe('—');
});

test('formatRate', () => {
  expect(formatRate(1024 * 100)).toBe('100.00 KB/s');
});

test('pctClass', () => {
  expect(pctClass(40)).toBe('ok');
  expect(pctClass(60)).toBe('accent');
  expect(pctClass(80)).toBe('warn');
  expect(pctClass(95)).toBe('danger');
  expect(pctClass(null)).toBe('muted');
});
```

把 `ui_helpers` 抽离为 `server/src/ui_helpers.js`，前后端共享（Node.js 用 require，浏览器用 `<script>` 直接挂到 window）。

**约束**：浏览器侧不能 require Node 模块，所以 `ui_helpers.js` 必须用 `module.exports = ...` + `if (typeof window !== 'undefined') window.UIH = ...` 模式。

### 9.2 端到端测试（手动 / Playwright）

| 场景 | 步骤 | 期望 |
|---|---|---|
| 流量单位换算 | 创建节点，上报大流量数据 | 卡片显示 GB / MB 自适应 |
| 复制安装命令 | 点击"复制 Docker" | Toast 出现"已复制"，剪贴板含完整命令 |
| 主题切换 | 点击 🌗 按钮 | 颜色变化，刷新后保持 |
| 详情页路由 | 点击节点 | URL 变 `#/node/xxx`；后退回仪表盘 |
| 拖拽排序 | 拖拽节点 | 顺序改变，刷新后保持 |
| Ping 颜色分级 | 模拟延迟 50/150/300ms | 绿/黄/红 |
| 自定义 CSS | 设置中心输入 CSS | 立即生效 |

### 9.3 浏览器兼容性

- Chrome 90+ ✅（CSS 变量 + hash 路由 + Drag API）
- Firefox 88+ ✅
- Safari 14+ ✅
- Edge 90+ ✅
- IE 11 ❌（已不在支持范围）

---

## 十、实施时间表

| 阶段 | 内容 | 行数（估） | 工时 | 风险 |
|------|------|----------|------|------|
| **P0** | 流量单位换算 + 复制 + Toast | 80 JS + 30 CSS | 1-2h | 低 |
| **P1** | 视觉重设计（卡片 / 颜色） | 200 CSS + 100 JS | 半天 | 低 |
| **P2** | 节点详情页（路由化） | 150 JS + 50 HTML | 半天 | 中 |
| **P3** | 主题切换 | 100 CSS + 30 JS | 半天 | 低 |
| **P3** | 拖拽排序 | 80 JS | 半天 | 低 |
| **测试** | 单元测试 + E2E | 50 test | 2h | 低 |
| **合计** | | ~870 行 | **3-4 天** | |

---

## 十一、文件改动清单

| 文件 | 改动类型 | 行数 |
|---|---|---|
| `server/public/index.html` | 重构（卡片 / 路由 / 主题按钮） | +80 / -30 |
| `server/public/style.css` | 大改（设计系统） | +400 / -50 |
| `server/public/app.js` | 中改（重写 renderGrid / 详情页 / 主题 / 拖拽） | +300 / -100 |
| `server/src/ui_helpers.js` | **新增** | ~60 |
| `server/test/ui_helpers.test.js` | **新增** | ~40 |
| `package.json` | 加 `ui_helpers` 到 main（不需要，因为是浏览器全局） | 0 |
| `server.js` | 不动 | 0 |
| `api.js` | 加 `custom_order` 字段透传（可选） | +5 |

---

## 十二、验收总览

完成所有阶段后：

| 维度 | 目标 |
|------|------|
| 视觉 | 追上 Komari 90% |
| 交互 | 卡片网格 / 一键复制 / Toast / 拖拽 |
| 主题 | 暗 / 亮 / 跟随系统 / 自定义 JSON |
| 详情页 | 路由化 + 30 天范围 |
| 安全 | **零妥协**（每条 S1-S8 都过） |
| 代码量 | +870 行（其中 250 行 CSS 变量、200 行重复模板） |
| 零依赖 | ✅（仅用浏览器原生 API） |
| 浏览器兼容 | Chrome 90+ / Firefox 88+ / Safari 14+ |

---

## 十三、决策点（请用户确认）

1. **P0 是否先做？** 这是立即可见效果，1-2 小时
2. **P2 路由化是否要做？** 还是继续用 modal？路由化是 Komari 的做法，体验更好
3. **P3 主题是否要做自定义 JSON 导入？** 这是给高玩用户的功能
4. **拖拽排序持久化到 settings 还是单独的 `ui_prefs` 表？** 我推荐前者（settings.ui.custom_order）
5. **是否需要支持移动端触屏拖拽？** 桌面端 drag API 在移动端不可用，需要 `touchstart/touchmove/touchend` 模拟（额外 ~50 行）

---

*方案完成。等待确认后开始 P0 实施。*
