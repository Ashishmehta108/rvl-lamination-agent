"""
ML HTTP micro-server (Flask).
Exposes three endpoints that the TypeScript backend calls:

  POST /collect     — append a tag snapshot to the time-series CSV
  POST /predict     — score tags with the loaded Isolation Forest model
  POST /retrain     — train (or retrain) the model
  GET  /status      — return model + baseline status
"""

import json
import logging
import sys
import threading
from datetime import datetime, timezone

from flask import Flask, request, jsonify

from config import ML_SERVER_PORT
from collector import append_readings, get_deploy_time
from baseline import try_create_baseline, get_baseline_stats, is_baseline_ready
from predict import predict as ml_predict, get_model_status
from train import train as ml_train
from alert_writer import write_anomaly_alert, resolve_ml_alert

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("ml.server")

app = Flask(__name__)

# ── Lock to prevent concurrent retrains ──────────────────────
_train_lock = threading.Lock()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "ml", "time": datetime.now(timezone.utc).isoformat()})


@app.route("/status", methods=["GET"])
def status():
    """Return model status, baseline status, and deployment info."""
    deploy_time = get_deploy_time()
    model_status = get_model_status()
    baseline_stats = get_baseline_stats()
    return jsonify({
        "deploy_time": deploy_time.isoformat(),
        "baseline": baseline_stats,
        "model": model_status,
    })


@app.route("/collect", methods=["POST"])
def collect():
    """
    Collect a tag snapshot and append it to the time-series CSV.
    Body: { "timestamp": "ISO-8601", "tags": { "TAG_SLUG": value, ... } }
    """
    body = request.get_json(force=True, silent=True) or {}
    timestamp = body.get("timestamp") or datetime.now(timezone.utc).isoformat()
    tags = body.get("tags") or {}

    if not tags:
        return jsonify({"error": "tags required"}), 400

    append_readings(timestamp, tags)

    # Try creating baseline in background (cheap, only acts if window complete)
    threading.Thread(target=try_create_baseline, daemon=True).start()

    return jsonify({"ok": True, "timestamp": timestamp, "tag_count": len(tags)})


@app.route("/predict", methods=["POST"])
def predict():
    """
    Score a tag snapshot for anomalies.
    Body: { "timestamp": "ISO-8601", "tags": { "TAG_SLUG": value, ... } }
    Also writes anomaly alerts to Postgres and resolves them on return to normal.
    """
    body = request.get_json(force=True, silent=True) or {}
    timestamp = body.get("timestamp") or datetime.now(timezone.utc).isoformat()
    tags = body.get("tags") or {}

    if not tags:
        return jsonify({"error": "tags required"}), 400

    try:
        result = ml_predict(tags)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "is_anomaly": False, "score": None}), 503

    # Write or resolve alert in Postgres
    if result.get("is_anomaly"):
        alert_id = write_anomaly_alert(result, timestamp, tags)
        result["alert_id"] = alert_id
    else:
        resolve_ml_alert()

    return jsonify(result)


@app.route("/retrain", methods=["POST"])
def retrain():
    """
    Trigger model retraining.
    Body (optional): { "force": true }  — train even before baseline is ready.
    """
    if not _train_lock.acquire(blocking=False):
        return jsonify({"error": "retrain already in progress"}), 409

    def _do_train(force: bool):
        try:
            metadata = ml_train(force=force)
            log.info("Retrain complete: %s", json.dumps(metadata, default=str))
        except Exception as exc:
            log.error("Retrain failed: %s", exc)
        finally:
            _train_lock.release()

    body = request.get_json(force=True, silent=True) or {}
    force = bool(body.get("force", False))
    thread = threading.Thread(target=_do_train, args=(force,), daemon=True)
    thread.start()

    return jsonify({
        "ok": True,
        "message": "Retraining started in background.",
        "force": force,
    })


if __name__ == "__main__":
    log.info("Starting ML server on port %d", ML_SERVER_PORT)
    app.run(host="127.0.0.1", port=ML_SERVER_PORT, debug=False)
