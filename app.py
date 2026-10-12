"""Service dashboard: one page to see, track and control the services on this PC.

Edit services.json to add or remove services. No restart needed after editing.
A background thread checks every service every few seconds and keeps a short
history in memory, so the page can show uptime, response time and recent checks.
"""
import json
import os
import platform
import re
import socket
import subprocess
import ipaddress
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request

try:
    import psutil
except ImportError:  # the System panel just hides itself until psutil is installed
    psutil = None

BASE = Path(__file__).parent
IS_WINDOWS = platform.system() == "Windows"
SC_STATES = {"1": "stopped", "2": "starting", "3": "stopping", "4": "running"}
CHECK_EVERY = 5      # seconds between checks
HISTORY_SIZE = 120   # checks kept per service (120 x 5s = 10 minutes)
SYSTEM_EVERY = 2     # seconds between system stat samples
SYSTEM_HISTORY = 90  # samples kept (90 x 2s = 3 minutes)

app = Flask(__name__)

_lock = threading.Lock()
_history = {}        # service id -> deque of (timestamp, up, latency_ms)
_last_change = {}    # service id -> (timestamp, up) when it last flipped
_latest = {}         # service id -> latest status row
_events = deque(maxlen=50)  # recent up/down changes and actions, newest last
_started = time.time()


def load_services():
    with open(BASE / "services.json", encoding="utf-8") as f:
        return json.load(f)


DEVICES_FILE = BASE / "devices.json"   # other computers found by network scans


def load_devices():
    try:
        with open(DEVICES_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_devices(devices):
    tmp = BASE / "devices.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2)
        f.write("\n")
    tmp.replace(DEVICES_FILE)


def remember_devices(found, names, replace_ports=True):
    """Merge scan results ({ip: [ports]}) into devices.json, keeping names you've given devices."""
    now = time.time()
    with _lock:
        devices = load_devices()
        for ip, ports in found.items():
            d = devices.setdefault(ip, {"first_seen": now})
            d["ports"] = sorted(set(ports) if replace_ports else set(ports) | set(d.get("ports", [])))
            d["last_seen"] = now
            if names.get(ip):
                d["hostname"] = names[ip]
        save_devices(devices)


def save_services(services):
    """Write services.json safely: write a temp file, then swap it in."""
    tmp = BASE / "services.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(services, f, indent=2)
        f.write("\n")
    tmp.replace(BASE / "services.json")


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "service"


def clean_service(data):
    """Check a service sent from the form. Returns (service, error)."""
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 60:
        return None, "Give the service a name (up to 60 characters)."
    svc = {"name": name}

    group = str(data.get("group", "")).strip()
    if group:
        svc["group"] = group[:40]

    port = str(data.get("port", "")).strip()
    if port:
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            return None, "Port must be a number from 1 to 65535."
        svc["port"] = int(port)

    host = str(data.get("host", "")).strip()
    if host:
        # An IP address or a computer name on your network, like 192.168.1.50 or nas.local
        if not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]{1,253}", host):
            return None, "Host should be an IP address like 192.168.1.50 or a computer name."
        svc["host"] = host

    service = str(data.get("service", "")).strip()
    if service:
        # Windows service names: letters, digits, spaces, and a few symbols. No quotes or shell characters.
        if not re.fullmatch(r"[A-Za-z0-9 _.\-$]{1,80}", service):
            return None, "That Windows service name has characters that aren't allowed."
        svc["service"] = service

    if not port and not service:
        return None, "Add a port, a Windows service name, or both, so there's something to check."
    if host and not port:
        return None, "A service on another computer needs a port to check."
    if host and service:
        return None, "Start / Stop only works for services on this PC. Clear the Windows service name or the host."

    path = str(data.get("path", "")).strip()
    if path:
        if not path.startswith("/"):
            path = "/" + path
        svc["path"] = path

    public_url = str(data.get("public_url", "")).strip()
    if public_url:
        if not re.match(r"https?://", public_url):
            return None, "Public URL must start with http:// or https://."
        svc["public_url"] = public_url

    return svc, None


_lan_cache = (0.0, [])


def lan_addresses():
    """This PC's own IPv4 network addresses (like 192.168.1.222), cached for a minute."""
    global _lan_cache
    if time.time() - _lan_cache[0] < 60:
        return _lan_cache[1]
    addrs = []
    try:
        if psutil:
            for nic in psutil.net_if_addrs().values():
                addrs += [a.address for a in nic if a.family == socket.AF_INET]
        else:
            addrs = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    addrs = [a for a in dict.fromkeys(addrs) if not a.startswith(("127.", "169.254."))]
    _lan_cache = (time.time(), addrs)
    return addrs


_owners_cache = (0.0, {})


def windows_services():
    """Installed Windows services as dicts (name, display_name, status, pid, binary). Empty off Windows."""
    if not (psutil and IS_WINDOWS):
        return []
    out = []
    for svc in psutil.win_service_iter():
        try:
            info = svc.as_dict()
        except Exception:
            continue
        out.append({"name": info["name"], "display_name": info.get("display_name") or info["name"],
                    "status": info.get("status"), "start_type": info.get("start_type"),
                    "pid": info.get("pid"), "binary": info.get("binpath") or ""})
    return out


def port_owners():
    """Which program (and Windows service, if any) is listening on each local port. Cached for 30s."""
    global _owners_cache
    if not psutil:
        return {}
    if time.time() - _owners_cache[0] < 30:
        return _owners_cache[1]
    by_pid = {s["pid"]: s for s in windows_services() if s["pid"]}
    owners = {}
    try:
        conns = psutil.net_connections(kind="tcp")
    except psutil.AccessDenied:
        conns = []
    for c in conns:
        if c.status != psutil.CONN_LISTEN or not c.laddr or c.laddr.port in owners:
            continue
        process = ""
        if c.pid:
            try:
                process = psutil.Process(c.pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        svc = by_pid.get(c.pid)
        owners[c.laddr.port] = {"process": process, "pid": c.pid,
                                "service": svc["name"] if svc else None,
                                "display_name": svc["display_name"] if svc else None}
    _owners_cache = (time.time(), owners)
    return owners


def check_port(port, host=None):
    """Connect to a port. Returns (milliseconds, address that answered), or (None, None).

    With no host it checks this PC: localhost first, then the PC's network addresses,
    because some programs only listen on their network address (192.168.x.x).
    """
    hosts = [host] if host else ["127.0.0.1", *lan_addresses()]
    for host in hosts:
        start = time.perf_counter()
        try:
            with socket.create_connection((host, int(port)), timeout=1.0 if len(hosts) == 1 else 0.5):
                return round((time.perf_counter() - start) * 1000, 1), host
        except OSError:
            continue
    return None, None


def sc(*args):
    """Run Windows' service control tool. Returns (exit_code, output)."""
    result = subprocess.run(["sc", *args], capture_output=True, text=True, timeout=30)
    return result.returncode, result.stdout + result.stderr


def service_state(name):
    """State of a Windows service, or None if not applicable."""
    if not IS_WINDOWS or not name:
        return None
    code, out = sc("query", name)
    if code == 1060:
        return "not installed"
    match = re.search(r"STATE\s*:\s*(\d)", out)
    return SC_STATES.get(match.group(1), "unknown") if match else "unknown"


def wait_for(name, wanted, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if service_state(name) == wanted:
            return True
        time.sleep(0.5)
    return False


def log_event(kind, text):
    with _lock:
        _events.append({"time": time.time(), "kind": kind, "text": text})


def check_all():
    """Check every service once and record the result."""
    now = time.time()
    services = load_services()
    seen = set()
    for s in services:
        sid = s["id"]
        seen.add(sid)
        port = s.get("port")
        remote = s.get("host")
        state = None if remote else service_state(s.get("service"))
        latency, answered_on = check_port(port, remote) if port else (None, None)
        up = latency is not None if port else state == "running"

        # If the Windows service name is missing or wrong, look up the real one from the port.
        suggested = None
        if port and up and not remote and IS_WINDOWS and state in (None, "not installed"):
            owner = port_owners().get(int(port)) or {}
            if owner.get("service") and owner["service"] != s.get("service"):
                suggested = {"service": owner["service"], "display_name": owner["display_name"]}

        with _lock:
            hist = _history.setdefault(sid, deque(maxlen=HISTORY_SIZE))
            hist.append((now, up, latency))
            prev = _last_change.get(sid)
            changed = prev is not None and prev[1] != up
            if prev is None or changed:
                _last_change[sid] = (now, up)
            since = _last_change[sid][0]
            ups = sum(1 for _, u, _ in hist if u)
            latencies = [ms for _, u, ms in hist if u and ms is not None]
            _latest[sid] = {
                "id": sid,
                "name": s["name"],
                "group": s.get("group", ""),
                "port": port,
                "path": s.get("path", "/"),
                "public_url": s.get("public_url"),
                "host": remote,
                "controllable": bool(IS_WINDOWS and s.get("service") and not remote),
                "state": state,
                "up": bool(up),
                "latency": latency,
                # Address to use in links: None means localhost works, else the network address that answered.
                "suggested_service": suggested,
                "open_host": remote or (answered_on if answered_on and answered_on != "127.0.0.1" else None),
                "avg_latency": round(sum(latencies) / len(latencies), 1) if latencies else None,
                "uptime": round(100 * ups / len(hist), 1),
                "since": since,
                "history": [None if not u else (ms if ms is not None else 0) for _, u, ms in hist],
            }
        if changed:
            log_event("up" if up else "down", f"{s['name']} is {'back up' if up else 'down'}")

    with _lock:
        # Forget services removed from services.json.
        for sid in list(_latest):
            if sid not in seen:
                _latest.pop(sid, None)
                _history.pop(sid, None)
                _last_change.pop(sid, None)
        order = {s["id"]: i for i, s in enumerate(services)}
        return sorted(_latest.values(), key=lambda r: order.get(r["id"], 0))


def poll_forever():
    while True:
        try:
            check_all()
        except Exception as e:  # keep the poller alive if services.json is mid-edit
            log_event("error", f"Check failed: {e}")
        time.sleep(CHECK_EVERY)


_system = {}         # latest system stats
_system_hist = deque(maxlen=SYSTEM_HISTORY)  # (cpu %, ram %, down B/s, up B/s)


def sample_system(prev_net, prev_time):
    """Read CPU, memory, disks, network and top processes once."""
    now = time.time()
    net = psutil.net_io_counters()
    elapsed = max(now - prev_time, 0.001) if prev_net else None
    down = (net.bytes_recv - prev_net.bytes_recv) / elapsed if elapsed else 0
    up = (net.bytes_sent - prev_net.bytes_sent) / elapsed if elapsed else 0

    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()

    disks = []
    for part in psutil.disk_partitions(all=False):
        if "cdrom" in part.opts or not part.fstype:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        disks.append({"mount": part.mountpoint, "total": usage.total,
                      "used": usage.used, "percent": usage.percent})

    procs = []
    cores = psutil.cpu_count() or 1
    for proc in psutil.process_iter(["name", "memory_info"]):
        try:
            if proc.pid == 0:  # "System Idle Process"
                continue
            mem_info = proc.info["memory_info"]
            procs.append({
                "pid": proc.pid,
                "name": proc.info["name"] or "?",
                "cpu": round(proc.cpu_percent(interval=None) / cores, 1),
                "memory": mem_info.rss if mem_info else 0,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda p: (p["cpu"], p["memory"]), reverse=True)

    with _lock:
        _system_hist.append((cpu, mem.percent, down, up))
        _system.update({
            "available": True,
            "cpu": cpu,
            "cores": cores,
            "cpu_freq": round(psutil.cpu_freq().current) if psutil.cpu_freq() else None,
            "memory": {"total": mem.total, "used": mem.total - mem.available, "percent": mem.percent},
            "disks": disks,
            "net": {"down": round(down), "up": round(up),
                    "total_down": net.bytes_recv, "total_up": net.bytes_sent},
            "boot_time": psutil.boot_time(),
            "processes": procs[:6],
            "history": [list(h) for h in _system_hist],
        })
    return net, now


def poll_system_forever():
    psutil.cpu_percent(interval=None)  # first call primes the counter
    prev_net, prev_time = None, time.time()
    while True:
        try:
            prev_net, prev_time = sample_system(prev_net, prev_time)
        except Exception as e:
            log_event("error", f"System stats failed: {e}")
            time.sleep(30)
        time.sleep(SYSTEM_EVERY)


_poller = None


def start_poller():
    global _poller
    if _poller is None:
        _poller = threading.Thread(target=poll_forever, daemon=True)
        _poller.start()
        if psutil:
            threading.Thread(target=poll_system_forever, daemon=True).start()


@app.before_request
def _ensure_poller():
    start_poller()


@app.get("/")
def index():
    return render_template("index.html", check_every=CHECK_EVERY, history_size=HISTORY_SIZE,
                           system_every=SYSTEM_EVERY)


@app.get("/api/status")
def status():
    with _lock:
        rows = list(_latest.values())
        events = list(_events)
    if not rows:
        rows = check_all()
    services = load_services()
    order = {s["id"]: i for i, s in enumerate(services)}
    pinned = {s["id"] for s in services if s.get("pinned")}
    rows = [{**r, "pinned": r["id"] in pinned} for r in rows]
    rows.sort(key=lambda r: (not r["pinned"], order.get(r["id"], 0)))
    return jsonify(
        services=rows,
        events=events[::-1],
        now=time.time(),
        started=_started,
        check_every=CHECK_EVERY,
        host=socket.gethostname(),
    )


def require_dashboard_header():
    # Custom header blocks other websites from triggering this in your browser.
    if request.headers.get("X-Dashboard") != "1":
        abort(403)


@app.get("/api/system")
def system():
    if not psutil:
        return jsonify(available=False, message="Run pip install -r requirements.txt to turn on system stats.")
    with _lock:
        data = dict(_system)
    return jsonify(data or {"available": True, "loading": True})


# Windows' own background processes and ports. Hidden in Discover unless "Show system" is ticked.
SYSTEM_PROCESSES = {
    "system", "svchost.exe", "lsass.exe", "wininit.exe", "services.exe", "spoolsv.exe",
    "smss.exe", "csrss.exe", "winlogon.exe", "searchindexer.exe", "msmpeng.exe",
    "nissrv.exe", "searchhost.exe", "explorer.exe", "dashost.exe",
}
SYSTEM_PORTS = {135, 137, 138, 139, 445, 5040, 5357, 7680, 49664, 49665, 49666, 49667, 49668, 49669}


def discover():
    """Find listening TCP ports and installed Windows services on this PC."""
    tracked = load_services()
    tracked_ports = {s.get("port") for s in tracked if s.get("port") and not s.get("host")}
    tracked_services = {s.get("service", "").lower() for s in tracked if s.get("service")}
    own_pid = os.getpid()

    # Windows services, keyed by the process that runs them.
    services, service_by_pid = [], {}
    for info in windows_services():
        row = {**info, "tracked": info["name"].lower() in tracked_services, "ports": []}
        # Services living inside svchost or Windows folders are Windows' own.
        binary = row["binary"].lower()
        row["system"] = "svchost.exe" in binary or "\\windows\\" in binary
        services.append(row)
        if row["pid"]:
            service_by_pid.setdefault(row["pid"], row)

    ports, seen = [], set()
    try:
        conns = psutil.net_connections(kind="tcp")
    except psutil.AccessDenied:
        conns = []
    for c in conns:
        if c.status != psutil.CONN_LISTEN or not c.laddr:
            continue
        port, address = c.laddr.port, c.laddr.ip
        if port in seen or c.pid == own_pid:
            continue
        seen.add(port)
        process = ""
        if c.pid:
            try:
                process = psutil.Process(c.pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        svc = service_by_pid.get(c.pid)
        if svc:
            svc["ports"].append(port)
        ports.append({
            "port": port,
            "local_only": address in ("127.0.0.1", "::1"),
            "pid": c.pid,
            "process": process,
            "service": svc["name"] if svc else None,
            "display_name": svc["display_name"] if svc else None,
            "tracked": port in tracked_ports,
            "system": process.lower() in SYSTEM_PROCESSES or port in SYSTEM_PORTS
                      or (svc is not None and svc["system"]),
        })
    ports.sort(key=lambda r: r["port"])
    services.sort(key=lambda r: (r["status"] != "running", r["display_name"].lower()))
    return {"ports": ports, "services": services, "windows": IS_WINDOWS}


# Ports worth looking for on other devices, with a guess at what usually runs there.
COMMON_PORTS = {
    21: "FTP", 22: "SSH", 23: "Telnet", 53: "DNS", 80: "Web", 139: "File sharing", 443: "Web (HTTPS)",
    445: "File sharing", 554: "Camera stream", 1883: "MQTT", 1900: "UPnP", 3000: "Web app", 3389: "Remote Desktop",
    5000: "Web app / Synology", 5001: "Synology (HTTPS)", 5900: "VNC", 6789: "Web app", 7878: "Radarr",
    8000: "Web app", 8080: "Web", 8081: "Web", 8085: "Libre Hardware Monitor", 8088: "Web", 8096: "Jellyfin",
    8123: "Home Assistant", 8200: "Duplicati", 8384: "Syncthing", 8443: "Web (HTTPS)", 8920: "Jellyfin (HTTPS)",
    8989: "Sonarr", 9000: "Portainer", 9090: "Cockpit / Prometheus", 9443: "Portainer (HTTPS)",
    9696: "Prowlarr", 32400: "Plex", 51413: "Transmission",
}
WEB_PORTS = {80, 443, 3000, 5000, 5001, 6789, 7878, 8000, 8080, 8081, 8085, 8088, 8096, 8123, 8200,
             8384, 8443, 8920, 8989, 9000, 9090, 9443, 9696, 32400}

_scan = {"running": False, "done": 0, "total": 0, "devices": [], "started": None, "finished": None, "error": None}


def lan_networks():
    """The /24 networks this PC is on, like 192.168.1.0/24. Skips VPN-sized or public ranges."""
    nets = []
    for addr in lan_addresses():
        ip = ipaddress.ip_address(addr)
        if ip.is_private:
            nets.append(ipaddress.ip_network(f"{addr}/24", strict=False))
    return list(dict.fromkeys(nets))


def _probe(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=0.35):
            return True
    except OSError:
        return False


def _name_of(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except (OSError, UnicodeError):
        return None


def run_scan(ports):
    own = set(lan_addresses())
    targets = [str(ip) for net in lan_networks() for ip in net.hosts() if str(ip) not in own]
    jobs = [(ip, port) for ip in targets for port in ports]
    with _lock:
        _scan.update(running=True, done=0, total=len(jobs), devices=[], started=time.time(),
                     finished=None, error=None if targets else "Couldn't find your home network address.")
    found = {}
    try:
        with ThreadPoolExecutor(max_workers=256) as pool:
            for (ip, port), is_open in zip(jobs, pool.map(lambda j: _probe(*j), jobs)):
                if is_open:
                    found.setdefault(ip, []).append(port)
                with _lock:
                    _scan["done"] += 1
            names = dict(zip(found, pool.map(_name_of, list(found))))
    except Exception as e:
        with _lock:
            _scan.update(error=f"Scan failed: {e}")
        names = {}

    tracked = {(s.get("host"), s.get("port")) for s in load_services() if s.get("host")}
    devices = []
    for ip in sorted(found, key=lambda a: ipaddress.ip_address(a)):
        devices.append({
            "ip": ip,
            "name": names.get(ip),
            "ports": [{"port": p, "label": COMMON_PORTS.get(p, ""), "web": p in WEB_PORTS,
                       "tracked": (ip, p) in tracked or (names.get(ip), p) in tracked}
                      for p in sorted(found[ip])],
        })
    with _lock:
        _scan.update(running=False, devices=devices, finished=time.time())
    remember_devices(found, names)
    log_event("action", f"Network scan found {len(devices)} device{'s' if len(devices) != 1 else ''}")


@app.post("/api/scan")
def start_scan():
    require_dashboard_header()
    body = request.get_json(silent=True) or {}
    extra = [int(p) for p in re.findall(r"\d+", str(body.get("ports", ""))) if 1 <= int(p) <= 65535]
    ports = sorted(set(COMMON_PORTS) | set(extra[:50]))
    with _lock:
        if _scan["running"]:
            return jsonify(ok=True, message="A scan is already running.")
    threading.Thread(target=run_scan, args=(ports,), daemon=True).start()
    return jsonify(ok=True, message="Scanning your network…")


@app.get("/api/scan")
def scan_status():
    with _lock:
        return jsonify(networks=[str(n) for n in lan_networks()], **_scan)


def scan_host(host, extra_ports=()):
    """Check one device for the common ports (plus any it had before). Returns open ports."""
    known = load_devices().get(host, {}).get("ports", [])
    ports = sorted(set(COMMON_PORTS) | set(known) | set(extra_ports))
    with ThreadPoolExecutor(max_workers=64) as pool:
        results = list(pool.map(lambda p: _probe(host, p), ports))
    return [p for p, ok in zip(ports, results) if ok]


def port_info(host, port, tracked):
    return {"port": port, "label": COMMON_PORTS.get(port, ""), "web": port in WEB_PORTS,
            "tracked": (host, port) in tracked}


@app.get("/api/devices")
def list_devices():
    """This PC plus every other device: scanned ones and hosts your services point at."""
    stored = load_devices()
    services = load_services()
    tracked = {(s.get("host"), s.get("port")) for s in services if s.get("host")}
    with _lock:
        latest = dict(_latest)
    hosts = list(stored) + [s["host"] for s in services if s.get("host") and s["host"] not in stored]
    out = []
    for host in dict.fromkeys(hosts):
        d = stored.get(host, {})
        mine = [s for s in services if s.get("host") == host]
        ups = [latest[s["id"]]["up"] for s in mine if s["id"] in latest]
        hostname = d.get("hostname")
        out.append({
            "host": host,
            "name": d.get("label") or (hostname.split(".")[0] if hostname else None),
            "hostname": hostname,
            "label": d.get("label"),
            "ports": [port_info(host, p, tracked) for p in d.get("ports", [])],
            "last_seen": d.get("last_seen"),
            "services": len(mine),
            "up": sum(ups),
            "status": "unknown" if not ups else ("up" if all(ups) else ("partial" if any(ups) else "down")),
        })
    def sort_key(d):
        try:
            return (0, ipaddress.ip_address(d["host"]))
        except ValueError:
            return (1, d["host"])
    out.sort(key=sort_key)
    pc_rows = [r for r in latest.values() if not r.get("host")]
    return jsonify(
        this_pc={"name": socket.gethostname(), "addresses": lan_addresses(),
                 "services": len(pc_rows), "up": sum(1 for r in pc_rows if r["up"])},
        devices=out,
    )


def _valid_host(host):
    return re.fullmatch(r"[A-Za-z0-9.\-:\[\]]{1,253}", host or "") is not None


@app.post("/api/devices/<host>/scan")
def rescan_device(host):
    require_dashboard_header()
    if not _valid_host(host):
        abort(400)
    body = request.get_json(silent=True) or {}
    extra = [int(p) for p in re.findall(r"\d+", str(body.get("ports", ""))) if 1 <= int(p) <= 65535][:50]
    open_ports = scan_host(host, extra)
    if open_ports:
        remember_devices({host: open_ports}, {host: _name_of(host)})
    msg = (f"{len(open_ports)} open port{'s' if len(open_ports) != 1 else ''} on {host}." if open_ports
           else f"No open ports answered on {host}. It may be off or blocking checks.")
    return jsonify(ok=True, message=msg, ports=open_ports)


@app.put("/api/devices/<host>")
def rename_device(host):
    require_dashboard_header()
    label = str((request.get_json(silent=True) or {}).get("label", "")).strip()[:40]
    with _lock:
        devices = load_devices()
        d = devices.setdefault(host, {"first_seen": time.time(), "ports": []})
        if label:
            d["label"] = label
        else:
            d.pop("label", None)
        save_devices(devices)
    return jsonify(ok=True, message=f"Renamed to {label}." if label else "Name reset.")


@app.delete("/api/devices/<host>")
def forget_device(host):
    require_dashboard_header()
    if any(s.get("host") == host for s in load_services()):
        return jsonify(ok=False, message="Remove this device's services first, then forget it."), 400
    with _lock:
        devices = load_devices()
        devices.pop(host, None)
        save_devices(devices)
    return jsonify(ok=True, message=f"Forgot {host}.")


@app.get("/api/lookup")
def lookup():
    """What's listening on a local port, for filling in the add form."""
    port = request.args.get("port", "")
    if not port.isdigit():
        return jsonify(found=False)
    owner = port_owners().get(int(port))
    return jsonify(found=bool(owner), **(owner or {}))


@app.get("/api/winservices")
def list_windows_services():
    return jsonify([{k: s[k] for k in ("name", "display_name", "status")}
                    for s in sorted(windows_services(), key=lambda s: s["display_name"].lower())])


@app.post("/api/services/<sid>/use-service")
def use_suggested_service(sid):
    """Apply the Windows service name found for this tile's port."""
    require_dashboard_header()
    name = str((request.get_json(silent=True) or {}).get("service", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9 _.\-$]{1,80}", name):
        abort(400)
    with _lock:
        services = load_services()
        svc = next((s for s in services if s["id"] == sid), None)
        if not svc or svc.get("host"):
            abort(404)
        svc["service"] = name
        save_services(services)
    threading.Thread(target=check_all, daemon=True).start()
    return jsonify(ok=True, message=f"{svc['name']} now uses the Windows service {name}.")


@app.get("/api/discover")
def discover_route():
    if not psutil:
        return jsonify(ok=False, message="Run pip install -r requirements.txt to turn on Discover."), 400
    return jsonify(ok=True, **discover())


@app.get("/api/services")
def list_services():
    return jsonify(load_services())


@app.post("/api/services")
def add_service():
    require_dashboard_header()
    svc, error = clean_service(request.get_json(silent=True) or {})
    if error:
        return jsonify(ok=False, message=error), 400
    with _lock:
        services = load_services()
        ids = {s["id"] for s in services}
        base = slugify(svc["name"])
        sid, n = base, 2
        while sid in ids:
            sid, n = f"{base}-{n}", n + 1
        services.append({"id": sid, **svc})
        save_services(services)
    log_event("action", f"Added {svc['name']}")
    threading.Thread(target=check_all, daemon=True).start()
    return jsonify(ok=True, message=f"Added {svc['name']}.", id=sid)


@app.put("/api/services/<sid>")
def edit_service(sid):
    require_dashboard_header()
    svc, error = clean_service(request.get_json(silent=True) or {})
    if error:
        return jsonify(ok=False, message=error), 400
    with _lock:
        services = load_services()
        for i, s in enumerate(services):
            if s["id"] == sid:
                services[i] = {"id": sid, **svc}
                if s.get("pinned"):
                    services[i]["pinned"] = True
                break
        else:
            abort(404)
        save_services(services)
    log_event("action", f"Edited {svc['name']}")
    threading.Thread(target=check_all, daemon=True).start()
    return jsonify(ok=True, message=f"Saved {svc['name']}.")


@app.post("/api/services/<sid>/pin")
def pin_service(sid):
    require_dashboard_header()
    with _lock:
        services = load_services()
        svc = next((s for s in services if s["id"] == sid), None)
        if not svc:
            abort(404)
        if svc.get("pinned"):
            svc.pop("pinned")
        else:
            svc["pinned"] = True
        save_services(services)
    return jsonify(ok=True, pinned=bool(svc.get("pinned")),
                   message=f"{'Pinned' if svc.get('pinned') else 'Unpinned'} {svc['name']}.")


@app.delete("/api/services/<sid>")
def remove_service(sid):
    require_dashboard_header()
    with _lock:
        services = load_services()
        gone = next((s for s in services if s["id"] == sid), None)
        if not gone:
            abort(404)
        save_services([s for s in services if s["id"] != sid])
        _latest.pop(sid, None)
        _history.pop(sid, None)
        _last_change.pop(sid, None)
    log_event("action", f"Removed {gone['name']}")
    return jsonify(ok=True, message=f"Removed {gone['name']}.")


@app.post("/api/<sid>/<action>")
def control(sid, action):
    require_dashboard_header()
    if action not in ("start", "stop", "restart"):
        abort(404)
    svc = next((s for s in load_services() if s["id"] == sid), None)
    if not svc or not svc.get("service"):
        abort(404)
    if not IS_WINDOWS:
        return jsonify(ok=False, message="Service control only works on Windows."), 400

    name = svc["service"]
    code, out = 0, ""
    if action in ("stop", "restart") and service_state(name) != "stopped":
        code, out = sc("stop", name)
        if code == 0:
            wait_for(name, "stopped")
    if code == 0 and action in ("start", "restart"):
        code, out = sc("start", name)

    if code == 0:
        log_event("action", f"{svc['name']}: {action} sent")
        return jsonify(ok=True, message=f"{svc['name']}: {action} sent.")
    if code == 5:
        message = "Access denied. The dashboard must run as administrator to control services."
    else:
        message = out.strip().splitlines()[-1] if out.strip() else f"sc failed with code {code}"
    log_event("error", f"{svc['name']}: {action} failed")
    return jsonify(ok=False, message=message), 500


if __name__ == "__main__":
    # For development in PyCharm. Use start.bat to run it properly.
    app.run(host="127.0.0.1", port=8088, debug=True, use_reloader=False)
