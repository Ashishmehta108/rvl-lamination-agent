#!/usr/bin/env python3
"""
start_ml.py  —  ML server launcher with dependency check.
Run from the repo root:
  python packages/ml/start_ml.py

Or add it to your dev workflow:
  npm run dev:ml
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ML_DIR = Path(__file__).resolve().parent
REQ_FILE = ML_DIR / "requirements.txt"


def check_and_install() -> None:
    try:
        import sklearn, pandas, numpy, flask, joblib, psycopg2  # noqa: F401
        print("[ml] Dependencies OK.")
    except ImportError:
        print("[ml] Installing dependencies from requirements.txt ...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-r", str(REQ_FILE)],
            cwd=str(ML_DIR),
        )


if __name__ == "__main__":
    check_and_install()
    print("[ml] Starting ML server ...")
    subprocess.run(
        [sys.executable, str(ML_DIR / "server.py")],
        cwd=str(ROOT),
    )
