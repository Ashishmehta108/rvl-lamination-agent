#a1.py
#!/usr/bin/env python3
"""
============================================================
  Raspberry Pi 4 — Modbus TCP Poller + Remote Data Pipeline
  Production Edition — WAL / Retry Queue / Health Check
  For: Nonwoven Lamination AI Agent
============================================================

FIXES in this version:
  • ALL tag addresses corrected from PLC XML (ExportedTags.xml)
    Formula: modbus_offset = xml_offset - 400001  (HREG)
             modbus_offset = xml_offset - 1        (COIL/OUTP)
    Every previous address was off by 1.
  • Persistent Modbus client — created once, reused across polls.
    No more 120 TCP handshakes/minute.
  • Per-tag try/except — one failed tag never kills the snapshot.
  • No liveness gate — MIN_SUCCESS_TAGS / REQUIRED_LIVE_TAGS removed.
    Mirrors the Node.js file that worked.
  • Socket always closed on all exit paths.
  • Raw register debug logging to modbus.log.

Dependencies:
  pip install "pymodbus==3.6.9" requests python-dotenv

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
#  Logging
# ══════════════════════════════════════════════════════════════
class _PreciseFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):
        ct = datetime.fromtimestamp(record.created, tz=timezone.utc)
        return ct.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(record.msecs):03d}Z"


def _setup_logging():
    log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    root_level     = getattr(logging, log_level_name, logging.INFO)
    fmt = _PreciseFormatter("%(asctime)s [%(levelname)-8s] %(name)s - %(message)s")

    root = logging.getLogger()
    root.setLevel(root_level)
    root.handlers.clear()

    ch = logging.StreamHandler()
    ch.setLevel(root_level)
    ch.setFormatter(fmt)
    root.addHandler(ch)

    fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "pipeline.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    fh.setLevel(root_level)
    fh.setFormatter(fmt)
    root.addHandler(fh)

    # modbus.log — raw register values at DEBUG level
    modbus_fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "modbus.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    modbus_fh.setLevel(logging.DEBUG)
    modbus_fh.setFormatter(fmt)
    modbus_logger = logging.getLogger("modbus")
    modbus_logger.setLevel(logging.DEBUG)
    modbus_logger.addHandler(modbus_fh)
    modbus_logger.propagate = True

    # errors.log — ERROR+ only
    eh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "errors.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    eh.setLevel(logging.ERROR)
    eh.setFormatter(fmt)
    root.addHandler(eh)

    if root_level > logging.DEBUG:
        logging.getLogger("pymodbus").setLevel(logging.WARNING)
        logging.getLogger("pymodbus.client").setLevel(logging.WARNING)
    else:
        logging.getLogger("pymodbus").setLevel(logging.DEBUG)


_setup_logging()
log        = logging.getLogger("pipeline")
modbus_log = logging.getLogger("modbus")


# ── Configuration ─────────────────────────────────────────────
REMOTE_BASE_URL   = os.getenv("REMOTE_BASE_URL", "https://mace-ebony-capital.ngrok-free.dev")
INGEST_PATH       = os.getenv("INGEST_PATH", "/ingest/tags")
HEALTH_PATH       = os.getenv("HEALTH_PATH", "/health")
API_AUTH_TOKEN    = os.getenv("API_AUTH_TOKEN", "dev-local-token")
MACHINE_ID        = os.getenv("MACHINE_ID", "lamination-01")
MACHINE_REVISION  = os.getenv("MACHINE_REVISION", "v1")

PLC_HOST          = os.getenv("PLC_HOST", "192.168.1.17")
PLC_PORT          = int(os.getenv("PLC_PORT", "502"))
PLC_UNIT_ID       = int(os.getenv("PLC_UNIT_ID", "1"))
MODBUS_TIMEOUT    = float(os.getenv("MODBUS_TIMEOUT", "3.0"))

UPDATE_INTERVAL   = float(os.getenv("UPDATE_INTERVAL", "0.5"))
PUSH_INTERVAL     = float(os.getenv("PUSH_INTERVAL", "5.0"))
HTTP_TIMEOUT      = float(os.getenv("HTTP_TIMEOUT", "10.0"))
MAX_RETRIES       = int(os.getenv("MAX_RETRIES", "72"))
RETRY_BACKOFF_CAP = float(os.getenv("RETRY_BACKOFF_CAP", "60.0"))
SENT_KEEP_HOURS   = float(os.getenv("SENT_KEEP_HOURS", "24.0"))

POLL_BACKOFF_BASE = float(os.getenv("POLL_BACKOFF_BASE", "1.0"))
POLL_BACKOFF_MAX  = float(os.getenv("POLL_BACKOFF_MAX", "30.0"))
POLL_JITTER_MAX   = float(os.getenv("POLL_JITTER_MAX", "0.2"))

INGEST_URL = REMOTE_BASE_URL.rstrip("/") + INGEST_PATH
HEALTH_URL = REMOTE_BASE_URL.rstrip("/") + HEALTH_PATH

_session = requests.Session()
_session.headers.update({
    "Content-Type":  "application/json",
    "Authorization": f"Bearer {API_AUTH_TOKEN}",
    "User-Agent":    f"NonwovenAgent/{MACHINE_REVISION}",
})


# ══════════════════════════════════════════════════════════════
#  Tag Definitions — addresses verified from ExportedTags.xml
#
#  HREG addressing:
#    XML offset (e.g. 401105) → modbus_offset = xml_offset - 400001
#    Example: XML 401105 → modbus 1104
#
#  COIL/OUTP addressing:
#    XML offset (e.g. 101) → modbus_offset = xml_offset - 1
#    Example: XML 101 → modbus 100
#
#  TagConfig.addr stores the RAW XML offset value.
#  _read_tag() applies the correct formula per fc type.
# ══════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class TagConfig:
    addr: int
    type: Literal["float", "uint16", "bool"]
    fc: int  # 3=HREG, 1=COIL


TAGS: dict[str, TagConfig] = {
    # ── Extruder ──────────────────────────────────────────────
    # XML: EXTRUDER_1_SCREW_1_ACT_RPM_D1104  offset=401105  float
    #sorted
    "EXTRUDER_RPM":        TagConfig(addr=401105, type="float",  fc=3),  # modbus 1104

    # XML: EXTRUDER_1_SCREW_1_ACT_AMP_D1108  offset=401109  float
    # >401109<
    "EXTRUDER_AMP":        TagConfig(addr=401109, type="float",  fc=3),  # modbus 1108

    # XML: EXTRUDER_1_SCREW_1_SPEED%_D1  offset=400002  unsignedShort
    "EXTRUDER_SPEED_PCT":  TagConfig(addr=400002, type="uint16", fc=3),  # modbus 1

    # XML: EXTRUDER_1_SCREW_1_ON/OFF_M100  offset=101  boolean
    "EXTRUDER_ON_OFF":     TagConfig(addr=101,    type="bool",   fc=1),  # modbus 100

    # XML: EX_1_SC_1_FAULT_M12  offset=13  boolean
    "EXTRUDER_FAULT":      TagConfig(addr=13,     type="bool",   fc=1),  # modbus 12

    # XML: EXTRUDER_1_SCREW_1_SPEED_VOL_D1200  offset=401201  float
    "EXTRUDER_SPEED_VOL":  TagConfig(addr=401201, type="float",  fc=3),  # modbus 1200

    # ── Laminator ─────────────────────────────────────────────
    # XML: LAMINATOR_ACT_MPM_D1106  offset=401107  float
    "LAMINATOR_MPM":       TagConfig(addr=401107, type="float",  fc=3),  # modbus 1106

    # XML: LAMINATOR_1_ACT_AMP_D1110  offset=401111  float
    "LAMINATOR_AMP":       TagConfig(addr=401111, type="float",  fc=3),  # modbus 1110

    # XML: LAMINATOR_SPEED%_D2  offset=400003  unsignedShort
    "LAMINATOR_SPEED_PCT": TagConfig(addr=400003, type="uint16", fc=3),  # modbus 2

    # XML: LAMINATOR_1_ON/OFF_M101  offset=102  boolean
    "LAMINATOR_ON_OFF":    TagConfig(addr=102,    type="bool",   fc=1),  # modbus 101

    # XML: LAMINATOR_1_DRIVE_FAULT_M13  offset=14  boolean
    "LAMINATOR_FAULT":     TagConfig(addr=14,     type="bool",   fc=1),  # modbus 13

    # XML: LAMINATOR_1_SPEED_VOL_D1202  offset=401203  float
    "LAMINATOR_SPEED_VOL": TagConfig(addr=401203, type="float",  fc=3),  # modbus 1202

    # ── Winder ────────────────────────────────────────────────
    # XML: WINDER_ACT_AMP_D1112  offset=401113  float
    "WINDER_AMP":          TagConfig(addr=401113, type="float",  fc=3),  # modbus 1112

    # XML: WINDER_TENSION%_D3  offset=400004  unsignedShort
    "WINDER_TENSION_PCT":  TagConfig(addr=400004, type="uint16", fc=3),  # modbus 3

    # XML: WINDER_ON/OFF_M102  offset=103  boolean
    "WINDER_ON_OFF":       TagConfig(addr=103,    type="bool",   fc=1),  # modbus 102

    # XML: WINDER_DRIVE_FAULT_M14  offset=15  boolean
    "WINDER_FAULT":        TagConfig(addr=15,     type="bool",   fc=1),  # modbus 14

    # XML: WINDER_TENSION_VOL_D1040  offset=401041  float
    "WINDER_TENSION_VOL":  TagConfig(addr=401041, type="float",  fc=3),  # modbus 1040

    # ── Master / Line ─────────────────────────────────────────
    # XML: MASTER_SPEED%_D0  offset=400001  unsignedShort
    "MASTER_SPEED_PCT":    TagConfig(addr=400001, type="uint16", fc=3),  # modbus 0

    # ── Unwinder tension ──────────────────────────────────────
    # XML: UW_SET_TENSION_D3502  offset=403503  unsignedShort
    "UW_SET_TENSION":      TagConfig(addr=403503, type="uint16", fc=3),  # modbus 3502

    # XML: UW_PV_WITH_FILTER_D3880  offset=403881  unsignedShort
    "UW_PV_TENSION":       TagConfig(addr=403881, type="uint16", fc=3),  # modbus 3880

    # ── Production meters ─────────────────────────────────────
    # XML: RUNNING_METER_D8  offset=400009  float
    "RUNNING_METER":       TagConfig(addr=400009, type="float",  fc=3),  # modbus 8

    # XML: TOTAL_METER_D10  offset=400011  float
    "TOTAL_METER":         TagConfig(addr=400011, type="float",  fc=3),  # modbus 10

    # ── GSM / Gram ────────────────────────────────────────────
    # XML: EX_1_SC_1_GSM_ENTRY_D1300  offset=401301  float
    "GSM_ENTRY":           TagConfig(addr=401301, type="float",  fc=3),  # modbus 1300

    # XML: EX_1_SC_1_GRAM_ENTRY_M3004  offset=403005  float
    "GRAM_ENTRY":          TagConfig(addr=403005, type="float",  fc=3),  # modbus 3004

    # ── Alarms / Safety ───────────────────────────────────────
    # XML: ALARM_IND_M125  offset=126  boolean
    "ALARM_IND":           TagConfig(addr=126,    type="bool",   fc=1),  # modbus 125

    # XML: EMG_STOP_BIT_M9  offset=10  boolean
    "EMG_STOP":            TagConfig(addr=10,     type="bool",   fc=1),  # modbus 9

    # ── Splice ────────────────────────────────────────────────
    # XML: SPLICE_ON/OFF_M111  offset=112  boolean
    "SPLICE_ON_OFF":       TagConfig(addr=112,    type="bool",   fc=1),  # modbus 111

    # XML: SPLICE_SPEED_D18  offset=400019  unsignedShort
    "SPLICE_SPEED":        TagConfig(addr=400019, type="uint16", fc=3),  # modbus 18
}


# ══════════════════════════════════════════════════════════════
#  Modbus read helpers
# ══════════════════════════════════════════════════════════════
def _regs_to_float(hi: int, lo: int) -> float:
    """Big-endian float from two 16-bit registers."""
    return struct.unpack(">f", struct.pack(">HH", hi, lo))[0]


def _read_tag(client: ModbusTcpClient, tag_name: str, cfg: TagConfig):
    """
    Read a single tag. Returns the decoded value or raises on error.
    Logs raw register values to modbus.log at DEBUG level.
    """
    if cfg.fc == 3:
        base = cfg.addr - 400001
        if cfg.type == "float":
            rr = client.read_holding_registers(address=base, count=2, slave=PLC_UNIT_ID)
            if rr.isError():
                raise RuntimeError(str(rr))
            val = _regs_to_float(rr.registers[0], rr.registers[1])
            modbus_log.debug(
                "[MODBUS] %-25s  addr=%d  raw=[0x%04X, 0x%04X]  decoded=%.4f",
                tag_name, base, rr.registers[0], rr.registers[1], val
            )
            if not math.isfinite(val):
                modbus_log.warning("[MODBUS] %-25s  non-finite float — returning 0.0", tag_name)
                return 0.0
            return val
        else:  # uint16
            rr = client.read_holding_registers(address=base, count=1, slave=PLC_UNIT_ID)
            if rr.isError():
                raise RuntimeError(str(rr))
            val = int(rr.registers[0])
            modbus_log.debug("[MODBUS] %-25s  addr=%d  value=%d", tag_name, base, val)
            return val

    if cfg.fc == 1:
        base = cfg.addr - 1
        rr = client.read_coils(address=base, count=1, slave=PLC_UNIT_ID)
        if rr.isError():
            raise RuntimeError(str(rr))
        val = bool(rr.bits[0])
        modbus_log.debug("[MODBUS] %-25s  coil=%d  value=%s", tag_name, base, val)
        return val

    raise ValueError(f"Unsupported FC: {cfg.fc}")


def poll_modbus_snapshot(client: ModbusTcpClient) -> tuple[dict, list[str]]:
    """
    Per-tag reads with individual try/except.
    One failed tag stores None and continues — poll never dies.
    Mirrors the Node.js implementation that worked.
    """
    values: dict      = {}
    errors: list[str] = []

    for tag_name, cfg in TAGS.items():
        try:
            values[tag_name] = _read_tag(client, tag_name, cfg)
        except Exception as exc:
            errors.append(f"{tag_name}: {exc}")
            modbus_log.warning("[MODBUS] %-25s  FAILED: %s", tag_name, exc)

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
#  Snapshot application
# ══════════════════════════════════════════════════════════════
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
        resp = _session.post(INGEST_URL, json=payload, headers=headers, timeout=HTTP_TIMEOUT)
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
#  Async Task: Modbus poll loop — persistent client
# ══════════════════════════════════════════════════════════════
async def modbus_client_poll_loop():
    global _plc_online, _plc_has_live_data
    loop     = asyncio.get_event_loop()
    failures = 0

    log.info(
        "[Loop] Modbus poll — target %s:%d  unit=%d  interval=%.2fs  timeout=%.1fs",
        PLC_HOST, PLC_PORT, PLC_UNIT_ID, UPDATE_INTERVAL, MODBUS_TIMEOUT,
    )

    while True:
        # Create a fresh client each connection attempt
        client    = ModbusTcpClient(host=PLC_HOST, port=PLC_PORT, timeout=MODBUS_TIMEOUT)
        connected = False

        try:
            connected = await loop.run_in_executor(None, client.connect)
            if not connected:
                raise ConnectionError("connect() returned False")

            modbus_log.debug("[MODBUS] TCP connected to %s:%d  unit=%d", PLC_HOST, PLC_PORT, PLC_UNIT_ID)

            if not _plc_online:
                log.info("[Poll] ✓ PLC online  %s:%d", PLC_HOST, PLC_PORT)
            _plc_online = True
            failures    = 0

            # ── Inner poll loop — keep reusing this connection ──
            while True:
                values, errors = await loop.run_in_executor(None, poll_modbus_snapshot, client)

                if errors:
                    log.warning(
                        "[Poll] %d tag error(s) this cycle — sample: %s",
                        len(errors), errors[0]
                    )

                if not values:
                    raise RuntimeError("zero tags read — PLC not responding")

                apply_polled_snapshot(values)
                _plc_has_live_data = True

                log.debug(
                    "[Poll] RPM=%.1f  MPM=%.1f  AMP=%.1f  tags_ok=%d  tags_err=%d",
                    state.extruder_rpm, state.laminator_mpm, state.extruder_amp,
                    len(values), len(errors)
                )

                jitter = random.uniform(0.0, POLL_JITTER_MAX)
                await asyncio.sleep(max(0.0, UPDATE_INTERVAL + jitter))

        except Exception as exc:
            if _plc_online:
                log.warning("[Poll] ✗ PLC went offline: %s", str(exc)[:160])
            _plc_online = False
            failures   += 1
            backoff     = min(POLL_BACKOFF_MAX, POLL_BACKOFF_BASE * (2 ** (failures - 1)))
            backoff    += random.uniform(0.0, POLL_JITTER_MAX)
            log.warning("[Poll] Failed #%d — reconnect in %.2fs", failures, backoff)
            await asyncio.sleep(backoff)

        finally:
            # Always close — prevents socket leak
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

        healthy      = await loop.run_in_executor(None, check_health)
        signature    = current_state_signature()
        data_changed = signature != _last_queued_signature

        if not healthy:
            pending = len(list(WAL_DIR.glob("*.json")))
            if data_changed:
                payload = build_payload()
                WALEntry.create(payload)
                _last_queued_signature = signature
                log.info("[Push] Server down — queued batch  (pending=%d)", pending + 1)
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
    log.info("  Nonwoven Modbus Poller — Production Edition (XML-corrected)")
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
    log.info("  Addresses:    verified from ExportedTags.xml")
    log.info("  Log files:    pipeline.log | modbus.log | errors.log")
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