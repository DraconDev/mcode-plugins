#!/usr/bin/env python3
"""Generate + download 100 additional images.

API constraint discovered at runtime: generate_image accepts at most 10
entries per `requests` array (HTTP 400 otherwise). So: 10 batches of 10.

Phase 1: generate, 10 batches of 10, executed concurrently
Phase 2: resolve each success_item to a download URL and fetch to ~/Pictures
Phase 3: validate image headers/dimensions, write a manifest

Resumable: a manifest of already-generated items is reused on re-run.
"""
import json
import os
import struct
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib  # noqa: E402

ITEMS_MODULE = os.environ.get("MCODE_ITEMS_MODULE", "batch100_generate")
MANIFEST_NAME = os.environ.get("MCODE_MANIFEST", "batch100_manifest.json")
TAG = os.environ.get("MCODE_TAG", "batch100")
ITEMS = importlib.import_module(ITEMS_MODULE).ITEMS  # noqa: E402

DEST = "/home/dracon/Pictures"
REC_DIR = "/home/dracon/Dev/mcode-plugins/.dracon/h3-tasks"
BATCH_SIZE = 10
GEN_WORKERS = 4
DL_WORKERS = 6


def run(cmd, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def build_args(items):
    return {
        "requests": [
            {
                "prompt": prompt,
                "aspect_ratio": ratio,
                "resolution": "2K",
                "output_file": stem,
            }
            for stem, ratio, prompt in items
        ]
    }


def gen_batch(bi, batch, manifest_path):
    args_path = os.path.join(REC_DIR, f"{TAG}_args_{bi}.json")
    with open(args_path, "w", encoding="utf-8") as fh:
        json.dump(build_args(batch), fh, ensure_ascii=False, indent=2)

    for attempt in (1, 2):
        proc = run([
            "mcode-tools", "connector", "call",
            "connector__matrix__generate_image",
            "--args-file", args_path,
        ])
        raw_path = os.path.join(REC_DIR, f"{TAG}_gen_{bi}.json")
        with open(raw_path, "w", encoding="utf-8") as fh:
            fh.write(proc.stdout)
        if proc.returncode != 0:
            print(f"batch {bi} attempt {attempt} exit={proc.returncode}: {proc.stderr[:300]}", flush=True)
            time.sleep(10)
            continue
        try:
            data = json.loads(proc.stdout)
        except Exception as exc:
            print(f"batch {bi} attempt {attempt} unparseable: {exc}", flush=True)
            time.sleep(10)
            continue
        if data.get("code") not in (0, None):
            print(f"batch {bi} attempt {attempt} code={data.get('code')}: {str(data.get('message'))[:300]}", flush=True)
            time.sleep(10)
            continue
        ok = data.get("success_items", [])
        bad = data.get("failed_items", [])
        print(f"batch {bi}: {len(ok)} ok, {len(bad)} failed", flush=True)
        return ok, bad

    print(f"batch {bi}: EXHAUSTED after 2 attempts", flush=True)
    return [], [{"batch": bi, "reason": "exhausted retries"}]


def image_dims(path):
    with open(path, "rb") as fh:
        d = fh.read(33)
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", d[16:24])
        return "PNG", w, h
    if d[:2] == b"\xff\xd8":
        with open(path, "rb") as fh:
            fh.read(2)
            while True:
                b = fh.read(1)
                while b and b != b"\xff":
                    b = fh.read(1)
                m = fh.read(1)
                while m == b"\xff":
                    m = fh.read(1)
                if m in (b"\xc0", b"\xc1", b"\xc2", b"\xc3", b"\xc5", b"\xc6", b"\xc7",
                         b"\xc9", b"\xca", b"\xcb", b"\xcd", b"\xce", b"\xcf"):
                    fh.read(3)
                    h, w = struct.unpack(">HH", fh.read(4))
                    return "JPEG", w, h
                ln = struct.unpack(">H", fh.read(2))[0]
                fh.read(ln - 2)
    return "UNKNOWN", 0, 0


def fetch_one(item):
    node_id = item.get("node_id")
    file_name = item.get("file_name")
    if not node_id or not file_name:
        return {"file_name": file_name, "ok": False, "reason": "missing node_id/file_name"}
    try:
        proc = run(["mcode-tools", "get_asset_url", str(node_id)], timeout=180)
        if proc.returncode != 0:
            return {"file_name": file_name, "ok": False, "reason": f"url exit {proc.returncode}: {proc.stderr[:200]}"}
        url = json.loads(proc.stdout)["download_url"]
    except Exception as exc:
        return {"file_name": file_name, "ok": False, "reason": f"url error: {exc}"}

    dest = os.path.join(DEST, file_name)
    part = dest + ".part"
    try:
        cp = run(["curl", "-fsSL", "--retry", "3", "--retry-delay", "2", "-o", part, url], timeout=600)
        if cp.returncode != 0:
            if os.path.exists(part):
                os.remove(part)
            return {"file_name": file_name, "ok": False, "reason": f"curl exit {cp.returncode}"}
        size = os.path.getsize(part)
        if size == 0:
            os.remove(part)
            return {"file_name": file_name, "ok": False, "reason": "empty file"}
        fmt, w, h = image_dims(part)
        if fmt == "UNKNOWN" or w == 0:
            os.remove(part)
            return {"file_name": file_name, "ok": False, "reason": "not a valid image"}
        os.replace(part, dest)
        return {"file_name": file_name, "ok": True, "format": fmt, "w": w, "h": h, "size": size}
    except Exception as exc:
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass
        return {"file_name": file_name, "ok": False, "reason": str(exc)}


def main():
    os.makedirs(DEST, exist_ok=True)
    os.makedirs(REC_DIR, exist_ok=True)
    assert len(ITEMS) == 100, f"expected 100 items, got {len(ITEMS)}"
    stems = [i[0] for i in ITEMS]
    assert len(set(stems)) == 100, "duplicate filename stems"

    manifest_path = os.path.join(REC_DIR, MANIFEST_NAME)
    manifest = {"generated": [], "failed": [], "downloaded": []}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    already = {g.get("file_name") for g in manifest.get("generated", [])}

    batches = [ITEMS[i:i + BATCH_SIZE] for i in range(0, len(ITEMS), BATCH_SIZE)]
    todo = []
    for bi, batch in enumerate(batches, start=1):
        if all(any(fn.startswith(s) for fn in already) for s, _, _ in batch):
            print(f"batch {bi}: already done, skipping", flush=True)
            continue
        todo.append((bi, batch))

    print(f"=== PHASE 1: {len(todo)} batch(es) of {BATCH_SIZE}, {GEN_WORKERS} workers ===", flush=True)
    generated = list(manifest.get("generated", []))
    failed = list(manifest.get("failed", []))
    with ThreadPoolExecutor(max_workers=GEN_WORKERS) as pool:
        futs = {pool.submit(gen_batch, bi, b, manifest_path): bi for bi, b in todo}
        for fut in as_completed(futs):
            bi = futs[fut]
            ok, bad = fut.result()
            generated.extend(ok)
            failed.extend(bad)
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump({"generated": generated, "failed": failed, "downloaded": manifest.get("downloaded", [])}, fh, indent=2)

    print(f"PHASE 1 DONE: generated={len(generated)} failed={len(failed)}", flush=True)
    for f in failed:
        print("  FAIL:", str(f)[:200], flush=True)

    if not generated:
        print("PHASE 2 skipped: nothing generated", flush=True)
        return 1

    print(f"=== PHASE 2: fetching {len(generated)} files, {DL_WORKERS} workers ===", flush=True)
    downloaded = []
    with ThreadPoolExecutor(max_workers=DL_WORKERS) as pool:
        futs = {pool.submit(fetch_one, it): it for it in generated}
        done = 0
        for fut in as_completed(futs):
            res = fut.result()
            downloaded.append(res)
            done += 1
            if res.get("ok"):
                print(f"  [{done}/{len(generated)}] OK   {res['file_name']} {res['w']}x{res['h']} {res['size']//1024}KB", flush=True)
            else:
                print(f"  [{done}/{len(generated)}] FAIL {res.get('file_name')}: {res.get('reason')}", flush=True)
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump({"generated": generated, "failed": failed, "downloaded": downloaded}, fh, indent=2)

    ok_count = sum(1 for d in downloaded if d.get("ok"))
    print(f"PHASE 2 DONE: {ok_count}/{len(downloaded)} downloaded and validated", flush=True)
    return 0 if ok_count == len(downloaded) else 1


if __name__ == "__main__":
    sys.exit(main())
