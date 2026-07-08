FROM python:3.12-slim
WORKDIR /app

# non-root user for reduced attack surface (reads /proc as any user)
RUN useradd -m -u 10001 monitor

# iputils-ping 提供 ICMP 探测能力；其 /bin/ping 自带 cap_net_raw，
# 故以 monitor 非 root 用户亦可执行。若镜像无 ping，探测自动回退到 TCP，不影响运行。
RUN apt-get update && apt-get install -y iputils-ping && rm -rf /var/lib/apt/lists/*

COPY collector.py agent.py ./
RUN mkdir -p /data && chown -R monitor:monitor /data /app
USER monitor
ENV INTERVAL=15 \
    SERVER_URL= \
    AGENT_ID= \
    AGENT_TOKEN= \
    DISK_PATH=/ \
    STATE_FILE=/data/state.json
VOLUME ["/data"]
CMD ["python", "agent.py"]
