# Simple Probe Agent — 极简镜像（仅依赖 Python 标准库，无需 pip 安装）
FROM python:3.11-slim
WORKDIR /app

# 安装 ping 使网络质量自测可用 ICMP（默认仅 TCP 443/80/53 回退；
# 部分运营商 DNS/探测点未开放这些端口，会被误判为"不可达"，如移动 211.136.192.6）。
# 默认容器能力已含 CAP_NET_RAW，ping 的 raw socket 可正常工作。
# 放在 COPY 之前作为独立层：改 agent 代码不会使 apt 层失效，离线/弱网环境可复用缓存。
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

COPY agent.py collector.py ./

# 运行环境变量（由 docker run -e 注入；默认值仅作占位，启动前必须设置）
ENV SERVER_URL="" \
    AGENT_ID="" \
    AGENT_TOKEN="" \
    INTERVAL=15 \
    DISK_PATH=/ \
    STATE_FILE=/data/state.json \
    PROBE_TARGETS="移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8"

# 月度流量计数状态落盘（建议挂卷持久化）
RUN mkdir -p /data
CMD ["python", "agent.py"]
