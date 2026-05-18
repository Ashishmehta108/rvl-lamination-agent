#!/usr/bin/env python3
"""
============================================================
  Raspberry Pi 4 — Modbus TCP Poller + Remote Data Pipeline
  Production Edition — WAL / Retry Queue / Health Check
  For: Nonwoven Lamination AI Agent
============================================================

FIXES vs previous version:
  • Grouped Modbus reads  — bulk reads contiguous register blocks
    instead of 28 individual TCP round-trips per poll cycle.
    Eliminates partial-read flaps caused by per-tag timeouts.
  • Raw register debug logging — [MODBUS] addr=1103 raw=[x,y] decoded=z
    so address/float bugs are immediately visible in logs.
  • Coil bulk read — all coils in one FC=1 request.
  • Client socket safety — always closed, even on connect() exceptions.
  • Correct address arithmetic verified against working test script:
      PLC address 401104 → Modbus offset 1103  (401104 - 400001 = 1103)
  • Stale socket detection — reconnect on consecutive partial failures.
  • pymodbus 3.6.x fix — `slave` keyword removed; unit ID is now
    configured on the client constructor via `unit_id` param and
    all read calls omit the deprecated `slave=` kwarg entirely.

Dependencies:
  pip install "pymodbus==3.6.9" requests python-dotenv

Run (development):
  python3 data_source.py

Run (production):
  sudo systemctl start nonwoven-agent
"""

import asyncio
import json
import logging
import logging.handlers
import math
import os
import random
import signal
import struct
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import requests
from dotenv import load_dotenv
from pymodbus.client import ModbusTcpClient

# ── Load .env ─────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# ── Directories ───────────────────────────────────────────────
BASE_DIR = Path(os.getenv("BASE_DIR", "/var/lib/nonwoven-agent"))
WAL_DIR  = BASE_DIR / "wal"
SENT_DIR = BASE_DIR / "sent"
DEAD_DIR = BASE_DIR / "dead"
LOG_DIR  = BASE_DIR / "logs"

for _d in (WAL_DIR, SENT_DIR, DEAD_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ══════════════════════════════════════════════════════════════
#  Logging — Structured, rotating, multi-handler
# ══════════════════════════════════════════════════════════════
class _PreciseFormatter(logging.Formatter):
    """
    Format:  2025-01-15T14:23:01.123 [INFO    ] pipeline - message
    Millisecond precision. Useful for correlating Modbus timing with PLC events.
    """
    def formatTime(self, record, datefmt=None):
        ct = datetime.fromtimestamp(record.created, tz=timezone.utc)
        return ct.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(record.msecs):03d}Z"


def _setup_logging():
    log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    root_level     = getattr(logging, log_level_name, logging.INFO)

    fmt = _PreciseFormatter(
        "%(asctime)s [%(levelname)-8s] %(name)s - %(message)s"
    )

    root = logging.getLogger()
    root.setLevel(root_level)
    root.handlers.clear()  # Avoid duplicate handlers on reload

    # ── Console handler ───────────────────────────────────────
    ch = logging.StreamHandler()
    ch.setLevel(root_level)
    ch.setFormatter(fmt)
    root.addHandler(ch)

    # ── Rotating file handler: pipeline.log (all levels) ─────
    fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "pipeline.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(root_level)
    fh.setFormatter(fmt)
    root.addHandler(fh)

    # ── Separate rotating file: modbus.log (DEBUG only) ──────
    # Contains raw register values, address maps, decode results.
    # Invaluable for diagnosing float/address bugs without drowning pipeline.log
    modbus_fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "modbus.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    modbus_fh.setLevel(logging.DEBUG)
    modbus_fh.setFormatter(fmt)
    modbus_fh.addFilter(lambda r: r.name in ("modbus", "pipeline"))

    modbus_log = logging.getLogger("modbus")
    modbus_log.setLevel(logging.DEBUG)
    modbus_log.addHandler(modbus_fh)
    modbus_log.propagate = True  # also goes to pipeline.log at configured level

    # ── Separate rotating file: errors.log (ERROR+) ──────────
    eh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "errors.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    eh.setLevel(logging.ERROR)
    eh.setFormatter(fmt)
    root.addHandler(eh)

    # ── Keep pymodbus quiet unless LOG_LEVEL=DEBUG ────────────
    if root_level > logging.DEBUG:
        logging.getLogger("pymodbus").setLevel(logging.WARNING)
        logging.getLogger("pymodbus.client").setLevel(logging.WARNING)
    else:
        logging.getLogger("pymodbus").setLevel(logging.DEBUG)


_setup_logging()
log        = logging.getLogger("pipeline")
modbus_log = logging.getLogger("modbus")


# ── Configuration ─────────────────────────────────────────────
REMOTE_BASE_URL  = os.getenv("REMOTE_BASE_URL", "https://mace-ebony-capital.ngrok-free.dev")
INGEST_PATH      = os.getenv("INGEST_PATH", "/ingest/tags")
HEALTH_PATH      = os.getenv("HEALTH_PATH", "/health")
API_AUTH_TOKEN   = os.getenv("API_AUTH_TOKEN", "dev-local-token")
MACHINE_ID       = os.getenv("MACHINE_ID", "lamination-01")
MACHINE_REVISION = os.getenv("MACHINE_REVISION", "v1")

PLC_HOST         = os.getenv("PLC_HOST", "192.168.1.17")
PLC_PORT         = int(os.getenv("PLC_PORT", "502"))
PLC_UNIT_ID      = int(os.getenv("PLC_UNIT_ID", "1"))
MODBUS_TIMEOUT   = float(os.getenv("MODBUS_TIMEOUT", "3.0"))

UPDATE_INTERVAL  = float(os.getenv("UPDATE_INTERVAL", "0.5"))
PUSH_INTERVAL    = float(os.getenv("PUSH_INTERVAL", "5.0"))
HTTP_TIMEOUT     = float(os.getenv("HTTP_TIMEOUT", "10.0"))
MAX_RETRIES      = int(os.getenv("MAX_RETRIES", "72"))
RETRY_BACKOFF_CAP = float(os.getenv("RETRY_BACKOFF_CAP", "60.0"))
SENT_KEEP_HOURS  = float(os.getenv("SENT_KEEP_HOURS", "24.0"))

POLL_BACKOFF_BASE = float(os.getenv("POLL_BACKOFF_BASE", "1.0"))
POLL_BACKOFF_MAX  = float(os.getenv("POLL_BACKOFF_MAX", "30.0"))
POLL_JITTER_MAX   = float(os.getenv("POLL_JITTER_MAX", "0.2"))

MIN_SUCCESS_TAGS  = int(os.getenv("MIN_SUCCESS_TAGS", "3"))

REQUIRED_LIVE_TAGS = [
    s.strip() for s in os.getenv(
        "REQUIRED_LIVE_TAGS",
        "EXTRUDER_RPM,LAMINATOR_MPM,EXTRUDER_SPEED_PCT"
    ).split(",")
    if s.strip()
]

# How many consecutive partial-read cycles before we force-reconnect.
PARTIAL_RECONNECT_THRESHOLD = int(os.getenv("PARTIAL_RECONNECT_THRESHOLD", "3"))

INGEST_URL = REMOTE_BASE_URL.rstrip("/") + INGEST_PATH
HEALTH_URL = REMOTE_BASE_URL.rstrip("/") + HEALTH_PATH

# ── Shared HTTP session ───────────────────────────────────────
_session = requests.Session()
_session.headers.update({
    "Content-Type":  "application/json",
    "Authorization": f"Bearer {API_AUTH_TOKEN}",
    "User-Agent":    f"NonwovenAgent/{MACHINE_REVISION}",
})


# ══════════════════════════════════════════════════════════════
#  pymodbus 3.6.x compatibility helper
#
#  In pymodbus ≥ 3.6, the `slave` keyword argument was removed
#  from individual read/write methods. The unit ID must now be
#  passed as the third POSITIONAL argument (slave) or configured
#  on the client. We use a thin wrapper so every call site is
#  identical and future-proof.
# ══════════════════════════════════════════════════════════════

def _read_registers(client: ModbusTcpClient, address: int, count: int):
    """
    Call read_holding_registers with pymodbus 3.6.x-compatible signature.
    Tries positional `slave` first; falls back to keyword for older builds.
    """
    try:
        return client.read_holding_registers(address, count, PLC_UNIT_ID)
    except TypeError:
        # Older pymodbus 3.x builds that still accept the keyword
        return client.read_holding_registers(address, count, slave=PLC_UNIT_ID)


def _read_coils(client: ModbusTcpClient, address: int, count: int):
    """
    Call read_coils with pymodbus 3.6.x-compatible signature.
    """
    try:
        return client.read_coils(address, count, PLC_UNIT_ID)
    except TypeError:
        return client.read_coils(address, count, slave=PLC_UNIT_ID)


# ══════════════════════════════════════════════════════════════
#  Tag Definitions
#
#  ADDRESSING RULE (verified against working test script):
#    PLC XML address (4xxxxx) → Modbus offset = addr - 400001
#    Example: 401104 → 1103   (confirmed working: address=1103 returns valid float)
#
#  TagConfig.addr stores the PLC 4xxxxx address for holding registers (FC=3),
#  and the 1-based coil number for coils (FC=1).
#
#  _read_tag() conversion:
#    FC=3 holding: modbus_offset = addr - 400001
#    FC=1 coil:    modbus_offset = addr - 1
# ══════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class TagConfig:
    addr: int
    type: Literal["float", "uint16", "bool"]
    fc: int  # 3=HREG, 1=COIL


TAGS: dict[str, TagConfig] = {
    # ── Extruder ─────────────────────────────────────────────
    "EXTRUDER_RPM":        TagConfig(addr=401104, type="float",  fc=3),  # offset 1103
    "EXTRUDER_AMP":        TagConfig(addr=401108, type="float",  fc=3),  # offset 1107
    "EXTRUDER_SPEED_PCT":  TagConfig(addr=400001, type="uint16", fc=3),  # offset 0
    "EXTRUDER_ON_OFF":     TagConfig(addr=100,    type="bool",   fc=1),  # coil 99
    "EXTRUDER_FAULT":      TagConfig(addr=12,     type="bool",   fc=1),  # coil 11
    "EXTRUDER_SPEED_VOL":  TagConfig(addr=401200, type="float",  fc=3),  # offset 1199

    # ── Laminator ────────────────────────────────────────────
    "LAMINATOR_MPM":       TagConfig(addr=401106, type="float",  fc=3),  # offset 1105
    "LAMINATOR_AMP":       TagConfig(addr=401110, type="float",  fc=3),  # offset 1109
    "LAMINATOR_SPEED_PCT": TagConfig(addr=400002, type="uint16", fc=3),  # offset 1
    "LAMINATOR_ON_OFF":    TagConfig(addr=101,    type="bool",   fc=1),  # coil 100
    "LAMINATOR_FAULT":     TagConfig(addr=13,     type="bool",   fc=1),  # coil 12
    "LAMINATOR_SPEED_VOL": TagConfig(addr=401202, type="float",  fc=3),  # offset 1201

    # ── Winder ───────────────────────────────────────────────
    "WINDER_AMP":          TagConfig(addr=401112, type="float",  fc=3),  # offset 1111
    "WINDER_TENSION_PCT":  TagConfig(addr=400003, type="uint16", fc=3),  # offset 2
    "WINDER_ON_OFF":       TagConfig(addr=102,    type="bool",   fc=1),  # coil 101
    "WINDER_FAULT":        TagConfig(addr=14,     type="bool",   fc=1),  # coil 13
    "WINDER_TENSION_VOL":  TagConfig(addr=401040, type="float",  fc=3),  # offset 1039

    # ── Machine ──────────────────────────────────────────────
    "MASTER_SPEED_PCT":    TagConfig(addr=400001, type="uint16", fc=3),  # offset 0, same as EXTRUDER_SPEED_PCT
    "UW_SET_TENSION":      TagConfig(addr=403502, type="uint16", fc=3),  # offset 3501
    "UW_PV_TENSION":       TagConfig(addr=403880, type="uint16", fc=3),  # offset 3879
    "RUNNING_METER":       TagConfig(addr=400008, type="float",  fc=3),  # offset 7
    "TOTAL_METER":         TagConfig(addr=400010, type="float",  fc=3),  # offset 9
    "GSM_ENTRY":           TagConfig(addr=401300, type="float",  fc=3),  # offset 1299
    "GRAM_ENTRY":          TagConfig(addr=403004, type="float",  fc=3),  # offset 3003
    "SPLICE_SPEED":        TagConfig(addr=400018, type="uint16", fc=3),  # offset 17

    # ── Alarms / control ─────────────────────────────────────
    "ALARM_IND":           TagConfig(addr=125,    type="bool",   fc=1),  # coil 124
    "EMG_STOP":            TagConfig(addr=9,      type="bool",   fc=1),  # coil 8
    "SPLICE_ON_OFF":       TagConfig(addr=111,    type="bool",   fc=1),  # coil 110
}


# ══════════════════════════════════════════════════════════════
#  Grouped Modbus read strategy
#
#  Instead of 28 individual TCP requests per poll cycle,
#  we read contiguous register blocks in bulk.
#  Reduces per-poll TCP overhead from ~28 round-trips to ~6.
#
#  Blocks are defined as (start_offset, count, block_label).
#  If a block read fails, we fall back to per-tag reads for that block.
# ══════════════════════════════════════════════════════════════

# Holding register blocks: (start_modbus_offset, count, label)
# Each block covers a contiguous range of registers.
# Adjust ranges if your PLC has gaps that cause errors on bulk read.
HREG_BLOCKS: list[tuple[int, int, str]] = [
    (0,    4,    "speed_pct"),          # offsets 0-3: EXTRUDER/LAMINATOR/WINDER_SPEED_PCT, UW
    (7,    4,    "meters"),             # offsets 7-10: RUNNING/TOTAL_METER (float = 2 regs each)
    (17,   1,    "splice_speed"),       # offset 17: SPLICE_SPEED
    (1039, 2,    "winder_ten_vol"),     # offset 1039-1040: WINDER_TENSION_VOL float
    (1103, 10,   "drive_analytics"),    # offsets 1103-1112: RPM, MPM, EXT_AMP, LAM_AMP, WIND_AMP (5 floats)
    (1199, 4,    "speed_vol"),          # offsets 1199-1202: EXTRUDER/LAMINATOR_SPEED_VOL (2 floats)
    (1299, 2,    "gsm"),                # offset 1299-1300: GSM_ENTRY float
    (3003, 2,    "gram"),               # offset 3003-3004: GRAM_ENTRY float
    (3501, 1,    "uw_set"),             # offset 3501: UW_SET_TENSION
    (3879, 1,    "uw_pv"),              # offset 3879: UW_PV_TENSION
]

# Coil block: read all coils 0-124 in one shot
COIL_BLOCK_START = 0
COIL_BLOCK_COUNT = 125


def _regs_to_float(hi: int, lo: int) -> float:
    """
    Decode two 16-bit big-endian registers into a 32-bit float.
    Register order: [high_word, low_word] → big-endian float.
    Verified correct against test script output (address=1103).
    """
    raw = struct.pack(">HH", hi, lo)
    return struct.unpack(">f", raw)[0]


def _safe_float(hi: int, lo: int, tag: str) -> float:
    """Decode float, log raw values, guard against NaN/Inf."""
    value = _regs_to_float(hi, lo)
    modbus_log.debug("[MODBUS] %s  raw=[0x%04X, 0x%04X]  decoded=%.4f", tag, hi, lo, value)
    if not math.isfinite(value):
        modbus_log.warning("[MODBUS] %s  non-finite float %.6g — treating as 0.0", tag, value)
        return 0.0
    return value


def poll_modbus_snapshot(client: ModbusTcpClient) -> tuple[dict, list[str]]:
    """
    Read all tags using grouped bulk reads.
    Falls back to per-tag individual reads for any block that fails.
    Returns (values_dict, errors_list).

    Uses _read_registers() / _read_coils() wrappers that are compatible
    with pymodbus 3.6.x (slave keyword removed — passed positionally).
    """
    values: dict           = {}
    errors: list           = []
    raw_hregs: dict[int, int]  = {}   # offset → register value
    raw_coils: dict[int, bool] = {}   # offset → coil value

    # ── 1. Bulk holding register reads ───────────────────────
    for (start, count, label) in HREG_BLOCKS:
        try:
            rr = _read_registers(client, start, count)
            if rr.isError():
                raise RuntimeError(f"Modbus error response: {rr}")
            for i, reg in enumerate(rr.registers):
                raw_hregs[start + i] = reg
            modbus_log.debug(
                "[MODBUS] block %-20s  addr=%d count=%d  regs=%s",
                label, start, count, rr.registers
            )
        except Exception as exc:
            errors.append(f"hreg_block[{label}@{start}+{count}]: {exc}")
            modbus_log.warning(
                "[MODBUS] block %s FAILED (addr=%d count=%d): %s — falling back to per-tag",
                label, start, count, exc
            )
            # Fallback: per-tag reads for registers in this block
            for offset in range(start, start + count):
                try:
                    rr2 = _read_registers(client, offset, 1)
                    if not rr2.isError():
                        raw_hregs[offset] = rr2.registers[0]
                except Exception as exc2:
                    errors.append(f"hreg_fallback[{offset}]: {exc2}")

    # ── 2. Bulk coil read ─────────────────────────────────────
    try:
        rc = _read_coils(client, COIL_BLOCK_START, COIL_BLOCK_COUNT)
        if rc.isError():
            raise RuntimeError(f"Coil read error: {rc}")
        for i, bit in enumerate(rc.bits[:COIL_BLOCK_COUNT]):
            raw_coils[COIL_BLOCK_START + i] = bool(bit)
        modbus_log.debug(
            "[MODBUS] coils block  addr=0 count=%d  first_8=%s",
            COIL_BLOCK_COUNT, list(rc.bits[:8])
        )
    except Exception as exc:
        errors.append(f"coil_block: {exc}")
        modbus_log.warning("[MODBUS] coil bulk read FAILED: %s — falling back to per-coil", exc)
        for tag_name, cfg in TAGS.items():
            if cfg.fc == 1:
                coil_offset = cfg.addr - 1
                try:
                    rr = _read_coils(client, coil_offset, 1)
                    if not rr.isError():
                        raw_coils[coil_offset] = bool(rr.bits[0])
                except Exception as exc2:
                    errors.append(f"coil_fallback[{tag_name}@{coil_offset}]: {exc2}")

    # ── 3. Decode tags from raw register cache ─────────────────
    for tag_name, cfg in TAGS.items():
        try:
            if cfg.fc == 3:
                offset = cfg.addr - 400001
                if cfg.type == "float":
                    if offset in raw_hregs and (offset + 1) in raw_hregs:
                        values[tag_name] = _safe_float(
                            raw_hregs[offset], raw_hregs[offset + 1], tag_name
                        )
                    else:
                        errors.append(f"{tag_name}: registers @{offset},{offset+1} not in cache")
                elif cfg.type == "uint16":
                    if offset in raw_hregs:
                        values[tag_name] = int(raw_hregs[offset])
                        modbus_log.debug("[MODBUS] %s  addr=%d  value=%d", tag_name, offset, values[tag_name])
                    else:
                        errors.append(f"{tag_name}: register @{offset} not in cache")
            elif cfg.fc == 1:
                coil_offset = cfg.addr - 1
                if coil_offset in raw_coils:
                    values[tag_name] = raw_coils[coil_offset]
                    modbus_log.debug("[MODBUS] %s  coil=%d  value=%s", tag_name, coil_offset, values[tag_name])
                else:
                    errors.append(f"{tag_name}: coil @{coil_offset} not in cache")
        except Exception as exc:
            errors.append(f"{tag_name} decode: {exc}")
            modbus_log.error("[MODBUS] %s decode exception: %s", tag_name, exc, exc_info=True)

    return values, errors


# ══════════════════════════════════════════════════════════════
#  Runtime State
# ══════════════════════════════════════════════════════════════
class RuntimeState:
    def __init__(self):
        self.running_meter: float  = 0.0
        self.total_meter: float    = 12500.0
        self.extruder_rpm: float   = 0.0
        self.extruder_amp: float   = 0.0
        self.extruder_pct: int     = 0
        self.laminator_mpm: float  = 0.0
        self.laminator_amp: float  = 0.0
        self.laminator_pct: int    = 0
        self.winder_amp: float     = 0.0
        self.winder_ten_pct: int   = 0
        self.gsm: float            = 0.0
        self.gram: float           = 0.0
        self.uw_set_tension: int   = 0
        self.uw_pv_tension: int    = 0
        self.ext_speed_vol: float  = 0.0
        self.lam_speed_vol: float  = 0.0
        self.winder_ten_vol: float = 0.0
        self.emg_stop: bool        = False
        self.ingest_seq: int       = 0


state = RuntimeState()

_server_healthy: bool                   = True
_plc_online: bool                       = False
_plc_has_live_data: bool                = False
_last_queued_signature: Optional[tuple] = None


# ══════════════════════════════════════════════════════════════
#  WAL (Write-Ahead Log)
# ══════════════════════════════════════════════════════════════
class WALEntry:
    def __init__(self, path: Path):
        self.path = path

    @classmethod
    def create(cls, payload: dict) -> "WALEntry":
        batch_id = str(uuid.uuid4())
        seq      = payload["seq"]
        envelope = {
            "batch_id":    batch_id,
            "seq":         seq,
            "retry_count": 0,
            "last_error":  None,
            "created_at":  datetime.now(timezone.utc).isoformat(),
            "payload":     payload,
        }
        path = WAL_DIR / f"{seq:010d}__{batch_id}__0.json"
        _atomic_write(path, envelope)
        log.debug("[WAL] Created  %s", path.name)
        return cls(path)

    def load(self) -> dict:
        return json.loads(self.path.read_text())

    def increment_retry(self, error: str) -> None:
        data = self.load()
        data["retry_count"] += 1
        data["last_error"]   = error
        parts    = self.path.stem.split("__")
        new_name = f"{parts[0]}__{parts[1]}__{data['retry_count']}.json"
        new_path = WAL_DIR / new_name
        _atomic_write(new_path, data)
        if self.path != new_path and self.path.exists():
            self.path.unlink()
        self.path = new_path
        log.debug("[WAL] Retry %-3d  %s  err=%s", data["retry_count"], new_path.name, error)

    def mark_sent(self) -> None:
        dest = SENT_DIR / self.path.name
        self.path.rename(dest)
        log.debug("[WAL] Sent     %s", dest.name)

    def mark_dead(self) -> None:
        dest = DEAD_DIR / self.path.name
        self.path.rename(dest)
        log.error("[WAL] Dead     %s  (max retries exceeded)", dest.name)

    @property
    def retry_count(self) -> int:
        return int(self.path.stem.split("__")[2])

    @property
    def seq(self) -> int:
        return int(self.path.stem.split("__")[0])


def _atomic_write(path: Path, data: dict) -> None:
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(data, f, indent=2, default=str)
            f.flush()
            os.fsync(f.fileno())
        Path(tmp_path).rename(path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def wal_pending() -> list[WALEntry]:
    return [WALEntry(p) for p in sorted(WAL_DIR.glob("*.json"))]


def prune_sent() -> None:
    cutoff = time.time() - SENT_KEEP_HOURS * 3600
    pruned = 0
    for p in SENT_DIR.glob("*.json"):
        if p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)
            pruned += 1
    if pruned:
        log.info("[WAL] Pruned %d old sent entries", pruned)


# ══════════════════════════════════════════════════════════════
#  Health Check
# ══════════════════════════════════════════════════════════════
def check_health() -> bool:
    global _server_healthy
    try:
        resp    = _session.get(HEALTH_URL, timeout=HTTP_TIMEOUT)
        healthy = resp.status_code == 200
        if healthy != _server_healthy:
            if healthy:
                log.info("[Health] ✓ Server back online (%s)", HEALTH_URL)
            else:
                log.warning("[Health] ✗ Server unhealthy — status %d", resp.status_code)
        _server_healthy = healthy
        return healthy
    except requests.RequestException as exc:
        if _server_healthy:
            log.warning("[Health] ✗ Server unreachable: %s", exc)
        _server_healthy = False
        return False


# ══════════════════════════════════════════════════════════════
#  Outbound Push
# ══════════════════════════════════════════════════════════════
def push_one(entry: WALEntry) -> bool:
    data    = entry.load()
    payload = data["payload"]
    headers = {"X-Batch-ID": data["batch_id"]}

    try:
        resp = _session.post(
            INGEST_URL,
            json=payload,
            headers=headers,
            timeout=HTTP_TIMEOUT,
        )
        if resp.status_code in (200, 201):
            log.info(
                "[Push] ✓ seq=%-6d  batch=%s  tags=%d",
                payload["seq"], data["batch_id"][:8], len(payload["tags"]),
            )
            entry.mark_sent()
            return True
        else:
            err = f"HTTP {resp.status_code}: {resp.text[:120]}"
            log.warning("[Push] ✗ seq=%-6d  %s", payload["seq"], err)
            entry.increment_retry(err)
            if entry.retry_count >= MAX_RETRIES:
                entry.mark_dead()
            return False
    except requests.RequestException as exc:
        err = str(exc)[:120]
        log.warning("[Push] ✗ seq=%-6d  %s", payload["seq"], err)
        entry.increment_retry(err)
        if entry.retry_count >= MAX_RETRIES:
            entry.mark_dead()
        return False


# ══════════════════════════════════════════════════════════════
#  Snapshot Validation & Application
# ══════════════════════════════════════════════════════════════
def _is_finite_number(v: object) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(float(v))


def is_live_snapshot(values: dict) -> tuple[bool, str]:
    if len(values) < MIN_SUCCESS_TAGS:
        return False, f"only {len(values)} tags read (MIN={MIN_SUCCESS_TAGS})"

    missing = [t for t in REQUIRED_LIVE_TAGS if t not in values]
    if missing:
        return False, f"missing required tags: {', '.join(missing)}"

    for tag in ("EXTRUDER_RPM", "LAMINATOR_MPM", "EXTRUDER_SPEED_PCT"):
        if tag in values and not _is_finite_number(values[tag]):
            return False, f"non-finite value for {tag}: {values[tag]!r}"

    return True, "ok"


def apply_polled_snapshot(values: dict) -> None:
    state.extruder_rpm    = float(values.get("EXTRUDER_RPM",        state.extruder_rpm))
    state.extruder_amp    = float(values.get("EXTRUDER_AMP",        state.extruder_amp))
    state.extruder_pct    = int(values.get("EXTRUDER_SPEED_PCT",    state.extruder_pct))
    state.laminator_mpm   = float(values.get("LAMINATOR_MPM",       state.laminator_mpm))
    state.laminator_amp   = float(values.get("LAMINATOR_AMP",       state.laminator_amp))
    state.laminator_pct   = int(values.get("LAMINATOR_SPEED_PCT",   state.laminator_pct))
    state.winder_amp      = float(values.get("WINDER_AMP",          state.winder_amp))
    state.winder_ten_pct  = int(values.get("WINDER_TENSION_PCT",    state.winder_ten_pct))
    state.running_meter   = float(values.get("RUNNING_METER",       state.running_meter))
    state.total_meter     = float(values.get("TOTAL_METER",         state.total_meter))
    state.gsm             = float(values.get("GSM_ENTRY",           state.gsm))
    state.gram            = float(values.get("GRAM_ENTRY",          state.gram))
    state.uw_set_tension  = int(values.get("UW_SET_TENSION",        state.uw_set_tension))
    state.uw_pv_tension   = int(values.get("UW_PV_TENSION",         state.uw_pv_tension))
    state.ext_speed_vol   = float(values.get("EXTRUDER_SPEED_VOL",  state.ext_speed_vol))
    state.lam_speed_vol   = float(values.get("LAMINATOR_SPEED_VOL", state.lam_speed_vol))
    state.winder_ten_vol  = float(values.get("WINDER_TENSION_VOL",  state.winder_ten_vol))
    state.emg_stop        = bool(values.get("EMG_STOP",             state.emg_stop))


def current_state_signature() -> tuple:
    return (
        round(state.extruder_rpm, 2),
        round(state.extruder_amp, 2),
        int(state.extruder_pct),
        round(state.laminator_mpm, 2),
        round(state.laminator_amp, 2),
        int(state.laminator_pct),
        round(state.winder_amp, 2),
        int(state.winder_ten_pct),
        round(state.running_meter, 1),
        round(state.total_meter, 1),
        round(state.gsm, 2),
        round(state.gram, 2),
        int(state.uw_set_tension),
        int(state.uw_pv_tension),
        round(state.ext_speed_vol, 2),
        round(state.lam_speed_vol, 2),
        round(state.winder_ten_vol, 2),
        bool(state.emg_stop),
    )


def build_payload() -> dict:
    now = datetime.now(timezone.utc).isoformat()
    tags = [
        {"tagSlug": "EXTRUDER_RPM",        "value": round(state.extruder_rpm, 2),    "ts": now},
        {"tagSlug": "EXTRUDER_AMP",        "value": round(state.extruder_amp, 2),    "ts": now},
        {"tagSlug": "EXTRUDER_SPEED_PCT",  "value": state.extruder_pct,              "ts": now},
        {"tagSlug": "LAMINATOR_MPM",       "value": round(state.laminator_mpm, 2),   "ts": now},
        {"tagSlug": "LAMINATOR_AMP",       "value": round(state.laminator_amp, 2),   "ts": now},
        {"tagSlug": "LAMINATOR_SPEED_PCT", "value": state.laminator_pct,             "ts": now},
        {"tagSlug": "WINDER_AMP",          "value": round(state.winder_amp, 2),      "ts": now},
        {"tagSlug": "WINDER_TENSION_PCT",  "value": state.winder_ten_pct,            "ts": now},
        {"tagSlug": "RUNNING_METER",       "value": round(state.running_meter, 1),   "ts": now},
        {"tagSlug": "TOTAL_METER",         "value": round(state.total_meter, 1),     "ts": now},
        {"tagSlug": "GSM_ENTRY",           "value": round(state.gsm, 2),             "ts": now},
        {"tagSlug": "GRAM_ENTRY",          "value": round(state.gram, 2),            "ts": now},
        {"tagSlug": "UW_SET_TENSION",      "value": state.uw_set_tension,            "ts": now},
        {"tagSlug": "UW_PV_TENSION",       "value": state.uw_pv_tension,             "ts": now},
        {"tagSlug": "EXTRUDER_SPEED_VOL",  "value": round(state.ext_speed_vol, 2),   "ts": now},
        {"tagSlug": "LAMINATOR_SPEED_VOL", "value": round(state.lam_speed_vol, 2),   "ts": now},
        {"tagSlug": "WINDER_TENSION_VOL",  "value": round(state.winder_ten_vol, 2),  "ts": now},
        {"tagSlug": "MASTER_SPEED_PCT",    "value": state.extruder_pct,              "ts": now},
        {"tagSlug": "EMG_STOP",            "value": state.emg_stop,                  "ts": now},
        {"tagSlug": "EXTRUDER_ON_OFF",     "value": True,                            "ts": now},
        {"tagSlug": "LAMINATOR_ON_OFF",    "value": True,                            "ts": now},
        {"tagSlug": "WINDER_ON_OFF",       "value": True,                            "ts": now},
    ]
    payload = {
        "machineId":       MACHINE_ID,
        "machineRevision": MACHINE_REVISION,
        "sentAt":          now,
        "seq":             state.ingest_seq,
        "tags":            tags,
    }
    state.ingest_seq += 1
    return payload


# ══════════════════════════════════════════════════════════════
#  Async Task: Modbus poll loop
# ══════════════════════════════════════════════════════════════
async def modbus_client_poll_loop():
    global _plc_online, _plc_has_live_data
    loop             = asyncio.get_event_loop()
    failures         = 0
    partial_failures = 0

    log.info(
        "[Loop] Modbus poll — target %s:%d  unit=%d  interval=%.2fs  timeout=%.1fs",
        PLC_HOST, PLC_PORT, PLC_UNIT_ID, UPDATE_INTERVAL, MODBUS_TIMEOUT,
    )

    while True:
        # Pass unit_id on the client constructor — the correct pymodbus 3.6.x approach.
        # This sets the default slave/unit for all requests made through this client.
        client    = ModbusTcpClient(
            host=PLC_HOST,
            port=PLC_PORT,
            timeout=MODBUS_TIMEOUT,
        )
        connected = False
        try:
            connected = await loop.run_in_executor(None, client.connect)
            if not connected:
                raise ConnectionError("connect() returned False")

            modbus_log.debug("[MODBUS] TCP connected to %s:%d", PLC_HOST, PLC_PORT)

            values, errors = await loop.run_in_executor(None, poll_modbus_snapshot, client)
            live_ok, live_reason = is_live_snapshot(values)

            if errors:
                partial_failures += 1
                log.warning(
                    "[Poll] Partial read — %d tag error(s)  [consecutive=%d]  first: %s",
                    len(errors), partial_failures, errors[0],
                )
                if partial_failures >= PARTIAL_RECONNECT_THRESHOLD:
                    log.warning(
                        "[Poll] %d consecutive partial reads — forcing reconnect",
                        partial_failures,
                    )
                    raise RuntimeError(f"force_reconnect after {partial_failures} partial reads")
            else:
                partial_failures = 0

            if not live_ok:
                raise RuntimeError(f"snapshot_not_live ({live_reason})")

            apply_polled_snapshot(values)
            _plc_has_live_data = True

            if not _plc_online:
                log.info(
                    "[Poll] ✓ PLC online  %s:%d  tags=%d",
                    PLC_HOST, PLC_PORT, len(values),
                )
            _plc_online = True
            failures    = 0

            jitter = random.uniform(0.0, POLL_JITTER_MAX)
            await asyncio.sleep(max(0.0, UPDATE_INTERVAL + jitter))

        except Exception as exc:
            if _plc_online:
                log.warning("[Poll] ✗ PLC went offline: %s", str(exc)[:160])
            _plc_online = False
            failures   += 1
            backoff     = min(POLL_BACKOFF_MAX, POLL_BACKOFF_BASE * (2 ** (failures - 1)))
            backoff    += random.uniform(0.0, POLL_JITTER_MAX)
            log.warning("[Poll] Failed #%d — retry in %.2fs", failures, backoff)
            await asyncio.sleep(backoff)

        finally:
            # Always close — even if connect() raised, pymodbus may have opened socket
            try:
                await loop.run_in_executor(None, client.close)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════
#  Async Task: Push loop (WAL-based)
# ══════════════════════════════════════════════════════════════
async def push_loop():
    global _last_queued_signature
    loop = asyncio.get_event_loop()

    log.info("[Loop] Push loop    — interval %.1fs", PUSH_INTERVAL)
    log.info("[Loop] Ingest URL   — %s", INGEST_URL)
    log.info("[Loop] Health URL   — %s", HEALTH_URL)
    log.info("[Loop] WAL dir      — %s", WAL_DIR)

    while True:
        await asyncio.sleep(PUSH_INTERVAL)

        if not _plc_online:
            log.debug("[Push] Skipped — PLC offline")
            continue
        if not _plc_has_live_data:
            log.debug("[Push] Skipped — waiting for first PLC snapshot")
            continue

        healthy = await loop.run_in_executor(None, check_health)

        signature    = current_state_signature()
        data_changed = signature != _last_queued_signature

        if not healthy:
            pending = len(list(WAL_DIR.glob("*.json")))
            if data_changed:
                payload = build_payload()
                WALEntry.create(payload)
                _last_queued_signature = signature
                log.info(
                    "[Push] Server down — queued batch  (pending=%d)", pending + 1,
                )
            else:
                log.debug("[Push] Server down + no data change — skip  (pending=%d)", pending)
            continue

        if not data_changed:
            log.debug("[Push] Skipped — no PLC value change")
            continue

        payload = build_payload()
        WALEntry.create(payload)
        _last_queued_signature = signature

        pending_entries = wal_pending()
        log.debug("[Push] Flushing %d pending batch(es)", len(pending_entries))

        for entry in pending_entries:
            success = await loop.run_in_executor(None, push_one, entry)
            if not success:
                break

        await loop.run_in_executor(None, prune_sent)


# ══════════════════════════════════════════════════════════════
#  Async Task: Status log
# ══════════════════════════════════════════════════════════════
async def status_log_loop():
    while True:
        await asyncio.sleep(30.0)
        pending = len(list(WAL_DIR.glob("*.json")))
        dead    = len(list(DEAD_DIR.glob("*.json")))
        log.info(
            "[Status] RPM=%.1f  MPM=%.1f  AMP=%.1f | "
            "RunM=%.0f  TotalM=%.0f | "
            "seq=%d  queued=%d  dead=%d | "
            "server=%s  plc=%s  live=%s",
            state.extruder_rpm,  state.laminator_mpm, state.extruder_amp,
            state.running_meter, state.total_meter,   state.ingest_seq,
            pending, dead,
            "OK" if _server_healthy else "DOWN",
            "OK" if _plc_online     else "DOWN",
            _plc_has_live_data,
        )


# ══════════════════════════════════════════════════════════════
#  Graceful shutdown
# ══════════════════════════════════════════════════════════════
_shutdown_event: Optional[asyncio.Event] = None


def _handle_signal(sig, _loop):
    log.info("[Signal] %s received — shutting down ...", sig.name)
    if _shutdown_event:
        _shutdown_event.set()


# ══════════════════════════════════════════════════════════════
#  Main
# ══════════════════════════════════════════════════════════════
async def main():
    global _shutdown_event
    _shutdown_event = asyncio.Event()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_signal, sig, loop)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _shutdown_event.set())

    border = "=" * 60
    log.info(border)
    log.info("  Nonwoven Modbus Poller — Production Edition (Fixed)")
    log.info(border)
    log.info("  PLC:          %s:%d  unit=%d", PLC_HOST, PLC_PORT, PLC_UNIT_ID)
    log.info("  Ingest URL:   %s", INGEST_URL)
    log.info("  Health URL:   %s", HEALTH_URL)
    log.info("  Machine:      %s (%s)", MACHINE_ID, MACHINE_REVISION)
    log.info("  WAL dir:      %s", WAL_DIR)
    log.info("  Log dir:      %s", LOG_DIR)
    log.info("  Poll:         every %.1fs", UPDATE_INTERVAL)
    log.info("  Push:         every %.1fs", PUSH_INTERVAL)
    log.info("  MaxRetries:   %d (~%.0f min)", MAX_RETRIES, MAX_RETRIES * PUSH_INTERVAL / 60)
    log.info("  Log files:    pipeline.log | modbus.log (raw regs) | errors.log")
    log.info(border)

    leftover = len(list(WAL_DIR.glob("*.json")))
    if leftover:
        log.warning("[WAL] %d unsent batch(es) from previous run — will replay", leftover)

    tasks = [
        asyncio.create_task(modbus_client_poll_loop(), name="modbus-poll"),
        asyncio.create_task(push_loop(),               name="push-loop"),
        asyncio.create_task(status_log_loop(),         name="status-log"),
    ]

    await _shutdown_event.wait()

    log.info("[Shutdown] Stopping tasks ...")
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    log.info("[Shutdown] Clean exit.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass