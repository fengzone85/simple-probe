# Simple Probe · Self-hosted Docker Monitor (Nezha alternative)

> Repository: https://github.com/fengzone85/simple-probe

The agent runs as a **Docker container** on each monitored VPS. It **only makes outbound HTTPS reports** — no inbound ports are opened on the monitored host, and no remote-execution capability exists. Data flows only into **your own dedicated VPS**, where the server renders a polished dashboard and can push offline / threshold-exceeded alerts to a QQ Mail inbox.

> Design goal: eliminate the class of vulnerabilities that plague Nezha (monitored hosts exposed to the public internet + remote execution → RCE). This design gives agents zero inbound surface, zero execution interfaces, and enforces auth + TLS end to end.

---

## Architecture

```
[Monitored VPS-A] docker agent ──HTTPS+Token──┐
[Monitored VPS-B] docker agent ──HTTPS+Token──┼──> [Dedicated VPS: server + dashboard]
[Monitored VPS-N] docker agent ──HTTPS+Token──┘      (Node + SQLite + ECharts / Nginx+TLS reverse proxy)
```

- **Agent is outbound-only**: reads metrics from `/proc` and POSTs them to `/api/report`. No firewall ports need to be opened on the monitored host; NAT / internal networks are unaffected.
- **Server**: binds `localhost:8080` and is exposed to the internet solely via Nginx + TLS on port 443.

## Directory layout

```
监控/
  agent/        # Monitored side (Docker)
    collector.py   collects CPU/memory/disk/load/traffic (incl. monthly totals)
    agent.py       periodic reporting + backoff retry
    Dockerfile     python:3.12-slim, stdlib only, runs as non-root
    docker-compose.yml
  server/       # Server + dashboard
    server.js / src/{db,auth,api,alerts}.js
    public/     polished dashboard (ECharts)
    Dockerfile / docker-compose.yml / .env.example
  nginx/monitor.conf.example   # TLS reverse-proxy + rate-limit example
```

## Security design

1. **Zero inbound on agents** — outbound reporting only.
2. **No remote exec / shell** — the agent only reads system metrics; there is no command-execution interface (the root cause of Nezha RCE).
3. **Authentication** — each agent has an `AGENT_ID` + `AGENT_TOKEN` (generated server-side, stored as sha256 in the DB); reports require `X-Agent-ID` + `Bearer`; unknown / mismatched are rejected.
4. **Transport encryption** — HTTPS throughout.
5. **Input validation** — `/api/report` strictly validates value ranges and types; out-of-range / malformed input is rejected with 400.
6. **Rate limiting** — Nginx rate-limits the report endpoint.
7. **Minimal attack surface** — local SQLite file; all dashboard / write endpoints require the admin token.
8. **Weak-token startup guard** — at startup, if `ADMIN_TOKEN` is empty, equals the default `change-me-admin-token`, or is shorter than 16 chars, the server refuses to start (`process.exit(1)`), forcing the admin to set a strong token early.
9. **HTTPS enforcement on admin APIs** — `adminAuth` checks `X-Forwarded-Proto`; any request proxied over a non-HTTPS origin is rejected with `403`, preventing plaintext transmission of the admin token. Note: this is fully effective only when the server port is NOT published to the public internet and only Nginx is exposed.
10. **Build-context isolation** — `server/.dockerignore` excludes `data/`, `.env`, `node_modules`, etc., so the SQLite database and credentials are never baked into the image.

## Third-party dependencies & privacy
- **Zero external front-end requests**: ECharts is vendored locally at `server/public/vendor/echarts.min.js`; the dashboard loads no CDN scripts. The server sets a strict `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; ...` with **no `unsafe-inline`**; all front-end interactions use `addEventListener` event delegation, which closes the XSS path that could steal the admin token.
- **Mail dependency**: alerts use `nodemailer` v9 (QQ Mail SMTP). After a major-version upgrade the transport is validated via `transporter.verify()`; just configure a real `SMTP_PASS` at deploy time.

## Deployment

### A. Server (your dedicated VPS)

```bash
# 1) Prepare the environment
apt update && apt install -y docker.io docker-compose nginx certbot python3-certbot-nginx

# 2) Copy server/ to the VPS and configure environment variables
cd server
cp .env.example .env
# Edit .env: set ADMIN_TOKEN, SMTP_PASS (QQ Mail authorization code), etc.
# NOTE: ADMIN_TOKEN must not be empty, must not equal the example default,
#       and must be >= 16 chars, otherwise the server refuses to start.

# 3) Start
docker compose up -d        # binds 127.0.0.1:8080 only (loopback); data in volume /data

# 4) Obtain TLS and set up the reverse proxy (see nginx/monitor.conf.example)
cp nginx/monitor.conf.example /etc/nginx/conf.d/monitor.conf
nginx -t && systemctl reload nginx
# then let certbot add 443 + cert (includes /api/report rate limiting):
certbot --nginx -d monitor.yourdomain.com
```

> **aaPanel (宝塔) users**: do not hand-write a conf that fights aaPanel. In aaPanel, create a site → reverse proxy pointing the domain to `127.0.0.1:8080`, and use aaPanel's Let's Encrypt one-click for TLS. Put the rate-limit zone (`limit_req_zone`) in "Nginx management → config" (the http block), and only keep `limit_req` in the site config.
> If Nginx itself is a separate Docker container (not a host process), put server and Nginx on a shared Docker network, reach each other by service name, and remove the `127.0.0.1:` port mapping in `server/docker-compose.yml`.

### B. Monitored side (each monitored VPS)

1. Open the dashboard → enter the admin token top-right → click **"+ New client"** → you get an `AGENT_ID` and an `AGENT_TOKEN`.
2. On that VPS, run:

```bash
docker run -d --name monitor-agent --restart unless-stopped \
  --network host \
  -e SERVER_URL=https://monitor.yourdomain.com \
  -e AGENT_ID=<the id you got> \
  -e AGENT_TOKEN=<the token you got> \
  -e INTERVAL=15 \
  -e DISK_PATH=/host \
  -v /:/host:ro \
  -v monitor-agent-data:/data \
  host-monitor-agent:latest
```

> **Key parameters for accurate host metrics**:
> - `--network host`: shares the host network namespace so `/proc/net/dev` reflects real traffic (the default bridge network would show the container's view).
> - `-v /:/host:ro` + `-e DISK_PATH=/host`: read-only mount of the host root so disk usage is computed for the VPS root disk, not the container overlay.
> - If running the agent directly on bare metal (no Docker), keep `DISK_PATH` at its default `/`.

> The `host-monitor-agent` image must be built on the monitored host first: `cd agent/ && docker build -t host-monitor-agent .`, or push it to a private/public registry and `docker pull`.

3. The client card appears on the dashboard, live-refreshing CPU/memory/disk/traffic/load, and you can edit **merchant, note, expiry date, monthly traffic quota**.

## Quick start (one-click)

A root `docker-compose.yml` is provided for a fast single-command launch of the **server** (dashboard) for testing / demos:

```bash
cp server/.env.example server/.env   # then edit ADMIN_TOKEN etc.
docker compose up -d                 # serves on http://<host>:8080
```

> ⚠️ This quick start exposes the server on plaintext `:8080`. The admin token would travel unencrypted, so **do not use it for production**. For production, always put Nginx + TLS in front (see section A above).

## Environment variables

**Server `.env`**: `PORT`, `ADMIN_TOKEN`, `OFFLINE_THRESHOLD_SEC` (default 60), `RETENTION_DAYS` (default 30), `ALERT_CPU_PCT`/`ALERT_MEM_PCT` (default 90), `ALERT_COOLDOWN_SEC`, `SMTP_*` (QQ Mail alerts).

**Monitored side**: `SERVER_URL`, `AGENT_ID`, `AGENT_TOKEN`, `INTERVAL` (seconds, default 15), `DISK_PATH` (default `/`).

## Dashboard features

- Overview: total / online / offline / average CPU·memory.
- Client cards: status dot, merchant badge, CPU/memory/load/traffic mini sparklines, disk progress bar, **expiry countdown** (<7 days yellow, expired red), notes.
- Detail page: ECharts time-series for CPU, memory, load, network rate, disk, and this-month traffic (vs quota), over 1h/6h/24h/7d.
- Edit / delete clients; auto-refresh every 10s.

## Alerts

- Offline (no report for longer than `OFFLINE_THRESHOLD_SEC`), CPU/memory over threshold → pushed via QQ Mail, with cooldown de-duplication (recipient configured via `ALERT_TO` in `.env`).
- **Prune-failure alert**: if `prune` fails 3 times in a row (e.g. DB permission / disk issues), an email alert is sent so the metrics table does not silently grow without bound.
- Set `SMTP_PASS` in `.env` (QQ Mail: Settings → Account → generate authorization code; not the login password).

## License

MIT — see [LICENSE](LICENSE).
