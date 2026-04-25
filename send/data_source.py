#!/usr/bin/env python3
"""
============================================================
  Raspberry Pi 4 — Modbus TCP Poller + Remote Data Pipeline
  Production Edition — WAL / Retry Queue / Health Check
  For: Nonwoven Lamination AI Agent
============================================================

Features:
  • Modbus TCP CLIENT — polls real PLC for live sensor data
  • WAL (Write-Ahead Log) — every batch durably written before HTTP push
  • Health check FIRST — GET /health before deciding to queue or push
  • No duplicate batches — only queues when PLC data actually changes
  • Retry queue — failed batches replayed oldest-first (no data loss)
  • Atomic file writes — temp→fsync→rename (power-loss safe)
  • Rotating log files + JSON audit trail
  • Systemd ready — exits cleanly on SIGTERM

Dependencies:
  pip install "pymodbus==3.6.9" requests python-dotenv

Run (development):
  python3 data_source.py

Run (production):
  sudo python3 data_source.py
"""

import asyncio
import json
import logging
import logging.handlers
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
from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusSlaveContext,
    ModbusServerContext,
)

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


# ── Logging ───────────────────────────────────────────────────
def _setup_logging():
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(name)s — %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    root.addHandler(ch)

    fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "pipeline.log", maxBytes=10 * 1024 * 1024, backupCount=5
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    root.addHandler(fh)


_setup_logging()
log = logging.getLogger("pipeline")


# ── Configuration ─────────────────────────────────────────────
REMOTE_BASE_URL  = os.getenv("REMOTE_BASE_URL", "https://mace-ebony-capital.ngrok-free.dev")
INGEST_PATH      = os.getenv("INGEST_PATH", "/ingest/tags")
HEALTH_PATH      = os.getenv("HEALTH_PATH", "/health")
API_AUTH_TOKEN   = os.getenv("API_AUTH_TOKEN", "dev-local-token")
MACHINE_ID       = os.getenv("MACHINE_ID", "lamination-01")
MACHINE_REVISION = os.getenv("MACHINE_REVISION", "v1")

PLC_HOST         = os.getenv("PLC_HOST", "127.0.0.1")
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

INGEST_URL = REMOTE_BASE_URL.rstrip("/") + INGEST_PATH
HEALTH_URL = REMOTE_BASE_URL.rstrip("/") + HEALTH_PATH

# ── Shared HTTP session ───────────────────────────────────────
_session = requests.Session()
_session.headers.update({
    "Content-Type":  "application/json",
    "Authorization": f"Bearer {API_AUTH_TOKEN}",
    "User-Agent":    f"NonwovenAgent/{MACHINE_REVISION}",
})


# ── Register Map ──────────────────────────────────────────────
HREG_EXTRUDER_SPEED_PCT  = 0
HREG_LAMINATOR_SPEED_PCT = 1
HREG_WINDER_TENSION_PCT  = 2
HREG_SPLICE_SPEED        = 17
HREG_UW_SET_TENSION      = 3501
HREG_UW_PV_TENSION       = 3879
HREG_RUNNING_METER       = 7
HREG_TOTAL_METER         = 9
HREG_WINDER_TENSION_VOL  = 1039
HREG_EXTRUDER_RPM        = 1103
HREG_LAMINATOR_MPM       = 1105
HREG_EXTRUDER_AMP        = 1107
HREG_LAMINATOR_AMP       = 1109
HREG_WINDER_AMP          = 1111
HREG_EXTRUDER_SPEED_VOL  = 1199
HREG_LAMINATOR_SPEED_VOL = 1201
HREG_GSM_ENTRY           = 1299
HREG_GRAM_ENTRY          = 3003

COIL_EMG_STOP            = 8
COIL_EXTRUDER_FAULT      = 11
COIL_LAMINATOR_FAULT     = 12
COIL_WINDER_FAULT        = 13
COIL_EXTRUDER_ON_OFF     = 99
COIL_LAMINATOR_ON_OFF    = 100
COIL_WINDER_ON_OFF       = 101
COIL_SPLICE_ON_OFF       = 110
COIL_ALARM_IND           = 124

HREG_COUNT = 3880
COIL_COUNT = 125


# ── Tag Config ────────────────────────────────────────────────
@dataclass(frozen=True)
class TagConfig:
    addr: int
    type: Literal["float", "uint16", "bool"]
    fc: int  # 3=HREG, 1=COIL, 4=IREG


TAGS: dict[str, TagConfig] = {
    "EXTRUDER_RPM":        TagConfig(addr=401104, type="float",  fc=3),
    "EXTRUDER_AMP":        TagConfig(addr=401108, type="float",  fc=3),
    "EXTRUDER_SPEED_PCT":  TagConfig(addr=400001, type="uint16", fc=3),
    "EXTRUDER_ON_OFF":     TagConfig(addr=100,    type="bool",   fc=1),
    "EXTRUDER_FAULT":      TagConfig(addr=12,     type="bool",   fc=1),
    "EXTRUDER_SPEED_VOL":  TagConfig(addr=401200, type="float",  fc=3),
    "LAMINATOR_MPM":       TagConfig(addr=401106, type="float",  fc=3),
    "LAMINATOR_AMP":       TagConfig(addr=401110, type="float",  fc=3),
    "LAMINATOR_SPEED_PCT": TagConfig(addr=400002, type="uint16", fc=3),
    "LAMINATOR_ON_OFF":    TagConfig(addr=101,    type="bool",   fc=1),
    "LAMINATOR_FAULT":     TagConfig(addr=13,     type="bool",   fc=1),
    "LAMINATOR_SPEED_VOL": TagConfig(addr=401202, type="float",  fc=3),
    "WINDER_AMP":          TagConfig(addr=401112, type="float",  fc=3),
    "WINDER_TENSION_PCT":  TagConfig(addr=400003, type="uint16", fc=3),
    "WINDER_ON_OFF":       TagConfig(addr=102,    type="bool",   fc=1),
    "WINDER_FAULT":        TagConfig(addr=14,     type="bool",   fc=1),
    "WINDER_TENSION_VOL":  TagConfig(addr=401040, type="float",  fc=3),
    "MASTER_SPEED_PCT":    TagConfig(addr=400000, type="uint16", fc=3),
    "UW_SET_TENSION":      TagConfig(addr=403502, type="uint16", fc=3),
    "UW_PV_TENSION":       TagConfig(addr=403880, type="uint16", fc=3),
    "RUNNING_METER":       TagConfig(addr=400008, type="float",  fc=3),
    "TOTAL_METER":         TagConfig(addr=400010, type="float",  fc=3),
    "GSM_ENTRY":           TagConfig(addr=401300, type="float",  fc=3),
    "GRAM_ENTRY":          TagConfig(addr=403004, type="float",  fc=3),
    "ALARM_IND":           TagConfig(addr=125,    type="bool",   fc=1),
    "EMG_STOP":            TagConfig(addr=9,      type="bool",   fc=1),
    "SPLICE_ON_OFF":       TagConfig(addr=111,    type="bool",   fc=1),
    "SPLICE_SPEED":        TagConfig(addr=400018, type="uint16", fc=3),
}


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

# ── Global flags ──────────────────────────────────────────────
_server_healthy: bool         = True   # optimistic
_plc_online: bool             = False
_plc_has_live_data: bool      = False
_last_queued_signature: Optional[tuple] = None


# ══════════════════════════════════════════════════════════════
#  WAL (Write-Ahead Log)
# ══════════════════════════════════════════════════════════════
class WALEntry:
    """
    One durable batch file on disk.

    Filename: <seq>__<uuid4>__<retry_count>.json
    Contents:
      payload      — original IngestBatch JSON (never mutated)
      created_at   — ISO timestamp of first write
      batch_id     — stable UUID for server-side idempotency
      seq          — monotonic sequence number
      retry_count  — incremented on each failed attempt
      last_error   — last HTTP status or exception string
    """

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
    """temp → fsync → rename  (power-loss safe)"""
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
    """All pending WAL entries sorted oldest-first."""
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
    """POST one WAL entry. Returns True on HTTP 200/201."""
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
#  Modbus Helpers
# ══════════════════════════════════════════════════════════════
def float_to_regs(value: float) -> list[int]:
    raw = struct.pack(">f", value)
    return [
        struct.unpack(">H", raw[0:2])[0],
        struct.unpack(">H", raw[2:4])[0],
    ]


def regs_to_float(hi: int, lo: int) -> float:
    return struct.unpack(">f", struct.pack(">HH", hi, lo))[0]


def _read_tag(client: ModbusTcpClient, cfg: TagConfig):
    if cfg.fc == 3:
        base = cfg.addr - 400001
        if cfg.type == "float":
            rr = client.read_holding_registers(address=base, count=2, slave=PLC_UNIT_ID)
            if rr.isError():
                raise RuntimeError(str(rr))
            return regs_to_float(rr.registers[0], rr.registers[1])
        rr = client.read_holding_registers(address=base, count=1, slave=PLC_UNIT_ID)
        if rr.isError():
            raise RuntimeError(str(rr))
        return int(rr.registers[0])

    if cfg.fc == 4:
        base = cfg.addr - 300001
        rr = client.read_input_registers(address=base, count=1, slave=PLC_UNIT_ID)
        if rr.isError():
            raise RuntimeError(str(rr))
        v = int(rr.registers[0])
        return v if v < 32768 else v - 65536

    if cfg.fc == 1:
        base = cfg.addr - 1
        rr = client.read_coils(address=base, count=1, slave=PLC_UNIT_ID)
        if rr.isError():
            raise RuntimeError(str(rr))
        return bool(rr.bits[0])

    raise ValueError(f"Unsupported FC: {cfg.fc}")


def poll_modbus_snapshot(client: ModbusTcpClient) -> tuple[dict, list[str]]:
    values: dict = {}
    errors: list[str] = []
    for tag_name, cfg in TAGS.items():
        try:
            values[tag_name] = _read_tag(client, cfg)
        except Exception as exc:
            errors.append(f"{tag_name}: {exc}")
    return values, errors


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
    """
    Fingerprint of all PLC-derived values.
    If this hasn't changed since the last queued batch, skip queuing.
    Excludes timestamps and sequence numbers.
    """
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
    loop     = asyncio.get_event_loop()
    failures = 0

    log.info(
        "[Loop] Modbus poll — target %s:%d  unit=%d  interval=%.2fs",
        PLC_HOST, PLC_PORT, PLC_UNIT_ID, UPDATE_INTERVAL,
    )

    while True:
        client    = ModbusTcpClient(host=PLC_HOST, port=PLC_PORT, timeout=MODBUS_TIMEOUT)
        connected = False
        try:
            connected = await loop.run_in_executor(None, client.connect)
            if not connected:
                raise ConnectionError("connect() returned False")

            values, errors = await loop.run_in_executor(None, poll_modbus_snapshot, client)

            if values:
                apply_polled_snapshot(values)
                _plc_has_live_data = True

            if not _plc_online:
                log.info("[Poll] ✓ PLC online  (%s:%d)", PLC_HOST, PLC_PORT)
            _plc_online = True

            if errors:
                log.warning(
                    "[Poll] Partial read — %d tag(s) failed; sample: %s",
                    len(errors), errors[0],
                )

            failures = 0
            jitter   = random.uniform(0.0, POLL_JITTER_MAX)
            await asyncio.sleep(max(0.0, UPDATE_INTERVAL + jitter))

        except Exception as exc:
            if _plc_online:
                log.warning("[Poll] ✗ PLC went offline: %s", str(exc)[:120])
            _plc_online = False
            failures   += 1
            backoff     = min(POLL_BACKOFF_MAX, POLL_BACKOFF_BASE * (2 ** (failures - 1)))
            backoff    += random.uniform(0.0, POLL_JITTER_MAX)
            log.warning(
                "[Poll] Failed #%d — retry in %.2fs", failures, backoff
            )
            await asyncio.sleep(backoff)

        finally:
            if connected:
                await loop.run_in_executor(None, client.close)


# ══════════════════════════════════════════════════════════════
#  Async Task: Push loop  (WAL-based)
# ══════════════════════════════════════════════════════════════
async def push_loop():
    """
    Every PUSH_INTERVAL seconds, this loop:

      1.  Skips if PLC is offline or no live data yet
      2.  Runs health check FIRST (GET /health)
      3a. If server DOWN + data changed  → write WAL (buffer for later), stop
      3b. If server DOWN + data unchanged → do nothing (no duplicate batches)
      4.  If server UP + data unchanged   → skip (no duplicate batches)
      5.  If server UP + data changed     → write WAL, then flush all pending
          batches oldest-first

    Key guarantee: batches are ONLY written to WAL when PLC data has actually
    changed. No duplicate or stale data is ever pushed.
    """
    global _last_queued_signature
    loop = asyncio.get_event_loop()

    log.info("[Loop] Push loop    — interval %.1fs", PUSH_INTERVAL)
    log.info("[Loop] Ingest URL   — %s", INGEST_URL)
    log.info("[Loop] Health URL   — %s", HEALTH_URL)
    log.info("[Loop] WAL dir      — %s", WAL_DIR)

    while True:
        await asyncio.sleep(PUSH_INTERVAL)

        # ── 1. Gate: PLC must be online with at least one snapshot ──
        if not _plc_online:
            log.debug("[Push] Skipped — PLC offline")
            continue
        if not _plc_has_live_data:
            log.debug("[Push] Skipped — waiting for first PLC snapshot")
            continue

        # ── 2. Health check FIRST (before deciding to queue) ────────
        healthy = await loop.run_in_executor(None, check_health)

        # ── 3. Has PLC data actually changed? ───────────────────────
        signature    = current_state_signature()
        data_changed = signature != _last_queued_signature

        if not healthy:
            pending = len(list(WAL_DIR.glob("*.json")))
            if data_changed:
                # Server is down BUT machine is producing new data —
                # durably queue it so nothing is lost when server recovers.
                payload = build_payload()
                WALEntry.create(payload)
                _last_queued_signature = signature
                log.info(
                    "[Push] Server unhealthy — new batch queued  (total pending=%d)",
                    pending + 1,
                )
            else:
                # Server is down AND data hasn't changed — nothing to queue.
                log.debug(
                    "[Push] Server unhealthy + no data change — skipping  (pending=%d)",
                    pending,
                )
            continue  # either way, don't attempt to push yet

        # ── 4. Server is healthy ─────────────────────────────────────
        if not data_changed:
            # Data is frozen (machine idle / same values) — don't push duplicates.
            log.debug("[Push] Skipped — no PLC value change since last batch")
            continue

        # ── 5. Server healthy + data changed — write WAL then flush ──
        payload = build_payload()
        WALEntry.create(payload)
        _last_queued_signature = signature

        pending_entries = wal_pending()
        log.debug("[Push] Flushing %d pending batch(es)", len(pending_entries))

        for entry in pending_entries:
            success = await loop.run_in_executor(None, push_one, entry)
            if not success:
                # Server hiccupped mid-flush — stop and retry next cycle.
                break

        # Housekeeping: prune old sent/ files
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
            "[Status] RPM=%.1f  MPM=%.1f  AMP=%.1f  "
            "RunM=%.0f  TotalM=%.0f  seq=%d  "
            "queued=%d  dead=%d  server=%s  plc=%s  live=%s",
            state.extruder_rpm,  state.laminator_mpm, state.extruder_amp,
            state.running_meter, state.total_meter,   state.ingest_seq,
            pending, dead,
            "✓" if _server_healthy else "✗",
            "✓" if _plc_online     else "✗",
            _plc_has_live_data,
        )


# ══════════════════════════════════════════════════════════════
#  Graceful shutdown
# ══════════════════════════════════════════════════════════════
_shutdown_event: Optional[asyncio.Event] = None


def _handle_signal(sig, _loop):
    log.info("[Signal] %s received — shutting down gracefully …", sig.name)
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
    log.info("  Nonwoven Modbus Poller — Production Edition")
    log.info(border)
    log.info("  PLC:         %s:%d  unit=%d", PLC_HOST, PLC_PORT, PLC_UNIT_ID)
    log.info("  Ingest URL:  %s", INGEST_URL)
    log.info("  Health URL:  %s", HEALTH_URL)
    log.info("  Machine:     %s (%s)", MACHINE_ID, MACHINE_REVISION)
    log.info("  WAL dir:     %s", WAL_DIR)
    log.info("  Poll:        every %.1fs", UPDATE_INTERVAL)
    log.info("  Push:        every %.1fs", PUSH_INTERVAL)
    log.info("  MaxRetries:  %d  (~%.0f min)", MAX_RETRIES, MAX_RETRIES * PUSH_INTERVAL / 60)
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

    log.info("[Shutdown] Stopping tasks …")
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    log.info("[Shutdown] Clean exit.")


# ══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
