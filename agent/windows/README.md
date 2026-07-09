# Windows 受控端（Agent）

在 Windows 机器上采集 CPU / 内存 / 磁盘 / 网络流量，并**只出站**回传到你的监控服务端
（与 Linux Docker Agent **完全相同的协议**，服务端无需任何改动）。

> 设计沿用主项目安全原则：受控端零入站、无远程执行接口、全程 `HTTPS + Token` 鉴权。

## 指标说明

上报字段与 Linux Agent 一致（`cpu` / `mem_*` / `disk_*` / `net_*` / `uptime` / `os` / `hostname`）。
唯一差异：**Windows 没有 load average 概念**，`load1` / `load5` / `load15` 固定上报 `0.0`（占位），
仪表盘上该项显示为 0，属正常现象。

## 前置条件

- Python 3.9+（安装时勾选 **Add Python to PATH**）
- 服务端已部署，且本机可访问其 HTTPS 地址
- 在监控后台「添加 Agent」获得 `AGENT_ID` 与 `AGENT_TOKEN`

## 安装依赖

```powershell
cd agent\windows
python -m pip install -r requirements.txt
```

（`psutil` 在 Windows 上有官方预编译 wheel，无需编译。）

## 运行

### 方式 A：直接运行（调试/临时）

编辑 `run.bat`，填入三个变量后双击运行：

```bat
set SERVER_URL=https://your-monitor-server.example.com
set AGENT_ID=win-pc-01
set AGENT_TOKEN=your-agent-token-here
```

或用环境变量直接启动：

```powershell
$env:SERVER_URL='https://...'; $env:AGENT_ID='win-pc-01'; $env:AGENT_TOKEN='...'
python windows_agent.py
```

### 方式 B：注册为开机自启（推荐生产）

以**管理员 PowerShell** 运行 `install.ps1`，自动安装依赖并注册「登录即启动、崩溃自动重启」的计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 `
  -RegisterTask `
  -ServerUrl https://your-monitor-server.example.com `
  -AgentId win-pc-01 `
  -AgentToken your-agent-token-here `
  -ProbeTargets "移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8"
```

> `-ProbeTargets` 可选：自定义网络质量自测目标（格式 `label:host[:port]`，逗号分隔）。不传则用默认三家运营商 DNS + 8.8.8.8；传空字符串 `""` 则关闭探测。目标写在本地，服务端不可下发。

注册后在「任务计划程序」中可查看/管理任务 `HostMonitorAgent-<AgentId>`。
（脚本会额外生成 `run_scheduled.bat` 用于承载环境变量，请勿删除。）

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `SERVER_URL` | 服务端地址（含 `https://`） | 必填 |
| `AGENT_ID` | 后台分配的 Agent ID | 必填 |
| `AGENT_TOKEN` | 后台分配的 Agent Token | 必填 |
| `DISK_PATH` | 统计的磁盘盘符 | `C:\` |
| `INTERVAL` | 上报间隔（秒，最小 5） | `15` |
| `PROBE_TARGETS` | 网络质量自测目标，格式 `label:host[:port]`，逗号分隔；不填用默认三家运营商 DNS + 8.8.8.8，置空关闭。目标写在本地，服务端不可下发 | 默认开启 |
| `STATE_FILE` | 月流量累计状态文件 | 脚本目录 `state.json` |

## 网络与防火墙

Agent **只发起出站 HTTPS 请求**到 `SERVER_URL/api/report`，不在本机开放任何入站端口，
防火墙无需放行。若服务端在自建 VPS 上，请确保该 VPS 的 443 可达。

---

## 原生 Linux 部署（systemd）

> 如果你的 Linux 机器上没有 Docker，或者追求**最小资源占用**（~15–25 MB 内存，无 Docker 守护进程开销），
> 可以直接用 systemd 形态部署。

### 适合场景

| 场景 | 推荐 | 理由 |
|------|------|------|
| 256 MB ~ 512 MB 小鸡 | **原生 systemd** | Docker 守护进程本身占用 50–120 MB，原生无此开销 |
| 已有 Docker 的机器（多容器管理） | **Docker** | 环境统一，与服务端体系一致 |
| 批量部署（Ansible / 脚本） | **原生 systemd** | shell 脚本循环更通用，不要求目标机有 Docker |
| 追求最小资源 | **原生 systemd** | 唯一选择 |

### 资源占用对比

| 形态 | 内存占用 | 额外磁盘 |
|------|---------|---------|
| **Docker** | ~65–150 MB（含 Docker 守护进程） | ~85 MB+（镜像层） |
| **原生 systemd** | **~15–25 MB**（纯 Python） | **~5 MB**（脚本） |

对 256 MB 小鸡来说，原生形态比 Docker 形态**节省约 125 MB 可用内存**。

### 一键安装（非交互）

下载脚本到机器，审查后再执行：

```bash
# 1. 下载（不改名，保留 .sh 方便后续卸载）
curl -o install.sh https://raw.githubusercontent.com/fengzone85/simple-probe/master/agent/install.sh

# 2. 审查脚本（强烈建议）
cat install.sh

# 3. 以 root 运行，支持非交互参数
sudo bash install.sh \
    --server  http://your-server:8008 \
    --id      your-node-id \
    --token   your-agent-token \
    --interval 15
```

> **Token 传递安全建议**：`--token` 会明文出现在 `ps aux` 与 shell 历史中，建议批量部署改用
> `--token-file <文件>`（`echo 'TOKEN' > /root/agent-token.txt` 后传 `--token-file /root/agent-token.txt`），
> 或通过环境变量 `SIMPP_TOKEN=TOKEN sudo bash install.sh --server ... --id ...` 传入。
> 三者优先级：`--token` > `--token-file` > `SIMPP_TOKEN`。

> **安全提示**：`install.sh` 本身不做任何网络下载，只读取本地同目录下的 `agent.py` / `collector.py` 文件。
> 建议将仓库克隆到机器后运行，而非 `curl | bash` 自动下载。
> 目标机需 Python 3.8+，安装脚本会自动探测并校验版本。

### 一键安装（交互式）

```bash
sudo bash install.sh
# 依次输入：SERVER_URL、AGENT_ID、AGENT_TOKEN（输入不回显）
```

### systemd 管理命令

```bash
# 查看状态
systemctl status simple-probe-agent

# 查看实时日志
journalctl -u simple-probe-agent -f

# 重启（如更新配置后）
systemctl restart simple-probe-agent

# 停止
systemctl stop simple-probe-agent

# 开机禁用
systemctl disable simple-probe-agent
```

### 环境变量说明

原生部署通过 `/etc/simple-probe/agent.env` 注入环境变量，无需手动 export：

| 变量 | 说明 | 原生默认值 |
|------|------|-----------|
| `DISK_PATH` | 磁盘统计路径 | `/`（原生直接读本机根） |
| `STATE_FILE` | 月度流量状态文件 | `/var/lib/simple-probe/state.json` |
| `SERVER_URL` | 服务端地址 | 来自 agent.env |
| `AGENT_ID` | 节点 ID | 来自 agent.env |
| `AGENT_TOKEN` | 认证令牌 | 来自 agent.env |
| `INTERVAL` | 上报间隔（秒） | `15` |

### ICMP 探测说明

- **有 ping**：优先使用 ICMP 探测网络质量
- **无 ping**（minimal 镜像）：自动回退到 TCP 探测，**功能不受影响**
- 如需完整 ICMP 能力：
  ```bash
  # Debian/Ubuntu
  apt-get install -y iputils-ping
  # Alpine
  apk add --no-cache iputils
  ```

### 完全卸载

```bash
sudo bash uninstall.sh
```

### 部署架构

```
/opt/simple-probe/          ← 程序目录（agent.py / collector.py）
/var/lib/simple-probe/      ← 状态目录（state.json，simple-probe 用户可写）
/etc/simple-probe/          ← 配置目录（agent.env，root 专属）
/etc/systemd/system/simple-probe-agent.service  ← systemd unit
```

### 与 Docker 形态的关系

- **共用同一套代码**：`agent.py` 和 `collector.py` 两份部署形态完全共享，零差异
- **行为完全一致**：两种形态的上报协议相同，服务端无需任何改动
- **可随时迁移**：Docker → 原生 或 原生 → Docker，只需重新 `install.sh`，无需重新获取 AGENT_ID / AGENT_TOKEN（服务端按 ID 识别节点）
- **state.json 兼容**：两种形态共用同一路径语义，迁移后月度流量累计不丢失
