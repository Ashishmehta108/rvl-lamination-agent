#!/usr/bin/env python3
"""
wal_inspector.py — CLI tool to inspect WAL directories

Usage:
  python3 wal_inspector.py              # show summary
  python3 wal_inspector.py --pending    # list pending batches
  python3 wal_inspector.py --dead       # list dead-letter batches
  python3 wal_inspector.py --replay     # manually replay dead → wal
  python3 wal_inspector.py --purge-sent # force-purge sent/ directory
"""

import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(os.getenv("BASE_DIR", "/var/lib/nonwoven-agent"))
WAL_DIR  = BASE_DIR / "wal"
SENT_DIR = BASE_DIR / "sent"
DEAD_DIR = BASE_DIR / "dead"


def fmt_size(path: Path) -> str:
    b = path.stat().st_size
    return f"{b/1024:.1f}KB" if b > 1024 else f"{b}B"


def fmt_age(path: Path) -> str:
    age_s = datetime.now(timezone.utc).timestamp() - path.stat().st_mtime
    if age_s < 60:    return f"{age_s:.0f}s ago"
    if age_s < 3600:  return f"{age_s/60:.0f}m ago"
    return f"{age_s/3600:.1f}h ago"


def load_entry(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def show_summary():
    pending = list(WAL_DIR.glob("*.json"))
    sent    = list(SENT_DIR.glob("*.json"))
    dead    = list(DEAD_DIR.glob("*.json"))

    print("=" * 52)
    print("  WAL Inspector — Nonwoven Agent")
    print("=" * 52)
    print(f"  BASE_DIR : {BASE_DIR}")
    print(f"  Pending  : {len(pending):>5} batches")
    print(f"  Sent     : {len(sent):>5} batches")
    print(f"  Dead     : {len(dead):>5} batches  ← investigate if > 0")
    print("=" * 52)

    if pending:
        oldest = sorted(pending)[0]
        d = load_entry(oldest)
        print(f"\n  Oldest pending: seq={d.get('seq')}  created={d.get('created_at')}")
        print(f"  Last error:     {d.get('last_error') or 'none'}")

    if dead:
        print(f"\n  ⚠  {len(dead)} dead-letter file(s) in {DEAD_DIR}")
        print("     Run with --dead to inspect, --replay to re-queue")


def list_entries(directory: Path, label: str):
    files = sorted(directory.glob("*.json"))
    if not files:
        print(f"No {label} entries.")
        return
    print(f"\n{'SEQ':>10}  {'RETRIES':>7}  {'AGE':>10}  {'SIZE':>8}  LAST ERROR")
    print("-" * 70)
    for p in files:
        d = load_entry(p)
        print(
            f"{d.get('seq', '?'):>10}  "
            f"{d.get('retry_count', 0):>7}  "
            f"{fmt_age(p):>10}  "
            f"{fmt_size(p):>8}  "
            f"{str(d.get('last_error') or '')[:40]}"
        )


def replay_dead():
    dead = list(DEAD_DIR.glob("*.json"))
    if not dead:
        print("No dead-letter entries to replay.")
        return
    for p in dead:
        dest = WAL_DIR / p.name
        d = load_entry(p)
        # Reset retry count
        d["retry_count"] = 0
        d["last_error"]  = "manually replayed"
        dest.write_text(json.dumps(d, indent=2, default=str))
        p.unlink()
        print(f"  Replayed: {p.name}  seq={d.get('seq')}")
    print(f"\n✓ {len(dead)} batch(es) moved back to WAL. Restart the agent to flush.")


def purge_sent():
    sent = list(SENT_DIR.glob("*.json"))
    if not sent:
        print("sent/ is already empty.")
        return
    for p in sent:
        p.unlink()
    print(f"✓ Purged {len(sent)} sent files.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WAL Inspector for Nonwoven Agent")
    parser.add_argument("--pending",    action="store_true", help="List pending WAL entries")
    parser.add_argument("--dead",       action="store_true", help="List dead-letter entries")
    parser.add_argument("--replay",     action="store_true", help="Move dead entries back to WAL")
    parser.add_argument("--purge-sent", action="store_true", help="Delete all sent/ files")
    args = parser.parse_args()

    if args.pending:
        list_entries(WAL_DIR, "pending")
    elif args.dead:
        list_entries(DEAD_DIR, "dead-letter")
    elif args.replay:
        replay_dead()
    elif args.purge_sent:
        purge_sent()
    else:
        show_summary()
