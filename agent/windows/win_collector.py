#!/usr/bin/env python3
"""Collect system metrics on Windows using psutil.

The returned dict shape mirrors agent/collector.py so the server treats reports
from Windows and Linux agents identically (no server-side changes required).

Windows has no load average; load1/load5/load15 are reported as 0.0 placeholders.
"""
import os
import time
import json
import socket
import platform
from datetime import datetime

try:
    import psutil
except ImportError:
    import sys
    print('ERROR: psutil is required. Run: pip install -r requirements.txt', file=sys.stderr)
    raise


def os_name():
    """Best-effort human-readable Windows edition, e.g. 'Windows 10 Pro 22H2'."""
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
            return (prod + (' ' + build if build else '')).strip()
    except Exception:
        pass
    try:
        ver = platform.win32_ver()
        return ' '.join([platform.system(), ver[0], ver[1]]).strip()
    except Exception:
        return platform.platform()


class WinCollector:
    def __init__(self, disk_path='C:\\', state_file='state.json'):
        self.disk_path = disk_path or 'C:\\'
        self.state_file = state_file
        self._net_prev = None
        self._net_prev_ts = 0
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
            du = psutil.disk_usage(self.disk_path)
            disk_total = du.total
            disk_used = du.used
            disk_pct = du.percent
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
            # Windows has no load average concept — placeholder 0.0.
            'load1': 0.0, 'load5': 0.0, 'load15': 0.0,
            'temp': temp,
            'swap_used': swap_used,
            'swap_total': swap_total,
            'swap_pct': round(swap_pct, 2),
            'net_rx_rate': rx_rate,
            'net_tx_rate': tx_rate,
            'net_rx_month': st.get('month_rx', 0),
            'net_tx_month': st.get('month_tx', 0),
        }
