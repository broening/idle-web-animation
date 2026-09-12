"""
Poll the three layerize jobs and download every layer they return.

The layers come back at whatever size and crop each model chose. They are
saved verbatim into figures/priest/cut-test/<model>/ so the studio's IoU can
compare them - it compares shape after cropping both sides to their own alpha
box, so a cropped layer is fine.

    python tools/collect-cut-test.py
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "figures" / "priest" / "cut-test"

FAL_KEY = os.environ.get("FAL_KEY", "")
KIE_KEY = os.environ.get("KIE_AI_API_KEY", "")

JOBS = {
    "fal-seedream-layerize": {
        "kind": "fal",
        "status": "https://queue.fal.run/bytedance/seedream/requests/01a04e02-f0bf-7122-9cf4-ed34210b2b40/status",
        "result": "https://queue.fal.run/bytedance/seedream/requests/01a04e02-f0bf-7122-9cf4-ed34210b2b40",
    },
    "fal-qwen-layered": {
        "kind": "fal",
        "status": "https://queue.fal.run/fal-ai/qwen-image-layered/requests/01a04e03-cfb0-7210-bdea-49ce08107d6d/status",
        "result": "https://queue.fal.run/fal-ai/qwen-image-layered/requests/01a04e03-cfb0-7210-bdea-49ce08107d6d",
    },
    "kie-seedream-decomposition": {
        "kind": "kie",
        "task": "6e4e5ff062e492f49d69d29da529dbd1",
    },
}


def get(url, key_header):
    req = urllib.request.Request(url, headers={"Authorization": key_header})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def urls_from(obj):
    """Every http(s) image URL anywhere in the response, in order, deduped."""
    found, seen = [], set()

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and o.startswith("http") and o not in seen:
            low = o.split("?")[0].lower()
            if low.endswith((".png", ".webp", ".jpg", ".jpeg")):
                seen.add(o)
                found.append(o)

    walk(obj)
    return found


def main():
    pending = dict(JOBS)
    results = {}
    deadline = time.time() + 900

    while pending and time.time() < deadline:
        for name in list(pending):
            job = pending[name]
            try:
                if job["kind"] == "fal":
                    st = get(job["status"], "Key " + FAL_KEY)
                    state = st.get("status")
                    if state == "COMPLETED":
                        results[name] = get(job["result"], "Key " + FAL_KEY)
                        del pending[name]
                        print(f"{name}: fertig")
                    elif state in ("FAILED", "ERROR"):
                        results[name] = {"_error": st}
                        del pending[name]
                        print(f"{name}: FEHLGESCHLAGEN {st}")
                    else:
                        print(f"{name}: {state}")
                else:
                    st = get(
                        "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=" + job["task"],
                        "Bearer " + KIE_KEY,
                    )
                    d = st.get("data") or {}
                    state = d.get("state") or d.get("status")
                    if state in ("success", "SUCCESS"):
                        results[name] = d
                        del pending[name]
                        print(f"{name}: fertig")
                    elif state in ("fail", "failed", "FAIL"):
                        results[name] = {"_error": d}
                        del pending[name]
                        print(f"{name}: FEHLGESCHLAGEN {d.get('failMsg')}")
                    else:
                        print(f"{name}: {state}")
            except Exception as e:  # noqa: BLE001 - poll loop must survive a blip
                print(f"{name}: Abfrage-Fehler {e}")
        if pending:
            time.sleep(15)

    for name, res in results.items():
        d = OUT / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "_response.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
        if "_error" in res:
            print(f"{name}: nichts zu laden")
            continue
        links = urls_from(res)
        print(f"{name}: {len(links)} Bilder")
        for i, u in enumerate(links):
            ext = u.split("?")[0].rsplit(".", 1)[-1].lower()
            p = d / f"layer_{i:02d}.{ext}"
            try:
                with urllib.request.urlopen(u, timeout=120) as r, open(p, "wb") as f:
                    f.write(r.read())
                print(f"   {p.name}  {p.stat().st_size // 1024} KB")
            except Exception as e:  # noqa: BLE001
                print(f"   {u} -> Fehler {e}")

    if pending:
        print("NOCH OFFEN:", ", ".join(pending))
        sys.exit(1)
    print("ALLE FERTIG")


if __name__ == "__main__":
    main()
