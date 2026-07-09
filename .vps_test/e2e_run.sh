#!/usr/bin/env bash
# =============================================================================
# Simple Probe — 真机 E2E 运行器（配合上传的修复版 install.sh 使用）
# 直接用本地 install.sh 跑一键流程：
#   1) 一键安装服务端（自动装 git/docker + 从 GitHub 拉源码 + docker build）
#   2) 用生成的 SETUP_TOKEN 自助注册受控端
#   3) 断言仪表盘 /api/agents 出现在线卡片
# 用法（在已上传 install.sh + agent/ 到 $SRC 的 VPS 上）：
#   sudo bash e2e_run.sh
# =============================================================================
set -euo pipefail
SRC="${SRC:-/tmp/sp-e2e}"
PORT=8080
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
die(){ echo -e "${RED}[FAIL] $*${NC}"; exit 1; }
ok(){ echo -e "${GREEN}[ OK ] $*${NC}"; }
info(){ echo -e "${YELLOW}[..] $*${NC}"; }

[[ "$(id -u)" -eq 0 ]] || die "必须以 root 运行（sudo bash e2e_run.sh）"
[[ -f "$SRC/install.sh" ]] || die "找不到 $SRC/install.sh（请先把修复版 install.sh 与 agent/ 上传到 $SRC）"
[[ -f "$SRC/agent/install.sh" ]] || die "找不到 $SRC/agent/install.sh（受控端载荷缺失）"

cd "$SRC"

info "== 1. 一键安装服务端（自动装 git/docker + 从 GitHub 拉源码 + 构建）=="
bash install.sh --install-server

ENV_FILE="/opt/simple-probe-src/server/.env"
[[ -f "$ENV_FILE" ]] || die "服务端 .env 未生成: $ENV_FILE"
SETUP_TOKEN="$(grep '^SETUP_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[[ -n "$SETUP_TOKEN" && -n "$ADMIN_TOKEN" ]] || die "无法从 .env 读取 SETUP_TOKEN / ADMIN_TOKEN"

info "== 2. 等待服务端在 :$PORT 就绪 =="
up=0
for i in $(seq 1 100); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then up=1; break; fi
  sleep 3
done
[[ $up -eq 1 ]] || die "服务端在 ~300s 内未于 :$PORT 就绪"
ok "服务端已在 :$PORT 响应"

info "== 3. 一键注册受控端（--setup-token）=="
bash install.sh --install-agent --server "http://localhost:$PORT" --setup-token "$SETUP_TOKEN" --setup-name e2e-test
systemctl is-active --quiet simple-probe-agent || die "受控端服务安装后未 active"

info "== 4. 等待首次上报（~25s）=="
sleep 25

info "== 5. 断言 /api/agents 出现在线卡片 =="
RESP="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:$PORT/api/agents")"
echo "$RESP" | python3 -c '
import sys, json
data = json.load(sys.stdin)
agents = data if isinstance(data, list) else data.get("agents", [])
target = [a for a in agents if a.get("name") == "e2e-test"]
if not target:
    print("  AGENT_NOT_FOUND (现有:", [a.get("name") for a in agents], ")")
    sys.exit(2)
a = target[0]
if not a.get("online"):
    print("  AGENT_OFFLINE last_seen=%s" % a.get("last_seen"))
    sys.exit(3)
print("  AGENT_ONLINE id=%s name=%s last_seen=%s" % (a.get("id"), a.get("name"), a.get("last_seen")))
sys.exit(0)
' || die "断言失败（见上方输出）"

ok "E2E 通过：受控端 'e2e-test' 已自助注册并上线"
echo ""
echo -e "  仪表盘: ${GREEN}http://localhost:$PORT${NC}  （ADMIN_TOKEN 见 $ENV_FILE）"
echo -e "  卸载:   ${YELLOW}bash $SRC/install.sh --uninstall${NC}"
