# Simple Probe Agent

受控端（Agent），负责在被控机器上采集系统指标并**只出站**上报给服务端。
与 Windows Agent **完全相同的上报协议**，服务端无需任何改动。

---

## 两种部署形态

| 形态 | 适合场景 | 内存占用 | 资源节省 |
|------|---------|---------|---------|
| **Docker** | 已有 Docker / 多容器管理 / 追求环境隔离 | ~65–150 MB | — |
| **原生 systemd** | 256–512 MB 小鸡 / 追求最小资源 / 无 Docker | **~15–25 MB** | **省 ~125 MB** |

> 对 256 MB 小鸡来说，原生 systemd 比 Docker 形态节省约 **125 MB 可用内存**（Docker 守护进程本身占用 50–120 MB）。

---

## 原生 systemd 部署（推荐，零依赖）

> 目标机只需 Python 3（绝大多数 Linux 内置），无需 Docker。

### 一键安装

```bash
# 下载脚本（建议先审查）
curl -o install.sh https://raw.githubusercontent.com/fengzone85/simple-probe/main/agent/install.sh
cat install.sh

# 非交互安装（Ansible / 批量部署）
sudo bash install.sh \
    --server  http://your-server:8008 \
    --id      your-node-id \
    --token   your-agent-token \
    --interval 15

# 交互式安装
sudo bash install.sh
```

### systemd 管理

```bash
systemctl status   simple-probe-agent    # 查看状态
journalctl -u      simple-probe-agent -f # 实时日志
systemctl restart  simple-probe-agent    # 重启（更新配置后）
systemctl stop     simple-probe-agent    # 停止
systemctl disable  simple-probe-agent    # 开机禁用
```

### 完全卸载

```bash
sudo bash uninstall.sh
```

### ICMP 探测

- **有 `ping`**：优先 ICMP，精准测量 RTT
- **无 `ping`**（minimal 镜像）：自动回退到 TCP，**功能不受影响**
- 补装 ICMP：`apt-get install -y iputils-ping`（Debian/Ubuntu）

### 部署架构

```
/opt/simple-probe/                       ← 程序目录（agent.py / collector.py）
/var/lib/simple-probe/                  ← 状态目录（state.json，简单-probe 用户可写）
/etc/simple-probe/                      ← 配置目录（agent.env，root 专属）
/etc/systemd/system/simple-probe-agent.service  ← systemd unit
```

---

## Docker 部署

详见 [`docker-compose.yml`](./docker-compose.yml)。

```bash
# 环境变量（三个必填）
export SERVER_URL=https://your-monitor-server:8008
export AGENT_ID=your-node-id
export AGENT_TOKEN=your-agent-token

docker compose up -d
```

| 环境变量 | 说明 | 默认 |
|---------|------|------|
| `SERVER_URL` | 服务端地址（`https://`） | 必填 |
| `AGENT_ID` | 后台分配的节点 ID | 必填 |
| `AGENT_TOKEN` | 后台分配的认证令牌 | 必填 |
| `INTERVAL` | 上报间隔（秒，最小 5） | `15` |
| `DISK_PATH` | 统计的磁盘路径 | `/host`（容器内宿主机根） |
| `PROBE_TARGETS` | 网络质量自测目标，格式 `label:host[:port]`，逗号分隔；不填用默认三家运营商 DNS + 8.8.8.8，置空关闭 | 默认开启 |
| `STATE_FILE` | 月度流量累计状态文件 | `/data/state.json` |

---

## Windows 部署

详见 [`windows/README.md`](./windows/README.md)。

---

## 环境变量（共两套形态通用）

| 变量 | 说明 | 默认 | 备注 |
|------|------|------|------|
| `SERVER_URL` | 服务端地址（`https://`） | 必填 | 非 localhost 必须 https |
| `AGENT_ID` | 节点 ID | 必填 | 后台「添加 Agent」获得 |
| `AGENT_TOKEN` | 认证令牌 | 必填 | 后台「添加 Agent」获得 |
| `INTERVAL` | 上报间隔（秒） | `15` | 最小 5 |
| `DISK_PATH` | 磁盘统计路径 | `/`（原生）`/host`（Docker） | 只读，不写入 |
| `STATE_FILE` | 月度流量状态文件 | `/var/lib/simple-probe/state.json` | 程序自读写 |
| `PROBE_TARGETS` | 网络质量探测目标 | 默认三家运营商 DNS + 8.8.8.8 | 本地固定，服务端不可下发 |

## 指标说明

上报字段：`cpu` / `mem_used` / `mem_total` / `mem_pct` / `disk_used` / `disk_total` / `disk_pct` /
`net_rx_rate` / `net_tx_rate` / `net_rx_month` / `net_tx_month` /
`load1` / `load5` / `load15` / `temp` / `swap_used` / `swap_total` / `swap_pct` /
`uptime` / `os` / `hostname` / `probes`（网络质量）。

**不采集**：IP 地址、地理位置、MAC 地址、用户名、进程列表、SSH 密钥等任何指纹数据。

## 安全原则

- **零入站**：Agent 不开放任何端口，不接受任何远程指令
- **只读采集**：仅读 `/proc` 和 `statvfs`，无任何写操作
- **最小 Token**：静态 Bearer Token 出站 HTTPS 推送，泄露风险仅限本机物理访问
- **非 root 运行**：Docker 用 `monitor` 用户，原生用 `simple-probe` 系统用户
- **服务端不可下发配置**：网络探测目标固定在本地环境变量，服务端无命令注入面

## 网络与防火墙

Agent **只发起出站 HTTPS 请求**到 `SERVER_URL/api/report`，不在本机开放任何入站端口，防火墙无需放行。确保被控机能访问服务端的 443 端口即可。

---

## 完全卸载

| 形态 | 命令 |
|------|------|
| **原生 systemd** | `sudo bash uninstall.sh` |
| **Docker** | `docker compose down`（可选 `docker rmi` 清除镜像） |
| **Windows** | 任务计划程序中删除 `HostMonitorAgent-<AgentId>` 任务 |
