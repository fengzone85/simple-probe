#!/usr/bin/env python3
"""Collect system metrics from /proc (Linux). Pure stdlib, no deps."""
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


def _read(path):
    try:
        with open(path, 'r') as f:
            return f.read()
    except Exception:
        return ''


def cpu_percent(prev=None):
    """Return (current_total, current_idle, percent). percent needs prev sample."""
    line = _read('/proc/stat').splitlines()[0]
    parts = list(map(int, line.split()[1:]))
    # user nice system idle iowait irq softirq steal guest guest_nice
    total = sum(parts)
    idle = parts[3] + parts[4]
    if prev is None:
        return total, idle, 0.0
    dtotal = total - prev[0]
    didle = idle - prev[1]
    if dtotal <= 0:
        return total, idle, 0.0
    return total, idle, max(0.0, min(100.0, (1.0 - didle / dtotal) * 100.0))


def mem_info():
    info = {}
    for line in _read('/proc/meminfo').splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            info[k.strip()] = int(v.split()[0]) * 1024  # bytes
    total = info.get('MemTotal', 0)
    # available if present, else free+buffers+cached
    avail = info.get('MemAvailable', info.get('MemFree', 0) + info.get('Buffers', 0) + info.get('Cached', 0))
    used = max(0, total - avail)
    pct = (used / total * 100.0) if total else 0.0
    return used, total, pct


def disk_info(path='/'):
    # 挂载遗漏（如 DISK_PATH 指向的路径不存在）时回退到容器自身 /，避免整段采集报错丢数据
    if path and not os.path.exists(path):
        path = '/'
    try:
        st = os.statvfs(path)
    except Exception:
        return 0, 0, 0.0
    total = st.f_blocks * st.f_frsize
    free = st.f_bfree * st.f_frsize
    used = max(0, total - free)
    pct = (used / total * 100.0) if total else 0.0
    return used, total, pct


# 真实磁盘文件系统类型（用于过滤伪文件系统，避免把 tmpfs/proc 等统计进"硬盘"）。
REAL_FS = {
    'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'reiserfs', 'jfs',
    'nilfs2', 'vfat', 'ntfs', 'exfat', 'zfs'
}


def disk_list(root='/'):
    """返回所有真实磁盘挂载点的使用率列表（用于多盘展示）。
    root: agent 根目录。裸跑为 '/'；Docker 形态为 '/host'，此时需读宿主机的
    /proc/mounts 并把挂载点拼回 /host 前缀再 statvfs，才能拿到真实各盘数据。
    过滤 tmpfs/proc/sysfs/devtmpfs/cgroup 等伪文件系统。

    去重依据为底层文件系统标识 os.stat(mount).st_dev：同一物理盘（含其
    bind 子挂载，如把宿主 /var/lib/simple-probe 挂进容器、或 LXC 子目录挂载）
    的 st_dev 相同，会被合并为一条（保留最短的挂载点作为盘根）；不同物理盘
    st_dev 不同，各自保留。这样不会出现"同一块盘被算成多块"的假多盘。"""
    if root in ('/', '', None):
        mounts_path = '/proc/mounts'
        prefix = ''
    else:
        # Docker 形态（root='/host'）：宿主 /proc 必须通过 `-v /proc:/hostproc:ro`
        # 单独挂入。因为对 '/' 的递归 bind 会把「容器自身」的 proc 带进 /host/proc，
        # 直接读 /host/proc/mounts 会拿到容器挂载表（含 overlay 根、/etc/hosts 等伪盘），
        # 而非真实宿主磁盘。故优先使用独立的 /hostproc/mounts。
        prefix = root.rstrip('/')
        mounts_path = os.path.join(root, 'proc', 'mounts')
        if prefix == '/host' and os.path.exists('/hostproc/mounts'):
            mounts_path = '/hostproc/mounts'
    if not os.path.exists(mounts_path):
        mounts_path = '/proc/mounts'
        prefix = ''
    # 先收集所有候选（含底层设备号 st_dev），再按 st_dev 去重。
    cands = []
    try:
        with open(mounts_path) as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                dev, mount, fstype = parts[0], parts[1], parts[2]
                if fstype not in REAL_FS:
                    continue
                p = mount if not prefix else (prefix + '/' + mount.lstrip('/'))
                # 跳过文件型挂载点（docker 注入的 /etc/hosts、/etc/resolv.conf 等伪盘，
                # 它们不是真实磁盘，且 st_dev 与根盘不同会被误判为独立盘）。
                try:
                    if not os.path.isdir(p):
                        continue
                except Exception:
                    continue
                try:
                    st = os.statvfs(p)
                    fsdev = os.stat(p).st_dev
                except Exception:
                    continue
                total = st.f_blocks * st.f_frsize
                free = st.f_bfree * st.f_frsize
                used = max(0, total - free)
                pct = (used / total * 100.0) if total else 0.0
                cands.append({'mount': mount, 'used': used, 'total': total,
                              'pct': round(pct, 2), 'dev': fsdev})
    except Exception:
        pass
    # 按 st_dev 合并：同一物理盘只保留挂载点最短的一条。
    best = {}
    for c in cands:
        d = c['dev']
        if d not in best or len(c['mount']) < len(best[d]['mount']):
            best[d] = c
    out = [{'mount': c['mount'], 'used': c['used'], 'total': c['total'], 'pct': c['pct']}
           for c in best.values()]
    # 稳定排序：挂载点越短越靠前（/ 永远在最前）
    out.sort(key=lambda x: (len(x['mount']), x['mount']))
    return out


def disk_io_counters_robust():
    """读取系统级磁盘 IO 累计字节数 (read_bytes, write_bytes)。
    优先用 psutil；若 psutil 不可用或返回全 0（常见于容器/LXC 的 I/O 隔离、
    或纯缓存空闲机），则直接解析 /proc/diskstats，累加各真实磁盘的扇区数
    （×512 得字节），跳过 ram/loop/zram/dm-/md 等伪设备。返回 (r, w)。"""
    try:
        dio = psutil.disk_io_counters()
        if dio and (dio.read_bytes or dio.write_bytes):
            return dio.read_bytes, dio.write_bytes
    except Exception:
        pass
    try:
        tot_r = tot_w = 0
        with open('/proc/diskstats') as f:
            for line in f:
                parts = line.split()
                if len(parts) < 11:
                    continue
                dev = parts[2]
                if dev.startswith(('ram', 'loop', 'zram')) or 'dm-' in dev or dev.startswith('md'):
                    continue
                try:
                    rsect = int(parts[5])   # 字段6: 读扇区数
                    wsect = int(parts[9])   # 字段10: 写扇区数
                except (IndexError, ValueError):
                    continue
                tot_r += rsect * 512
                tot_w += wsect * 512
        return tot_r, tot_w
    except Exception:
        return 0, 0


def load_avg():
    parts = _read('/proc/loadavg').split()
    if len(parts) >= 3:
        return float(parts[0]), float(parts[1]), float(parts[2])
    return 0.0, 0.0, 0.0


def net_totals():
    """Sum rx/tx bytes across non-loopback interfaces from /proc/net/dev."""
    rx = tx = 0
    for line in _read('/proc/net/dev').splitlines()[2:]:
        if ':' not in line:
            continue
        name, data = line.split(':', 1)
        if name.strip() == 'lo':
            continue
        cols = data.split()
        rx += int(cols[0])
        tx += int(cols[8])
    return rx, tx


def os_name():
    try:
        with open('/etc/os-release') as f:
            for line in f:
                if line.startswith('PRETTY_NAME='):
                    return line.split('=', 1)[1].strip().strip('"')
    except Exception:
        pass
    return ' '.join([platform.system(), platform.release()])


def uptime_sec():
    try:
        return float(_read('/proc/uptime').split()[0])
    except Exception:
        return 0.0


def swap_info():
    """Swap usage from /proc/meminfo (bytes). Non-fingerprint metric."""
    info = {}
    for line in _read('/proc/meminfo').splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            info[k.strip()] = int(v.split()[0]) * 1024  # bytes
    total = info.get('SwapTotal', 0)
    free = info.get('SwapFree', 0)
    used = max(0, total - free)
    pct = (used / total * 100.0) if total else 0.0
    return used, total, pct


def temp_celsius():
    """Max temperature from /sys/class/thermal (°C). None if no sensor available.

    Read from thermal_zone*/temp which is in millidegrees; divide by 1000.
    This is a non-fingerprint metric (no kernel/GPU/IP info), safe to report.
    """
    temps = []
    try:
        base = '/sys/class/thermal'
        for name in os.listdir(base):
            if name.startswith('thermal_zone'):
                try:
                    v = int(_read(os.path.join(base, name, 'temp')).strip())
                    temps.append(v / 1000.0)
                except Exception:
                    pass
    except Exception:
        pass
    return round(max(temps), 1) if temps else None


def parse_probe_targets(spec):
    """Parse PROBE_TARGETS env spec: 'label:host[:port],...'. Empty -> [].

    The server NEVER supplies these targets — they are fixed in the agent's
    local config. So probing is a self-contained reachability test against
    public infrastructure, NOT a server-pushed scan (no command channel).
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


def probe_one(host, port=443, timeout=2.5, retries=3):
    """Measure RTT (ms) to host. Prefer ICMP (system ping); fall back to TCP.

    宽松化：TCP 回退依次尝试 443 / 80 / 目标端口，只要任一可连通即视为可达；
    并重试多次吸收单次抖动/端口偶发不可达，避免把运营商探测点（cm/cu 等）
    轻易判为"中断"。返回 (ms: float|None, ok: bool)。纯网络自测，只采 RTT 与
    可达性，不采任何主机指纹。"""
    def _icmp():
        if shutil.which('ping'):
            try:
                if os.name == 'nt':
                    cmd = ['ping', '-n', '1', '-w', str(int(timeout * 1000)), host]
                else:
                    cmd = ['ping', '-c', '1', '-W', str(int(timeout)), host]
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 2)
                s = (out.stdout or '') + (out.stderr or '')
                m = re.search(r'平均\s*=\s*([\d.,]+)\s*ms', s)            # Windows
                if not m:
                    m = re.search(r'=\s*[\d.]+/([\d.]+)/[\d.]+/[\d.]+\s*ms', s)  # Linux avg(min/avg/max/mdev)
                if m:
                    return round(float(m.group(1).replace(',', '.')), 1), True
                # ICMP 通但 RTT 解析失败（个别系统输出格式差异）仍判可达，
                # 避免把能 ping 通的运营商 DNS 误判为中断。Windows 的 ping 对
                # 不可达也返回 0，故仅对非 nt 生效。
                if out.returncode == 0 and os.name != 'nt':
                    return None, True
            except Exception:
                pass
        return None, False

    def _tcp():
        import socket as _sock
        # 443/80 最常被放行；目标端口（如 DNS 的 53）作为最后兜底。
        ports = [443, 80]
        if port not in ports:
            ports.append(port)
        for p in ports:
            try:
                t0 = time.time()
                with _sock.create_connection((host, p), timeout=timeout):
                    return round((time.time() - t0) * 1000.0, 1), True
            except Exception:
                continue
        return None, False

    for _ in range(max(1, retries)):
        ms, ok = _icmp()
        if ok:
            return ms, True
        ms, ok = _tcp()
        if ok:
            return ms, True
    return None, False


class Collector:
    def __init__(self, disk_path='/', state_file='/data/state.json', probe_targets=None):
        self.disk_path = disk_path
        self.state_file = state_file
        self.probe_targets = probe_targets or []
        self._cpu_prev = None
        self._net_prev = None
        self._net_prev_ts = 0
        self._disk_io_prev = None
        self._disk_io_prev_ts = 0
        self._state = self._load_state()
        # prime cpu sample
        self._cpu_prev = cpu_percent()[0:2]

    def _load_state(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_state(self):
        try:
            os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
            with open(self.state_file, 'w') as f:
                json.dump(self._state, f)
        except Exception:
            pass

    def collect(self):
        # CPU (needs a prior sample -> take new sample then compute)
        total, idle, cpu = cpu_percent(self._cpu_prev)
        self._cpu_prev = (total, idle)

        mem_used, mem_total, mem_pct = mem_info()
        disk_used, disk_total, disk_pct = disk_info(self.disk_path)
        disks = disk_list(self.disk_path)
        l1, l5, l15 = load_avg()
        swap_used, swap_total, swap_pct = swap_info()
        temp = temp_celsius()
        rx, tx = net_totals()
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
            dr, dw = disk_io_counters_robust()
            if self._disk_io_prev is not None and self._disk_io_prev_ts:
                dt = now - self._disk_io_prev_ts
                if dt > 0:
                    disk_r_rate = max(0.0, (dr - self._disk_io_prev[0]) / dt)
                    disk_w_rate = max(0.0, (dw - self._disk_io_prev[1]) / dt)
            self._disk_io_prev = (dr, dw)
            self._disk_io_prev_ts = now
        except Exception:
            pass

        # monthly cumulative (persisted, survives restart, resets on month rollover)
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

        return {
            'hostname': socket.gethostname(),
            'os': os_name(),
            'uptime': uptime_sec(),
            'cpu': round(cpu, 2),
            'mem_used': mem_used,
            'mem_total': mem_total,
            'mem_pct': round(mem_pct, 2),
            'disk_used': disk_used,
            'disk_total': disk_total,
            'disk_pct': round(disk_pct, 2),
            'load1': l1, 'load5': l5, 'load15': l15,
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
            'disks': disks,
            'probes': probes
        }
