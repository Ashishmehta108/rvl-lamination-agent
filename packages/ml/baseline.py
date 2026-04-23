"""
Baseline manager.
Captures the first 7 calendar days of data after deployment and
saves it as the permanent baseline dataset.
"""

import logging
import shutil
from datetime import timedelta

import pandas as pd

from config import (
    BASELINE_CSV,
    BASELINE_DAYS,
    TIMESERIES_CSV,
)
from collector import get_deploy_time

log = logging.getLogger("ml.baseline")


def is_baseline_ready() -> bool:
    """Return True if the baseline CSV already exists and has data."""
    return BASELINE_CSV.exists() and BASELINE_CSV.stat().st_size > 100


def try_create_baseline() -> bool:
    """
    Check if we have enough data to create the week-1 baseline.

    The baseline covers the first BASELINE_DAYS calendar days after
    the deployment timestamp. Once created, it is never overwritten.

    Returns True if baseline was just created or already exists.
    """
    if is_baseline_ready():
        log.info("Baseline already exists: %s", BASELINE_CSV)
        return True

    if not TIMESERIES_CSV.exists():
        log.warning("No time-series data yet — cannot create baseline.")
        return False

    deploy_time = get_deploy_time()
    cutoff = deploy_time + timedelta(days=BASELINE_DAYS)

    df = pd.read_csv(TIMESERIES_CSV, parse_dates=["timestamp"])
    if df.empty:
        log.warning("Time-series CSV is empty.")
        return False

    # Filter to first 7 days
    baseline_df = df[df["timestamp"] <= cutoff].copy()
    if baseline_df.empty:
        log.warning("No data within the baseline window yet.")
        return False

    # Check if we've actually passed the baseline window
    latest_ts = df["timestamp"].max()
    if pd.Timestamp(latest_ts) < pd.Timestamp(cutoff):
        day_count = (pd.Timestamp(latest_ts) - pd.Timestamp(deploy_time)).days + 1
        log.info(
            "Baseline window not complete yet. Day %d/%d. "
            "Collecting until %s.",
            day_count, BASELINE_DAYS, cutoff.isoformat()
        )
        return False

    # Save baseline (permanent copy)
    baseline_df.to_csv(BASELINE_CSV, index=False)
    log.info(
        "Baseline created: %d rows, %d columns, %s -> %s",
        len(baseline_df),
        len(baseline_df.columns),
        baseline_df["timestamp"].min(),
        baseline_df["timestamp"].max(),
    )
    return True


def get_baseline_stats() -> dict:
    """Return summary statistics of the baseline dataset."""
    if not is_baseline_ready():
        return {"status": "not_ready", "rows": 0}

    df = pd.read_csv(BASELINE_CSV, parse_dates=["timestamp"])
    numeric_cols = df.select_dtypes(include=["number"]).columns.tolist()

    return {
        "status": "ready",
        "rows": len(df),
        "columns": len(df.columns),
        "numeric_tags": numeric_cols,
        "time_range": {
            "start": str(df["timestamp"].min()),
            "end": str(df["timestamp"].max()),
        },
        "stats": df[numeric_cols].describe().to_dict() if numeric_cols else {},
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    result = try_create_baseline()
    print(f"Baseline ready: {result}")
    if result:
        stats = get_baseline_stats()
        print(f"Baseline stats: {stats['rows']} rows, {stats['columns']} cols")
