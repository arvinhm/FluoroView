"""``fluoroview [image]`` — start the local engine and open the studio in the browser."""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from . import __version__
from .config import Settings, default_cache_dir, saved_token
from .server.app import create_app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fluoroview", description="Open microscopy images in FluoroView.")
    parser.add_argument("image", nargs="?", help="image to open at start-up")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=0, help="port (default: a free port)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("--cache-dir", type=Path, default=None, help=f"pyramid cache (default: {default_cache_dir()})")
    parser.add_argument("--cache-limit-gb", type=float, default=20.0, help="cache size cap in GB (default: 20)")
    parser.add_argument("--version", action="version", version=f"FluoroView {__version__}")
    args = parser.parse_args(argv)

    sock = socket.socket(socket.AF_INET6 if ":" in args.host else socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    port = sock.getsockname()[1]

    settings = Settings(host=args.host, port=port, cache_limit_bytes=int(args.cache_limit_gb * 1e9))
    settings.token = os.environ.get("FLUOROVIEW_TOKEN") or saved_token()
    if args.cache_dir:
        settings.cache_dir = args.cache_dir
    app = create_app(settings)

    if args.image:
        try:
            app.state.registry.open(args.image)
        except Exception as exc:
            print(f"fluoroview: cannot open {args.image}: {exc}", file=sys.stderr)
            return 2

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{port}/#token={settings.token}"
    print(f"FluoroView {__version__}  {url}", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, (url,)).start()
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
