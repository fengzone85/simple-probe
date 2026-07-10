#!/usr/bin/env python3
"""Collect system metrics on Windows using psutil.

The returned dict shape mirrors agent/collector.py so the server treats reports
from Windows and Linux agents identically (no server-side changes required).

Windows has no load average; load1/load5/load15 are reported as 0.0 placeholders.
"""
import os
import re
import time
import json
import shutil
import socket
import platform
import subprocess
import concurrent.futures
from datetime import datetime

try:
    import psutil
except ImportError:
    import sys
    print('ERROR: psutil is required. Run: pip install -r requirements.txt', file=sys.stderr)
    raise


def parse_probe_targets(spec):
    """Parse PROBE_TARGETS env spec: 'label:host[:port],...'. Empty -> [].

    The server NEVER supplies these targets — fixed in the agent's local
    config. Probing is a self-contained reachability test against public
    infrastructure, NOT a server-pushed scan (no command channel).
    """
    out = []
    if not spec:
        return out
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if ':' not in part:
            out.append((part, part, 53))
            continue
        label, rest = part.split(':', 1)
        host = rest
        port = 53
        if ':' in rest:
            host, p = rest.rsplit(':', 1)
            try:
                port = int(p)
            except Exception:
                port = 53
        # 基础格式校验（防御 operator 误配；host 来自本地配置，非服务端下发，无注入面）。
        # host 非空且长度 ≤ 253（域名上限）；port 落在 [1,65535]；label 超限截断到 24（与服务端一致）。
        label = label.strip() or host
        if not host or len(host) > 253 or not (1 <= int(port) <= 65535):
            continue
        if len(label) > 24:
            label = label[:24]
        out.append((label, host, port))
    return out


def probe_one(host, port=53, timeout=3, retries=1):
    """Measure RTT (ms) to host. Prefer ICMP (system ping); fall back to TCP.

    Retries once on failure to absorb transient jitter (brief 1-2s blips),
    so an occasional dropped probe does not flip a carrier to X for one tick.
    Returns (ms: float|None, ok: bool). No host fingerprint collected.
    """
    def _try():
        if shutil.which('ping'):
            if os.name == 'nt':
                cmd = ['ping', '-n', '1', '-w', str(int(timeout * 1000)), host]
            else:
                cmd = ['ping', '-c', '1', '-W', str(int(timeout)), host]
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 2)
                s = (out.stdout or '') + (out.stderr or '')
                m = re.search(r'平均\s*=\s*([\d.,]+)\s*ms', s)
                if not m:
                    m = re.search(r'=\s*[\d.]+/[\d.]+/[\d.]+/[\d.]+\s*ms', s)
                if m:
                    val = float(m.group(1).replace(',', '.'))
                    return round(val, 1), True
            except Exception:
                pass
        try:
            t0 = time.time()
            with socket.create_connection((host, port), timeout=timeout):
                ms = (time.time() - t0) * 1000.0
            return round(ms, 1), True
        except Exception:
            return None, False
    last = (None, False)
    for _ in range(retries + 1):
        last = _try()
        if last[1]:
            return last
    return last
def os_name():
    """Best-effort human-readable Windows edition, e.g. 'Windows 11 Pro 23H2'."""
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r'SOFTWARE\Microsoft\Windows NT\CurrentVersion',
        ) as k:
            prod = winreg.QueryValueEx(k, 'ProductName')[0]
            try:
                build = winreg.QueryValueEx(k, 'DisplayVersion')[0]
            except Exception:
                build = ''
            try:
                cb = int(winreg.QueryValueEx(k, 'CurrentBuild')[0] or 0)
                # Windows 11 has build >= 22000 (registry still says "Windows 10")
                if cb >= 22000 and prod.startswith('Windows 10'):
                    prod = prod.replace('Windows 10', 'Windows 11')
            except Exception:
                pass
            return (prod + (' ' + build if build else '')).strip()
    except Exception:
        pass
    try:
        ver = platform.win32_ver()
        return ' '.join([platform.system(), ver[0], ver[1]]).strip()
    except Exception:
        return platform.platform()


class WinCollector:
    def __init__(self, disk_path='C:\\', state_file='state.json', probe_targets=None):
        self.disk_path = disk_path or 'C:\\'
        self.state_file = state_file
        self.probe_targets = probe_targets or []
        self._net_prev = None
        self._net_prev_ts = 0
        self._disk_io_prev = None
        self._disk_io_prev_ts = 0
        self._state = self._load_state()
        # Prime the CPU sample so the first collect() returns a real percentage.
        try:
            psutil.cpu_percent(interval=0.1)
        except Exception:
            pass

    def _load_state(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_state(self):
        try:
            d = os.path.dirname(self.state_file) or '.'
            os.makedirs(d, exist_ok=True)
            with open(self.state_file, 'w') as f:
                json.dump(self._state, f)
        except Exception:
            pass

    def _net_totals(self):
        """Total rx/tx bytes across all interfaces (excludes loopback by psutil)."""
        c = psutil.net_io_counters()
        return c.bytes_recv, c.bytes_sent

    def collect(self):
        # CPU: percent since the primer / last call.
        try:
            cpu = psutil.cpu_percent(interval=None)
        except Exception:
            cpu = 0.0
        if cpu is None:
            cpu = 0.0

        vm = psutil.virtual_memory()
        mem_used = vm.used
        mem_total = vm.total
        mem_pct = vm.percent

        try:
            # 自动探测所有固定硬盘（disk_path 为 'C:\' 或空时走全盘检测）
            paths = []
            if self.disk_path and self.disk_path.strip() and self.disk_path.strip() != 'C:\\':
                paths = [p.strip() for p in self.disk_path.split(',') if p.strip()]
            else:
                paths = [p.mountpoint for p in psutil.disk_partitions()
                         if 'fixed' in (p.opts or '').lower()]
            total_used = 0
            total_total = 0
            for p in paths:
                try:
                    du = psutil.disk_usage(p)
                    total_used += du.used
                    total_total += du.total
                except Exception:
                    pass
            disk_total = total_total
            disk_used = total_used
            disk_pct = round(total_used / total_total * 100, 2) if total_total > 0 else 0.0
        except Exception:
            disk_total = disk_used = 0
            disk_pct = 0.0

        rx, tx = self._net_totals()
        now = time.time()
        rx_rate = tx_rate = 0.0
        if self._net_prev is not None and self._net_prev_ts:
            dt = now - self._net_prev_ts
            if dt > 0:
                rx_rate = max(0.0, (rx - self._net_prev[0]) / dt)
                tx_rate = max(0.0, (tx - self._net_prev[1]) / dt)
        self._net_prev = (rx, tx)
        self._net_prev_ts = now

        # Disk I/O rate
        disk_r_rate = disk_w_rate = 0.0
        try:
            dio = psutil.disk_io_counters()
            if dio:
                dr, dw = dio.read_bytes, dio.write_bytes
                if self._disk_io_prev is not None and self._disk_io_prev_ts:
                    dt = now - self._disk_io_prev_ts
                    if dt > 0:
                        disk_r_rate = max(0.0, (dr - self._disk_io_prev[0]) / dt)
                        disk_w_rate = max(0.0, (dw - self._disk_io_prev[1]) / dt)
                self._disk_io_prev = (dr, dw)
                self._disk_io_prev_ts = now
        except Exception:
            pass

        # Monthly cumulative traffic (persisted, survives restart, resets on month rollover).
        month_key = datetime.now().strftime('%Y-%m')
        st = self._state
        if st.get('month_key') != month_key:
            st['month_key'] = month_key
            st['month_rx'] = 0
            st['month_tx'] = 0
        if 'last_rx' in st and 'last_tx' in st:
            st['month_rx'] = st.get('month_rx', 0) + max(0, rx - st['last_rx'])
            st['month_tx'] = st.get('month_tx', 0) + max(0, tx - st['last_tx'])
        st['last_rx'] = rx
        st['last_tx'] = tx
        self._save_state()

        # Network self-test (fixed public targets from local config; no server command).
        probes = {}
        if self.probe_targets:
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.probe_targets)) as ex:
                    for label, ms, ok in ex.map(lambda t: (t[0],) + probe_one(t[1], t[2]), self.probe_targets):
                        probes[label] = {'ms': ms, 'ok': ok}
            except Exception:
                probes = {}

        try:
            uptime = time.time() - psutil.boot_time()
        except Exception:
            uptime = 0.0

        # Temperature (may be empty on some hosts -> None). Non-fingerprint metric.
        try:
            temps = []
            for _name, entries in psutil.sensors_temperatures().items():
                for e in entries:
                    if e.current is not None:
                        temps.append(e.current)
            temp = round(max(temps), 1) if temps else None
        except Exception:
            temp = None

        # Swap usage. Non-fingerprint metric.
        try:
            sm = psutil.swap_memory()
            swap_used = sm.used
            swap_total = sm.total
            swap_pct = sm.percent
        except Exception:
            swap_used = swap_total = 0
            swap_pct = 0.0

        return {
            'hostname': socket.gethostname(),
            'os': os_name(),
            'uptime': round(uptime, 1),
            'cpu': round(cpu, 2),
            'mem_used': mem_used,
            'mem_total': mem_total,
            'mem_pct': round(mem_pct, 2),
            'disk_used': disk_used,
            'disk_total': disk_total,
            'disk_pct': round(disk_pct, 2),
            # Windows has no load average concept — use process count as a meaningful proxy.
            'load1': len(psutil.pids()), 'load5': 0.0, 'load15': 0.0,
            'temp': temp,
            'swap_used': swap_used,
            'swap_total': swap_total,
            'swap_pct': round(swap_pct, 2),
            'net_rx_rate': rx_rate,
            'net_tx_rate': tx_rate,
            'net_rx_month': st.get('month_rx', 0),
            'net_tx_month': st.get('month_tx', 0),
            'disk_r_rate': disk_r_rate,
            'disk_w_rate': disk_w_rate,
            'probes': probes
        }
