---
title: 受控端部署
description: Agent 部署指南
---

# 受控端部署

Simple Probe 受控端支持两种部署形态，代码完全相同，仅部署方式不同。

## 形态对比

| | Docker | 原生 systemd |
|---|---|---|
| 内存占用 | 65-150MB | 12-25MB |
| 前置依赖 | Docker Engine | Python 3.6+ |
| 安全隔离 | 容器 + non-root + 只读挂载 | systemd 14 项加固 |
| 部署复杂度 | 一条命令 | 交互脚本 |
| 适用场景 | 已有 Docker 环境 | 精简系统 / 小内存 |

## Docker 部署

```bash
docker run -d \
  --name simple-probe-agent \
  --restart unless-stopped \
  -e AGENT_TOKEN="<Token>" \
  -e SERVER_URL="https://monitor.example.com" \
  -v /proc:/host/proc:ro \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  ghcr.io/fengzone85/simple-probe-agent:latest
```

## 原生 systemd 部署

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/main/agent/install.sh | bash
```

脚本会：
1. 检查 Python 3 环境
2. 创建 `/opt/simple-probe-agent/` 目录（权限 700）
3. 复制 `agent.py` + `collector.py`
4. 生成 `agent.env`（权限 600，含 Token 和 Server URL）
5. 注册 systemd 服务（14 项安全加固）
6. 启动并设置开机自启

### systemd 安全加固项

| 加固项 | 说明 |
|---|---|
| `NoNewPrivileges=yes` | 禁止提权 |
| `ProtectSystem=strict` | 文件系统只读 |
| `ProtectHome=yes` | 隔离 /home |
| `PrivateTmp=yes` | 隔离 /tmp |
| `ProtectKernelTunables=yes` | 隔离内核参数 |
| `ProtectKernelModules=yes` | 禁止加载内核模块 |
| `ProtectControlGroups=yes` | 隔离 cgroup |
| `RestrictNamespaces=yes` | 禁止创建命名空间 |
| `RestrictRealtime=yes` | 禁止实时调度 |
| `RestrictSUIDSGID=yes` | 禁止 setuid/sgid |
| `MemoryDenyWriteExecute=yes` | 禁止可写可执行内存 |
| `LockPersonality=yes` | 锁定进程特性 |
| `SystemCallArchitectures=native` | 限制系统调用架构 |
| `CapabilityBoundingSet=` | 清空所有 capabilities |

## 连接地址（SERVER_URL / Agent 专用连接地址）选型

Agent 只做**出站 HTTPS POST** 到 `/api/report`，没有长连接，因此 `SERVER_URL`（对应后台「站点信息 → Agent 专用连接地址」）有两种合法填法，按部署目标二选一。

### 方案 A：走盾（隐藏源站 IP）

把地址填成 Cloudflare **代理域名（橙云）**，流量经过 CF WAF：

```bash
SERVER_URL=https://monitor.example.com          # 走 443
# 或源站监听 8443 且已在 CF 开启代理：
SERVER_URL=https://monitor.example.com:8443
```

- CF 仅代理固定端口，HTTPS 为 `443 / 2053 / 2083 / 2087 / 2096 / 8443`。**其余端口（含 4443）CF 不代理**，连域名:4443 会直接失败，并非"绕过盾"。
- CF 的 SSL 模式需设为 **Full** 或 **Full (strict)**。
- 优点：源站 IP 始终被 CF 隐藏；缺点：受 WAF 规则与免费版限流影响，严格规则可能误杀 `/api/report`。

### 方案 B：直连（不套盾，最稳）

让 Agent **直连源站**，绕过 CF：

```bash
SERVER_URL=https://agent.example.com:4443       # 灰云(DNS-only)子域名 + 自有证书
# 或源站公网 IP（需自有证书，公网 CA 一般不为裸 IP 签发）：
SERVER_URL=https://1.2.3.4:4443
```

- 该 DNS 记录必须设为**灰云（仅 DNS，不代理）**，或用源站公网 IP，否则仍会经过 CF。
- Agent 强制 HTTPS，直连地址必须持有有效证书（建议用灰云子域名签 Let's Encrypt，而非裸 IP）。
- 优点：无中间层、最稳定、不怕 WAF 误杀；缺点：源站 IP 对该地址可见（但仅写在 `agent.env` / 安装脚本里，访客看不到）。

### 与后台「站点信息」的关系

后台「设置 → 站点信息」有两项，互不冲突：

- **项目网址**：填套盾的公网域名（如 `https://monitor.example.com`），供前台/后台互跳，访客只接触这个地址。
- **Agent 专用连接地址**：填方案 A 或 B 的地址，仅 Agent 上报与安装脚本使用，不对外暴露。

### 选型建议

| 你的目标 | 推荐方案 | SERVER_URL 示例 |
|---|---|---|
| 彻底隐藏源站 IP | A 走盾 | `https://monitor.example.com` |
| 追求稳定 / 怕 WAF 误杀 | B 直连 | `https://agent.example.com:4443` |

## 采集指标

| 指标 | Linux 来源 | Windows 来源 |
|---|---|---|
| CPU 使用率 | `/proc/stat` | psutil |
| 内存使用率 | `/proc/meminfo` | psutil |
| 磁盘使用率 | `os.statvfs` | psutil |
| 系统负载 | `/proc/loadavg` | — |
| 网络流量 | `/proc/net/dev` | psutil |
| 温度 | `/sys/class/thermal/` | psutil |
| Swap | `/proc/meminfo` | psutil |
| 开机时长 | `/proc/uptime` | psutil |
| 网络质量 | ICMP/TCP ping | ICMP/TCP ping |

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/main/agent/uninstall.sh | bash
```

完全幂等，可重复执行。
