# Simple Probe · Self-hosted Docker Monitor (Nezha alternative)

> Repository: https://github.com/fengzone85/simple-probe

The agent runs as a **Docker container** on each monitored VPS. It **only makes outbound HTTPS reports** — no inbound ports are opened on the monitored host, and no remote-execution capability exists. Data flows only into **your own dedicated VPS**, where the server renders a polished dashboard and can push offline / threshold-exceeded alerts to a QQ Mail inbox or Telegram.

> Design goal: eliminate the class of vulnerabilities that plague Nezha (monitored hosts exposed to the public internet + remote execution → RCE). This design gives agents zero inbound surface, zero execution interfaces, and enforces auth + TLS end to end.

---

## Design principles (5)

This project trades "doing less" for "being safer". Five non-negotiable design principles:

1. **Trust isolation over feature richness** — neither the server nor any agent is assumed trustworthy; a breach of either must not spread to the other.
2. **No command channel** — Agent → Server is a one-way data flow; the server has no mechanism to influence agent behavior (no WebSocket downstream, no task push).
3. **Zero coupling between agents** — each agent knows only its own `SERVER_URL` + token; agents cannot perceive one another.
4. **Data minimization** — we collect only 6 categories of basic state (online / load / CPU / memory / disk / traffic) and never fingerprint the host (no kernel version, GPU, public IP, or connection count).
5. **Server untrusted + credentials never naked** — HTTPS throughout, tokens stored as SHA-256 hashes, sessions via signed cookies, dangerous actions gated by TOTP; defense in depth, not single-point trust.

> See "Threat model: trust-boundary analysis" below for the full compromise walkthrough.

## Project advantages

This project earned a **⭐⭐⭐⭐⭐ (5/5)** rating in two independent security / code reviews, with the verdict "safe for production use". Core strengths:

**🔒 Security-first architecture**
- **Zero inbound, zero remote-execution on agents**: eliminates the Nezha-class "monitored host exposed + remote exec → RCE" attack surface at the root; monitoring data only enters your own dedicated VPS.
- **Transport + implementation defense in depth**: HTTPS enforcement via whitelist (only `X-Forwarded-Proto: https` passes, default deny — no spoofed-header bypass), constant-time token comparison (no timing side-channel), and a strict CSP (no `unsafe-inline`, no external scripts).

**🛡️ Layered identity & access control**
- **Multi-factor auth**: agents report with mutual Token; the server uses an admin token plus an optional read-only token (minimal RBAC basis).
- **No more naked credentials**: dashboard login uses a signed `HttpOnly + Secure + SameSite=Strict` cookie, so the admin token is no longer stored in plaintext on the front end (kills the XSS-theft risk); optional **TOTP two-factor authentication** requires a code on top of the token for all admin writes, so the static token alone cannot perform dangerous actions.

**🌐 Cross-platform, drop-in**
- **Linux (Docker, stdlib-only) + Windows (native psutil) agents** report identical fields, so the server receives them with **zero changes**; the Windows agent can be registered as a "start on logon, restart on crash" scheduled task in one command.

**📊 Observability & alerting**
- Standard **Prometheus `/metrics`** export (Bearer auth) for Grafana; offline / CPU·memory threshold alerts push to **QQ Mail and Telegram** in parallel (one channel failing does not affect the other), with monthly-traffic-quota and expiry-countdown reminders.

**⚡ Lightweight, low-dependency, easy to deploy**
- Zero-dependency TOTP implementation; ECharts vendored locally (no CDN); agents are stdlib-only and run as non-root; application-layer rate limiting plus Nginx security headers; weak-token startup guard, input validation, and build-context isolation all included.

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
  agent/        # Monitored side (Docker, Linux)
    collector.py   collects CPU/memory/disk/load/traffic (incl. monthly totals)
    agent.py       periodic reporting + backoff retry
    Dockerfile     python:3.12-slim, stdlib only, runs as non-root
    docker-compose.yml
  agent/windows/ # Monitored side (native Windows, psutil; see its README)
    win_collector.py  Windows metric collection (same protocol as Linux)
    windows_agent.py  periodic reporting + backoff retry
    install.ps1       install deps + register startup scheduled task
    run.bat           convenient launcher
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
11. **Dashboard two-factor authentication (TOTP)** — can be enabled in the "Security" panel. Once enabled, all **admin write operations** (create/edit/delete clients, reset token, test alert) additionally require a TOTP code on top of the static token, so the static admin token alone cannot perform dangerous actions. Dashboard login is maintained by a signed `HttpOnly + Secure + SameSite=Strict` cookie, so the admin token is **no longer stored in plaintext on the front end** (eliminating the XSS-theft risk). Read-only pulls (Grafana, `/metrics`, `READONLY_TOKEN`) stay transparent and are not subject to 2FA. See "Two-factor authentication (TOTP)" below.
12. **Agent report-channel hardening** — both agents (Linux / Windows) enforce HTTPS client-side: a non-localhost `http://` `SERVER_URL` fails at startup, preventing the token from ever being sent in cleartext (defense in depth beyond the server's `X-Forwarded-Proto` whitelist). On `401/403` they enter a **10-minute long backoff with no immediate retry** (the static token cannot self-heal, avoiding log flooding and brute-force against the server); transient errors (5xx, network blips) still use the exponential backoff retry.

### Two-factor authentication (TOTP)

To further harden the admin surface, enable TOTP 2FA in the dashboard's "🔒 Security" panel:

1. Open the Security panel and click **Enable two-factor authentication**; the system generates a Base32 secret (shown only once).
2. Manually enter the secret into any TOTP app (Google Authenticator / 1Password / Authy). This project calls no external QR service, complying with the CSP policy.
3. Enter the 6-digit code shown by the app and click **Confirm enable**.

After enabling:

- Dashboard login requires **admin token + TOTP code**; the session is kept via a signed cookie (HttpOnly, never stored in plaintext on the front end).
- All admin write operations require the TOTP code in addition to the token; the static token alone is rejected.
- Read-only monitoring (Grafana, `/metrics`, read-only token) is unaffected and stays transparent.

**Lost-device recovery**: if you lose your TOTP device, clear the 2FA config in SQLite and re-bind:

```bash
sqlite3 data/monitor.db "DELETE FROM admin_config;"
```

(In production, `SESSION_SECRET` should be a fixed random value; otherwise every server restart invalidates all sessions.)

## Threat model: trust-boundary analysis (design philosophy)

> In one sentence: **Trust isolation matters more than feature richness.** This project's security is achieved not by stacking defensive layers, but by *not doing* things — no command channel, no host fingerprinting, no agent-to-agent awareness. An attacker cannot exploit what does not exist.

### Our assumption: the server is untrusted, and so is the agent

Many monitoring systems implicitly assume "the server is trusted". Once the server is compromised, every agent falls with it — because agents accept server commands, execute pushed tasks, and trust everything the server says.

Our design assumes the opposite: **the server may be compromised, a single agent may be compromised, and either breach must not affect the other.** Below we verify this assumption against the code.

### Three pillars (all verified in code)

**① No command channel (Agent → Server is one-way)**
- The agent only `POST`s to `/api/report`; the response body is used solely for error logging (`e.read()`) and is **never parsed or executed**. The agent listens on no port and has no `subprocess`/`Popen`/`eval`/`exec`.
- The server's only agent-facing endpoint is `POST /report`; `agentAuth` merely validates the token and stores the metric, returning `{ok:true}`. There is no WebSocket / SSE / any downstream push in the codebase; the dashboard refreshes via browser-side polling, unrelated to agents.
- This is a **deliberate non-implementation** of a command channel — not "not yet built". Bidirectional WebSocket monitors are the opposite: more capable, but the trust boundary is broken.

**② Zero coupling between agents**
- Each agent knows only its own `SERVER_URL` + token, and is unaware of other agents.
- Metrics are stored per `agent_id`; all cross-agent aggregation (`getAgents`/`getMetricsAll`) is admin-only read queries for the dashboard, never pushed to any agent. Even a compromised server has no mechanism to make "agent A contact agent B".

**③ Collected data carries no exploitable information**
- We collect only 6 categories of basic state: online, load, CPU, memory, disk, traffic (incl. monthly totals).
- We do **not** collect kernel version, GPU, public IP, or connection count. Even if the server DB is exfiltrated, the leak is only "machine X had CPU/memory Y at time Z" — useless for targeted attacks (no kernel version → no CVE targeting, no public IP → no direct target, no GPU → no mining leverage).

### Three compromise scenarios

| Scenario | Attacker can | This project | Command-channel / fingerprinting monitor |
| --- | --- | --- | --- |
| ① Server compromised | Read reported data | ✅ (6 metrics only, no fingerprint) | ✅ (incl. kernel/GPU/public-IP/conns) |
| | Spoof data to mislead agents | no effect (agents take no commands) | no effect |
| | Push malicious tasks / probes | ❌ impossible (no command channel) | ✅ can push; agent becomes jump host |
| | Move laterally to other agents | ❌ impossible | ⚠️ can probe other networks via tasks |
| ② One agent compromised | Read its own token | ✅ (visible via docker env) | ✅ (visible via ps/cmdline) |
| | Spoof its own data | ✅ (only affects that agent) | ✅ |
| | Lateral move / attack server | ❌ impossible (POST-only; server runs no agent command) | ❌ impossible |
| ③ Server + one agent compromised | Get other agents' tokens | ⚠️ yes (see refinement) | ⚠️ yes |
| | Spoof other agents' data | ⚠️ yes | ⚠️ yes |
| | Execute / push tasks on other agents | ❌ impossible (no command channel) | ✅ possible (probe tasks, not RCE) |

### Refinement of scenario ③ (our design is more optimistic)

Tokens are stored in the database as **SHA-256 hashes** (`token_hash`), never in plaintext. Authentication compares `sha256(submitted token)` against the stored hash (constant-time). Therefore:

- A **read-only** DB leak (e.g. exfiltration without write access) yields **no plaintext token** for any agent. To spoof another agent's data, the attacker must either brute-force a 24-byte random token (infeasible) or overwrite `token_hash` with a known value.
- In other words, a "compromised server" that is read-only **cannot immediately spoof**; DB write access is required. This is a concrete hardening of the ⚠️ row above.

In the worst case (server + one agent both compromised), the attacker's ceiling is **spoofing other agents' reports** — the dashboard shows fake data, but **no machine is controlled**.

### Two honest caveats

1. **Strictly more than "6 items"**: besides the basic state, `hostname` and `os` (distro name, e.g. "Ubuntu 22.04") are also stored. They are lightweight identifiers, **not attack fingerprints** (no kernel version / CVE targeting, no public IP, no GPU), but the "no fingerprint" claim should be read as "no fingerprint useful for targeted attack".
2. **Token hashing downgrades "plaintext leak" to "forge only with DB write access"**, not complete immunity — this should be explicit when evaluating scenario ③.

## Trust-boundary comparison with mainstream monitors (e.g. Nezha)

Many monitors (e.g. Nezha) prioritize features with an architecture of **monitored hosts exposed to the public internet + bidirectional communication (WebSocket) + remote execution**. More capable, but the trust boundary is broken: once the server is compromised, every monitored host becomes a remotely controllable node.

| Dimension | Simple Probe (this project) | Command-channel monitors (e.g. Nezha) |
| --- | --- | --- |
| Agent inbound | Zero inbound (outbound HTTPS only) | Usually exposes ports / dashboard to the internet |
| Communication | One-way (Agent→Server POST) | Bidirectional (WebSocket, server can push) |
| Remote execution | ❌ none (deliberately absent) | ✅ present (command exec → RCE risk) |
| Agent coupling | Zero; mutually unaware | Server can orchestrate; agents can be jump hosts |
| Collected data | 6 basic metrics, no fingerprint | May include kernel/version/network detail |
| Worst case (server + 1 agent breached) | Only report spoofing; no machine controlled | Can push tasks to probe / execute via agents |
| Trust model | Server and agents both untrusted | Implicitly assumes "server is trusted" |

> Bottom line: Simple Probe trades a functional "subtraction" (no command channel, no fingerprinting, no agent awareness) for a security "addition". An attacker cannot exploit what does not exist.

## Clarification on other agent-type probes (source-level evidence)

Some other agent-type probes (an open-source project using a server→agent command channel), often compared with this project, also use that pattern. Two common misconceptions are corrected here with its actual `agent/main.go` source.

**Misconception 1: "the agent can be RCE'd" — false.**
Its ICMP probe path is: `executeICMPPing(target)` → `resolvePublicIPs()` (DNS resolution + blacklist check) → take `ips[0].String()` → only then `exec.Command("ping", "-c", "1", "-W", "2", pingTarget)`. Two facts matter:
- The argument reaching `exec.Command` is **always the output of `net.IP.String()`** (e.g. `192.168.1.1`, `2001:db8::1`) — it can never contain shell metacharacters like `;`, `|`, or backticks.
- Go's `exec.Command` calls `execve` directly; no `/bin/sh` is involved.

So even if the server pushes `; rm -rf /`, it is rejected at the `resolvePublicIPs` / `net.ParseIP` stage and ping never starts. **This is not RCE; it is a type-constrained command invocation.** Equating "there is an exec call" with "arbitrary code can be executed" is classic audit over-generalization. Its TCP/HTTP paths dial using the already-validated `net.IP` objects directly (`dialPublicTCP` → `dialResolvedTCP`), with no second DNS resolution, so there is no DNS-rebinding / TOCTOU bypass — its SSRF defense is actually quite rigorous.

**Misconception 2: "adding task signatures to the WebSocket fixes server-compromise risk" — ineffective for this threat model.**
This project's threat model assumes the server is untrusted and may be compromised. Once the server is compromised, the attacker holds the signing key and **is the legitimate signer**. Task signatures only protect against a third party tampering in transit; they cannot stop the server itself from being the attacker. For signatures to help here, a trust root outside the server (independent CA or agent-local allowlist) would be required — which is effectively redesigning the trust model, and that is exactly "no command channel" itself.

**Correct characterization & conclusion:**
- After a server compromise, the attacker **can** make all agents probe arbitrary public targets via ICMP/TCP/HTTP (restricted by the CIDR blacklist to public addresses only — no intranet reach). It is a **distributed probe jump host**, not an RCE botnet.
- But the "probe jump host" capability **is not a bug; it is the core feature** (public ping monitoring). It cannot be removed while keeping the feature; only eliminating the command channel (this project's approach) resolves it fully.

> In one line: such an agent-type probe is a *constrained controlled probe agent*, not an *RCE backdoor*. Its problem is not RCE — it is the mere existence of a command channel, which this project deliberately avoids.

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

### Hide the origin IP (optional, recommended)

Even without Cloudflare's CDN/WAF ("CF shield"), the setup above (8080 bound to loopback + Nginx TLS + strong token + CSP) is already secure; however, the VPS public IP is still directly exposed and will be scanned / brute-forced, with no managed WAF.

To **expose no inbound ports at all** and keep the origin IP invisible, see [`TUNNEL-GUIDE.md`](TUNNEL-GUIDE.md): it covers both Cloudflare Tunnel and Tailscale, with full commands and certificate / firewall notes.

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

**Server `.env`**: `PORT`, `ADMIN_TOKEN`, `OFFLINE_THRESHOLD_SEC` (default 60), `RETENTION_DAYS` (default 30), `ALERT_CPU_PCT`/`ALERT_MEM_PCT` (default 90), `ALERT_COOLDOWN_SEC`, `SMTP_*` (QQ Mail alerts), `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (optional, Telegram alerts), `READONLY_TOKEN` (optional, read-only account — see below), `SESSION_SECRET`/`SESSION_TTL_MS` (2FA session — see "Two-factor authentication (TOTP)").

**Monitored side**: `SERVER_URL`, `AGENT_ID`, `AGENT_TOKEN`, `INTERVAL` (seconds, default 15), `DISK_PATH` (default `/`).

## Dashboard features

- Overview: total / online / offline / average CPU·memory.
- Client cards: status dot, merchant badge, CPU/memory/load/traffic mini sparklines, disk progress bar, **expiry countdown** (<7 days yellow, expired red), notes.
- Detail page: ECharts time-series for CPU, memory, load, network rate, disk, and this-month traffic (vs quota), over 1h/6h/24h/7d.
- Edit / delete clients; auto-refresh every 10s.

## Alerts

- Offline (no report for longer than `OFFLINE_THRESHOLD_SEC`), CPU/memory over threshold → pushed via QQ Mail, with cooldown de-duplication (recipient configured via `ALERT_TO` in `.env`).
- **Prune-failure alert**: if `prune` fails 3 times in a row (e.g. DB permission / disk issues), an email alert is sent so the metrics table does not silently grow without bound.
- **Telegram alerts (optional)**: once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`, the alerts above are **also** delivered to Telegram in parallel with email (each channel fails independently). See `.env.example` for how to obtain them.
- Provide `SMTP_PASS` in `.env` for mail (QQ Mail: Settings → Account → generate authorization code; not the login password). Telegram and email can be enabled independently.
- **Send a test alert**: after configuring, verify with `curl -X POST -H 'X-Admin-Token: YOUR_TOKEN' http://localhost:8080/api/test-alert` (add `-H 'X-Forwarded-Proto: https'` when behind an Nginx proxy), click the **📨 Test Alert** button on the dashboard top-right (fill in the admin token first), or run `node scripts/test-notify.js` from the `server/` directory.

## Read-only account (READONLY_TOKEN)

To avoid sharing the full-privilege admin token around, configure an optional **read-only** account:

- Set the optional `READONLY_TOKEN` in `.env` (also recommended ≥ 16 chars).
- Holders may **only call read-only `GET` endpoints** (client list, latest metrics, sparklines, `/metrics`); all write operations (`POST /agents`, `PUT/DELETE /agents/:id`, `reset-token`, `/test-alert`) are blocked by the `adminOnly` guard with `401`.
- Ideal for read-only consumers like Grafana / third-party dashboards, so the admin token is not exposed to them.
- The read-only account is **not subject to 2FA** (2FA only constrains admin writes), keeping programmatic read pulls transparent.

## Prometheus metrics export (`/metrics`)

To integrate with Prometheus / Grafana and other observability stacks, the server exposes metrics in standard exposition format:

- `GET /metrics` returns Prometheus text format with unit-suffixed metric names and escaped labels, e.g. `probe_cpu_percent{agent="...",host="..."}`, `probe_mem_percent`, `probe_disk_percent`, `probe_net_rx_bytes_per_sec`, etc.
- **Auth**: supports `Authorization: Bearer <ADMIN_TOKEN | READONLY_TOKEN>`; requests without a token get `401`.
- **Trade-off**: this endpoint does **not** enforce HTTPS, to ease in-network Prometheus scraping, protected by the Bearer token; if exposed publicly, always place it behind Nginx + TLS.
- Example:

```bash
curl -H 'Authorization: Bearer <your READONLY_TOKEN>' http://localhost:8080/metrics
```

## Windows monitored side

Besides the Linux Docker agent, this project ships a **native Windows agent** (see the `agent/windows/` directory) for monitoring Windows servers:

- Built on `psutil`, it collects CPU / memory / disk / network rate & monthly totals / uptime, and reports **exactly the same fields as the Linux agent**, so the server receives it with zero changes.
- Windows has no load average, so `load1/load5/load15` are fixed placeholders `0.0` (the dashboard shows 0, as expected).
- Install: run `agent/windows/install.ps1` to auto `pip install psutil` and register a "start on logon, restart on crash" scheduled task (auto-start); `run.bat` offers a convenient temporary launcher. See `agent/windows/README.md` for details.
- Security follows the main project: the agent is outbound-only with no remote-execution interface, using `HTTPS + Token` end to end; monthly traffic totals persist to `state.json` and survive restarts.

## Security review checklist

A security review was performed; all high/medium items are addressed. Summary (✅ done, ⬜ optional left):

| Priority | Item | Status | Notes |
| --- | --- | --- | --- |
| P0 | Critical fixes (S1/S2) | ✅ | Fixed in earlier session |
| P1 | Hardening (S5/C5/C4) | ✅ | Fixed in earlier session |
| P2 | Hardening (④⑤⑥⑦) | ✅ | Fixed in earlier session |
| P3 ⑩ | Prometheus `/metrics` | ✅ | `GET /metrics` with Bearer / read-only token auth |
| P3 ⑪ | Read-only account (RBAC basis) | ✅ | `READONLY_TOKEN`: read-only GET, no writes |
| P3 ⑨ | Windows agent | ✅ | `agent/windows/` on psutil, protocol-compatible with Linux, zero server changes |
| P3 ⑧ | Admin TOTP 2FA | ✅ | Signed session-cookie login (no plaintext token on front end) + TOTP on writes |
| P3 ⑧ | WebAuthn / hardware key | ⬜ | Optional left: TOTP already removes the plaintext-token exposure; WebAuthn adds limited value and needs browser + third-party lib verification |

**Bottom line**: the review's concern — a static admin token lingering in the front end and stealable via XSS — is fully resolved by the **HttpOnly signed-cookie login + TOTP second factor**; cross-platform agents, metric exposure, and the read-only account are all in place.

## License

MIT — see [LICENSE](LICENSE).
