# Static server for run.sh: serves ROOT, saves POSTed canvases to OUT and appends other POSTs to LOG.
import base64, http.server, sys, urllib.parse

ROOT, PORT, OUT, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        url = urllib.parse.urlparse(self.path)
        if url.path == "/__save":
            name = urllib.parse.parse_qs(url.query)["name"][0]
            with open(f"{OUT}/{name}.png", "wb") as f:
                f.write(base64.b64decode(body.split(",", 1)[1]))
        else:
            with open(LOG, "a") as f:
                f.write(body + "\n")
        self.send_response(200)
        self.end_headers()


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
