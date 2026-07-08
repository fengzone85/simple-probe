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
  -AgentToken your-agent-token-here
```

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
| `STATE_FILE` | 月流量累计状态文件 | 脚本目录 `state.json` |

## 网络与防火墙

Agent **只发起出站 HTTPS 请求**到 `SERVER_URL/api/report`，不在本机开放任何入站端口，
防火墙无需放行。若服务端在自建 VPS 上，请确保该 VPS 的 443 可达。
