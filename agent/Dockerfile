# Simple Probe Agent — 极简镜像（仅依赖 Python 标准库，无需 pip 安装）
FROM python:3.11-slim
WORKDIR /app
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
