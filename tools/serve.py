"""
The studio's dev server: reads like python -m http.server, and writes.

`python -m http.server` cannot save. That is why the studio could only ever
hand you a zip or a block of JSON to paste somewhere yourself. This serves the
same files the same way and adds three things:

    PUT  /figures/<figure>/<file>   write a layer or a figure.json
    POST /_import?name=<figure>     run tools/import-layers.py on it
    DELETE /figures/<figure>/<file> remove one file

Standard library only, like the rest of the tools here. Nothing new to install
and nothing to build.

    python tools/serve.py            # http://127.0.0.1:5173/studio/
    python tools/serve.py 8080

It binds to 127.0.0.1 on purpose. A server that writes to disk on request has
no business being reachable from the network, and binding to 0.0.0.0 "because
it is only local anyway" is how that stops being true.
"""
import http.server
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIGURES = (ROOT / "figures").resolve()
IMPORTER = ROOT / "tools" / "import-layers.py"

MAX_BODY = 64 * 1024 * 1024          # one layer, generously
NAME_OK = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# What may be written at all. An authoring tool has no reason to drop a .py or
# an .html into the art folder, and refusing by list beats guessing.
SUFFIX_OK = {".png", ".webp", ".jpg", ".jpeg", ".json"}


def safe_target(url_path):
    """Resolve a URL path to a file inside figures/, or return None.

    Everything here is a refusal: `..`, an absolute path, a symlink pointing
    out of the tree, a name the shell would find interesting. The check is on
    the RESOLVED path, because that is the only thing that cannot be tricked
    by spelling.
    """
    path = urllib.parse.unquote(url_path.split("?", 1)[0])
    if not path.startswith("/figures/"):
        return None
    parts = [p for p in path[len("/figures/"):].split("/") if p]
    # figures/index.json is the one file that lives beside the figures rather
    # than inside one, and a new figure has to be able to add itself to it.
    if parts == ["index.json"]:
        return (FIGURES / "index.json").resolve()
    if len(parts) < 2 or len(parts) > 3:
        return None                                   # figure/file, or figure/layers/file
    if len(parts) == 3 and parts[1] != "layers":
        return None
    for p in parts:
        if not NAME_OK.match(p.lower()):
            return None
    target = (FIGURES / Path(*parts)).resolve()
    if target.suffix.lower() not in SUFFIX_OK:
        return None
    try:
        target.relative_to(FIGURES)
    except ValueError:
        return None                                   # climbed out of the tree
    return target


class Handler(http.server.SimpleHTTPRequestHandler):

    # A figure is twenty-odd full-canvas images and the studio asks for all of
    # them at once. HTTP/1.0 closes after every response, so each image needs
    # its own connection and the listen backlog overflows: measured on this
    # server, two of twelve parallel requests came back as a reset connection,
    # which the studio then reports as a layer that failed to load. Keep-alive
    # plus a real backlog fixes both halves of that.
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        """No caching, ever.

        The studio saves a file and reads it straight back. A 200 from the
        disk cache there means the editor shows the version it just replaced,
        which looks exactly like a save that silently failed.
        """
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        return self.rfile.read(n)

    def do_GET(self):
        """One extra route so the studio can tell which server it is talking to.

        Guessing from a failed PUT is worse: python -m http.server answers 501
        for a method it does not know, and a proxy in between could answer
        anything. A route that only exists here is a straight answer.
        """
        if self.path.split("?", 1)[0] == "/_studio":
            return self.reply(200, {"write": True, "root": str(ROOT)})
        super().do_GET()

    def do_PUT(self):
        target = safe_target(self.path)
        if target is None:
            return self.reply(403, {"error": "nur figures/<figur>/[layers/]<datei> "
                                             "mit png, webp, jpg oder json"})
        body = self.read_body()
        if body is None:
            return self.reply(413, {"error": "leerer oder zu grosser Inhalt"})
        if target.suffix.lower() == ".json":
            try:
                json.loads(body.decode("utf-8"))
            except Exception as e:
                # Writing broken JSON here would take the figure down and the
                # studio could not even load it again to fix it.
                return self.reply(400, {"error": "kein gueltiges JSON: %s" % e})
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        self.reply(200, {"ok": True, "path": str(target.relative_to(ROOT)).replace("\\", "/"),
                         "bytes": len(body)})

    def do_DELETE(self):
        target = safe_target(self.path)
        if target is None:
            return self.reply(403, {"error": "ausserhalb von figures/"})
        if not target.exists():
            return self.reply(404, {"error": "gibt es nicht"})
        target.unlink()
        self.reply(200, {"ok": True})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/_import":
            return self.reply(404, {"error": "unbekannt"})
        name = urllib.parse.parse_qs(parsed.query).get("name", [""])[0]
        if not NAME_OK.match(name):
            return self.reply(400, {"error": "unzulaessiger Figurenname"})
        folder = (FIGURES / name).resolve()
        try:
            folder.relative_to(FIGURES)
        except ValueError:
            return self.reply(400, {"error": "unzulaessiger Figurenname"})
        if not folder.is_dir():
            return self.reply(404, {"error": "figures/%s gibt es nicht" % name})

        # The importer keeps an existing rig and only replaces the pixels, so
        # calling it again after an upload is safe by construction. rewrite=1
        # is the deliberate exception, and the studio asks before sending it.
        cmd = [sys.executable, str(IMPORTER), str(folder), name]
        if urllib.parse.parse_qs(parsed.query).get("rewrite", [""])[0] == "1":
            cmd.append("--rewrite-rig")
        try:
            r = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300, cwd=str(ROOT))
        except subprocess.TimeoutExpired:
            return self.reply(504, {"error": "import-layers.py lief zu lange"})
        self.reply(200 if r.returncode == 0 else 500,
                   {"ok": r.returncode == 0, "out": r.stdout, "err": r.stderr})

    def log_request(self, code="-", size="-"):
        # One line per write, silence for the hundreds of GETs a reload makes.
        # Only successful requests come through here; log_error keeps its own
        # route to log_message, which is left alone on purpose - an override
        # that quietly swallowed the errors too cost an afternoon once.
        if self.command in ("PUT", "POST", "DELETE"):
            sys.stderr.write("%s %s -> %s\n" % (self.command, self.path, code))


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128          # the default of 5 dropped connections
    allow_reuse_address = True        # restart without waiting out TIME_WAIT


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    server = Server(("127.0.0.1", port), Handler)
    print("Wurzel:  %s" % ROOT)
    print("Studio:  http://127.0.0.1:%d/studio/" % port)
    print("Schreibt nur nach figures/. Strg+C beendet.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbeendet")


if __name__ == "__main__":
    main()
