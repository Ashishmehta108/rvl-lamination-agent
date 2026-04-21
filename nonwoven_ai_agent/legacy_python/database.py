"""
SQLite persistence layer for the Nonwoven AI Agent.
Stores readings, alerts, daily summaries, insights, and monthly reports.
Designed for 24/7 operation — survives restarts.
"""

import sqlite3
import json
import threading
from datetime import datetime, timedelta
from contextlib import contextmanager

from config import DB_PATH

_local = threading.local()


@contextmanager
def get_db():
    """Thread-safe database connection context manager."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH, timeout=10)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield _local.conn
        _local.conn.commit()
    except Exception:
        _local.conn.rollback()
        raise


def init_db():
    """Create all tables if they don't exist."""
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS readings (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT NOT NULL,
                tag_name    TEXT NOT NULL,
                value       REAL,
                unit        TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_readings_ts
                ON readings(timestamp);
            CREATE INDEX IF NOT EXISTS idx_readings_tag
                ON readings(tag_name, timestamp);

            CREATE TABLE IF NOT EXISTS alerts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT NOT NULL,
                tag         TEXT NOT NULL,
                label       TEXT,
                value       REAL,
                unit        TEXT,
                level       TEXT NOT NULL,
                message     TEXT NOT NULL,
                llm_analysis TEXT,
                email_sent  INTEGER DEFAULT 0,
                acknowledged INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_alerts_ts
                ON alerts(timestamp);
            CREATE INDEX IF NOT EXISTS idx_alerts_level
                ON alerts(level);

            CREATE TABLE IF NOT EXISTS daily_summaries (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                date        TEXT NOT NULL UNIQUE,
                stats_json  TEXT NOT NULL,
                total_production_meters REAL DEFAULT 0,
                uptime_minutes INTEGER DEFAULT 0,
                total_alerts INTEGER DEFAULT 0,
                insights    TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS monthly_reports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                year        INTEGER NOT NULL,
                month       INTEGER NOT NULL,
                report_html TEXT NOT NULL,
                metrics_json TEXT,
                email_sent  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now')),
                UNIQUE(year, month)
            );
        """)
    print("[DB] Database initialized successfully.")


# ── Readings ─────────────────────────────────────────────────────

def store_reading(snapshot: dict):
    """Store a Modbus snapshot's tag values into the readings table."""
    timestamp = snapshot.get("timestamp", datetime.now().isoformat())
    tags = snapshot.get("tags", {})
    rows = []
    for tag_name, tag_data in tags.items():
        val = tag_data.get("value")
        # Only store numeric values (skip booleans and Nones for trends)
        if val is not None and not isinstance(val, bool):
            rows.append((timestamp, tag_name, float(val), tag_data.get("unit", "")))
        elif isinstance(val, bool):
            rows.append((timestamp, tag_name, 1.0 if val else 0.0, ""))

    if rows:
        with get_db() as conn:
            conn.executemany(
                "INSERT INTO readings (timestamp, tag_name, value, unit) VALUES (?, ?, ?, ?)",
                rows
            )


def get_recent_readings(tag_name: str, hours: int = 1) -> list[dict]:
    """Get recent readings for a specific tag."""
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT timestamp, value, unit FROM readings "
            "WHERE tag_name = ? AND timestamp > ? ORDER BY timestamp",
            (tag_name, cutoff)
        ).fetchall()
    return [{"timestamp": r["timestamp"], "value": r["value"], "unit": r["unit"]} for r in rows]


def get_all_recent_readings(hours: int = 1) -> dict:
    """Get recent readings for ALL tags, grouped by tag name."""
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT tag_name, timestamp, value FROM readings "
            "WHERE timestamp > ? ORDER BY tag_name, timestamp",
            (cutoff,)
        ).fetchall()

    result = {}
    for r in rows:
        tag = r["tag_name"]
        if tag not in result:
            result[tag] = []
        result[tag].append({"timestamp": r["timestamp"], "value": r["value"]})
    return result


# ── Alerts ───────────────────────────────────────────────────────

def store_alert(alert_dict: dict) -> int:
    """Store an alert and return its ID."""
    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO alerts (timestamp, tag, label, value, unit, level, message) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                alert_dict.get("timestamp", datetime.now().isoformat()),
                alert_dict.get("tag", ""),
                alert_dict.get("label", ""),
                alert_dict.get("value"),
                alert_dict.get("unit", ""),
                alert_dict.get("level", "WARNING"),
                alert_dict.get("message", ""),
            )
        )
    return cursor.lastrowid


def update_alert_llm_analysis(alert_id: int, analysis: str):
    """Update an alert with LLM-generated analysis."""
    with get_db() as conn:
        conn.execute(
            "UPDATE alerts SET llm_analysis = ? WHERE id = ?",
            (analysis, alert_id)
        )


def mark_alert_email_sent(alert_id: int):
    """Mark that an alert email has been sent."""
    with get_db() as conn:
        conn.execute("UPDATE alerts SET email_sent = 1 WHERE id = ?", (alert_id,))


def get_alerts_since(hours: int = 24) -> list[dict]:
    """Get alerts from the last N hours."""
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM alerts WHERE timestamp > ? ORDER BY timestamp DESC",
            (cutoff,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_unsent_alerts() -> list[dict]:
    """Get alerts that haven't been emailed yet."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM alerts WHERE email_sent = 0 ORDER BY timestamp DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_recent_alerts(limit: int = 500) -> list[dict]:
    """Get the most recent N alerts."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Daily Summaries ──────────────────────────────────────────────

def get_daily_stats(date_str: str = None) -> dict:
    """
    Compute min/max/avg statistics for each tag on a given date.
    date_str format: 'YYYY-MM-DD'. Defaults to today.
    """
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")

    with get_db() as conn:
        rows = conn.execute(
            "SELECT tag_name, "
            "  MIN(value) as min_val, MAX(value) as max_val, "
            "  AVG(value) as avg_val, COUNT(*) as sample_count "
            "FROM readings "
            "WHERE DATE(timestamp) = ? "
            "GROUP BY tag_name",
            (date_str,)
        ).fetchall()

    stats = {}
    for r in rows:
        stats[r["tag_name"]] = {
            "min": round(r["min_val"], 3) if r["min_val"] else None,
            "max": round(r["max_val"], 3) if r["max_val"] else None,
            "avg": round(r["avg_val"], 3) if r["avg_val"] else None,
            "samples": r["sample_count"],
        }
    return stats


def store_daily_summary(date_str: str, stats: dict, production_meters: float,
                        uptime_minutes: int, alert_count: int, insights: str = None):
    """Store or update a daily summary."""
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO daily_summaries "
            "(date, stats_json, total_production_meters, uptime_minutes, total_alerts, insights) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (date_str, json.dumps(stats), production_meters, uptime_minutes, alert_count, insights)
        )


def get_daily_summary(date_str: str) -> dict | None:
    """Get a stored daily summary."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM daily_summaries WHERE date = ?", (date_str,)
        ).fetchone()
    return dict(row) if row else None


# ── Monthly Reports ──────────────────────────────────────────────

def get_monthly_summary(year: int, month: int) -> dict:
    """
    Aggregate a full month's data for report generation.
    Returns production stats, alert counts by severity, and tag statistics.
    """
    start_date = f"{year:04d}-{month:02d}-01"
    if month == 12:
        end_date = f"{year + 1:04d}-01-01"
    else:
        end_date = f"{year:04d}-{month + 1:02d}-01"

    with get_db() as conn:
        # Tag statistics for the month
        tag_rows = conn.execute(
            "SELECT tag_name, "
            "  MIN(value) as min_val, MAX(value) as max_val, "
            "  AVG(value) as avg_val, COUNT(*) as sample_count "
            "FROM readings "
            "WHERE DATE(timestamp) >= ? AND DATE(timestamp) < ? "
            "GROUP BY tag_name",
            (start_date, end_date)
        ).fetchall()

        # Alert counts by severity
        alert_rows = conn.execute(
            "SELECT level, COUNT(*) as cnt FROM alerts "
            "WHERE DATE(timestamp) >= ? AND DATE(timestamp) < ? "
            "GROUP BY level",
            (start_date, end_date)
        ).fetchall()

        # Total production (max total_meter - min total_meter)
        prod_row = conn.execute(
            "SELECT MIN(value) as start_m, MAX(value) as end_m FROM readings "
            "WHERE tag_name = 'TOTAL_METER' "
            "AND DATE(timestamp) >= ? AND DATE(timestamp) < ?",
            (start_date, end_date)
        ).fetchone()

        # Daily summaries for the month
        daily_rows = conn.execute(
            "SELECT * FROM daily_summaries "
            "WHERE date >= ? AND date < ? ORDER BY date",
            (start_date, end_date)
        ).fetchall()

    tag_stats = {}
    for r in tag_rows:
        tag_stats[r["tag_name"]] = {
            "min": round(r["min_val"], 3) if r["min_val"] else None,
            "max": round(r["max_val"], 3) if r["max_val"] else None,
            "avg": round(r["avg_val"], 3) if r["avg_val"] else None,
            "samples": r["sample_count"],
        }

    alert_counts = {r["level"]: r["cnt"] for r in alert_rows}

    production_meters = 0
    if prod_row and prod_row["start_m"] is not None and prod_row["end_m"] is not None:
        production_meters = round(prod_row["end_m"] - prod_row["start_m"], 1)

    return {
        "year": year,
        "month": month,
        "tag_stats": tag_stats,
        "alert_counts": alert_counts,
        "total_alerts": sum(alert_counts.values()),
        "production_meters": production_meters,
        "daily_summaries": [dict(r) for r in daily_rows],
        "operating_days": len(daily_rows),
    }


def store_monthly_report(year: int, month: int, report_html: str, metrics: dict):
    """Store a monthly report."""
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO monthly_reports (year, month, report_html, metrics_json) "
            "VALUES (?, ?, ?, ?)",
            (year, month, report_html, json.dumps(metrics))
        )


def get_monthly_reports() -> list[dict]:
    """List all monthly reports."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, year, month, email_sent, created_at FROM monthly_reports ORDER BY year DESC, month DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_monthly_report(report_id: int) -> dict | None:
    """Get a specific monthly report."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM monthly_reports WHERE id = ?", (report_id,)
        ).fetchone()
    return dict(row) if row else None


# ── Cleanup ──────────────────────────────────────────────────────

def cleanup_old_readings(days: int = 90):
    """Delete readings older than N days to keep DB size manageable."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    with get_db() as conn:
        conn.execute("DELETE FROM readings WHERE timestamp < ?", (cutoff,))
    print(f"[DB] Cleaned up readings older than {days} days.")


if __name__ == "__main__":
    init_db()
    print(f"Database ready at: {DB_PATH}")
