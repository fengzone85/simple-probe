#!/usr/bin/env python3
"""Host monitor agent: collects metrics and pushes to the self-hosted server."""
import os
import sys
import time
import json
import urllib.request
import urllib.error
from collector import Collector

SERVER_URL = os.environ.get('SERVER_URL', '').rstrip('/')
AGENT_ID = os.environ.get('AGENT_ID', '')
AGENT_TOKEN = os.environ.get('AGENT_TOKEN', '')
INTERVAL = max(5, int(os.environ.get('INTERVAL', '15')))
DISK_PATH = os.environ.get('DISK_PATH', '/')
STATE_FILE = os.environ.get('STATE_FILE', '/data/state.json')

if not SERVER_URL or not AGENT_ID or not AGENT_TOKEN:
    print('ERROR: SERVER_URL, AGENT_ID and AGENT_TOKEN must be set', file=sys.stderr)
    sys.exit(1)

REPORT_URL = SERVER_URL + '/api/report'
collector = Collector(disk_path=DISK_PATH, state_file=STATE_FILE)


def send(payload, attempt=0):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(REPORT_URL, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('X-Agent-ID', AGENT_ID)
    req.add_header('Authorization', 'Bearer ' + AGENT_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                return True
            print(f'[warn] report status {resp.status}', file=sys.stderr)
    except urllib.error.HTTPError as e:
        print(f'[warn] report HTTP {e.code}: {e.read().decode(errors="ignore")}', file=sys.stderr)
    except Exception as e:
        print(f'[warn] report error: {e}', file=sys.stderr)
    # exponential backoff retry (max 3)
    if attempt < 3:
        time.sleep(min(30, 2 ** attempt * INTERVAL))
        return send(payload, attempt + 1)
    return False


def main():
    print(f'[agent] starting: id={AGENT_ID} server={SERVER_URL} interval={INTERVAL}s')
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
