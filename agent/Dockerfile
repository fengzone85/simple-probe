FROM python:3.12-slim
WORKDIR /app

# non-root user for reduced attack surface (reads /proc as any user)
RUN useradd -m -u 10001 monitor

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
