# 第三方主题皮肤（Theme / Skin）

simple-probe 的**公开状态页（首页 `/`）**支持可插拔的第三方皮肤。一个皮肤就是一个独立的前端工程，通过免登录的 `/api/public/*` 接口拉取数据，渲染成任意样式。

## 目录约定

把皮肤放在 `public/themes/<id>/` 下，至少包含：

```
public/themes/<id>/
├── index.html        # 皮肤入口（必填）
├── manifest.json     # 皮肤元信息（必填，见下）
└── ...               # 任意 js / css / 图片等自有资源
```

`manifest.json` 字段：

| 字段         | 说明                                   |
| ------------ | -------------------------------------- |
| `id`         | 与目录名一致                           |
| `name`       | 展示名（后台下拉框显示）               |
| `author`     | 作者                                   |
| `description`| 简介                                   |

## 启用方式

1. 在后台「设置 → 皮肤模板」选择该皮肤并保存；
2. 此后访客访问首页 `/` 即看到该皮肤（由服务端按 `ui_settings.public_theme` 投放）；
3. 选择 `built-in` 可恢复内置默认状态页。

## 资源引用规则（重要）

皮肤通过 `/` 被投放，但文件实体在 `/themes/<id>/` 下，因此：

- **自有资源必须用绝对路径**引用，例如 `/themes/<id>/app.js`、`/themes/<id>/style.css`；
- 可复用根目录共享资源：`/flags.js`（国旗）、`/style.css`（基础样式）；
- 所有资源受同源 CSP 限制，必须同源（即本服务器）。

## 数据接口（免登录，受 `public_enabled` 开关控制）

| 接口                    | 返回                                   |
| ----------------------- | -------------------------------------- |
| `GET /api/public/meta`  | 站点标题、是否开放、默认布局           |
| `GET /api/public/overview` | 总数 / 在线 / 离线 / 分组概览       |
| `GET /api/public/agents`| 脱敏客户端列表（名称、分组、国家、CPU、内存、硬盘、本月流量、在线时长等）|

> 若 `public_enabled = false`，上述接口返回 `403`，皮肤应展示「暂未开放」之类提示。

## Komari 兼容 API（可选，供 Komari 社区皮肤复用）

后端已实现一套 **Komari 兼容 API 层（PoC）**：把本机数据映射成 Komari 主题所期望的 `{status,message,data}` 结构与同构字段，并兼容 Komari 主题的实时通道。同样受 `public_enabled` 开关控制（关闭时返回 `403` / 空快照）。

| 接口                          | 对应 Komari 行为                                    |
| ----------------------------- | --------------------------------------------------- |
| `GET /api/public`             | 站点公开属性（sitename / description / theme 等）    |
| `GET /api/version`            | 版本信息                                            |
| `GET /api/nodes`              | 节点基础信息列表（uuid / name / group / region 等） |
| `GET /api/recent/:uuid`       | 该节点最近实时指标（嵌套结构：`cpu.usage` / `ram.total` / `network.up` …）|
| `WebSocket /api/clients`      | 发送 `get` 返回 `{data:{online:[...], data:{uuid:{...}}}}` 实时快照（需 `ws` 包，缺失时自动降级为上面三个 REST 接口轮询）|

> 接入 Komari 社区皮肤时，只需将其前端请求层的 base URL 指向本服务、资源路径改为 `/themes/<id>/...`，即可复用。自带适配示例见 `komari-demo/`。

## 参考实现

- `demo/`：最小可运行皮肤（极简列表），基于 `/api/public/*`，可直接复制改造。
- `komari-demo/`：适配版 Komari 皮肤示例，基于上面的 Komari 兼容 API，证明 Komari 社区皮肤可在本项目运行。

## 关于复用 Komari 社区皮肤

Komari 皮肤原本面向 **Komari 自有后端 API**（JSON-RPC2 / WebSocket，数据模型不同）开发。本项目已通过**兼容层**抹平差异：

1. **兼容层（已实现，推荐先试）**：后端把本机数据映射成 Komari 格式并暴露 `/api/public`、`/api/nodes`、`/api/recent/:uuid`、`WebSocket /api/clients`，Komari 社区皮肤的前端请求层只需改 base URL 与资源路径（`/themes/<id>/...`）即可直接挂载。示例见 `komari-demo/`。
2. **适配路线**：若你只想用本项目原生契约，也可基于 `/api/public/*` 改写皮肤请求层（结构更轻、长期可控）。
