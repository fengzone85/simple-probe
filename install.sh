#!/usr/bin/env bash
# =============================================================================
# Simple Probe — 一键部署脚本
#   借鉴 Nezha / Komari / Pulse 的「单文件下载 + 交互菜单 + 统一管理」范式
# =============================================================================
# 一条命令下载并运行（建议先下载审阅，再 sudo 执行）：
#   # 最小化镜像可能未预装 curl，先安装（仅 Debian/Ubuntu 等 apt 系统需要）
#   apt-get update && apt-get install -y curl
#   # 下载安装脚本（默认分支 master）
#   curl -fsSL https://raw.githubusercontent.com/fengzone85/simple-probe/master/install.sh -o install.sh
#   chmod +x install.sh
#   sudo ./install.sh
#
# 也可作为管理脚本重复运行（查看状态 / 卸载 / 更新）。
#
# 安全说明：
#   - 本脚本只下载本项目自有文件（agent 载荷）或 git clone 本项目源码，
#     不执行任何第三方二进制；仍建议下载后先 `cat install.sh` 审查。
#   - 受控端注册使用服务端 SETUP_TOKEN，仅用于创建客户端记录，不建立任何
#     指令通道（agent 注册后依旧只上报指标）。
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/fengzone85/simple-probe/master}"
REPO_GIT="${REPO_GIT:-https://github.com/fengzone85/simple-probe.git}"
SRC_DIR="/opt/simple-probe-src"

# ── 非交互参数（供 CI / 批量部署）─────────────────────────────────────────────
ACTION=""
A_SERVER=""; A_ID=""; A_TOKEN=""; A_TOKEN_FILE=""; A_SETUP=""; A_SETUP_NAME=""; A_INTERVAL=""

show_usage() {
    cat <<EOF
Simple Probe 一键部署脚本

用法（交互）：
  sudo bash install.sh                 # 显示菜单，逐项选择

用法（非交互 / 一键）：
  # 安装服务端（Docker，自动生成强随机令牌）
  sudo bash install.sh --install-server

  # 安装受控端（需先在服务端后台「新建客户端」拿到 ID/Token）
  sudo bash install.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

  # 安装受控端（一键自助注册：只需服务端地址 + SETUP_TOKEN）
  sudo bash install.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>

  # 更新本安装脚本（覆盖为 GitHub 最新版）
  sudo bash install.sh --update-script

  # 更新服务端（拉取最新源码并重建容器）
  sudo bash install.sh --update-server

  # 更新受控端（保留已注册身份，拉取最新 agent 代码）
  sudo bash install.sh --update-agent

  # 查看状态 / 卸载
  sudo bash install.sh --status
  sudo bash install.sh --uninstall

选项：
  --install-server        安装服务端（Docker）
  --install-agent         安装受控端（systemd）
  --update-script         更新本安装脚本为最新版
  --update-server         更新服务端（git pull + 重建容器）
  --update-agent          更新受控端（systemd，保留原连接配置）
  --status                查看服务端/受控端状态
  --uninstall             卸载服务端与受控端
  --server URL            SERVER_URL
  --id / --token          节点 ID 与令牌（手动模式）
  --token-file FILE       从文件读取令牌（推荐，避免明文暴露）
  --setup-token SECRET    用服务端 SETUP_TOKEN 自助注册（免 --id/--token）
  --setup-name NAME       自助注册的节点显示名（可选）
  --interval SEC          上报间隔（秒，默认 15）
  --repo URL              自定义 raw 仓库地址（默认本项目 master 分支）
EOF
}

# ── OS / 架构自检 ──────────────────────────────────────────────────────────────
detect_os() {
    if [[ -r /etc/os-release ]]; then
        . /etc/os-release 2>/dev/null
        echo "${PRETTY_NAME:-${ID:-unknown}}"
    else
        echo "unknown"
    fi
}
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) echo "$(uname -m)" ;;
    esac
}

download() {
    local url="$1" out="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$out"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$out" "$url"
    else
        echo -e "${RED}[错误] 需要 curl 或 wget 才能下载文件${NC}" >&2
        return 1
    fi
}

# ── 受控端安装 ─────────────────────────────────────────────────────────────────
install_agent() {
    ensure_deps || exit 1
    local args=()
    [[ -n "$A_SERVER" ]]     && args+=(--server "$A_SERVER")
    [[ -n "$A_ID" ]]         && args+=(--id "$A_ID")
    [[ -n "$A_TOKEN" ]]      && args+=(--token "$A_TOKEN")
    [[ -n "$A_TOKEN_FILE" ]] && args+=(--token-file "$A_TOKEN_FILE")
    [[ -n "$A_SETUP" ]]      && args+=(--setup-token "$A_SETUP")
    [[ -n "$A_SETUP_NAME" ]] && args+=(--setup-name "$A_SETUP_NAME")
    [[ -n "$A_INTERVAL" ]]   && args+=(--interval "$A_INTERVAL")

    # 仓库内运行：直接复用本地 agent/install.sh（已充分测试）
    if [[ -f "$SCRIPT_DIR/agent/install.sh" ]]; then
        echo -e "${GREEN}[OK]   使用本地 agent/install.sh${NC}"
        bash "$SCRIPT_DIR/agent/install.sh" "${args[@]}"
        return
    fi

    # 单文件 curl 场景：下载 agent 载荷到临时目录后运行
    local tmp; tmp="$(mktemp -d)"
    echo -e "${YELLOW}[信息] 从 ${REPO_RAW}/agent 下载受控端载荷…${NC}"
    for f in install.sh uninstall.sh agent.py collector.py simple-probe-agent.service; do
        if ! download "$REPO_RAW/agent/$f" "$tmp/$f"; then
            echo -e "${RED}[错误] 下载 $f 失败${NC}" >&2
            rm -rf "$tmp"; exit 1
        fi
    done
    chmod +x "$tmp/install.sh"
    bash "$tmp/install.sh" "${args[@]}"
    rm -rf "$tmp"
}

# ── 基础工具保障（curl / git 等一键流程前置依赖）─────────────────────────────────
ensure_deps() {
    local missing=()
    for t in curl git; do
        command -v "$t" >/dev/null 2>&1 || missing+=("$t")
    done
    [[ ${#missing[@]} -eq 0 ]] && return 0
    echo -e "${YELLOW}[信息] 缺少基础工具 ${missing[*]}，尝试安装…${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y "${missing[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y install "${missing[@]}"
    elif command -v yum >/dev/null 2>&1; then
        yum -y install "${missing[@]}"
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache "${missing[@]}"
    else
        echo -e "${RED}[错误] 无法安装基础工具 ${missing[*]}，请手动安装后重试${NC}" >&2
        return 1
    fi
    for t in "${missing[@]}"; do
        command -v "$t" >/dev/null 2>&1 || { echo -e "${RED}[错误] ${t} 安装失败${NC}" >&2; return 1; }
    done
    return 0
}

# ── 启动并确认 Docker 守护进程真正就绪（含 containerd / socket activation 兜底）──
# 先确保容器运行时 containerd 健康：若 overlayfs snapshotter 的元数据目录缺失
# （如曾被手动清理后残留的 containerd 进程未重建），build 阶段会报
# “failed to open database file: .../io.containerd.snapshotter.v1.overlayfs/metadata.db”
start_docker_daemon() {
    local i
    # 拉起并等待 containerd 重建 snapshotter 元数据目录
    systemctl restart containerd 2>/dev/null || true
    for i in $(seq 1 8); do
        [ -d /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs ] && break
        sleep 1
    done
    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
    for i in $(seq 1 10); do
        docker info >/dev/null 2>&1 && return 0
        sleep 2
    done
    # 部分环境 docker.service 走 socket activation 会报
    # “no sockets found via socket activation”，禁用 socket 后直启 service 即可
    systemctl disable docker.socket 2>/dev/null || true
    systemctl stop docker.socket 2>/dev/null || true
    systemctl restart containerd 2>/dev/null || true
    systemctl restart docker 2>/dev/null || true
    for i in $(seq 1 10); do
        docker info >/dev/null 2>&1 && return 0
        sleep 2
    done
    return 1
}

# ── Docker 保障 ────────────────────────────────────────────────────────────────
ensure_docker() {
    # 客户端已装时，先尝试拉起守护进程，避免无谓重装
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
        start_docker_daemon && return 0
    fi
    # 官方安装脚本依赖 curl，确保基础工具就绪
    command -v curl >/dev/null 2>&1 || ensure_deps || true
    echo -e "${YELLOW}[信息] 未检测到可用的 Docker（含 compose/buildx），开始安装…${NC}"

    if command -v apt-get >/dev/null 2>&1; then
        # 部分基础镜像（如 Debian 13 trixie）会预装与 Docker 官方包冲突的
        # docker.io / docker-buildx / containerd / runc：必须先移除，否则
        # docker-buildx-plugin 因文件冲突无法安装，最终 compose build 会报
        # 「requires buildx 0.17.0 or later」。
        apt-get remove -y docker.io docker-buildx docker-compose containerd runc 2>/dev/null || true
        curl -fsSL https://get.docker.com | sh
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y install docker-ce docker-ce-cli docker-compose-plugin docker-buildx-plugin
    elif command -v yum >/dev/null 2>&1; then
        yum -y install docker-ce docker-ce-cli docker-compose-plugin docker-buildx-plugin
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache docker docker-cli-compose
    else
        echo -e "${YELLOW}[警告] 无法用包管理器安装 Docker，回退到官方安装脚本（第三方）${NC}"
        curl -fsSL https://get.docker.com | sh
    fi

    # 兜底：buildx 偶发未装上时显式补装（需先移除 Debian 自带的 docker-buildx）
    if ! docker buildx version >/dev/null 2>&1; then
        apt-get remove -y docker-buildx 2>/dev/null || true
        ( command -v apt-get >/dev/null 2>&1 && apt-get install -y docker-buildx-plugin ) \
          || ( command -v dnf     >/dev/null 2>&1 && dnf -y install docker-buildx-plugin ) \
          || ( command -v yum     >/dev/null 2>&1 && yum -y install docker-buildx-plugin ) \
          || true
    fi

    start_docker_daemon || true

    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        return 0
    fi
    echo -e "${RED}[错误] Docker 安装失败或守护进程无法启动，请手动排查后重试${NC}" >&2
    return 1
}

# ── 服务端安装 ─────────────────────────────────────────────────────────────────
install_server() {
    ensure_deps || exit 1
    ensure_docker || exit 1

    if ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}[信息] 未检测到 git，尝试安装…${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y git
        elif command -v dnf >/dev/null 2>&1; then
            dnf -y install git
        elif command -v yum >/dev/null 2>&1; then
            yum -y install git
        elif command -v apk >/dev/null 2>&1; then
            apk add --no-cache git
        fi
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${RED}[错误] 需要 git 才能拉取服务端源码（且无法自动安装）${NC}" >&2
        exit 1
    fi

    if [[ -d "$SRC_DIR/.git" ]]; then
        echo -e "${YELLOW}[信息] 更新已有源码…${NC}"
        git -C "$SRC_DIR" fetch origin master -q
        git -C "$SRC_DIR" reset --hard origin/master
        git -C "$SRC_DIR" branch -u origin/master master 2>/dev/null || true
    else
        echo -e "${YELLOW}[信息] 克隆服务端源码到 $SRC_DIR …${NC}"
        git clone --depth 1 "$REPO_GIT" "$SRC_DIR"
    fi

    cd "$SRC_DIR/server"

    if [[ ! -f .env ]]; then
        cp .env.example .env
        local admin sess setup
        admin="$(openssl rand -hex 32)"
        sess="$(openssl rand -hex 32)"
        setup="$(openssl rand -hex 16)"
        sed -i "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=${admin}#" .env
        sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${sess}#" .env
        sed -i "s#^SETUP_TOKEN=.*#SETUP_TOKEN=${setup}#" .env
        echo -e "${GREEN}[OK]   已生成随机 ADMIN_TOKEN / SESSION_SECRET / SETUP_TOKEN${NC}"
        echo -e "${YELLOW}[重要] SETUP_TOKEN = ${setup}${NC}"
        echo -e "${YELLOW}        受控端一键注册请用: --setup-token ${setup}${NC}"
        echo -e "${YELLOW}        ADMIN_TOKEN 已写入 .env，请妥善保存（仅显示此一次）${NC}"
    else
        echo -e "${GREEN}[OK]   已存在 .env，跳过生成${NC}"
    fi

    echo -e "${YELLOW}[信息] 构建并启动服务端（首次需编译 better-sqlite3，约 1-2 分钟）…${NC}"
    # 先清理本项目旧实例，避免重跑/升级时端口或容器冲突（如 8080 已被占用）
    docker compose down 2>/dev/null || true
    docker compose up -d --build

    echo ""
    echo -e "${GREEN}✅ 服务端已启动${NC}"
    echo -e "   仪表盘: http://localhost:8080  （当前为明文测试端口）"
    echo -e "   生产请将 Nginx + TLS 反代到 127.0.0.1:8080（见 README 部署章节）"
}

# ── 更新：本安装脚本自身 ──────────────────────────────────────────────────────
update_script() {
    ensure_deps || return 1
    echo -e "${YELLOW}[信息] 下载最新 install.sh…${NC}"
    local new; new="$(mktemp)"
    if ! download "$REPO_RAW/install.sh" "$new"; then
        echo -e "${RED}[错误] 下载 install.sh 失败${NC}" >&2; rm -f "$new"; return 1
    fi
    local target
    if [[ -f "$0" && -w "$(dirname "$0")" ]]; then
        target="$(realpath "$0")"
    else
        target="/usr/local/bin/simple-probe-install.sh"
    fi
    cp "$new" "$target"
    chmod +x "$target"
    rm -f "$new"
    echo -e "${GREEN}[OK]   已更新脚本: $target${NC}"
    echo -e "${YELLOW}[提示] 请使用更新后的脚本重新运行: sudo bash $target${NC}"
}

# ── 更新：服务端（拉取最新源码并重建容器）─────────────────────────────────────
update_server() {
    ensure_docker || return 1
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}[信息] 未检测到 git，尝试安装…${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y git
        elif command -v dnf >/dev/null 2>&1; then dnf -y install git
        elif command -v yum >/dev/null 2>&1; then yum -y install git
        elif command -v apk >/dev/null 2>&1; then apk add --no-cache git
        fi
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${RED}[错误] 需要 git 才能更新服务端${NC}" >&2; return 1
    fi
    if [[ ! -d "$SRC_DIR/server" ]]; then
        echo -e "${RED}[错误] 未检测到服务端安装（缺少 $SRC_DIR/server），请先「安装服务端」${NC}" >&2
        return 1
    fi

    if [[ -d "$SRC_DIR/.git" ]]; then
        echo -e "${YELLOW}[信息] 拉取最新源码并同步到 master（丢弃本地对源码的改动）…${NC}"
        git -C "$SRC_DIR" fetch origin master -q
        git -C "$SRC_DIR" reset --hard origin/master
        git -C "$SRC_DIR" branch -u origin/master master 2>/dev/null || true
    else
        # 早期手动拷贝部署（无 .git）：改造为 git 跟踪，便于后续一键更新；
        # .env 等未跟踪文件不会被覆盖。
        echo -e "${YELLOW}[信息] 当前为非 git 手动部署，改造为 git 跟踪以便更新…${NC}"
        git -C "$SRC_DIR" init -q
        git -C "$SRC_DIR" remote add origin "$REPO_GIT" 2>/dev/null \
          || git -C "$SRC_DIR" remote set-url origin "$REPO_GIT"
        git -C "$SRC_DIR" fetch origin master -q
        git -C "$SRC_DIR" checkout -B master -f origin/master
        git -C "$SRC_DIR" branch --set-upstream-to=origin/master master
    fi

    cd "$SRC_DIR/server"
    echo -e "${YELLOW}[信息] 重建并重启服务端…${NC}"
    docker compose up -d --build
    echo -e "${GREEN}[OK]   服务端已更新并重启${NC}"
}

# ── 更新：受控端（保留已注册身份，拉取最新 agent 代码）──────────────────────────
update_agent() {
    ensure_deps || return 1
    local envfile="/etc/simple-probe/agent.env"
    if [[ ! -f "$envfile" ]]; then
        echo -e "${RED}[错误] 未检测到受控端安装（缺少 $envfile），请先「安装受控端」${NC}" >&2
        return 1
    fi
    # 从已存 env 读取注册身份，用户无需重新输入令牌
    local SERVER_URL="" AGENT_ID="" AGENT_TOKEN="" INTERVAL=15 k v
    while IFS='=' read -r k v; do
        case "$k" in
            SERVER_URL)  SERVER_URL="$v" ;;
            AGENT_ID)    AGENT_ID="$v" ;;
            AGENT_TOKEN) AGENT_TOKEN="$v" ;;
            INTERVAL)    INTERVAL="$v" ;;
        esac
    done < "$envfile"
    if [[ -z "$SERVER_URL" || -z "$AGENT_ID" || -z "$AGENT_TOKEN" ]]; then
        echo -e "${RED}[错误] $envfile 缺少必要参数，请重新「安装受控端」${NC}" >&2
        return 1
    fi
    echo -e "${YELLOW}[信息] 更新受控端（保留已注册身份，拉取最新 agent 代码）…${NC}"
    echo -e "  服务端: ${GREEN}$SERVER_URL${NC}  节点: ${GREEN}$AGENT_ID${NC}"

    # 强制从 GitHub 拉取最新 agent 载荷（无论本脚本是否本地旧版），保证更新到最新
    local tmp; tmp="$(mktemp -d)"
    echo -e "${YELLOW}[信息] 从 ${REPO_RAW}/agent 下载最新受控端载荷…${NC}"
    for f in install.sh uninstall.sh agent.py collector.py simple-probe-agent.service; do
        if ! download "$REPO_RAW/agent/$f" "$tmp/$f"; then
            echo -e "${RED}[错误] 下载 $f 失败${NC}" >&2
            rm -rf "$tmp"; return 1
        fi
    done
    chmod +x "$tmp/install.sh"
    # 复用受控端安装脚本，传入已存身份 → 覆盖 agent.py 等并重启服务
    bash "$tmp/install.sh" --server "$SERVER_URL" --id "$AGENT_ID" --token "$AGENT_TOKEN" --interval "$INTERVAL"
    rm -rf "$tmp"
    echo -e "${GREEN}[OK]   受控端已更新并重启${NC}"
}

# ── 状态 / 卸载 ────────────────────────────────────────────────────────────────
status_all() {
    echo "== 服务端 (Docker) =="
    local running=0 installed=0
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q simple-probe-server; then
        running=1
        docker ps --filter name=simple-probe-server --format '  {{.Names}}  {{.Status}}'
    fi
    [[ -d "$SRC_DIR/server" ]] && installed=1
    if [[ $running -eq 0 && $installed -eq 1 ]]; then
        echo "  已安装但未运行 → 可选「5) 更新服务端」重建启动，或: docker compose -C $SRC_DIR/server up -d"
    elif [[ $running -eq 0 && $installed -eq 0 ]]; then
        echo "  未安装 → 请先「1) 安装服务端」"
    fi
    echo "== 受控端 (systemd) =="
    if systemctl list-unit-files simple-probe-agent.service >/dev/null 2>&1; then
        if systemctl is-active --quiet simple-probe-agent; then
            echo "  active"
        else
            echo "  inactive / 未运行"
        fi
    else
        echo "  未安装"
    fi
}

uninstall_all() {
    echo "== 卸载受控端 =="
    if [[ -f /opt/simple-probe/uninstall.sh ]]; then
        bash /opt/simple-probe/uninstall.sh || true
    else
        echo "  受控端未安装"
    fi
    echo "== 卸载服务端 (Docker) =="
    if [[ -d "$SRC_DIR/server" ]]; then
        ( cd "$SRC_DIR/server" && docker compose down ) || true
        echo -e "${YELLOW}[提示] 源码仍在 $SRC_DIR，数据库在 Docker 卷中；如需彻底清除请手动删除。${NC}"
    else
        echo "  服务端未安装"
    fi
}

# ── 菜单 ───────────────────────────────────────────────────────────────────────
show_menu() {
    echo ""
    echo -e "${BLUE}━━━ Simple Probe 一键部署 ━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  系统: ${GREEN}$(detect_os)${NC}  架构: ${GREEN}$(detect_arch)${NC}"
    echo ""
    echo "  1) 安装服务端 (Docker)"
    echo "  2) 安装受控端 Agent (systemd)"
    echo "  3) 更新受控端 (拉取最新 agent 代码)"
    echo "  4) 更新安装脚本 (install.sh 自身)"
    echo "  5) 更新服务端 (拉取最新 + 重建)"
    echo "  6) 查看状态"
    echo "  7) 卸载"
    echo "  0) 退出"
    echo ""
    read -r -p "请选择 [0-7]: " c
    case "$c" in
        1) install_server ;;
        2) install_agent ;;
        3) update_agent ;;
        4) update_script ;;
        5) update_server ;;
        6) status_all ;;
        7) uninstall_all ;;
        *) echo "退出"; exit 0 ;;
    esac
}

# ── 参数解析 ───────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-server) ACTION="server"; shift ;;
        --install-agent)  ACTION="agent";  shift ;;
        --update-script)  ACTION="update-script"; shift ;;
        --update-server)  ACTION="update-server"; shift ;;
        --update-agent)   ACTION="update-agent"; shift ;;
        --status)         ACTION="status"; shift ;;
        --uninstall)      ACTION="uninstall"; shift ;;
        --server)      A_SERVER="$2"; shift 2 ;;
        --id)          A_ID="$2"; shift 2 ;;
        --token)       A_TOKEN="$2"; shift 2 ;;
        --token-file)  A_TOKEN_FILE="$2"; shift 2 ;;
        --setup-token) A_SETUP="$2"; shift 2 ;;
        --setup-name)  A_SETUP_NAME="$2"; shift 2 ;;
        --interval)    A_INTERVAL="$2"; shift 2 ;;
        --repo)        REPO_RAW="$2"; shift 2 ;;
        -h|--help)     show_usage; exit 0 ;;
        *) echo -e "${RED}[错误] 未知参数: $1${NC}" >&2; show_usage; exit 1 ;;
    esac
done

# ── 入口 ───────────────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
    echo -e "${RED}[错误] 必须以 root 运行（sudo bash install.sh）${NC}" >&2
    exit 1
fi

if [[ -n "$ACTION" ]]; then
    case "$ACTION" in
        server)    install_server ;;
        agent)     install_agent ;;
        update-script) update_script ;;
        update-server) update_server ;;
        update-agent)  update_agent ;;
        status)    status_all ;;
        uninstall) uninstall_all ;;
    esac
elif [[ -t 0 ]]; then
    while true; do show_menu; done
else
    show_usage
    exit 1
fi
