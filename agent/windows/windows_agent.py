#!/usr/bin/env python3
"""Windows host monitor agent: collects metrics and pushes to the self-hosted server.

Protocol-compatible with agent/agent.py (same /api/report POST, same payload shape).
Configure via environment variables (see README.md / run.bat).
"""
import os
import sys
import time
import json
import urllib.request
import urllib.error
from urllib.parse import urlparse
from win_collector import WinCollector, parse_probe_targets

# Long backoff on auth rejection (401/403): the agent token is static and cannot
# self-heal, so hammering the server only aids brute-force and floods logs.
# Mirrors other agent-type probes' "auth failure → 10-min backoff" behavior.
AUTH_BACKOFF = 600  # seconds

SERVER_URL = os.environ.get('SERVER_URL', '').rstrip('/')
AGENT_ID = os.environ.get('AGENT_ID', '')
AGENT_TOKEN = os.environ.get('AGENT_TOKEN', '')
INTERVAL = max(5, int(os.environ.get('INTERVAL', '15')))
DISK_PATH = os.environ.get('DISK_PATH', 'C:\\')
DEFAULT_STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'state.json')
STATE_FILE = os.environ.get('STATE_FILE', DEFAULT_STATE)
# 网络质量自测目标（固定公共基础设施，写死在本地，服务端不可下发）。
# 格式：label:host[:port]，逗号分隔。置空则关闭探测。仅测延迟/可达性，不采任何指纹。
PROBE_TARGETS = os.environ.get('PROBE_TARGETS', '移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8')

if not SERVER_URL or not AGENT_ID or not AGENT_TOKEN:
    print('ERROR: SERVER_URL, AGENT_ID and AGENT_TOKEN must be set', file=sys.stderr)
    sys.exit(1)

# ① Defense in depth: refuse plaintext HTTP except for localhost testing.
# The server already enforces HTTPS via X-Forwarded-Proto; this stops a
# misconfigured http:// SERVER_URL from ever sending the token in cleartext.
_url = urlparse(SERVER_URL)
if _url.scheme not in ('http', 'https'):
    print(f'ERROR: SERVER_URL must start with http(s): {SERVER_URL!r}', file=sys.stderr)
    sys.exit(1)
if _url.scheme == 'http' and _url.hostname not in ('localhost', '127.0.0.1', '::1'):
    print('ERROR: SERVER_URL must use https unless pointing at localhost', file=sys.stderr)
    sys.exit(1)

REPORT_URL = SERVER_URL + '/api/report'
collector = WinCollector(disk_path=DISK_PATH, state_file=STATE_FILE, probe_targets=parse_probe_targets(PROBE_TARGETS))


def send(payload, attempt=0):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(REPORT_URL, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', 'simple-probe-agent/1.0')
    req.add_header('X-Agent-ID', AGENT_ID)
    req.add_header('Authorization', 'Bearer ' + AGENT_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                return True
            print(f'[warn] report status {resp.status}', file=sys.stderr)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            # Static token can't self-heal: long backoff, no immediate retry.
            print(f'[warn] auth rejected (HTTP {e.code}); backing off {AUTH_BACKOFF}s — check AGENT_TOKEN', file=sys.stderr)
            time.sleep(AUTH_BACKOFF)
            return False
        print(f'[warn] report HTTP {e.code}: {e.read().decode(errors="ignore")}', file=sys.stderr)
    except Exception as e:
        print(f'[warn] report error: {e}', file=sys.stderr)
    # transient errors: exponential backoff retry (max 3)
    if attempt < 3:
        time.sleep(min(30, 2 ** attempt * INTERVAL))
        return send(payload, attempt + 1)
    return False


def main():
    print(f'[agent] starting: id={AGENT_ID} server={SERVER_URL} interval={INTERVAL}s disk={DISK_PATH}')
    while True:
        try:
            payload = collector.collect()
        except Exception as e:
            print(f'[error] collect failed: {e}', file=sys.stderr)
            payload = None
        if payload:
            ok = send(payload)
            if not ok:
                print('[error] failed to report after retries; metrics for this cycle dropped', file=sys.stderr)
        time.sleep(INTERVAL)


if __name__ == '__main__':
    main()
