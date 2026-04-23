"""
Time-series data collector.
Appends incoming sensor batches to a local CSV file for ML training.
This avoids depending on MongoDB for the ML pipeline.
"""

import csv
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import TIMESERIES_CSV, DEPLOY_MARKER

log = logging.getLogger("ml.collector")

# ── CSV header (written once) ─────────────────────────────────
# Dynamic columns: timestamp + one column per numeric tag


def _ensure_deploy_marker() -> datetime:
    """Record the deployment timestamp on first ever call."""
    if DEPLOY_MARKER.exists():
        ts_str = DEPLOY_MARKER.read_text().strip()
        return datetime.fromisoformat(ts_str)
    now = datetime.now(timezone.utc)
    DEPLOY_MARKER.write_text(now.isoformat())
    log.info("Deployment timestamp recorded: %s", now.isoformat())
    return now


def get_deploy_time() -> datetime:
    """Return the deployment timestamp (creating if needed)."""
    return _ensure_deploy_marker()


def append_readings(timestamp: str, tags: dict[str, Any]) -> None:
    """
    Append a single snapshot of tag readings to the time-series CSV.

    Parameters
    ----------
    timestamp : str
        ISO-8601 timestamp of the reading.
    tags : dict
        Mapping of tag_slug -> value (only numeric values are kept).
    """
    _ensure_deploy_marker()

    # Filter to numeric values only
    numeric_tags: dict[str, float] = {}
    for slug, val in tags.items():
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            numeric_tags[slug] = float(val)
        elif isinstance(val, dict):
            # Handle nested format: {"value": 42.0, "label": "...", "unit": "..."}
            v = val.get("value") or val.get("valueNumber")
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                numeric_tags[slug] = float(v)

    if not numeric_tags:
        return

    file_exists = TIMESERIES_CSV.exists() and TIMESERIES_CSV.stat().st_size > 0

    if file_exists:
        # Read existing header to maintain column order
        with open(TIMESERIES_CSV, "r", newline="") as f:
            reader = csv.reader(f)
            existing_header = next(reader, None)
        if existing_header:
            existing_cols = set(existing_header[1:])  # skip 'timestamp'
            new_cols = set(numeric_tags.keys()) - existing_cols
            if new_cols:
                # New tags appeared — rewrite header (rare path)
                header = existing_header + sorted(new_cols)
                _rewrite_header(header)
            else:
                header = existing_header
        else:
            header = ["timestamp"] + sorted(numeric_tags.keys())
    else:
        header = ["timestamp"] + sorted(numeric_tags.keys())

    # Write row
    with open(TIMESERIES_CSV, "a", newline="") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(header)
        row = [timestamp]
        for col in header[1:]:
            row.append(numeric_tags.get(col, ""))
        writer.writerow(row)


def _rewrite_header(new_header: list[str]) -> None:
    """Rewrite the CSV file with an expanded header (keeps existing data)."""
    import tempfile, shutil

    tmp = TIMESERIES_CSV.with_suffix(".tmp")
    with open(TIMESERIES_CSV, "r", newline="") as src, \
         open(tmp, "w", newline="") as dst:
        reader = csv.DictReader(src)
        writer = csv.DictWriter(dst, fieldnames=new_header)
        writer.writeheader()
        for row in reader:
            writer.writerow(row)
    shutil.move(str(tmp), str(TIMESERIES_CSV))
    log.info("CSV header expanded: %d columns", len(new_header))
