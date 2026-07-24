---
title: 原生 Linux 部署
description: 无 Docker 的原生 systemd 部署方式
---

# 原生 Linux 部署

适用于无 Docker 环境、精简系统、小内存 VPS（256-512MB）。

## 资源对比

| 部署形态 | 内存基线 | 前置依赖 | 镜像大小 |
|---|---|---|---|
| Docker 容器 | 65-150MB | Docker Engine (~120MB) | ~80MB |
| **原生 systemd** | **12-25MB** | **Python 3.6+** | **~50KB** |
| 差值 | **~125MB** | — | — |

> 同一套代码（`agent.py` + `collector.py`），零改动，全在部署层。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/main/agent/install.sh | bash
```

支持交互模式和非交互模式：

```bash
# 非交互模式
curl -fsSL ... | bash -s -- --token "YOUR_TOKEN" --url "https://monitor.example.com"
```

## 文件布局

```
/opt/simple-probe-agent/     (700 root:root)
├── agent.py
├── collector.py
└── agent.env                (600 root:root)
    ├── AGENT_TOKEN=xxx
    └── SERVER_URL=https://...
```

## systemd 服务

```ini
[Unit]
Description=DiTing Lite Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/simple-probe-agent
EnvironmentFile=/opt/simple-probe-agent/agent.env
ExecStart=/usr/bin/python3 agent.py
Restart=always
RestartSec=30

# 14 项安全加固
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
MemoryDenyWriteExecute=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

## 管理命令

```bash
# 查看状态
systemctl status simple-probe-agent

# 查看日志
journalctl -u simple-probe-agent -f

# 重启
systemctl restart simple-probe-agent

# 停止
systemctl stop simple-probe-agent

# 卸载（幂等）
curl -fsSL .../uninstall.sh | bash
```

## 与 Docker 形态共存

两种形态可以混用：
- 资源充裕的机器用 Docker（隔离性更好）
- 256MB 小鸡用原生（省内存）
- 所有形态上报的数据格式完全一致

切换形态：卸载当前形态 → 安装另一种形态 → 同一 Token 即可恢复历史数据。
