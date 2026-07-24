---
title: Windows 部署
description: Windows 受控端部署
---

# Windows 部署

Simple Probe 受控端支持 Windows，使用 psutil 采集系统指标。

## 前置条件

- Windows 10 / Server 2016 及以上
- Python 3.6+（[下载](https://www.python.org/downloads/)）

## 安装

以管理员身份运行 PowerShell：

```powershell
cd C:\
git clone https://github.com/fengzone85/diting.git
cd simple-probe\agent\windows
.\install.ps1
```

按提示输入：
- Server URL（如 `https://monitor.example.com`）
- Agent Token

## 采集支持

Windows 版受控端通过 psutil 采集：

| 指标 | 支持 |
|---|---|
| CPU 使用率 | ✅ |
| 内存使用率 | ✅ |
| 磁盘使用率 | ✅ |
| 网络流量 | ✅ |
| 温度 | ✅（如硬件支持） |
| Swap | ✅ |
| 开机时长 | ✅ |
| 系统负载 | ❌（Windows 无此概念） |
| 网络质量 | ✅ ICMP/TCP |

## 服务管理

安装后注册为 Windows 服务，随系统自启。

```powershell
# 查看状态
Get-Service SimpleProbeAgent

# 启动/停止
Start-Service SimpleProbeAgent
Stop-Service SimpleProbeAgent

# 查看日志
Get-EventLog -LogName Application -Source SimpleProbeAgent -Newest 50
```

## 卸载

以管理员身份运行：

```powershell
cd C:\simple-probe\agent\windows
.\uninstall.ps1
```
