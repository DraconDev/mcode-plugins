#!/usr/bin/env python3
"""Submit exactly ONE MiniMax-H3 task and persist its lifecycle mapping.

Safety properties:
  * refuses to run if a prior record already has submission_attempted=True
  * captures raw stdout/stderr into separate unique files BEFORE any parsing
  * a missing/ambiguous task_id is reported as an AMBIGUOUS submission and the
    script exits non-zero WITHOUT ever issuing a second submit
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

BASE = "/home/dracon/Dev/mcode-plugins"
REC = os.path.join(BASE, ".dracon", "h3-tasks")
PROMPT_FILE = os.path.join(REC, "prompt_practice.txt")
RECORD_FILE = os.path.join(REC, "task_record.json")
VIDEOS = os.path.join(BASE, "videos")

MODEL = "MiniMax-H3"
DURATION = 15
RATIO = "16:9"
RESOLUTION = "2K"
MAX_BODY_BYTES = 64 * 1024 * 1024


def now_ms():
    return int(time.time() * 1000)


def sanitize(task_id):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(task_id))[:120]


def build_args(prompt):
    return {
        "model": MODEL,
        "prompt": prompt,
        "duration": DURATION,
        "ratio": RATIO,
        "resolution": RESOLUTION,
    }


def extract_task_id(data):
    if isinstance(data, dict):
        for key in ("task_id", "taskId", "id"):
            if data.get(key):
                return data[key]
        for key in ("data", "result", "output"):
            if isinstance(data.get(key), dict):
                found = extract_task_id(data[key])
                if found:
                    return found
    return None


def main():
    dry = "--dry-run" in sys.argv
    os.makedirs(REC, exist_ok=True)
    os.makedirs(VIDEOS, exist_ok=True)

    with open(PROMPT_FILE, encoding="utf-8") as fh:
        prompt = fh.read().strip()
    if not prompt:
        print("ABORT: empty prompt")
        return 1
    if len(prompt) > 7000:
        print(f"ABORT: prompt too long ({len(prompt)} > 7000)")
        return 1

    args = build_args(prompt)
    body = json.dumps(args, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_BODY_BYTES:
        print(f"ABORT: request body too large ({len(body)} bytes)")
        return 1

    args_file = os.path.join(REC, "submit_args.json")
    with open(args_file, "w", encoding="utf-8") as fh:
        json.dump(args, fh, ensure_ascii=False, indent=2)

    fingerprint = hashlib.sha256(
        json.dumps(args, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()

    print(f"model={MODEL} duration={DURATION} ratio={RATIO} resolution={RESOLUTION}")
    print(f"prompt_chars={len(prompt)} body_bytes={len(body)} fingerprint={fingerprint[:16]}")
    print(f"args_file={args_file}")

    if dry:
        print("DRY RUN - no submit issued")
        return 0

    record = {}
    if os.path.exists(RECORD_FILE):
        with open(RECORD_FILE, encoding="utf-8") as fh:
            record = json.load(fh)
    if record.get("submission_attempted"):
        print("ABORT: prior submission_attempted found; refusing to submit again")
        return 2

    record.update(
        {
            "model": MODEL,
            "duration": DURATION,
            "ratio": RATIO,
            "resolution": RESOLUTION,
            "reviewed_request_fingerprint": fingerprint,
            "prompt_chars": len(prompt),
            "submission_attempted": True,
            "submitted_at_ms": now_ms(),
            "provider_task_id": None,
            "output_file_path": None,
            "last_query_at_ms": None,
            "terminal_status": "submitted",
        }
    )
    with open(RECORD_FILE, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    print("pre-submit record persisted -> submission_attempted=True")

    stamp = now_ms()
    stdout_path = os.path.join(REC, f"submit_stdout_{stamp}.json")
    stderr_path = os.path.join(REC, f"submit_stderr_{stamp}.log")
    proc = subprocess.run(
        [
            "mcode-tools", "connector", "call",
            "connector__matrix__submit_video_generation",
            "--args-file", args_file,
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    with open(stdout_path, "w", encoding="utf-8") as fh:
        fh.write(proc.stdout)
    with open(stderr_path, "w", encoding="utf-8") as fh:
        fh.write(proc.stderr)
    print(f"exit={proc.returncode} stdout={stdout_path} stderr={stderr_path}")

    if proc.returncode != 0:
        print("--- STDERR ---")
        print(proc.stderr[:2000])
        print("Submission FAILED outright; record left for review.")
        return proc.returncode

    try:
        data = json.loads(proc.stdout)
    except Exception as exc:
        print(f"AMBIGUOUS: unparseable stdout ({exc}). Do NOT resubmit.")
        print(proc.stdout[:2000])
        return 3

    task_id = extract_task_id(data)
    if not task_id:
        print("AMBIGUOUS: no task_id in response. Do NOT resubmit.")
        print(json.dumps(data)[:2000])
        return 4

    out_path = os.path.join(VIDEOS, f"{sanitize(task_id)}.mp4")
    record["provider_task_id"] = str(task_id)
    record["output_file_path"] = os.path.relpath(out_path, BASE)
    record["terminal_status"] = "running"
    with open(RECORD_FILE, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)

    print(f"TASK_ID={task_id}")
    print(f"MODEL={MODEL}")
    print(f"OUTPUT={record['output_file_path']}")
    print(f"SUBMITTED_AT_MS={record['submitted_at_ms']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
