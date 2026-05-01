"""
Centralized configuration for the Nonwoven AI Agent.
All settings are loaded from environment variables with sensible defaults.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Ollama / LLM ─────────────────────────────────────────────────
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b")
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
OLLAMA_TEMPERATURE = float(os.getenv("OLLAMA_TEMPERATURE", "0"))

# ── Email Service (Nodemailer) ───────────────────────────────────
EMAIL_SERVICE_URL = os.getenv("EMAIL_SERVICE_URL", "http://localhost:3001")
EMAIL_API_KEY = os.getenv("EMAIL_API_KEY", "nonwoven-agent-secret-key")

# ── Alert / Report Recipients ────────────────────────────────────
# Comma-separated email addresses
ALERT_RECIPIENTS = [
    e.strip() for e in os.getenv("ALERT_RECIPIENTS", "").split(",") if e.strip()
]
REPORT_RECIPIENTS = [
    e.strip() for e in os.getenv("REPORT_RECIPIENTS", "").split(",") if e.strip()
]

# ── Database ─────────────────────────────────────────────────────
DB_PATH = os.getenv("DB_PATH", "nonwoven_data.db")

# ── Timing / Intervals ──────────────────────────────────────────
MODBUS_POLL_INTERVAL = int(os.getenv("MODBUS_POLL_INTERVAL", "2"))        # seconds
DB_SAMPLE_INTERVAL = int(os.getenv("DB_SAMPLE_INTERVAL", "30"))           # store to DB every N seconds
ANOMALY_CHECK_INTERVAL = int(os.getenv("ANOMALY_CHECK_INTERVAL", "30"))   # LLM analysis every N seconds
ALERT_COOLDOWN_SECONDS = int(os.getenv("ALERT_COOLDOWN_SECONDS", "300"))  # 5 min between repeat alerts

# ── Daily Summary Time ───────────────────────────────────────────
DAILY_SUMMARY_HOUR = int(os.getenv("DAILY_SUMMARY_HOUR", "23"))
DAILY_SUMMARY_MINUTE = int(os.getenv("DAILY_SUMMARY_MINUTE", "59"))

# ── Monthly Report Schedule ──────────────────────────────────────
MONTHLY_REPORT_DAY = int(os.getenv("MONTHLY_REPORT_DAY", "1"))
MONTHLY_REPORT_HOUR = int(os.getenv("MONTHLY_REPORT_HOUR", "6"))

# ── Flask Server ─────────────────────────────────────────────────
FLASK_HOST = os.getenv("FLASK_HOST", "0.0.0.0")
FLASK_PORT = int(os.getenv("FLASK_PORT", "4444"))

# ── HMI / Modbus (can override modbus_reader defaults) ──────────
HMI_IP = os.getenv("HMI_IP", "192.168.1.17")
HMI_PORT_MODBUS = int(os.getenv("HMI_PORT", "502"))

# ── Agent behavior ──────────────────────────────────────────────
# If True, the agent uses template fallback messages when LLM is unavailable
LLM_FALLBACK_ENABLED = os.getenv("LLM_FALLBACK_ENABLED", "true").lower() == "true"
# Maximum retries for LLM calls before falling back
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "2"))
# Timeout for LLM calls in seconds
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "30"))
