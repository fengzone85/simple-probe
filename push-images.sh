#!/usr/bin/env bash
# 一键构建并推送 ghcr.io 镜像（需在能连 Docker Hub 的机器上运行）。
#
# 用途：本机（如 NAS）离线无法拉基础镜像时，可在联网机器上跑此脚本补齐 ghcr 包。
#       server 走本地 build（与项目真实部署方式一致）；agent 从源码构建（含多盘修复的 collector.py）。
#
# 用法：
#   export GHCR_PAT=ghp_xxx        # 必须有 write:packages 权限的 GitHub PAT
#   ./push-images.sh              # 构建并推送 server + agent
#   ./push-images.sh server       # 只推送 server  -> ghcr.io/<user>/diting:latest
#   ./push-images.sh agent        # 只推送 agent   -> ghcr.io/<user>/diting-agent:latest
#
# 可选环境变量：
#   GHCR_USER  默认 fengzone85（ghcr 命名空间，与 GitHub 账号一致）

set -euo pipefail

GHCR_USER="${GHCR_USER:-fengzone85}"
REPO="ghcr.io/${GHCR_USER}"

if [[ -z "${GHCR_PAT:-}" ]]; then
  echo "错误：请先 export GHCR_PAT（具备 write:packages 权限的 GitHub PAT）" >&2
  exit 1
fi

# 登录（凭据写入 ~/.docker/config.json，用完建议 docker logout ghcr.io）
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

build_and_push() {
  local name="$1" context="$2" dockerfile="$3" target="$4"
  echo "==> 构建 ${target} (context=${context}, dockerfile=${dockerfile})"
  # 弱网/离线时 build 可能卡住，统一用 timeout 包裹
  timeout 600 docker build -f "$dockerfile" -t "$target" "$context"

  echo "==> 推送 ${target}"
  local attempt
  for attempt in 1 2 3; do
    if timeout 600 docker push "$target"; then
      echo "==> ${target} 推送成功"
      return 0
    fi
    echo "推送尝试 ${attempt} 失败/超时，清理后重试..." >&2
    # 干掉可能卡住的 push 关联容器
    docker kill "$(docker ps -q --filter "ancestor=${target}")" 2>/dev/null || true
    sleep 3
  done
  echo "错误：${target} 推送失败" >&2
  return 1
}

DO_SERVER=0
DO_AGENT=0
if [[ $# -eq 0 ]]; then
  DO_SERVER=1
  DO_AGENT=1
fi
for arg in "$@"; do
  case "$arg" in
    server) DO_SERVER=1 ;;
    agent)  DO_AGENT=1 ;;
    *) echo "未知参数: $arg（可用 server | agent）" >&2; exit 1 ;;
  esac
done

[[ $DO_SERVER -eq 1 ]] && build_and_push server ./server ./server/Dockerfile "${REPO}/diting:latest"
[[ $DO_AGENT  -eq 1 ]] && build_and_push agent  ./agent  ./agent/Dockerfile  "${REPO}/diting-agent:latest"

echo "完成。"
