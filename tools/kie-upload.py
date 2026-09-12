"""
Upload a file to kie.ai's own storage and print the URL its models can fetch.

kie's image fetcher runs on Volcano Engine in Beijing and cannot reach Western
hosts: a fal CDN link came back with a TLS certificate issued for a Kubernetes
cluster, and a Wikimedia link timed out. Their own Playground sidesteps this by
uploading the file first — that is what the "Upload successfully" line in the
form means — and this does the same thing over the API.

Two traps their documentation sets:
  - one page gives the host as api.kie.ai. That returns 404. The working host
    is kieai.redpandaai.co.
  - the result files sit on tempfile.aiquickdraw.com, which refuses Python's
    default user agent with 403. Fetch them with curl.

Uploads are free and the file is kept for three days.

    python tools/kie-upload.py figures/priest/source.png
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ENDPOINT = "https://kieai.redpandaai.co/api/file-stream-upload"


def upload(path, upload_path="images/idle-web-animation"):
    key = os.environ.get("KIE_AI_API_KEY")
    if not key:
        sys.exit("KIE_AI_API_KEY fehlt in der Umgebung")
    p = Path(path)
    if not p.exists():
        sys.exit(f"Datei fehlt: {p}")

    out = subprocess.run(
        ["curl", "-s", "-m", "300", "-X", "POST", ENDPOINT,
         "-H", "Authorization: Bearer " + key,
         "-F", f"file=@{p}",
         "-F", f"uploadPath={upload_path}",
         "-F", f"fileName={p.name}"],
        capture_output=True, text=True, check=True,
    ).stdout

    try:
        res = json.loads(out)
    except json.JSONDecodeError:
        sys.exit("Antwort war kein JSON:\n" + out[:400])

    url = (res.get("data") or {}).get("downloadUrl")
    if not url:
        sys.exit("Kein downloadUrl in der Antwort:\n" + json.dumps(res)[:400])

    size = (res.get("data") or {}).get("fileSize", 0)
    print(f"{p.name}  {size // 1024} KB hochgeladen")
    print(url)
    return url


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Aufruf: python tools/kie-upload.py <datei> [zielpfad]")
    upload(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "images/idle-web-animation")
