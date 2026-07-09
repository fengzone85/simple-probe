#!/usr/bin/env bash
# =============================================================================
# Simple Probe — 一键脚本 E2E 验证（自包含）
# 在干净的 Debian/Ubuntu VPS 上运行：克隆最新 main → 装服务端 → 用 SETUP_TOKEN
# 自助注册受控端 → 断言仪表盘 /api/agents 出现在线卡片。
#
# 用法：
#   sudo bash verify_oneclick.sh
# 可选环境变量：REPO / BRANCH / WORK
# =============================================================================
set -euo pipefail

REPO="${REPO:-https://github.com/fengzone85/simple-probe.git}"
BRANCH="${BRANCH:-}"
WORK="${WORK:-/tmp/sp-e2e}"
SRC_DIR="/opt/simple-probe-src"
PORT=8080

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
die(){ echo -e "${RED}[FAIL] $*${NC}"; exit 1; }
ok(){ echo -e "${GREEN}[ OK ] $*${NC}"; }
info(){ echo -e "${YELLOW}[..] $*${NC}"; }

[[ "$(id -u)" -eq 0 ]] || die "必须以 root 运行（sudo bash verify_oneclick.sh）"

# 一键脚本会自行安装 git/docker，这里仅做「能拉起脚本」的最低校验
command -v bash >/dev/null 2>&1 || die "缺少 bash"

echo "== 1. 获取仓库源码 =="
if [[ ! -d "$WORK/.git" ]]; then
  # 自包含模式：先确保有 git 再克隆（默认分支）
  if ! command -v git >/dev/null 2>&1; then
    ( command -v apt-get >/dev/null 2>&1 && apt-get update -qq && apt-get install -y git ) \
      || ( command -v dnf >/dev/null 2>&1 && dnf -y install git ) \
      || ( command -v yum >/dev/null 2>&1 && yum -y install git ) \
      || die "缺少 git 且无法自动安装"
  fi
  rm -rf "$WORK"
  if [[ -n "$BRANCH" ]]; then
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$WORK"
  else
    git clone --depth 1 "$REPO" "$WORK"
  fi
fi
cd "$WORK"

echo "== 2. 安装服务端（Docker，自动生成令牌）=="
bash install.sh --install-server

ENV_FILE="$SRC_DIR/server/.env"
[[ -f "$ENV_FILE" ]] || die "服务端 .env 未生成: $ENV_FILE"
SETUP_TOKEN="$(grep '^SETUP_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[[ -n "$SETUP_TOKEN" && -n "$ADMIN_TOKEN" ]] || die "无法从 .env 读取 SETUP_TOKEN / ADMIN_TOKEN"

echo "== 3. 等待服务端在 :$PORT 就绪 =="
up=0
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then up=1; break; fi
  sleep 3
done
[[ $up -eq 1 ]] || die "服务端在 ~180s 内未于 :$PORT 就绪"
ok "服务端已在 :$PORT 响应"

echo "== 4. 一键注册受控端（--setup-token）=="
bash install.sh --install-agent --server "http://localhost:$PORT" --setup-token "$SETUP_TOKEN" --setup-name e2e-test
systemctl is-active --quiet simple-probe-agent || die "受控端服务安装后未 active"

echo "== 5. 等待首次上报（~25s）=="
sleep 25

echo "== 6. 断言 /api/agents 出现在线卡片 =="
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
echo -e "  卸载:   ${YELLOW}bash $WORK/install.sh --uninstall${NC}"
