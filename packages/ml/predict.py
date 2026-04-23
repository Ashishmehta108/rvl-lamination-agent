"""
Predict module.
Loads the latest Isolation Forest model and scores incoming tag readings.
Returns anomaly flag, score, and per-tag contributions.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np

from config import MODEL_PATH, METADATA_PATH, ANOMALY_THRESHOLD

log = logging.getLogger("ml.predict")

_model_cache: dict = {}


def _load_model() -> dict:
    """Load model from disk (cached per process)."""
    global _model_cache
    if _model_cache.get("path") == str(MODEL_PATH) and MODEL_PATH.exists():
        # Check if file has been updated
        mtime = MODEL_PATH.stat().st_mtime
        if mtime == _model_cache.get("mtime"):
            return _model_cache

    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            f"No trained model found at {MODEL_PATH}. "
            "Run train.py first."
        )

    artifact = joblib.load(MODEL_PATH)
    _model_cache = {
        "path": str(MODEL_PATH),
        "mtime": MODEL_PATH.stat().st_mtime,
        "pipeline": artifact["pipeline"],
        "numeric_cols": artifact["numeric_cols"],
    }
    log.info("Model loaded from %s (%d tags)", MODEL_PATH.name, len(artifact["numeric_cols"]))
    return _model_cache


def predict(tags: dict[str, Any]) -> dict:
    """
    Score a single snapshot of tag readings.

    Parameters
    ----------
    tags : dict
        Mapping of tag_slug -> value (flat dict, numeric values only).

    Returns
    -------
    dict with:
        is_anomaly: bool
        score: float          (negative = more anomalous)
        threshold: float
        anomalous_tags: list  (tags that contributed most to anomaly)
        tag_scores: dict      (per-tag deviation from training mean)
        model_tags: list      (all tags the model knows about)
    """
    model = _load_model()
    pipeline = model["pipeline"]
    numeric_cols: list[str] = model["numeric_cols"]

    # Build feature vector (same column order as training)
    X_row = []
    missing_tags: list[str] = []
    for col in numeric_cols:
        val = tags.get(col)
        if val is None:
            # Try nested dict format
            for k, v in tags.items():
                if k == col and isinstance(v, dict):
                    val = v.get("value") or v.get("valueNumber")
                    break
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            X_row.append(float(val))
        else:
            X_row.append(0.0)  # impute missing with 0 (scaled later)
            missing_tags.append(col)

    X = np.array([X_row])

    # Get anomaly decision score
    score = float(pipeline.decision_function(X)[0])
    label = int(pipeline.predict(X)[0])  # -1=anomaly, 1=normal
    is_anomaly = score < ANOMALY_THRESHOLD

    # Per-tag contribution: deviation from training mean in scaled space
    scaler = pipeline.named_steps["scaler"]
    X_scaled = scaler.transform(X)[0]
    tag_deviations: dict[str, float] = {}
    for i, col in enumerate(numeric_cols):
        tag_deviations[col] = round(float(X_scaled[i]), 3)

    # Top anomalous tags = highest absolute deviation
    sorted_tags = sorted(tag_deviations.items(), key=lambda t: abs(t[1]), reverse=True)
    anomalous_tags = [t for t, dev in sorted_tags[:5] if abs(dev) > 2.0]

    return {
        "is_anomaly": is_anomaly,
        "score": round(score, 4),
        "threshold": ANOMALY_THRESHOLD,
        "label": label,
        "anomalous_tags": anomalous_tags,
        "tag_scores": tag_deviations,
        "missing_tags": missing_tags,
        "model_tags": numeric_cols,
        "scored_at": datetime.now(timezone.utc).isoformat(),
    }


def get_model_status() -> dict:
    """Return model status and training metadata."""
    if not MODEL_PATH.exists():
        return {"status": "no_model", "trained_at": None}

    metadata = {}
    if METADATA_PATH.exists():
        try:
            metadata = json.loads(METADATA_PATH.read_text())
        except Exception:
            pass

    return {
        "status": "ready",
        "model_path": str(MODEL_PATH),
        "model_size_bytes": MODEL_PATH.stat().st_size,
        **metadata,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    # Read JSON tags from stdin for CLI testing
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "No input provided. Pipe JSON tags via stdin."}))
        sys.exit(1)
    try:
        input_tags = json.loads(raw)
        result = predict(input_tags)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
