#Requires -Version 5.1
<#
.SYNOPSIS
    Windows Monitor Agent 安装脚本：安装依赖，可选注册为开机启动的计划任务。
.DESCRIPTION
    1) 检查 Python 3.9+
    2) pip install -r requirements.txt
    3) (可选 -RegisterTask) 注册登录即启动的计划任务，使 agent 后台常驻
.PARAMETER ServerUrl   监控服务端地址，如 https://monitor.example.com
.PARAMETER AgentId     在后台「添加 Agent」获得的 ID
.PARAMETER AgentToken  在后台「添加 Agent」获得的 Token
.PARAMETER DiskPath    统计的磁盘盘符，默认 C:\
.PARAMETER Interval    上报间隔（秒），默认 15
.PARAMETER ProbeTargets 网络质量自测目标（可选）。格式 label:host[:port]，逗号分隔；不填则用默认三家运营商 DNS + 8.8.8.8，置空则关闭。目标写在本地，服务端不可下发。
.PARAMETER RegisterTask 开关；指定则创建开机启动任务
.PARAMETER Repo        agent 载荷（windows_agent.py 等）的 raw 仓库基址；经一键命令单独下载 install.ps1 时用于自举拉取配套文件
.EXAMPLE
    .\install.ps1 -RegisterTask -ServerUrl https://monitor.example.com -AgentId win-pc-01 -AgentToken xxxx
#>
param(
    [string]$ServerUrl,
    [string]$AgentId,
    [string]$AgentToken,
    [string]$DiskPath = 'C:\',
    [int]$Interval = 15,
    [string]$ProbeTargets = '',
    [switch]$RegisterTask,
    [string]$Repo = 'https://raw.githubusercontent.com/fengzone85/simple-probe/master/agent/windows'
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# 0) 自举：一键命令只单独下载了 install.ps1，同目录没有 agent 载荷。
#    此时把配套文件下载到持久安装目录（%ProgramData%\simple-probe-agent），
#    后续依赖安装 / 计划任务全部指向该目录（避免指向 TEMP 被清理）。
$InstallDir = $ScriptDir
if (-not (Test-Path (Join-Path $ScriptDir 'windows_agent.py'))) {
    $InstallDir = Join-Path $env:ProgramData 'simple-probe-agent'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Host "同目录未找到 windows_agent.py，正从 $Repo 下载配套文件到 $InstallDir ..."
    foreach ($f in 'windows_agent.py', 'win_collector.py', 'requirements.txt') {
        try {
            Invoke-WebRequest "$Repo/$f" -OutFile (Join-Path $InstallDir $f) -UseBasicParsing
        } catch {
            Write-Error "下载 $f 失败：$($_.Exception.Message)"
            exit 1
        }
    }
    Write-Host '配套文件下载完成。'
}

# 1) 检查 Python
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Write-Error '未找到 python。请先安装 Python 3.9+ 并勾选「Add to PATH」。'
    exit 1
}
$ver = & python -c "import sys; print('%d.%d' % sys.version_info[:2])"
Write-Host "检测到 Python $ver"

# 2) 安装依赖
Write-Host '正在安装依赖 (psutil) ...'
& python -m pip install --upgrade pip | Out-Null
& python -m pip install -r (Join-Path $InstallDir requirements.txt)
Write-Host '依赖安装完成。'

# 3) 注册计划任务（开机自启、崩溃自动重启）
if ($RegisterTask) {
    if (-not $ServerUrl -or -not $AgentId -or -not $AgentToken) {
        Write-Error '注册计划任务需提供 -ServerUrl -AgentId -AgentToken'
        exit 1
    }
    $bat = Join-Path $InstallDir 'run_scheduled.bat'
    $probeLine = if ($ProbeTargets) { "set PROBE_TARGETS=$ProbeTargets" } else { "" }
    @"
@echo off
set SERVER_URL=$ServerUrl
set AGENT_ID=$AgentId
set AGENT_TOKEN=$AgentToken
set DISK_PATH=$DiskPath
set INTERVAL=$Interval
$probeLine
python "$InstallDir\windows_agent.py"
"@ | Out-File -FilePath $bat -Encoding ascii

    $action = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) -Hidden
    $taskName = "HostMonitorAgent-$AgentId"
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
    Write-Host "已注册开机启动任务：$taskName （可在「任务计划程序」中管理）"
}

Write-Host ''
Write-Host '安装完成。'
Write-Host "  - 安装目录：$InstallDir"
Write-Host "  - 临时运行：python `"$InstallDir\windows_agent.py`""
if (-not $RegisterTask) {
    Write-Host '  - 注册为服务：powershell -ExecutionPolicy Bypass -File install.ps1 -RegisterTask -ServerUrl <url> -AgentId <id> -AgentToken <token>'
}
# 立即启动 Agent（后台运行，隐藏窗口）
Write-Host '正在启动 Agent ...'
Start-Process -WindowStyle Hidden -FilePath "$InstallDir\run_scheduled.bat"
