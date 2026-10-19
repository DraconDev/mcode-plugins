#!/usr/bin/env python3
"""Submit exactly ONE video-generation task and persist its lifecycle mapping.

Safety properties:
  * refuses to run if the target record already has submission_attempted=True
  * validates model/duration/resolution/ratio locally BEFORE any paid call
  * captures raw stdout/stderr into separate unique files BEFORE any parsing
  * a missing/ambiguous task_id is reported as AMBIGUOUS and exits non-zero
    WITHOUT ever issuing a second submit
  * each distinct workflow uses its OWN record file, so prior records are
    retained as evidence rather than overwritten

Usage:
  submit_video.py --model MiniMax-Hailuo-2.3 --duration 10 --resolution 768P \
                  --prompt-file <path> --record <path> [--ratio 16:9] [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

BASE = "/home/dracon/Dev/mcode-plugins"
REC_DIR = os.path.join(BASE, ".dracon", "h3-tasks")
VIDEOS = os.path.join(BASE, "videos")
MAX_BODY_BYTES = 64 * 1024 * 1024
MAX_PROMPT_CHARS = 7000

# model -> (allowed durations, allowed resolutions, ratio required?, ratio allowed)
MODEL_RULES = {
    "MiniMax-H3": (
        set(range(4, 16)),
        {"768P", "2K"},
        True,
        {"adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"},
    ),
    "MiniMax-H3-Max": (
        set(range(5, 16)),
        {"480P", "768P"},
        True,
        {"adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"},
    ),
    "MiniMax-Hailuo-2.3": (
        {6, 10},
        {"768P", "1080P"},
        False,
        None,  # ratio must be omitted entirely for H2.3
    ),
}


def now_ms():
    return int(time.time() * 1000)


def sanitize(task_id):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(task_id))[:120]


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


def validate(model, duration, resolution, ratio):
    durations, resolutions, ratio_required, ratio_allowed = MODEL_RULES[model]
    if duration not in durations:
        raise SystemExit(f"ABORT: duration {duration} invalid for {model}")
    if resolution not in resolutions:
        raise SystemExit(f"ABORT: resolution {resolution} invalid for {model}")
    if model == "MiniMax-Hailuo-2.3":
        if resolution == "1080P" and duration != 6:
            raise SystemExit("ABORT: 1080P is valid for H2.3 only at 6 seconds")
        if ratio is not None:
            raise SystemExit("ABORT: ratio must be omitted for MiniMax-Hailuo-2.3")
    else:
        if not ratio:
            raise SystemExit(f"ABORT: {model} text-to-video requires a concrete ratio")
        if ratio not in ratio_allowed:
            raise SystemExit(f"ABORT: ratio {ratio} invalid for {model}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--duration", type=int, required=True)
    ap.add_argument("--resolution", required=True)
    ap.add_argument("--ratio", default=None)
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--record", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.model not in MODEL_RULES:
        raise SystemExit(f"ABORT: unknown model {args.model}")
    validate(args.model, args.duration, args.resolution, args.ratio)

    os.makedirs(REC_DIR, exist_ok=True)
    os.makedirs(VIDEOS, exist_ok=True)

    with open(args.prompt_file, encoding="utf-8") as fh:
        prompt = fh.read().strip()
    if not prompt:
        raise SystemExit("ABORT: empty prompt")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise SystemExit(f"ABORT: prompt too long ({len(prompt)} > {MAX_PROMPT_CHARS})")

    submit_args = {
        "model": args.model,
        "prompt": prompt,
        "duration": args.duration,
        "resolution": args.resolution,
    }
    if args.ratio:
        submit_args["ratio"] = args.ratio

    body = json.dumps(submit_args, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_BODY_BYTES:
        raise SystemExit(f"ABORT: request body too large ({len(body)} bytes)")

    args_file = os.path.join(REC_DIR, f"submit_args_{args.model.lower()}.json")
    with open(args_file, "w", encoding="utf-8") as fh:
        json.dump(submit_args, fh, ensure_ascii=False, indent=2)

    fingerprint = hashlib.sha256(
        json.dumps(submit_args, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()

    print(f"model={args.model} duration={args.duration} resolution={args.resolution} ratio={args.ratio or '(omitted)'}")
    print(f"prompt_chars={len(prompt)} body_bytes={len(body)} fingerprint={fingerprint[:16]}")
    print(f"args_file={args_file}")
    print(f"record={args.record}")

    if args.dry_run:
        print("DRY RUN - no submit issued")
        return 0

    record = {}
    if os.path.exists(args.record):
        with open(args.record, encoding="utf-8") as fh:
            record = json.load(fh)
    if record.get("submission_attempted"):
        print("ABORT: prior submission_attempted found for this record; refusing to submit again")
        return 2

    record.update(
        {
            "model": args.model,
            "duration": args.duration,
            "resolution": args.resolution,
            "ratio": args.ratio,
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
    with open(args.record, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    print("pre-submit record persisted -> submission_attempted=True")

    stamp = now_ms()
    stdout_path = os.path.join(REC_DIR, f"submit_stdout_{stamp}.json")
    stderr_path = os.path.join(REC_DIR, f"submit_stderr_{stamp}.log")
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
    with open(args.record, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)

    print(f"TASK_ID={task_id}")
    print(f"MODEL={args.model}")
    print(f"OUTPUT={record['output_file_path']}")
    print(f"SUBMITTED_AT_MS={record['submitted_at_ms']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
