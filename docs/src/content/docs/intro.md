---
title: 简介
description: Simple Probe — 轻量、安全、自托管的服务器监控系统
---

import { Card, CardGrid } from '@astrojs/starlight/components';

# Simple Probe

**轻量、安全、自托管的服务器监控系统。**

Simple Probe 是一个纯状态监控方案，专注于「在线/负载/CPU/内存/硬盘/流量」等核心指标，
不带远程控制、不带指令通道，从架构层面消除 RCE 风险。

## 核心特性

<CardGrid stagger>
  <Card title="🔒 零指令通道" icon="seti:lock">
    受控端仅出站上报，服务端无法向 Agent 下发任何指令。从架构层面杜绝 RCE。
  </Card>
  <Card title="🪶 轻量低耗" icon="seti:rocket">
    原生 Linux 部署内存占用 12-25MB；Python 受控端仅 ~200 行，零外部依赖。
  </Card>
  <Card title="🛡️ 安全优先" icon="seti:shield">
    TOTP 2FA、CSP、HTTPS 白名单、恒定时间比较、RBAC 只读账号、Prometheus /metrics。
  </Card>
  <Card title="📊 实用仪表盘" icon="seti:graph">
    CPU/内存/磁盘/温度/Swap/网络质量/Ping 折线图，3 秒实时流量，Sparkline 趋势缩略。
  </Card>
  <Card title="🐳 双形态部署" icon="seti:docker">
    Docker 容器化或原生 systemd 部署，同一套代码零改动，用户按需选择。
  </Card>
  <Card title="🔌 告警通知" icon="seti:bell">
    QQ 邮箱 / Telegram 告警，离线检测、阈值触发、告警隔离与自动清理。
  </Card>
</CardGrid>

## 设计理念

1. **无指令通道** — Agent 不监听任何端口，服务端无下发能力
2. **Agent 零耦合** — Agent 之间互不通信，一个被攻破不影响其他
3. **数据最小化** — 采集仅限系统状态，不含进程列表/配置/密钥等可利用信息

## 适用于

- 🔐 安全偏执型运维 — 不接受任何远程控制能力
- 💾 小内存机器用户（256-512MB）— 资源占用极低
- 🕵️ 隐私优先者 — 数据完全自主，不经过第三方
- 📋 代码审计/合规需求 — 全量代码 < 800 行，可人工审计

## 不适用于

- 需要 Web 终端 / SSH 远程控制（推荐哪吒 / Komari）
- 需要 SSL 证书 / 网站监控（推荐哪吒）
- 需要花哨 UI / 零运维部署（推荐 cf-vps-monitor）

## 下一步

- [快速开始](/quick-start/) — 5 分钟部署
- [安全设计](/security/) — 了解威胁模型
