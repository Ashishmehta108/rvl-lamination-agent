"""
ML Pipeline configuration.
Reads settings from environment variables (shared .env at repo root).
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from repo root
_repo_root = Path(__file__).resolve().parent.parent.parent
load_dotenv(_repo_root / ".env")

# ── Paths ─────────────────────────────────────────────────────
ML_DATA_DIR = Path(os.getenv("ML_DATA_DIR", str(_repo_root / "data" / "ml")))
ML_DATA_DIR.mkdir(parents=True, exist_ok=True)

TIMESERIES_CSV = ML_DATA_DIR / "timeseries.csv"
BASELINE_CSV   = ML_DATA_DIR / "baseline_week1.csv"
MODEL_PATH     = ML_DATA_DIR / "model_latest.joblib"
METADATA_PATH  = ML_DATA_DIR / "metadata.json"
HISTORY_DIR    = ML_DATA_DIR / "training_history"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)

# ── Deployment timestamp (auto-created on first run) ──────────
DEPLOY_MARKER = ML_DATA_DIR / "deploy_timestamp.txt"

# ── Model parameters ─────────────────────────────────────────
BASELINE_DAYS         = int(os.getenv("ML_BASELINE_DAYS", "7"))
ANOMALY_CONTAMINATION = float(os.getenv("ML_CONTAMINATION", "0.05"))
ANOMALY_THRESHOLD     = float(os.getenv("ML_ANOMALY_THRESHOLD", "-0.5"))
N_ESTIMATORS          = int(os.getenv("ML_N_ESTIMATORS", "200"))
RANDOM_STATE          = 42

# ── Backend connection ────────────────────────────────────────
POSTGRES_URL = os.getenv("POSTGRES_URL",
                         "postgresql://rvl:rvl@127.0.0.1:5432/rvl?schema=public")
BACKEND_URL  = os.getenv("ML_BACKEND_URL", "http://127.0.0.1:7000")
API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "dev-local-token")
MACHINE_ID    = os.getenv("MACHINE_ID", "lamination-01")
MACHINE_REVISION = os.getenv("MACHINE_REVISION", "v1")

# ── Server ────────────────────────────────────────────────────
ML_SERVER_PORT = int(os.getenv("ML_SERVER_PORT", "7100"))
