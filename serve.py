#!/usr/bin/env python3

"""Tiny static file server for the Barebones Deck Builder.

Serves this folder over HTTP so the app runs from http://localhost instead of
being opened as a file:// URL. Browsers restrict some features (clipboard,
fetch, storage scoping) on file:// pages, so running from a server is nicer.

The page pings `/__heartbeat` while it is open. When the tab is closed the
page sends `/__shutdown` (via navigator.sendBeacon), and this server exits
automatically after a short grace period. That is the closest a web page can
get to "run the kill command" -- browsers cannot run shell commands, so the
*server* shuts *itself* down on request instead.

Usage:
    python3 serve.py            # serves on an auto-picked free port
    python3 serve.py 8000       # serves on a specific port
    python3 serve.py --no-exit  # serve and never auto-shutdown
"""

import http.server
import socketserver
import socket
import sys
import os
import threading
import time
import webbrowser
from functools import partial

# Seconds to wait after the last "tab closed" beacon before shutting down.
# Kept comfortably longer than a page reload so that reloading (which briefly
# unloads the old page, firing its shutdown beacon, before the new page's
# requests arrive and cancel it) never stops the server.
SHUTDOWN_GRACE = 6

_state = {
    "httpd": None,
    "shutdown_at": None,     # timestamp when we should exit, or None
    "never_exit": False,
    "lock": threading.Lock(),
}


def find_free_port(preferred):
    """Return `preferred` if free, otherwise an OS-assigned free port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never cache so edits show up on reload during development.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _cancel_shutdown(self):
        # Any activity from the page means a tab is (still) open -- cancel any
        # pending shutdown. This is what makes a reload safe: the reloaded page
        # immediately requests its assets, cancelling the shutdown that the old
        # page's unload beacon may have scheduled.
        with _state["lock"]:
            _state["shutdown_at"] = None

    def do_GET(self):
        if self.path.startswith("/__heartbeat"):
            self._cancel_shutdown()
            self._no_content()
            return
        # Serving any real file (index.html, app.js, ...) also counts as
        # activity, so a reload cancels a pending shutdown right away.
        self._cancel_shutdown()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__shutdown"):
            if not _state["never_exit"]:
                with _state["lock"]:
                    _state["shutdown_at"] = time.time() + SHUTDOWN_GRACE
            self._no_content()
            return
        self._cancel_shutdown()
        self.send_error(404)

    def _no_content(self):
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, fmt, *args):
        # Quieter, more readable logging.
        sys.stderr.write("  %s\n" % (fmt % args))


def shutdown_watcher():
    """Background thread: stop the server once the grace period elapses."""
    while True:
        time.sleep(1)
        with _state["lock"]:
            when = _state["shutdown_at"]
        if when is not None and time.time() >= when:
            print("\nTab closed -- shutting down.")
            httpd = _state["httpd"]
            if httpd is not None:
                threading.Thread(target=httpd.shutdown, daemon=True).start()
            return


def main():
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    _state["never_exit"] = "--no-exit" in flags
    open_browser = "--no-browser" not in flags

    port = 8000
    if args:
        try:
            port = int(args[0])
        except ValueError:
            print(f"Invalid port: {args[0]!r}", file=sys.stderr)
            return 1

    port = find_free_port(port)
    directory = os.path.dirname(os.path.abspath(__file__))
    handler = partial(Handler, directory=directory)

    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    _state["httpd"] = httpd

    url = f"http://localhost:{port}/index.html"
    print("Barebones Deck Builder is running:")
    print(f"  {url}")
    if _state["never_exit"]:
        print("Auto-shutdown disabled. Press Ctrl+C to stop.\n")
    else:
        print(f"Closes automatically ~{SHUTDOWN_GRACE}s after the last tab is closed.")
        print("Press Ctrl+C to stop now.\n")

    if not _state["never_exit"]:
        threading.Thread(target=shutdown_watcher, daemon=True).start()

    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
