#!/usr/bin/env bash
# =============================================================================
# Simple Probe Agent — native systemd installation script
# =============================================================================
# Supports interactive and non-interactive (--server --id --token --interval)
# mode.  Safe to review before running: no network downloads, no external
# dependencies beyond Python 3 and systemctl.
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

# ── Defaults ─────────────────────────────────────────────────────────────────
INTERVAL=15
REPO="https://raw.githubusercontent.com/fengzone85/simple-probe/master/agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Install Simple Probe Agent as a systemd service.

Required (interactive if not given):
  --server SERVER_URL   Monitoring server address  (e.g. https://your-server:8008)
  --id     AGENT_ID     Agent/Node identifier
  --token  AGENT_TOKEN  Authentication token (visible in process list — prefer --token-file)
  --token-file FILE     Read token from FILE (recommended; avoids leaking via ps/shell history)
  --setup-token SECRET  One-click register with server SETUP_TOKEN (no need for --id/--token)
  --setup-name NAME     Node display name for self-registration (optional)
  --interval SECONDS    Report interval in seconds (default: 15)
  --install-agent       （兼容一键命令语义标记；本脚本即受控端安装，忽略即可）
  --repo BASE_URL       Raw 仓库地址（agent.py 等配套文件来源，默认 master 分支）

Examples:
  # Interactive (prompts for token silently)
  sudo bash install.sh

  # Fully non-interactive (for Ansible / scripts)
  sudo bash install.sh --server https://monitor:8008 --id node1 --token SECRET --interval 15
EOF
    exit 0
}

# ── CLI argument parsing ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)  SERVER_URL="$2";  shift 2 ;;
        --id)      AGENT_ID="$2";    shift 2 ;;
        --token)   AGENT_TOKEN="$2"; shift 2 ;;
        --interval)
            if ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -lt 1 ]]; then
                echo -e "${RED}[错误] --interval 必须是正整数${NC}" >&2
                exit 1
            fi
            INTERVAL="$2"; shift 2 ;;
        --probe-targets)
            # 网络质量自测目标（label:host[:port]，逗号分隔）；写进 agent.env，受控端启动即生效。
            PROBE_TARGETS="$2"; shift 2 ;;
        --repo)
            REPO="$2"; shift 2 ;;
        --install-agent)
            shift ;;   # 兼容一键命令的语义标记；本脚本即受控端安装，忽略即可
        --token-file)
            AGENT_TOKEN_FILE="$2"; shift 2 ;;
        --setup-token)
            SETUP_TOKEN="$2"; shift 2 ;;
        --setup-name)
            SETUP_NAME="$2"; shift 2 ;;
        --help|-h) usage ;;
        *)
            echo -e "${RED}[错误] 未知参数: $1${NC}" >&2
            usage ;;
    esac
done

# ── 1. Root check ─────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
    echo -e "${RED}[错误] 必须以 root 运行（sudo bash install.sh）${NC}" >&2
    exit 1
fi

# ── 2. Detect / install Python 3 ─────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
    PYTHON="$(command -v python)"
    command -v "$PYTHON" --version 2>&1 | grep -qE 'Python 3\.' && {
        echo -e "${YELLOW}[警告] python 指向 Python 3；建议使用 python3 命令${NC}" >&2
    }
else
    echo -e "${YELLOW}[提示] 未检测到 python3，正在尝试安装…${NC}" >&2
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y python3
    elif command -v yum >/dev/null 2>&1; then
        yum install -y python3
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y python3
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache python3
    else
        echo -e "${RED}[错误] 无法安装 Python 3，请手动安装后再运行本脚本${NC}" >&2
        exit 1
    fi
    PYTHON="$(command -v python3)"
fi

echo -e "${GREEN}[OK]   Python: $("$PYTHON" --version 2>&1)${NC}"

# 版本下限校验（agent 使用 3.8+ 语法/特性）
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)' 2>/dev/null; then
    echo -e "${RED}[错误] Python 版本过低，需 >= 3.8，当前: $("$PYTHON" --version 2>&1)${NC}" >&2
    exit 1
fi

# ── 3. Detect ping (optional, warn if missing) ─────────────────────────────────
if ! command -v ping >/dev/null 2>&1; then
    echo -e ""
    echo -e "${YELLOW}[提示] 未检测到 ping 命令，网络质量探测将使用 TCP fallback（功能不受影响）${NC}"
    echo -e "${YELLOW}[提示] 如需完整 ICMP 探测，请运行: apt-get install -y iputils-ping${NC}"
fi

# ── 3b. Resolve AGENT_TOKEN from file / env (if not passed via --token) ──────
if [[ -z "${AGENT_TOKEN:-}" && -n "${AGENT_TOKEN_FILE:-}" ]]; then
    if [[ -f "$AGENT_TOKEN_FILE" ]]; then
        AGENT_TOKEN="$(tr -d '[:space:]' < "$AGENT_TOKEN_FILE")"
    else
        echo -e "${RED}[错误] --token-file 指定的文件不存在: $AGENT_TOKEN_FILE${NC}" >&2
        exit 1
    fi
fi
if [[ -z "${AGENT_TOKEN:-}" && -n "${SIMPP_TOKEN:-}" ]]; then
    AGENT_TOKEN="$SIMPP_TOKEN"
fi

# ── 3c. One-click self-registration via SETUP_TOKEN ─────────────────────────────
# 若提供 --setup-token，则向服务端自助注册，自动获得 AGENT_ID / AGENT_TOKEN，
# 无需在后台手动「新建客户端」。注册后行为与普通安装完全一致（仍只上报指标）。
if [[ -n "${SETUP_TOKEN:-}" ]]; then
    if [[ -z "${SERVER_URL:-}" ]]; then
        echo -e "${RED}[错误] 使用 --setup-token 必须同时提供 --server${NC}" >&2
        exit 1
    fi
    echo -e "${YELLOW}[信息] 正在通过 SETUP_TOKEN 向服务端自助注册客户端…${NC}"
    # 用 Python 标准库发 HTTPS 请求（无需额外依赖）
    REG_JSON="$("$PYTHON" - "$SERVER_URL" "$SETUP_TOKEN" "${SETUP_NAME:-}" <<'PYEOF'
import sys, json, urllib.request, urllib.error
server, token, name = sys.argv[1], sys.argv[2], sys.argv[3]
url = server.rstrip('/') + '/api/setup/register'
payload = {"setup_token": token}
if name:
    payload["name"] = name
data = json.dumps(payload).encode()
req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.loads(r.read().decode())
    print(json.dumps({"ok": True, "id": body.get("agent_id"), "tok": body.get("agent_token")}))
except urllib.error.HTTPError as e:
    msg = e.read().decode()
    try:
        msg = json.loads(msg).get("error", msg)
    except Exception:
        pass
    print(json.dumps({"ok": False, "error": "HTTP %s: %s" % (e.code, msg)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
PYEOF
)"
    if ! echo "$REG_JSON" | "$PYTHON" -c 'import sys, json; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null; then
        ERR=$(echo "$REG_JSON" | "$PYTHON" -c 'import sys, json; print(json.load(sys.stdin).get("error", "unknown"))' 2>/dev/null)
        echo -e "${RED}[错误] 自助注册失败: ${ERR}${NC}" >&2
        exit 1
    fi
    AGENT_ID=$(echo "$REG_JSON" | "$PYTHON" -c 'import sys, json; print(json.load(sys.stdin)["id"])' 2>/dev/null)
    AGENT_TOKEN=$(echo "$REG_JSON" | "$PYTHON" -c 'import sys, json; print(json.load(sys.stdin)["tok"])' 2>/dev/null)
    echo -e "${GREEN}[OK]   自助注册成功，节点 ID: ${AGENT_ID}${NC}"
fi

# ── 4. Interactive config collection ─────────────────────────────────────────
if [[ -z "${SERVER_URL:-}" ]]; then
    echo ""
    echo "━━━ Simple Probe Agent 安装配置 ━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -n "服务端地址 (SERVER_URL)  [例如 https://your-server:8008]: "
    read -r SERVER_URL
fi

if [[ -z "${SERVER_URL}" ]]; then
    echo -e "${RED}[错误] SERVER_URL 不能为空${NC}" >&2
    exit 1
fi

if [[ -z "${AGENT_ID:-}" ]]; then
    echo ""
    echo -n "节点 ID (AGENT_ID): "
    read -r AGENT_ID
fi

if [[ -z "${AGENT_ID}" ]]; then
    echo -e "${RED}[错误] AGENT_ID 不能为空${NC}" >&2
    exit 1
fi

if [[ -z "${AGENT_TOKEN:-}" ]]; then
    echo ""
    echo -n "认证令牌 (AGENT_TOKEN): "
    read -rs AGENT_TOKEN
    echo ""
fi

if [[ -z "${AGENT_TOKEN}" ]]; then
    echo -e "${RED}[错误] AGENT_TOKEN 不能为空${NC}" >&2
    exit 1
fi

# ── 4b. Validate SERVER_URL scheme (agent refuses non-localhost http) ──────
case "$SERVER_URL" in
    https://*) ;;
    http://localhost*|http://127.0.0.1*|http://\[::1\]*)
        echo -e "${YELLOW}[警告] 检测到 localhost 的 http，仅本地测试允许；生产环境请用 https${NC}" >&2
        ;;
    http://*)
        echo -e "${RED}[错误] SERVER_URL 必须使用 https（agent 拒绝向非 localhost 的 http 明文发送令牌）${NC}" >&2
        exit 1
        ;;
    *)
        echo -e "${RED}[错误] SERVER_URL 必须以 http(s):// 开头${NC}" >&2
        exit 1
        ;;
esac

# ── 5. Create system user ─────────────────────────────────────────────────────
if id simple-probe >/dev/null 2>&1; then
    echo -e "${GREEN}[OK]   系统用户 simple-probe 已存在${NC}"
else
    useradd -r -M -s /usr/sbin/nologin -d /nonexistent -c "Simple Probe Agent" simple-probe
    echo -e "${GREEN}[OK]   创建系统用户 simple-probe${NC}"
fi

# ── 6. Create directories ────────────────────────────────────────────────────
mkdir -p /opt/simple-probe
mkdir -p /var/lib/simple-probe
mkdir -p /etc/simple-probe

# ── 6b. 自举：经管道执行时同目录无 agent.py，从仓库下载配套文件 ──────────────
if [[ ! -f "${SCRIPT_DIR}/agent.py" ]]; then
    echo -e "${YELLOW}[信息] 同目录未找到 agent.py，将从 ${REPO} 下载配套文件…${NC}"
    for f in agent.py collector.py uninstall.sh; do
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${REPO}/$f" -o "${SCRIPT_DIR}/$f" || { echo -e "${RED}[错误] 下载 $f 失败${NC}" >&2; exit 1; }
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${SCRIPT_DIR}/$f" "${REPO}/$f" || { echo -e "${RED}[错误] 下载 $f 失败${NC}" >&2; exit 1; }
        else
            echo -e "${RED}[错误] 需要 curl 或 wget 才能下载配套文件${NC}" >&2; exit 1
        fi
    done
    echo -e "${GREEN}[OK]   已下载 agent.py / collector.py / uninstall.sh${NC}"
fi

# ── 7. Copy agent files ──────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/agent.py"     /opt/simple-probe/agent.py
cp "${SCRIPT_DIR}/collector.py" /opt/simple-probe/collector.py
chmod 644 /opt/simple-probe/agent.py /opt/simple-probe/collector.py
echo -e "${GREEN}[OK]   复制 agent.py / collector.py → /opt/simple-probe/${NC}"

# 同时部署 uninstall.sh，保证用户能按提示路径卸载
cp "${SCRIPT_DIR}/uninstall.sh" /opt/simple-probe/uninstall.sh
chmod 644 /opt/simple-probe/uninstall.sh

# ── 8. Set directory ownership & permissions ───────────────────────────────────
chown -R simple-probe:simple-probe /var/lib/simple-probe
chmod 700 /var/lib/simple-probe
echo -e "${GREEN}[OK]   /var/lib/simple-probe → simple-probe:simple-probe  (700)${NC}"

# ── 9. Write env file ─────────────────────────────────────────────────────────
#   Write to a temp file first, then move + chmod — avoids leaving world-readable
#   content on disk in case of interruption.
ENV_CONTENT="SERVER_URL=${SERVER_URL}
AGENT_ID=${AGENT_ID}
AGENT_TOKEN=${AGENT_TOKEN}
INTERVAL=${INTERVAL}
DISK_PATH=/
STATE_FILE=/var/lib/simple-probe/state.json
"
# 探测目标（网络质量自测 DNS）：服务端下发的 label:host 列表；为空则受控端回退内置默认。
if [[ -n "${PROBE_TARGETS:-}" ]]; then
  ENV_CONTENT="${ENV_CONTENT}PROBE_TARGETS=${PROBE_TARGETS}
"
fi

TMP_ENV=$(mktemp)
chmod 600 "$TMP_ENV"
echo "$ENV_CONTENT" > "$TMP_ENV"
chown root:root "$TMP_ENV"
mv "$TMP_ENV" /etc/simple-probe/agent.env
echo -e "${GREEN}[OK]   写入 /etc/simple-probe/agent.env  (root:0.0.0  600)${NC}"

# ── 10. Deploy systemd unit ───────────────────────────────────────────────────
cp "${SCRIPT_DIR}/simple-probe-agent.service" /etc/systemd/system/
# 用检测到的 Python 解释器路径回填 ExecStart，避免硬编码 /usr/bin/python3
# 在部分发行版或自定义安装（/usr/local/bin、pyenv 等）下找不到的问题
sed -i "s#/usr/bin/python3#${PYTHON}#g" /etc/systemd/system/simple-probe-agent.service
chmod 644 /etc/systemd/system/simple-probe-agent.service
systemctl daemon-reload
echo -e "${GREEN}[OK]   部署 simple-probe-agent.service${NC}"

# ── 11. Enable & start ────────────────────────────────────────────────────────
systemctl enable --now simple-probe-agent
echo -e "${GREEN}[OK]   启用并启动服务${NC}"

# ── 12. Verify ────────────────────────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet simple-probe-agent; then
    echo -e "${GREEN}[OK]   服务运行中 (active)${NC}"
else
    echo -e "${RED}[错误] 服务启动失败，最后 30 行日志如下，请排查后重试：${NC}" >&2
    journalctl -u simple-probe-agent -n 30 --no-pager
    exit 1
fi
echo ""
echo "━━━ 安装完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${GREEN}✅ Simple Probe Agent 已安装并运行${NC}"
echo ""
echo "  验证命令："
echo "    systemctl status  simple-probe-agent"
echo "    journalctl -u simple-probe-agent -f   # 实时日志"
echo ""
echo "  管理命令："
echo "    systemctl restart simple-probe-agent  # 重启"
echo "    systemctl stop    simple-probe-agent  # 停止"
echo ""
echo "  配置文件："
echo "    /etc/simple-probe/agent.env"
echo "    /opt/simple-probe/agent.py"
echo "    /var/lib/simple-probe/state.json      # 月度流量状态"
echo ""
echo "  卸载命令："
echo "    bash /opt/simple-probe/uninstall.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
