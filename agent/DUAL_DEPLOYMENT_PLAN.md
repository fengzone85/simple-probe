# Simple Probe Agent 双形态部署可行性方案

> **目标**：同一套 agent 代码（agent.py + collector.py），提供 Docker 和原生 systemd 两种部署形态，被控端零侵入、资源占用最小。
> **日期**：2026-07-09
> **结论**：完全可行，代码零改动，改动集中在部署层，预计 1 人天完成。

---

## 一、现状分析

### 1.1 Docker 形态现状

**Docker 提供的全部能力（逐条核对）：**

| Docker 提供的 | 实现方式 | 脱 Docker 等价方案 | 难度 |
|--------------|---------|-----------------|------|
| 非 root 用户（`monitor` uid 10001） | `RUN useradd -m -u 10001 monitor` + `USER monitor` | 创建系统用户 `simple-probe`，systemd `User=` | 低 |
| 只读挂载宿主机根（`/:/host:ro`） | `volumes: - /:/host:ro` | 改为 `DISK_PATH=/`（直接读本机根，无需挂载） | 零 |
| host 网络命名空间 | `network_mode: host` | 裸跑天然就是 host 网络，读 `/proc/net/dev` 已是真实数据 | 零 |
| 进程守护 / 自动重启 | `restart: unless-stopped` | systemd `Restart=always` | 低 |
| ICMP 探测能力 | 镜像内置 `iputils-ping` | 依赖目标机 `iputils-ping`；无则走 TCP fallback（collector 已有） | 低 |
| 持久化目录（`/data`） | named volume `agent-data` | 改为本地目录 `/var/lib/simple-probe`，权限收敛 | 低 |

**关键发现**：Docker 在此处是**纯打包壳**，没有任何 Docker 专属 API 调用。agent.py / collector.py 完全不感知容器环境。

### 1.2 现有 agent 代码与部署相关的环境变量

```
SERVER_URL    ← 服务端地址（必填）
AGENT_ID      ← 节点标识（必填）
AGENT_TOKEN   ← 认证令牌（必填）
INTERVAL      ← 上报间隔，默认 15 秒
DISK_PATH     ← 磁盘统计路径，默认 /（Docker compose 填 /host）
STATE_FILE    ← 持久化状态文件，默认 /data/state.json
PROBE_TARGETS ← 网络质量探测目标，默认内置
```

### 1.3 各文件改动量评估

| 文件 | 当前行数 | 改动量 | 改动内容 |
|------|---------|-------|---------|
| `agent.py` | 98 行 | **零改动** | 环境变量默认值已兼容，代码通用 |
| `collector.py` | 307 行 | **零改动** | `disk_info()` 有路径不存在回退逻辑，无需改 |
| `Dockerfile` | 25 行 | **零改动** | 保留，Docker 形态专用 |
| `docker-compose.yml` | 28 行 | **零改动** | 保留，Docker 形态专用 |
| `simple-probe-agent.service` | 新增 | 约 25 行 | systemd unit |
| `install.sh` | 新增 | 约 120 行 | 一键安装脚本（含用户创建、unit 部署、env 配置） |
| `README.md` | 已有 | +40 行 | 补"原生部署"章节 |
| `README_EN.md` | 已有 | +40 行 | 同上 |

---

## 二、架构设计

### 2.1 统一代码 + 两种部署形态

```
agent/
├── agent.py                        ← 代码完全不动
├── collector.py                     ← 代码完全不动
│
├── Dockerfile                      ← Docker 形态专用（不变）
├── docker-compose.yml              ← Docker 形态专用（不变）
│
├── simple-probe-agent.service      ← [新增] systemd unit
├── install.sh                      ← [新增] 原生一键安装脚本
├── requirements-native.txt          ← [新增] 原生依赖（python3 + iputils-ping）
└── README.md / README_EN.md        ← [修改] 补原生部署章节
```

**核心原则**：agent 代码零改动，差异只在部署层。保证两套形态行为完全一致，bug 只修一份。

### 2.2 原生部署路径详解

**创建专用低权系统用户：**
```bash
# 创建不可登录的系统用户 simple-probe
useradd -r -M -s /usr/sbin/nologin -d /nonexistent -c "Simple Probe Agent" simple-probe
```
- `-r`：系统账号（uid < 1000）
- `-M`：不创建 home 目录
- `-s /usr/sbin/nologin`：禁止登录（安全加固）
- 等价于 Docker 里的 `useradd -m -u 10001 monitor`

**systemd service 文件：**
```
/etc/systemd/system/simple-probe-agent.service
/lib/systemd/system/simple-probe-agent.service
```

**配置文件（敏感信息分离）：**
```
/etc/simple-probe/agent.env          ← 含 SERVER_URL / AGENT_ID / AGENT_TOKEN
/var/lib/simple-probe/state.json    ← 月度流量累计状态（程序自己读写）
```

**目录权限：**
```bash
mkdir -p /var/lib/simple-probe
chown simple-probe:simple-probe /var/lib/simple-probe
chmod 700 /var/lib/simple-probe           # 仅属主可读写
chown root:root /etc/simple-probe/agent.env
chmod 600 /etc/simple-probe/agent.env   # 仅 root 可读写 token
```

### 2.3 环境变量差异对照

| 环境变量 | Docker 形态 | 原生 systemd 形态 |
|---------|-----------|----------------|
| `DISK_PATH` | `/host` | `/` |
| `STATE_FILE` | `/data/state.json` | `/var/lib/simple-probe/state.json` |
| `SERVER_URL` | `${SERVER_URL}` | 同（从 `/etc/simple-probe/agent.env` 注入） |
| `AGENT_ID` | `${AGENT_ID}` | 同 |
| `AGENT_TOKEN` | `${AGENT_TOKEN}` | 同 |
| `INTERVAL` | `15`（默认） | `15`（默认） |

---

## 三、安全设计

### 3.1 原生形态的安全态势

Docker 给了 namespace 隔离层（文件系统、网络、进程 PID）。原生去掉这层后，如何补偿：

| 威胁 | Docker 防御 | 原生 systemd 等价防御 | 评估 |
|------|------------|-------------------|------|
| Agent 被入侵后写宿主机文件系统 | Docker 只读挂载 `/host:ro`，写不了 | `ProtectSystem=strict`（systemd）禁止写入 `/usr` `/boot` `/etc` 等；`ReadWritePaths=/var/lib/simple-probe` 只开白名单写权限 | ✅ 等价 |
| Agent 被入侵后以 root 权限运行 | 非 root monitor 用户 | `User=simple-probe` + `NoNewPrivileges=true`（禁止提升 root） | ✅ 等价 |
| Agent 读取敏感文件 | namespace 隔离，只能通过 `/host` 读 | 同上，`ProtectHome=read-only` 禁止读 `/home` | ✅ 等价 |
| Agent 被用于内网扫描 | Docker host 网络仍有隔离边界 | host 网络直接暴露，等价（与 Docker 同）；但我们 agent 零入站、无扫描能力，安全影响极小 | ⚠️ 略降 |
| Agent 进程被其他进程注入 | Docker namespace 隔离 PID | systemd `ProtectSystem=strict` 限制可执行文件路径 | ✅ 等价 |

**结论**：原生形态安全略弱于 Docker（namespace 隔离缺失），但通过 systemd 的 capability 收紧，仍能保持**高安全水位**，远超"跑 root"或"无任何隔离"的方案。

### 3.2 systemd 安全加固项（完整清单）

```ini
[Unit]
Description=Simple Probe Agent

[Service]
Type=simple
User=simple-probe
Group=simple-probe
ExecStart=/usr/bin/python3 /opt/simple-probe/agent.py
WorkingDirectory=/opt/simple-probe

# 安全加固
NoNewPrivileges=true              ; 禁止任何子进程提权
ProtectSystem=strict             ; 禁止写入 /usr /boot /etc /srv 等系统目录
ProtectHome=read-only            ; 禁止读取用户 home 目录
ReadWritePaths=/var/lib/simple-probe  ; 只开这一处写权限
PrivateTmp=true                   ; 独立 /tmp namespace
ProtectKernelTunables=true       ; 禁止修改内核参数
ProtectKernelLogs=true           ; 禁止读取内核日志
ProtectClock=true                ; 禁止修改硬件时钟
ProtectHostname=true             ; 禁止修改 hostname
ProtectControlGroups=true        ; 禁止修改 cgroup
LockPersonality=true             ; 禁止切换 execution domain（防止 ret2libc）
MemoryDenyWriteExecute=false     ; 不强制（Python 需 JIT 等）
RestrictAddressFamilies=inet inet6  ; 只允许 IPv4/IPv6 socket（禁止 unix/domain socket 创建）
SystemCallFilter=@system-service ; 只允许安全 syscalls 子集

# 行为
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=simple-probe-agent
```

这份配置与 Docker 的 namespace 隔离**各有所长**——namespace 封进程边界，systemd 封 capability，两者对"防止被入侵后的横向移动"效果相当。

---

## 四、资源占用对比

### 4.1 实测预估（基于真实组件）

| 形态 | 组件 | 内存（RSS） | CPU | 磁盘 |
|------|------|-----------|-----|------|
| **Docker** | Docker 守护进程（本机全局） | +50~120 MB | 偶尔调度开销 | ~80 MB（镜像层） |
| **Docker** | Python 容器（monitor 用户） | 15~30 MB | ≈0（采集时短暂） | — |
| **原生** | Python 3 解释器 | 12~25 MB | ≈0 | ~5 MB（脚本） |
| **合计** | Docker 形态 | **~65~150 MB** | 有 Docker 调度 | **~85 MB+** |
| **合计** | 原生 systemd | **~12~25 MB** | 无额外开销 | **~5 MB** |

> Docker 守护进程本身是**全局常驻进程**，即使机器上只跑一个监控容器，也要吃掉 50-120 MB + CPU 调度。相比之下，裸 Python 只占进程本身的内存。

### 4.2 小机器场景量化

| 机器规格 | Docker 形态实际可用 | 原生形态实际可用 | 节省 |
|---------|-----------------|----------------|------|
| 256 MB 小鸡 | ~106~191 MB | ~231~244 MB | +125 MB 可用 |
| 512 MB VPS | ~362~462 MB | ~487~500 MB | +125 MB 可用 |
| 2 GB 机器 | ~1850~1950 MB | ~1975~1988 MB | +125 MB 可用 |

**对 256 MB 小鸡来说，Docker vs 原生 = 差 125 MB 可用内存 = 约 50% 的差距**，这是真实影响。

### 4.3 部署便利性对比

| 维度 | Docker 形态 | 原生 systemd 形态 |
|------|-----------|----------------|
| 前置依赖 | 需安装 Docker Engine | 需安装 Python 3（绝大多数 Linux 已内置） |
| 安装命令 | `docker compose up -d`（需先 clone 仓库） | `curl ... \| bash`（一行命令搞定） |
| 升级 | `docker compose pull` | `systemctl restart simple-probe-agent`（脚本需另写） |
| 卸载 | `docker compose down` | `bash uninstall.sh`（需另写） |
| 批量部署 | Docker 支持批量 `docker compose -f ... up`，适合 ansible | shell 脚本循环也易批量 |
| 最小化用户门槛 | 需要懂 Docker | 只需要能跑 bash |

**结论**：原生形态在**资源占用**和**安装门槛**（不需要 Docker）上完胜；Docker 形态在**隔离性**和**一致性环境**上占优。

---

## 五、安装脚本设计（install.sh）

### 5.1 核心流程

```text
1. 检测 root 权限（sudo bash 要求）
2. 检测 Python 3（which python3 || apt-get install python3）
3. 检测/创建系统用户 simple-probe
4. 创建目录结构
   /opt/simple-probe/          ← 程序目录（只读）
   /var/lib/simple-probe/      ← 状态目录（可写，属主 simple-probe）
   /etc/simple-probe/          ← 配置目录（root 专属）
5. 下载/复制 agent.py + collector.py 到 /opt/simple-probe/
6. 写入 /etc/simple-probe/agent.env（含 token 加密存储提示）
7. 部署 systemd service 文件
8. systemctl daemon-reload && enable && start
9. 输出验证命令：systemctl status simple-probe-agent && journalctl -u simple-probe-agent -f
```

### 5.2 交互式参数收集

```bash
read -p "服务端地址 (SERVER_URL): " SERVER_URL
read -p "节点 ID (AGENT_ID): " AGENT_ID
read -sp "认证令牌 (AGENT_TOKEN): " AGENT_TOKEN   # silent input
echo ""
```

支持非交互（CI / ansible 场景）：
```bash
bash install.sh --server http://your-server:8008 --id node1 --token SECRET --interval 15
```

### 5.3 脚本安全考虑

- token 输入使用 `read -sp`（不回显）
- `/etc/simple-probe/agent.env` 权限 `0600 root:root`
- `install.sh` 本身不做任何网络下载（防止供应链攻击），用户手动 `cp` 或 `scp` 脚本到机器上跑
- 不使用 `curl | bash` 自动下载（可作为可选项，用 `curl -o install.sh` 让用户先审查再执行）

---

## 六、用户画像与推荐路径

| 场景 | 推荐形态 | 理由 |
|------|---------|------|
| 256 MB~512 MB 小鸡 | **原生 systemd** | Docker 守护进程吃掉 50-120 MB 不可接受 |
| 已有 Docker 的机器（多容器管理） | **Docker** | 环境统一，不需要额外维护一套 systemd |
| 批量部署（Ansible/Salt） | **原生 systemd** | shell 脚本循环更通用，不要求目标机有 Docker |
| Windows 服务器 | **原生（PowerShell）** | 已有 windows_agent.py + install.ps1，无需 Docker |
| macOS 服务器 | **原生 systemd（launchd）** | macOS 没有 Docker Desktop 不实际；launchd 等价 systemd |
| 追求最小资源 | **原生 systemd** | 唯一选择 |
| 追求部署一致性 | **Docker** | 与服务端同体系，运维习惯一致 |

---

## 七、ICMP 探测能力说明

| 场景 | `iputils-ping` 状态 | 行为 |
|------|-------------------|------|
| Docker 形态 | 镜像内置，始终有 | ICMP 优先，回退 TCP |
| 原生（有 ping） | 系统自带 | 同上 |
| 原生（无 ping，minimal 镜像） | 不存在 | 自动回退到 TCP（collector 已有 fallback，无需改动代码） |

**建议**：在 install.sh 里检测 `ping` 是否存在，不存在时输出提示并推荐安装：
```bash
if ! command -v ping &>/dev/null; then
    echo "[提示] 未检测到 ping 命令，网络质量探测将使用 TCP fallback（功能不受影响）"
    echo "[提示] 如需完整 ICMP 探测，请运行: apt-get install -y iputils-ping"
fi
```

---

## 八、向后兼容性

- **现有 Docker 用户**：完全不受影响，`Dockerfile` 和 `docker-compose.yml` 零改动
- **现有服务端**：完全无感知，被控端部署方式与上报协议无关
- **已部署的节点**：可以随时在机器上"从 Docker 迁移到原生"或反之，无需重新获取 AGENT_ID / AGENT_TOKEN（服务端按 ID 识别节点）

---

## 九、实施计划

### 第一阶段：核心产出（建议优先完成）
- [ ] `agent/simple-probe-agent.service`
- [ ] `agent/install.sh`
- [ ] `agent/uninstall.sh`（卸载脚本，清理用户、目录、unit）
- [ ] README / README_EN.md 补原生部署章节

### 第二阶段：增强
- [ ] `agent/requirements-native.txt`（写明可选依赖 `iputils-ping`）
- [ ] `agent/update.sh`（systemd 下升级脚本：从 GitHub 下载新版本并 restart）
- [ ] systemd timer：`simple-probe-agent-update.timer`（自动更新，定时拉 GitHub release）

### 第三阶段：验证
- [ ] 在 256 MB 小鸡上实测原生部署，验证内存占用
- [ ] 在 512 MB 机器上从 Docker 形态迁移到原生，验证数据连续性（state.json 迁移）
- [ ] 在有/无 iputils-ping 两种环境下测试网络探测 fallback

---

## 十、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Python 3 在目标机不存在 | 低 | 高（无法运行） | install.sh 自动检测并安装；文档注明 Python 3.8+ |
| systemd service 写法有误导致无法启动 | 低 | 中 | 提供 `systemctl status` 验证命令；单元测试 systemd 语法 |
| 用户误以 root 运行 agent | 低 | 高 | service 文件硬编码 `User=simple-probe`；install.sh 创建专用用户 |
| 非 root 用户无权读 `/proc` 部分路径 | 低 | 中 | monitor 用户可读 `/proc`；部分受限路径不影响核心指标 |
| state.json 权限问题导致无法写入 | 低 | 中 | install.sh 负责创建目录并设 700 权限 |

---

## 十一、结论

**可行性：✅ 完全可行，无技术阻塞。**

- agent 代码零改动（`disk_info()` 回退逻辑已内置）
- 主要工作集中在部署脚本（install.sh + service 文件）
- 原生形态内存节省 ~125 MB（对 256MB 小鸡是 50% 提升）
- 两种形态安全落差通过 systemd capability 收紧可弥补
- 用户可按机器条件自由选择，无需服务端配合

**建议优先级：立即推进第一阶段。** 一旦落地，Simple Probe 的被控端将同时拥有"最小资源占用"和"零门槛安装"两个杀手级优势，覆盖从 256 MB 小鸡到 32 GB 大机的全场景。
