"""
alert_writer.py
Writes ML anomaly detections directly into the Postgres alert_events table.
Uses psycopg2 (same DB as the backend's Drizzle/pg-boss connection).
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import psycopg2
import psycopg2.extras

from config import POSTGRES_URL, MACHINE_ID, MACHINE_REVISION

log = logging.getLogger("ml.alert_writer")


def _conn():
    """Open a new Postgres connection using the shared POSTGRES_URL."""
    return psycopg2.connect(POSTGRES_URL)


def _new_id(prefix: str = "alert") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def write_anomaly_alert(
    prediction: dict[str, Any],
    timestamp: str,
    raw_tags: dict[str, Any],
) -> str | None:
    """
    Insert an anomaly alert into the Postgres alert_events table.

    Parameters
    ----------
    prediction   Result dict from predict.predict()
    timestamp    ISO-8601 timestamp of the anomalous reading
    raw_tags     Original tag values for payload context

    Returns the alert_events.id if inserted, None if skipped/failed.
    """
    if not prediction.get("is_anomaly"):
        return None

    score = prediction.get("score", 0.0)
    anomalous_tags = prediction.get("anomalous_tags", [])
    tag_scores = prediction.get("tag_scores", {})

    # Severity: score < -0.7 = critical, else warning
    severity = "critical" if score < -0.7 else "warning"

    tag_list_str = ", ".join(anomalous_tags[:3]) if anomalous_tags else "multiple tags"
    title = f"ML Anomaly Detected ({severity.upper()})"
    description = (
        f"Isolation Forest flagged an anomaly at {timestamp}. "
        f"Score: {score:.4f}. Top deviating tags: {tag_list_str}."
    )
    dedupe_key = f"ml:{MACHINE_ID}:{MACHINE_REVISION}:anomaly"

    payload = {
        "ml_score": score,
        "threshold": prediction.get("threshold"),
        "anomalous_tags": anomalous_tags,
        "tag_scores": {k: v for k, v in list(tag_scores.items())[:20]},  # cap payload size
        "machine_id": MACHINE_ID,
        "machine_revision": MACHINE_REVISION,
        "source": "ml_isolation_forest",
        "ts": timestamp,
    }

    alert_id = _new_id("alert")

    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                # Upsert: if an open ML anomaly alert already exists for this
                # machine, skip (dedupe) rather than flooding.
                cur.execute(
                    """
                    INSERT INTO alert_events (
                        id, machine_id, rule_id, severity, status,
                        title, description, dedupe_key, payload, llm_analysis,
                        starts_at, created_at
                    )
                    VALUES (%s, %s, NULL, %s, 'open', %s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (machine_id, dedupe_key) DO NOTHING
                    """,
                    (
                        alert_id,
                        MACHINE_ID,
                        severity,
                        title,
                        description,
                        dedupe_key,
                        psycopg2.extras.Json(payload),
                        psycopg2.extras.Json({}),
                        timestamp,
                    ),
                )
                inserted = cur.rowcount
            conn.commit()

        if inserted:
            log.warning(
                "Anomaly alert created: id=%s score=%.4f tags=%s",
                alert_id, score, anomalous_tags,
            )
            return alert_id
        else:
            log.debug("Anomaly alert deduped (existing open alert for %s)", MACHINE_ID)
            return None

    except Exception as exc:
        log.error("Failed to write anomaly alert to Postgres: %s", exc)
        return None


def resolve_ml_alert() -> bool:
    """
    Mark the open ML anomaly alert as resolved when readings return to normal.
    Called when predict() returns is_anomaly=False.
    """
    dedupe_key = f"ml:{MACHINE_ID}:{MACHINE_REVISION}:anomaly"
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE alert_events
                    SET status = 'resolved', ends_at = NOW()
                    WHERE machine_id = %s
                      AND dedupe_key = %s
                      AND status = 'open'
                    """,
                    (MACHINE_ID, dedupe_key),
                )
                updated = cur.rowcount
            conn.commit()
        if updated:
            log.info("ML anomaly alert resolved for machine %s", MACHINE_ID)
        return updated > 0
    except Exception as exc:
        log.error("Failed to resolve ML alert: %s", exc)
        return False
