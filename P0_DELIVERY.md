# P0 交付说明

**日期**：2026-07-09
**范围**：`server/public/app.js` + `server/public/style.css`
**目标**：流量单位自动换算 + 进度条阈值色 + Toast 类型化 + 网络质量色块

---

## 改动摘要

### 1. `app.js` — JS 层

| 行 | 改动 |
|---|---|
| L83-87 | `toast(msg, type)` 新增 `type` 参数，支持 `'ok'|'err'|'warn'`，CSS class 动态设置 |
| L96 | 原有 `fmtBytes` 保持（已支持 B/KB/MB/GB/TB/PB 6档自动换算） |
| L97-106 | **新增** `pctClass(p)` → `''\|'bar-warn'\|'bar-danger'`（阈值 75%/90%） |
| L108-113 | **新增** `probeClass(ms)` → `'probe-ok'\|'probe-warn'\|'probe-bad'\|'probe-na'`（阈值 100ms/300ms） |
| L225-226 | 进度条渲染加阈值 class：`el.className = 'bar-i ' + cls` |
| L263 | 流量标签改用 `fmtRate()`：`↓ ${fmtRate(rx)} · ↑ ${fmtRate(tx)}` |
| L266 | 网络质量从纯文字改渲染为带色块的 `<span class="probe probe-xxx">` |
| 全部 toast 调用 | 按成功/失败/警告补了第二个参数 |

### 2. `style.css` — 样式层

| 行 | 改动 |
|---|---|
| L76-78 | `.bar > i` → `.bar-i`，新增 `.bar-i.bar-warn`（黄）/`.bar-i.bar-danger`（红） |
| L115-117 | Toast 类型色：`toast-ok`（绿）/`toast-err`（红）/`toast-warn`（黄），`z-index` 升到 1000 |
| L122-132 | **新增** `.probes` 弹性布局 + 四种 probe 色块 |

---

## 效果对照

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 流量 1234567890 bytes/s | `1206 KB/s`（只到 KB） | `↓ 1.18 MB/s · ↑ 1.18 MB/s` |
| CPU 92% | 渐变蓝绿条 | 渐变红条 |
| CPU 78% | 渐变蓝绿条 | 渐变黄条 |
| Ping 23ms | 纯文字 `google.com 23ms` | 绿色小药丸 `google.com 23ms` |
| Ping 156ms | 纯文字 `github.com 156ms` | 黄色小药丸 |
| Ping 320ms | 纯文字 `cf.com 320ms` | 红色小药丸 |
| 复制成功 | 白色边框 Toast | 绿色边框 Toast |
| 创建成功 | 白色边框 Toast | 绿色边框 Toast |
| 创建失败 | 白色边框 Toast | 红色边框 Toast |

---

## 行为变更说明

- **向后兼容**：`toast(msg)` 不传 type 仍然工作（显示默认色）
- **进度条**：已有 CSS 渐变的卡片刷新后颜色不变，新阈值从下次 `renderGrid` 刷新时生效
- **probe 色块**：仅在 `cardHtml` 渲染时计算，ECharts 详情页的 probe 折线图不受影响（折线图本身用颜色区分）

---

## 未涵盖的 P0 项（留到 P1）

- [ ] 仪表盘节点卡片整体布局重设计（卡片内部结构不变，只换了色块）
- [ ] 移动端触屏拖拽排序

---

# P1 交付说明

**日期**：2026-07-09
**范围**：server/public/app.js + server/public/style.css
**目标**：卡片内部重设计（Komari 风格小清新布局）

---

## 布局变更

### 卡片结构（改前 vs 改后）

| 区域 | 改前 | 改后 |
|---|---|---|
| **.top** | 状态点 + 名称 + 徽章 | 同，但标题加粗 overflow: ellipsis |
| **.meta** | hostname · OS · **在线 X天** | hostname · OS（在线时长移到底部） |
| **.metrics** | 2列 × 7格，sparkline 在 label **下方** | 3列，sparkline 在 label **左侧**，更紧凑 |
| **网络** | 单独一行 probe 药丸 | 合并到网络格，流量 + probe 并排 |
| **磁盘** | 单独一格（label + bar） | **独立一行**，bar 撑满宽 |
| **.foot** | 只剩编辑按钮 | 在线时长 + 编辑按钮 |
| **整卡** | 无边框分隔 | 顶部有分隔线，分区清晰 |

### 新增 CSS 类

| 类 | 作用 |
|---|---|
| .m-spark | sparkline 容器（左侧固定宽度） |
| .m-info | 标签+数值容器（右侧弹性） |
| .m-lbl | 小标签（10px uppercase） |
| .m-val | 大数值（14px 加粗，支持 bar-warn/danger 色） |
| .metric-wide | 网络格跨 3 列 |
| .disk-row | 磁盘独立行 |
| .uptime | 底部在线时长 |
| .status.alert | CPU/内存/磁盘 ≥90% 时的红色脉冲状态点 |

### 告警态联动

cardHtml 顶部判断：
`js
const alert = (m.cpu >= 90 || m.mem_pct >= 90 || (m.disk_pct != null && m.disk_pct >= 90));
const statusCls = a.online ? (alert ? 'alert' : 'on') : '';
`
任一资源 ≥90%，状态点从绿色变红色脉冲，无需打开详情页就能感知。

### 响应式

- 桌面：3列网格，卡片最小宽度 270px（↓330px）
- 移动端（≤640px）：单列，3列变2列，网络格跨2列

### 视觉对照

`
改前：                        改后：
┌─────────────────────┐     ┌────────────────────────────┐
│ ●名称  [商家] [剩7天]│     │ ●名称  [商家] [剩7天]       │
│ hostname · Linux    │     ├────────────────────────────┤
│ CPU        23.4%    │     │ [~~sparkline~~]  CPU  23%  │
│ ━━━━━━             │     │ [~~sparkline~~]  内存 61%  │
│ 内存        61.2%    │     │ [~~sparkline~~]  负载 0.42│
│ ━━━━━━             │     ├────────────────────────────┤
│ 网络 Google  ✓  ...  │     │  网络  ↓1.18MB/s ↑0.82MB/s│
│ ━━━━━━━━━━━━━━━━   │     │       [Google ✓23ms] [GH ✕]│
│ [硬盘] [━━━━━━━━━━] │     ├────────────────────────────┤
│        45% 120G/256G│     │ 硬盘 ▓▓▓▓▓▓░░░░ 45% 120G/256G│
│ [编辑]              │     ├────────────────────────────┤
└─────────────────────┘     │ ⏱ 12天3时      [编辑]      │
                           └────────────────────────────┘
`

### 行为变更

- **无破坏性**：所有指标数值不变，只改了排列方式和视觉
- **进度条**：CPU/内存/Swap/磁盘任一 ≥90%，数值变红，状态点变脉冲红
- **响应式**：移动端卡片自动切换单列

---

## 未涵盖的 P1 项（留到 P2）

- [ ] 节点详情页路由化（hash 路由，#/node/:id，卡片点击可跳转）
- [ ] 节点卡片点击打开侧边详情面板（替代 modal）

---

# P2 交付说明

**日期**：2026-07-09
**范围**：server/public/app.js + server/public/style.css + server/public/index.html
**目标**：详情页从 Modal 改为 Hash 路由滑入面板

---

## 改动摘要

### 架构变化

| | 改前 | 改后 |
|---|---|---|
| **打开详情** | openModal('detailModal') 居中遮罩弹窗 | 卡片点击 → location.hash = #/node/:id |
| **关闭详情** | closeModal() | history.back() / 返回按钮 / 点击遮罩 |
| **URL** | 无状态 | /#/node/42 可分享、可收藏 |
| **仪表盘** | 弹窗期间不可交互 | 面板滑入时仪表盘仍可见（半透明遮罩） |
| **刷新页面** | 弹窗消失 | **保持当前节点详情**（hash 路由） |

### 新增 JS 函数

| 函数 | 作用 |
|---|---|
| initRouter() | 初始化 hashchange 监听 + bootstrap |
| onHashChange() | 解析 /#/node/:id，分发 open/close |
| 
avigateDetail(id) | 设置 hash 并触发路由 |
| closeDetailPanel() | 关闭面板、停止轮询、清除 liveTimer |
| openDetailPanel(id) | 打开面板（防重复打开）、加载数据、启动轮询 |

### CSS

- .detail-overlay：半透明遮罩，opacity 0→1 过渡，点外部关闭
- .detail-panel：480px 固定右侧，translateX(100%)→0 滑入
- .dp-header：固定顶部，含返回按钮 + 节点名称
- .dp-body：可滚动内容区，复用 .charts/.live-traffic 原有类

### 行为细节

- **防重复打开**：同一节点点两次不重复初始化 ECharts
- **关闭路径**：返回按钮 / overlay 点击 / 浏览器后退 / Esc（浏览器原生）
- **10s 刷新**：检查 .detailPanel.open 而非 .detailModal.show
- **无害残桩**：[data-close="detailModal"] 分支保留（元素已移除，永不触发）

---

## 未涵盖的 P2 项（留到 P3）

- [ ] 节点切换器（面板顶部左右箭头，快速浏览多节点）
- [ ] 面板内直接操作（编辑、重置 Token、删除），无需返回仪表盘

---

# P3 交付说明

**日期**：2026-07-09
**范围**：pp.js + style.css + index.html
**目标**：节点切换器 + 面板内编辑/重置/删除

---

## P3.1 节点切换器

| 交互 | 行为 |
|---|---|
| 面板头部左右箭头 | 切到上一个 / 下一个节点 |
| 边界状态 | 首个节点：← 隐藏；末节点：→ 隐藏 |
| 当前位置 | 3 / 12 显示在箭头之间 |
| 浏览器前进/后退 | ✅ 同样触发节点切换 |

**实现细节**：
- orderedAgentIds 全局数组，panel 打开时从 currentAgents 快照
- updateNavButtons(id) 根据当前索引控制箭头可见性
- switchTo(id) = 
avigateDetail(id)，复用已有 hash 路由

---

## P3.2 面板内编辑操作

面板底部新增操作栏（含三条按钮）：

| 按钮 | 行为 |
|---|---|
| ✏️ **编辑信息** | 打开编辑弹窗，填入当前节点数据 |
| 🔑 **重置 Token** | 同上，自动触发「重置 Token」按钮 |
| 🗑️ **删除节点** | 同上，自动触发「删除」按钮并确认 |

**提交后行为**：

| 操作 | 面板 | 仪表盘 |
|---|---|---|
| 保存编辑 | ✅ 刷新面板数据（不关面板） | ✅ 刷新卡片 |
| 重置 Token | ✅ 刷新面板（保留面板） | ✅ 刷新卡片 |
| 删除节点 | ✅ 自动关闭（history.back()） | ✅ 刷新卡片 |

**实现要点**：
- panelReset：先 openEdit(detailId) 填表单，再 $('btnResetToken').click() 触发确认
- panelDelete：50ms 延迟等待 modal 渲染，再触发 $('btnDelete').click()
- submitEdit 增加 loadDetail() 调用，保留面板同时更新内容

---

## 未涵盖的 P3 项（可选后续）

- [ ] 键盘 ← → 全局快捷切换节点（需 modal 外也能响应）
- [ ] 节点搜索/过滤器内置到面板顶部
- [ ] 历史告警列表直接在面板内展开（无需跳到仪表盘过滤）
