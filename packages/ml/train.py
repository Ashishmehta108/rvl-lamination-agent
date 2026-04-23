"""
Isolation Forest trainer.
Reads the time-series CSV and trains (or retrains) the anomaly detection model.
Saves model + metadata, archives old models to training_history/.
"""

import json
import logging
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

from config import (
    TIMESERIES_CSV,
    BASELINE_CSV,
    MODEL_PATH,
    METADATA_PATH,
    HISTORY_DIR,
    N_ESTIMATORS,
    ANOMALY_CONTAMINATION,
    RANDOM_STATE,
)
from baseline import try_create_baseline, is_baseline_ready

log = logging.getLogger("ml.train")


def load_training_data(min_rows: int = 100) -> tuple[pd.DataFrame, list[str]]:
    """
    Load and prepare the training data from the time-series CSV.
    Returns the cleaned DataFrame and the list of numeric tag columns.
    Falls back to baseline CSV if main CSV is unavailable.
    """
    csv_to_use = TIMESERIES_CSV if TIMESERIES_CSV.exists() else BASELINE_CSV
    if not csv_to_use.exists():
        raise FileNotFoundError(f"No training data found at {csv_to_use}")

    df = pd.read_csv(csv_to_use, parse_dates=["timestamp"])

    if len(df) < min_rows:
        raise ValueError(
            f"Insufficient training data: {len(df)} rows (need >= {min_rows}). "
            "Let the system collect more data before retraining."
        )

    # Identify numeric tag columns (everything except timestamp)
    tag_cols = [c for c in df.columns if c != "timestamp"]
    numeric_cols = df[tag_cols].select_dtypes(include=["number"]).columns.tolist()

    if not numeric_cols:
        raise ValueError("No numeric columns found in training data.")

    # Drop rows where ALL numeric values are missing
    df_clean = df[["timestamp"] + numeric_cols].dropna(how="all", subset=numeric_cols)

    # Fill remaining NaN with column median (handles sparse readings)
    df_clean[numeric_cols] = df_clean[numeric_cols].fillna(
        df_clean[numeric_cols].median()
    )

    log.info(
        "Training data loaded: %d rows, %d numeric tags from %s",
        len(df_clean), len(numeric_cols), csv_to_use.name,
    )
    return df_clean, numeric_cols


def train(force: bool = False) -> dict:
    """
    Train the Isolation Forest model.

    Parameters
    ----------
    force : bool
        If True, train even if baseline is not yet complete.

    Returns
    -------
    dict  Training result metadata.
    """
    # Attempt to finalize baseline first
    try_create_baseline()

    if not is_baseline_ready() and not force:
        raise RuntimeError(
            "Baseline not ready yet. The system needs 7 calendar days of data. "
            "Use force=True to train on whatever data is available."
        )

    df, numeric_cols = load_training_data()
    X = df[numeric_cols].values

    # Build pipeline: standard scaler + Isolation Forest
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("iforest", IsolationForest(
            n_estimators=N_ESTIMATORS,
            contamination=ANOMALY_CONTAMINATION,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        )),
    ])

    pipeline.fit(X)

    # Compute training-set scores for reference
    scores = pipeline.decision_function(X)
    anomaly_labels = pipeline.predict(X)
    n_anomalies = int((anomaly_labels == -1).sum())

    # Archive existing model if present
    if MODEL_PATH.exists():
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        archive = HISTORY_DIR / f"model_{ts}.joblib"
        shutil.copy2(MODEL_PATH, archive)
        log.info("Archived old model to %s", archive.name)

    # Persist new model
    joblib.dump({"pipeline": pipeline, "numeric_cols": numeric_cols}, MODEL_PATH)

    # Persist metadata
    metadata = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_rows": len(df),
        "numeric_tags": numeric_cols,
        "n_estimators": N_ESTIMATORS,
        "contamination": ANOMALY_CONTAMINATION,
        "training_anomalies_found": n_anomalies,
        "training_anomaly_rate": round(n_anomalies / len(df), 4),
        "score_mean": float(np.mean(scores)),
        "score_std": float(np.std(scores)),
        "time_range": {
            "start": str(df["timestamp"].min()),
            "end": str(df["timestamp"].max()),
        },
        "baseline_used": is_baseline_ready(),
    }
    METADATA_PATH.write_text(json.dumps(metadata, indent=2))

    log.info(
        "Model trained: %d rows, %d tags, %d anomalies (%.1f%%)",
        len(df), len(numeric_cols), n_anomalies,
        100 * n_anomalies / len(df),
    )
    return metadata


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    force_flag = "--force" in sys.argv
    try:
        result = train(force=force_flag)
        print(json.dumps(result, indent=2))
        sys.exit(0)
    except Exception as exc:
        log.error("Training failed: %s", exc)
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
