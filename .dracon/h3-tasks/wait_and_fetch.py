#!/usr/bin/env python3
"""Query one provider video task until terminal, then download the MP4 atomically.

This is a SINGLE same-conversation wait loop, not a recurring poll:
  * one task_id, one model, one query at a time
  * bounded attempts, hard stop
  * no new paid task, no child session, no concurrent queries
  * download goes to <output>.part and is only renamed after validation
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BASE = "/home/dracon/Dev/mcode-plugins"
REC_DIR = os.path.join(BASE, ".dracon", "h3-tasks")

SLEEPS = [60, 40, 40, 40, 40, 40, 40, 40]


def now_ms():
    return int(time.time() * 1000)


def load_record(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_record(path, rec):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)


def query(task_id, model):
    proc = subprocess.run(
        [
            "mcode-tools", "connector", "call",
            "connector__matrix__query_video_generation",
            "--args", json.dumps({"task_id": task_id, "model": model}),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        return {"__error__": proc.stderr.strip()[:500] or f"exit {proc.returncode}"}
    try:
        return json.loads(proc.stdout)
    except Exception as exc:
        return {"__error__": f"unparseable query response: {exc}: {proc.stdout[:300]}"}


def find_status(data):
    if not isinstance(data, dict):
        return None, None
    for key in ("status", "state", "task_status"):
        if data.get(key):
            return str(data[key]).lower(), data
    for key in ("data", "result", "output"):
        if isinstance(data.get(key), dict):
            st, sub = find_status(data[key])
            if st:
                return st, data
    return None, data


def find_video_url(data):
    if not isinstance(data, dict):
        return None
    for key in ("video_url", "url", "download_url"):
        if isinstance(data.get(key), str) and data[key].startswith("http"):
            return data[key]
    for key in ("data", "result", "output"):
        if isinstance(data.get(key), dict):
            found = find_video_url(data[key])
            if found:
                return found
    return None


def download_atomic(url, final_path):
    part = final_path + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "mcode-h3-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        ctype = resp.headers.get("Content-Type", "")
        with open(part, "wb") as fh:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                fh.write(chunk)
    size = os.path.getsize(part)
    if size == 0:
        os.remove(part)
        raise RuntimeError("downloaded file is empty")
    with open(part, "rb") as fh:
        head = fh.read(16)
    is_mp4 = head[4:8] == b"ftyp" or head[:4] == b"\x00\x00\x00\x18"
    if not is_mp4:
        os.remove(part)
        raise RuntimeError(f"downloaded payload is not a valid MP4 (head={head[:12]!r}, ctype={ctype})")
    os.replace(part, final_path)
    return size, ctype


def main():
    record_path = sys.argv[1]
    rec = load_record(record_path)
    task_id = rec.get("provider_task_id")
    model = rec.get("model")
    if not task_id:
        print("ERROR: no provider_task_id in record")
        return 2
    out_rel = rec.get("output_file_path")
    if not out_rel:
        out_rel = os.path.join("videos", f"{task_id}.mp4")
    final_path = os.path.join(BASE, out_rel)
    os.makedirs(os.path.dirname(final_path), exist_ok=True)

    print(f"task_id={task_id} model={model} output={out_rel}")

    last = None
    for attempt, sleep in enumerate(SLEEPS, start=1):
        time.sleep(sleep)
        data = query(task_id, model)
        stamp = now_ms()
        with open(os.path.join(REC_DIR, f"query_{stamp}.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        rec["last_query_at_ms"] = stamp
        save_record(record_path, rec)

        if "__error__" in data:
            last = f"query_error: {data['__error__']}"
            print(f"attempt {attempt}: {last}")
            continue

        status, payload = find_status(data)
        last = status
        print(f"attempt {attempt}: status={status}")

        if status in ("succeeded", "success", "completed", "done"):
            url = find_video_url(data)
            if not url:
                rec["terminal_status"] = "unverified_no_url"
                save_record(record_path, rec)
                print("ERROR: succeeded but no video_url")
                return 4
            try:
                size, ctype = download_atomic(url, final_path)
            except Exception as exc:
                rec["terminal_status"] = "download_failed"
                rec["terminal_error"] = str(exc)
                save_record(record_path, rec)
                print(f"ERROR: download failed: {exc}")
                return 5
            rec["terminal_status"] = "delivered"
            rec["delivered_at_ms"] = now_ms()
            rec["delivered_size_bytes"] = size
            rec["delivered_content_type"] = ctype
            save_record(record_path, rec)
            print(f"DELIVERED path={out_rel} size={size} ctype={ctype}")
            return 0

        if status in ("failed", "cancelled", "canceled", "error"):
            rec["terminal_status"] = status
            rec["terminal_error"] = json.dumps(data)[:2000]
            save_record(record_path, rec)
            print(f"TERMINAL_{status.upper()} {json.dumps(data)[:1500]}")
            return 6

    rec["terminal_status"] = "still_running"
    save_record(record_path, rec)
    print(f"STILL_RUNNING after {len(SLEEPS)} attempts, last={last}")
    return 7


if __name__ == "__main__":
    sys.exit(main())
