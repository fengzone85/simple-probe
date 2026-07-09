#!/usr/bin/env bash
# =============================================================================
# Simple Probe Agent — native systemd uninstallation script
# =============================================================================
# Cleans up all artefacts created by install.sh.
# Idempotent: safe to run even if the agent was never installed.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

echo ""
echo "━━━ Simple Probe Agent 卸载 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Stop service ───────────────────────────────────────────────────────────
if systemctl is-active --quiet simple-probe-agent 2>/dev/null; then
    systemctl stop simple-probe-agent
    echo -e "${GREEN}[OK]   已停止服务${NC}"
else
    echo -e "${YELLOW}[跳过] 服务未运行，无需停止${NC}"
fi

# ── 2. Disable service ────────────────────────────────────────────────────────
if systemctl is-enabled --quiet simple-probe-agent 2>/dev/null; then
    systemctl disable simple-probe-agent >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK]   已取消开机自启${NC}"
else
    echo -e "${YELLOW}[跳过] 服务未设置开机自启${NC}"
fi

# ── 3. Remove systemd unit ────────────────────────────────────────────────────
if [[ -f /etc/systemd/system/simple-probe-agent.service ]]; then
    rm -f /etc/systemd/system/simple-probe-agent.service
    echo -e "${GREEN}[OK]   删除 service 文件${NC}"
else
    echo -e "${YELLOW}[跳过] service 文件不存在${NC}"
fi

# ── 4. Reload systemd ─────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true
echo -e "${GREEN}[OK]   systemd daemon-reload 完成${NC}"

# ── 5. Remove system user ─────────────────────────────────────────────────────
if id simple-probe >/dev/null 2>&1; then
    if userdel simple-probe >/dev/null 2>&1; then
        echo -e "${GREEN}[OK]   删除系统用户 simple-probe${NC}"
    else
        echo -e "${YELLOW}[警告] 删除用户 simple-probe 失败（可能仍有进程占用），请手动执行: userdel simple-probe${NC}"
    fi
else
    echo -e "${YELLOW}[跳过] 用户 simple-probe 不存在${NC}"
fi

# ── 6. Remove directories ─────────────────────────────────────────────────────
if [[ -d /opt/simple-probe ]]; then
    rm -rf /opt/simple-probe
    echo -e "${GREEN}[OK]   删除 /opt/simple-probe/${NC}"
else
    echo -e "${YELLOW}[跳过] /opt/simple-probe 不存在${NC}"
fi

if [[ -d /var/lib/simple-probe ]]; then
    rm -rf /var/lib/simple-probe
    echo -e "${GREEN}[OK]   删除 /var/lib/simple-probe/${NC}"
else
    echo -e "${YELLOW}[跳过] /var/lib/simple-probe 不存在${NC}"
fi

# ── 7. Remove config directory ───────────────────────────────────────────────
if [[ -d /etc/simple-probe ]]; then
    rm -rf /etc/simple-probe
    echo -e "${GREEN}[OK]   删除 /etc/simple-probe/${NC}"
else
    echo -e "${YELLOW}[跳过] /etc/simple-probe 不存在${NC}"
fi

echo ""
echo "━━━ 卸载完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${GREEN}✅ Simple Probe Agent 已完全卸载${NC}"
echo ""
echo "  残留检查（如需确认）："
echo "    getent passwd simple-probe    # 应无输出"
echo "    ls /opt/simple-probe/          # 应报错"
echo "    ls /var/lib/simple-probe/      # 应报错"
echo "    ls /etc/simple-probe/          # 应报错"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
