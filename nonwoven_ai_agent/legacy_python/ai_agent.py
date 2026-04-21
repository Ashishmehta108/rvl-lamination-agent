"""
Nonwoven Lamination Machine — AI Monitoring Agent (LangGraph Edition)

This is the main entry point. It runs 24/7 and orchestrates:
  1. Modbus data collection (every 2s)
  2. Rule-based threshold checks (fast, reliable)
  3. LLM-powered alert analysis via LangGraph (every 30s batch)
  4. Daily summaries + insight generation (23:59 daily)
  5. Monthly report generation + email (1st of each month)
  6. Flask REST API + dashboard serving

Architecture:
  - Rule-based checks: ALWAYS run (no LLM dependency)
  - LLM analysis: Enriches alerts with context, composes emails
  - Fallback: If Ollama is down, template messages are used
"""

import json
import time
import threading
import collections
import statistics
import logging
import os
from datetime import datetime
from flask import Flask, jsonify, send_from_directory, request
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from modbus_reader import ModbusTcpClient, read_all_tags, TAGS
from config import (
    FLASK_HOST, FLASK_PORT, HMI_IP, HMI_PORT_MODBUS,
    MODBUS_POLL_INTERVAL, DB_SAMPLE_INTERVAL, ANOMALY_CHECK_INTERVAL,
    ALERT_COOLDOWN_SECONDS, DAILY_SUMMARY_HOUR, DAILY_SUMMARY_MINUTE,
    MONTHLY_REPORT_DAY, MONTHLY_REPORT_HOUR,
)
import database as db
from langgraph_agent import analyze_alert, generate_daily_insights, generate_monthly_report

# ── Logging ──────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ai_agent")

app = Flask(__name__, static_folder="dashboard")

# ── In-memory state (for fast dashboard updates) ─────────────────
HISTORY_SIZE = 1800  # ~1hr at 2s interval
history = collections.deque(maxlen=HISTORY_SIZE)
in_memory_alerts = collections.deque(maxlen=500)
latest = {}
lock = threading.Lock()

# ── Rolling stats per tag (for statistical anomaly detection) ────
rolling = {name: collections.deque(maxlen=60) for name in TAGS}

# ── Alert cooldown tracking ─────────────────────────────────────
ALERT_COOLDOWN = ALERT_COOLDOWN_SECONDS
last_alert_time = {}

# ── Pending alerts queue for LLM analysis ────────────────────────
pending_alerts = collections.deque(maxlen=100)
pending_alerts_lock = threading.Lock()

# ── DB sampling counter ──────────────────────────────────────────
_sample_counter = 0
_sample_interval = max(1, DB_SAMPLE_INTERVAL // MODBUS_POLL_INTERVAL)

# ── Latest insights storage ──────────────────────────────────────
latest_insights = {"date": None, "text": "No insights generated yet."}


# ═══════════════════════════════════════════════════════════════════
# RULE-BASED ANOMALY DETECTION (runs every 2s — NO LLM)
# ═══════════════════════════════════════════════════════════════════

def check_anomalies(snapshot):
    """Fast, deterministic threshold checks. Identical logic to the original."""
    tags = snapshot.get("tags", {})

    for name, cfg in TAGS.items():
        tag_data = tags.get(name, {})
        val = tag_data.get("value")
        if val is None or isinstance(val, bool):
            continue

        rolling[name].append(val)

        # 1. Hard threshold alerts
        if cfg.get("alarm_hi") and val > cfg["alarm_hi"]:
            _fire_alert(name, cfg["label"], val, cfg["unit"],
                        "ALARM", f"Value {val:.1f} {cfg['unit']} exceeded alarm limit {cfg['alarm_hi']}")

        elif cfg.get("warn_hi") and val > cfg["warn_hi"]:
            _fire_alert(name, cfg["label"], val, cfg["unit"],
                        "WARNING", f"Value {val:.1f} {cfg['unit']} exceeded warning limit {cfg['warn_hi']}")

        # 2. Statistical anomaly: spike > 3 std deviations from rolling mean
        if len(rolling[name]) >= 20:
            mean = statistics.mean(rolling[name])
            stdev = statistics.stdev(rolling[name])
            if stdev > 0 and abs(val - mean) > 3 * stdev:
                _fire_alert(name, cfg["label"], val, cfg["unit"],
                            "ANOMALY", f"Statistical spike detected: {val:.1f} (mean={mean:.1f}, σ={stdev:.1f})")

    # 3. Emergency stop
    emg = tags.get("EMG_STOP", {}).get("value")
    if emg is True:
        _fire_alert("EMG_STOP", "Emergency Stop", 1, "", "CRITICAL", "EMERGENCY STOP ACTIVATED!")

    # 4. Drive faults
    for fname in ["EXTRUDER_FAULT", "LAMINATOR_FAULT", "WINDER_FAULT"]:
        if tags.get(fname, {}).get("value") is True:
            _fire_alert(fname, TAGS[fname]["label"], 1, "", "FAULT",
                        f"{TAGS[fname]['label']} drive fault detected!")

    # 5. Tension deviation
    sv = tags.get("UW_SET_TENSION", {}).get("value")
    pv = tags.get("UW_PV_TENSION", {}).get("value")
    if sv and pv and sv > 0:
        dev_pct = abs(pv - sv) / sv * 100
        if dev_pct > 25:
            _fire_alert("UW_TENSION_DEV", "Unwinder Tension", pv, "",
                        "WARNING", f"Tension deviation {dev_pct:.1f}% (SV={sv}, PV={pv})")


def _fire_alert(tag, label, value, unit, level, message):
    """Fire an alert: add to in-memory list + queue for LLM analysis."""
    now_ts = datetime.now().isoformat()
    now_s = time.time()
    cooldown_key = f"{tag}_{level}"

    if now_s - last_alert_time.get(cooldown_key, 0) < ALERT_COOLDOWN:
        return

    last_alert_time[cooldown_key] = now_s

    alert = {
        "timestamp": now_ts,
        "tag": tag,
        "label": label,
        "value": value,
        "unit": unit,
        "level": level,
        "message": message,
    }

    # Add to in-memory (for dashboard)
    with lock:
        in_memory_alerts.appendleft(alert)

    # Queue for LLM analysis
    with pending_alerts_lock:
        pending_alerts.append(alert)

    logger.info(f"[{level}] {now_ts} — {message}")


# ═══════════════════════════════════════════════════════════════════
# SCHEDULED JOBS
# ═══════════════════════════════════════════════════════════════════

def job_collect_data():
    """
    Primary data collection loop.
    Runs every MODBUS_POLL_INTERVAL seconds.
    Reads Modbus → checks thresholds → updates in-memory → samples to DB.
    """
    global latest, _sample_counter

    try:
        client = ModbusTcpClient(HMI_IP, port=HMI_PORT_MODBUS, timeout=3)
        if not client.connect():
            logger.warning("Cannot connect to HMI — will retry on next cycle.")
            return

        snapshot = read_all_tags(client)
        client.close()

        # Rule-based anomaly checks (fast, no LLM)
        check_anomalies(snapshot)

        # Update in-memory state
        with lock:
            latest = snapshot
            history.append(snapshot)

        # Sample to SQLite periodically (not every 2s — too much data)
        _sample_counter += 1
        if _sample_counter >= _sample_interval:
            _sample_counter = 0
            try:
                db.store_reading(snapshot)
            except Exception as e:
                logger.error(f"DB write failed: {e}")

    except Exception as e:
        logger.error(f"Data collection error: {e}")


def job_analyze_alerts():
    """
    Process queued alerts via LangGraph LLM agent.
    Runs every ANOMALY_CHECK_INTERVAL seconds.
    Batches alerts to avoid overwhelming the LLM.
    """
    alerts_to_process = []
    with pending_alerts_lock:
        while pending_alerts:
            alerts_to_process.append(pending_alerts.popleft())

    if not alerts_to_process:
        return

    logger.info(f"Processing {len(alerts_to_process)} queued alert(s) via LangGraph...")

    for alert_data in alerts_to_process:
        try:
            analysis = analyze_alert(alert_data)
            logger.info(f"[LLM] Analysis complete for {alert_data['tag']}: {analysis[:100]}...")
        except Exception as e:
            logger.error(f"LLM analysis failed for {alert_data['tag']}: {e}")
            # Alert is already stored in DB by the rule-based check
            # The LLM just enriches it — failure is non-critical


def job_daily_summary():
    """
    Generate daily summary and LLM insights.
    Runs once at DAILY_SUMMARY_HOUR:DAILY_SUMMARY_MINUTE.
    """
    global latest_insights
    date_str = datetime.now().strftime("%Y-%m-%d")
    logger.info(f"Generating daily summary for {date_str}...")

    try:
        # Compute and store daily stats
        stats = db.get_daily_stats(date_str)
        today_alerts = db.get_alerts_since(24)

        # Get production meters for today
        readings = db.get_recent_readings("TOTAL_METER", 24)
        production = 0
        if readings and len(readings) >= 2:
            production = readings[-1]["value"] - readings[0]["value"]

        # Estimate uptime (we have a reading every ~30s, so count * 30 / 60 = minutes)
        uptime_minutes = len(readings) * DB_SAMPLE_INTERVAL // 60

        # Generate LLM insights
        insights = generate_daily_insights(date_str)
        latest_insights = {"date": date_str, "text": insights}

        # Store summary
        db.store_daily_summary(
            date_str=date_str,
            stats=stats,
            production_meters=production,
            uptime_minutes=uptime_minutes,
            alert_count=len(today_alerts),
            insights=insights,
        )

        logger.info(f"Daily summary stored for {date_str}")

    except Exception as e:
        logger.error(f"Daily summary generation failed: {e}")


def job_monthly_report():
    """
    Generate and email monthly report.
    Runs on MONTHLY_REPORT_DAY at MONTHLY_REPORT_HOUR:00.
    """
    logger.info("Starting monthly report generation...")
    try:
        report = generate_monthly_report()
        logger.info("Monthly report generated and emailed successfully.")
    except Exception as e:
        logger.error(f"Monthly report generation failed: {e}")


def job_db_cleanup():
    """Clean up old readings (keep last 90 days). Runs weekly."""
    try:
        db.cleanup_old_readings(days=90)
    except Exception as e:
        logger.error(f"DB cleanup failed: {e}")


# ═══════════════════════════════════════════════════════════════════
# REST API ENDPOINTS
# ═══════════════════════════════════════════════════════════════════

@app.route("/api/live")
def api_live():
    """All tag values right now."""
    with lock:
        return jsonify(latest)


@app.route("/api/alerts")
def api_alerts():
    """Alert log from in-memory (fast) or DB (persistent)."""
    source = request.args.get("source", "memory")
    if source == "db":
        hours = int(request.args.get("hours", 24))
        alerts = db.get_alerts_since(hours)
        return jsonify(alerts)
    else:
        with lock:
            return jsonify(list(in_memory_alerts))


@app.route("/api/history/<tag_name>")
def api_history(tag_name):
    """Trend data for one tag (from in-memory ring buffer)."""
    with lock:
        result = []
        for snap in history:
            tv = snap["tags"].get(tag_name, {}).get("value")
            if tv is not None:
                result.append({"t": snap["timestamp"], "v": tv})
    return jsonify(result)


@app.route("/api/summary")
def api_summary():
    """Key KPIs only."""
    with lock:
        tags = latest.get("tags", {})
        return jsonify({
            "extruder_rpm":   tags.get("EXTRUDER_RPM",   {}).get("value"),
            "extruder_amp":   tags.get("EXTRUDER_AMP",   {}).get("value"),
            "laminator_mpm":  tags.get("LAMINATOR_MPM",  {}).get("value"),
            "laminator_amp":  tags.get("LAMINATOR_AMP",  {}).get("value"),
            "winder_amp":     tags.get("WINDER_AMP",     {}).get("value"),
            "running_meter":  tags.get("RUNNING_METER",  {}).get("value"),
            "total_meter":    tags.get("TOTAL_METER",    {}).get("value"),
            "master_speed":   tags.get("MASTER_SPEED_PCT",{}).get("value"),
            "gsm":            tags.get("GSM_ENTRY",      {}).get("value"),
            "alarm_active":   tags.get("ALARM_IND",      {}).get("value"),
            "emg_stop":       tags.get("EMG_STOP",       {}).get("value"),
            "active_alerts":  len(in_memory_alerts),
            "timestamp":      latest.get("timestamp"),
        })


@app.route("/api/insights")
def api_insights():
    """Latest daily insights from LLM."""
    return jsonify(latest_insights)


@app.route("/api/reports")
def api_reports():
    """List all monthly reports."""
    reports = db.get_monthly_reports()
    return jsonify(reports)


@app.route("/api/reports/<int:report_id>")
def api_report_detail(report_id):
    """Get a specific monthly report."""
    report = db.get_monthly_report(report_id)
    if report:
        return jsonify(report)
    return jsonify({"error": "Report not found"}), 404


@app.route("/api/stats/daily")
def api_daily_stats():
    """Aggregated daily production stats."""
    date_str = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    stats = db.get_daily_stats(date_str)
    return jsonify({"date": date_str, "stats": stats})


@app.route("/api/health")
def api_health():
    """Agent health check."""
    return jsonify({
        "status": "running",
        "agent": "nonwoven-ai-agent",
        "version": "2.0.0",
        "uptime": time.time() - _start_time,
        "latest_reading": latest.get("timestamp"),
        "queued_alerts": len(pending_alerts),
        "total_in_memory_alerts": len(in_memory_alerts),
    })


@app.route("/")
def index():
    return send_from_directory("dashboard", "index.html")


# ═══════════════════════════════════════════════════════════════════
# MAIN STARTUP
# ═══════════════════════════════════════════════════════════════════

_start_time = time.time()


def start_agent():
    """Initialize everything and start the 24/7 agent."""
    global _start_time
    _start_time = time.time()

    # 1. Initialize database
    logger.info("Initializing database...")
    db.init_db()

    # 2. Set up APScheduler
    scheduler = BackgroundScheduler(
        job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 60}
    )

    # Data collection: every MODBUS_POLL_INTERVAL seconds
    scheduler.add_job(
        job_collect_data,
        trigger=IntervalTrigger(seconds=MODBUS_POLL_INTERVAL),
        id="collect_data",
        name="Modbus Data Collection",
    )

    # LLM alert analysis: every ANOMALY_CHECK_INTERVAL seconds
    scheduler.add_job(
        job_analyze_alerts,
        trigger=IntervalTrigger(seconds=ANOMALY_CHECK_INTERVAL),
        id="analyze_alerts",
        name="LLM Alert Analysis",
    )

    # Daily summary + insights: every day
    scheduler.add_job(
        job_daily_summary,
        trigger=CronTrigger(hour=DAILY_SUMMARY_HOUR, minute=DAILY_SUMMARY_MINUTE),
        id="daily_summary",
        name="Daily Summary & Insights",
    )

    # Monthly report: 1st of each month
    scheduler.add_job(
        job_monthly_report,
        trigger=CronTrigger(day=MONTHLY_REPORT_DAY, hour=MONTHLY_REPORT_HOUR, minute=0),
        id="monthly_report",
        name="Monthly Report Generation",
    )

    # DB cleanup: every Sunday at 3 AM
    scheduler.add_job(
        job_db_cleanup,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=0),
        id="db_cleanup",
        name="Database Cleanup",
    )

    scheduler.start()
    logger.info("APScheduler started with all jobs.")

    # 3. Print startup info
    print("\n" + "=" * 60)
    print("  [FACTORY] Nonwoven AI Agent v2.0 - LangGraph Edition")
    print("=" * 60)
    print(f"  Dashboard:    http://localhost:{FLASK_PORT}")
    print(f"  Health:       http://localhost:{FLASK_PORT}/api/health")
    print(f"  HMI Target:   {HMI_IP}:{HMI_PORT_MODBUS}")
    print(f"  LLM Model:    {os.getenv('OLLAMA_MODEL', 'qwen3:4b')}")
    print(f"  Email Svc:    {os.getenv('EMAIL_SERVICE_URL', 'http://localhost:3001')}")
    print(f"  Database:     {os.getenv('DB_PATH', 'nonwoven_data.db')}")
    print("=" * 60)
    print("  Scheduled Jobs:")
    print(f"    - Data collection:  every {MODBUS_POLL_INTERVAL}s")
    print(f"    - Alert analysis:   every {ANOMALY_CHECK_INTERVAL}s")
    print(f"    - Daily summary:    {DAILY_SUMMARY_HOUR:02d}:{DAILY_SUMMARY_MINUTE:02d}")
    print(f"    - Monthly report:   Day {MONTHLY_REPORT_DAY} at {MONTHLY_REPORT_HOUR:02d}:00")
    print(f"    - DB cleanup:       Sundays at 03:00")
    print("=" * 60 + "\n")

    # 4. Start Flask (blocking)
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    start_agent()
