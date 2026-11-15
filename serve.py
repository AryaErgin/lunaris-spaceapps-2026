"""Serve the offline LUNARIS app with correct JavaScript module MIME types.

`python -m http.server` takes MIME types from the operating system. Some Windows
installations report `.mjs` as text/plain, and browsers then refuse to run the
application's ES modules. This launcher pins the types the app needs.

    python serve.py            # http://127.0.0.1:8000/
    python serve.py --port 8137
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TYPES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".mesh": "application/octet-stream",
    ".woff2": "font/woff2",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def end_headers(self):
        # Local preview only: always serve the files currently on disk.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent / "web"
    handler = partial(Handler, directory=str(root))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"LUNARIS offline app: http://{args.bind}:{args.port}/  (Ctrl+C to stop)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
