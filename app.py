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
import threading
import time
from collections import deque
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

    service = str(data.get("service", "")).strip()
    if service:
        # Windows service names: letters, digits, spaces, and a few symbols. No quotes or shell characters.
        if not re.fullmatch(r"[A-Za-z0-9 _.\-$]{1,80}", service):
            return None, "That Windows service name has characters that aren't allowed."
        svc["service"] = service

    if not port and not service:
        return None, "Add a port, a Windows service name, or both, so there's something to check."

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


def check_port(port):
    """Milliseconds to connect to this port on this machine, or None if nothing answers."""
    start = time.perf_counter()
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.8):
            return round((time.perf_counter() - start) * 1000, 1)
    except OSError:
        return None


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
        state = service_state(s.get("service"))
        latency = check_port(port) if port else None
        up = latency is not None if port else state == "running"

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
                "controllable": bool(IS_WINDOWS and s.get("service")),
                "state": state,
                "up": bool(up),
                "latency": latency,
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
    tracked_ports = {s.get("port") for s in tracked if s.get("port")}
    tracked_services = {s.get("service", "").lower() for s in tracked if s.get("service")}
    own_pid = os.getpid()

    # Windows services, keyed by the process that runs them.
    services, service_by_pid = [], {}
    if IS_WINDOWS:
        for svc in psutil.win_service_iter():
            try:
                info = svc.as_dict()
            except Exception:
                continue
            row = {
                "name": info["name"],
                "display_name": info.get("display_name") or info["name"],
                "status": info.get("status"),
                "start_type": info.get("start_type"),
                "pid": info.get("pid"),
                "binary": info.get("binpath") or "",
                "tracked": info["name"].lower() in tracked_services,
                "ports": [],
            }
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
