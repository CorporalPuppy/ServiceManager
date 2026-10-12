"""Runs the dashboard in the background with an icon in the Windows system tray.

The icon is green when every service is up, red when something is down, and grey
while starting. Hover it for a summary; right-click for Open and Quit.
start.bat launches this, so there's no console window to keep open.
"""
import logging
import socket
import threading
import time
import webbrowser
from pathlib import Path

import pystray
from PIL import Image, ImageDraw
from waitress import create_server

import app as dashboard

HOST, PORT = "127.0.0.1", 8088
URL = f"http://localhost:{PORT}"
COLORS = {"starting": "#9ca3af", "ok": "#22c55e", "down": "#ef4444"}

logging.basicConfig(filename=Path(__file__).with_name("tray.log"), level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")


def already_running():
    try:
        with socket.create_connection((HOST, PORT), timeout=0.5):
            return True
    except OSError:
        return False


def make_icon(state):
    """A round status light, drawn at 64px so Windows scales it down cleanly."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), fill="#111827")
    d.ellipse((12, 12, 52, 52), fill=COLORS[state])
    return img


def summary():
    with dashboard._lock:
        rows = list(dashboard._latest.values())
    up = sum(1 for r in rows if r["up"])
    down = [r["name"] for r in rows if not r["up"]]
    return rows, up, down


def main():
    if already_running():
        webbrowser.open(URL)
        return

    server = create_server(dashboard.app, host=HOST, port=PORT, threads=8)
    threading.Thread(target=server.run, daemon=True).start()
    dashboard.start_poller()
    logging.info("Dashboard started on %s", URL)
    threading.Timer(1.5, webbrowser.open, args=(URL,)).start()

    def status_text(_item=None):
        rows, up, down = summary()
        if not rows:
            return "Starting…"
        return f"{up} of {len(rows)} services up" + (f" · down: {', '.join(down[:3])}" if down else "")

    def open_dashboard(_icon=None, _item=None):
        webbrowser.open(URL)

    def quit_app(icon, _item):
        logging.info("Quit from tray")
        icon.visible = False
        server.close()
        icon.stop()

    icon = pystray.Icon(
        "service-dashboard",
        make_icon("starting"),
        "Service dashboard: starting",
        menu=pystray.Menu(
            pystray.MenuItem("Open dashboard", open_dashboard, default=True),
            pystray.MenuItem(status_text, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit (stops the dashboard)", quit_app),
        ),
    )

    def watch(icon):
        icon.visible = True
        try:
            icon.notify("Running at " + URL, "Service dashboard")
        except Exception:
            pass
        last_state, last_down = None, None
        while True:
            try:
                last_state, last_down = refresh(icon, last_state, last_down)
            except Exception:
                logging.exception("Tray update failed")
            time.sleep(dashboard.CHECK_EVERY)

    def refresh(icon, last_state, last_down):
        rows, up, down = summary()
        state = "starting" if not rows else ("down" if down else "ok")
        if state != last_state:
            icon.icon = make_icon(state)
            last_state = state
        icon.title = f"Service dashboard: {status_text()}"[:127]
        if rows:
            newly_down = set(down) - (last_down or set())
            if last_down is not None and newly_down:  # skip the first check after starting
                try:
                    icon.notify(", ".join(sorted(newly_down)) + " went down", "Service dashboard")
                except Exception:
                    pass
            last_down = set(down)
        icon.update_menu()
        return last_state, last_down

    icon.run(setup=lambda i: threading.Thread(target=watch, args=(i,), daemon=True).start())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logging.exception("Tray crashed")
        raise
