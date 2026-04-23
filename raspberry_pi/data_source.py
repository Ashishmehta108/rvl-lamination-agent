#!/usr/bin/env python3
"""
============================================================
  Raspberry Pi 4 — Modbus TCP Server + Remote Data Pipeline
  For: Nonwoven Lamination AI Agent
  Replaces: arduino/data_source.ino  (no ESP32 needed)
============================================================

This script does TWO things:

  1. MODBUS TCP SERVER (port 502)
     → The AI Agent polls this device for live sensor data
       via modbus-serial / readHoldingRegisters / readCoils

  2. HTTP POST to REMOTE BACKEND (ngrok)
     → Every N seconds, pushes sensor data to the cloud backend
       using the exact IngestBatch schema the backend expects

Register mapping matches nonwoven_ai_agent/src/modbus.ts:
  - FC 3 (Holding Registers): offset = addr − 400001
  - FC 1 (Coils):             offset = addr − 1

Dependencies:
  pip install pymodbus requests python-dotenv

Run:
  sudo python3 data_source.py          # port 502 needs root
  python3 data_source.py --port 5020   # non-privileged port for testing
"""

import argparse
import asyncio
import logging
import os
import struct
import random
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusSlaveContext,
    ModbusServerContext,
)
from pymodbus.server import StartAsyncTcpServer

# ── Load .env from parent directory if available ──────────────
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("data_source")

# ── Configuration ─────────────────────────────────────────────
BIND_IP            = os.getenv("BIND_IP", "0.0.0.0")
MODBUS_PORT        = int(os.getenv("MODBUS_PORT", "502"))
REMOTE_URL         = os.getenv("REMOTE_URL",
                        "https://mace-ebony-capital.ngrok-free.dev/ingest/tags")
API_AUTH_TOKEN     = os.getenv("API_AUTH_TOKEN", "dev-local-token")
MACHINE_ID         = os.getenv("MACHINE_ID", "lamination-01")
MACHINE_REVISION   = os.getenv("MACHINE_REVISION", "v1")

UPDATE_INTERVAL    = float(os.getenv("UPDATE_INTERVAL", "0.5"))   # seconds
PUSH_INTERVAL      = float(os.getenv("PUSH_INTERVAL", "5.0"))    # seconds

# ── Register Map (mirrors modbus.ts & data_source.ino) ───────
# FC3 Holding Registers — offset = addr − 400001
#   uint16 registers
HREG_EXTRUDER_SPEED_PCT  = 0       # addr 400001
HREG_LAMINATOR_SPEED_PCT = 1       # addr 400002
HREG_WINDER_TENSION_PCT  = 2       # addr 400003
HREG_SPLICE_SPEED        = 17      # addr 400018
HREG_UW_SET_TENSION      = 3501    # addr 403502
HREG_UW_PV_TENSION       = 3879    # addr 403880

#   float registers (2 regs each, Big-Endian word order)
HREG_RUNNING_METER       = 7       # addr 400008  (7, 8)
HREG_TOTAL_METER         = 9       # addr 400010  (9, 10)
HREG_WINDER_TENSION_VOL  = 1039    # addr 401040  (1039, 1040)
HREG_EXTRUDER_RPM        = 1103    # addr 401104  (1103, 1104)
HREG_LAMINATOR_MPM       = 1105    # addr 401106  (1105, 1106)
HREG_EXTRUDER_AMP        = 1107    # addr 401108  (1107, 1108)
HREG_LAMINATOR_AMP       = 1109    # addr 401110  (1109, 1110)
HREG_WINDER_AMP          = 1111    # addr 401112  (1111, 1112)
HREG_EXTRUDER_SPEED_VOL  = 1199    # addr 401200  (1199, 1200)
HREG_LAMINATOR_SPEED_VOL = 1201    # addr 401202  (1201, 1202)
HREG_GSM_ENTRY           = 1299    # addr 401300  (1299, 1300)
HREG_GRAM_ENTRY          = 3003    # addr 403004  (3003, 3004)

# FC1 Coils — offset = addr − 1
COIL_EMG_STOP            = 8       # addr 9
COIL_EXTRUDER_FAULT      = 11      # addr 12
COIL_LAMINATOR_FAULT     = 12      # addr 13
COIL_WINDER_FAULT        = 13      # addr 14
COIL_EXTRUDER_ON_OFF     = 99      # addr 100
COIL_LAMINATOR_ON_OFF    = 100     # addr 101
COIL_WINDER_ON_OFF       = 101     # addr 102
COIL_SPLICE_ON_OFF       = 110     # addr 111
COIL_ALARM_IND           = 124     # addr 125

# Data store sizes (must cover highest offset + 1)
HREG_COUNT = 3880   # 0 .. 3879
COIL_COUNT = 125    # 0 .. 124


# ── Simulation State ─────────────────────────────────────────
class SimState:
    """Mutable simulation state — mirrors the Arduino globals."""

    def __init__(self):
        self.running_meter: float = 0.0
        self.total_meter: float   = 12500.0

        self.extruder_rpm: float     = 60.0
        self.extruder_amp: float     = 22.0
        self.extruder_pct: int       = 65
        self.laminator_mpm: float    = 105.0
        self.laminator_amp: float    = 7.5
        self.laminator_pct: int      = 70
        self.winder_amp: float       = 5.5
        self.winder_ten_pct: int     = 55

        self.gsm: float              = 30.5
        self.gram: float             = 150.0
        self.uw_set_tension: int     = 400
        self.uw_pv_tension: int      = 400

        self.ext_speed_vol: float    = 0.0
        self.lam_speed_vol: float    = 0.0
        self.winder_ten_vol: float   = 0.0

        self.emg_stop: bool          = False

        self.ingest_seq: int         = 0


sim = SimState()


# ── Helpers ───────────────────────────────────────────────────
def float_to_regs(value: float) -> list[int]:
    """
    Convert IEEE 754 float → two uint16 registers in Big-Endian word order.
    Matches the Arduino writeFloat() and the Node.js readFloatBE() in modbus.ts.
    """
    raw = struct.pack(">f", value)
    hi = struct.unpack(">H", raw[0:2])[0]
    lo = struct.unpack(">H", raw[2:4])[0]
    return [hi, lo]


def _rand(lo: float, hi: float) -> float:
    return random.uniform(lo, hi)


# ── Sensor Update Loop ───────────────────────────────────────
def update_sensors():
    """Generate simulated sensor values (same logic as data_source.ino)."""

    # Extruder
    sim.extruder_rpm  = 60.0  + _rand(-2.0, 2.0)
    sim.extruder_amp  = 22.0  + _rand(-1.0, 1.0)
    sim.extruder_pct  = 65    + random.randint(-2, 2)

    # Laminator
    sim.laminator_mpm = 105.0 + _rand(-2.0, 2.0)
    sim.laminator_amp = 7.5   + _rand(-0.5, 0.5)
    sim.laminator_pct = 70    + random.randint(-2, 2)

    # Winder
    sim.winder_amp     = 5.5  + _rand(-0.3, 0.3)
    sim.winder_ten_pct = 55   + random.randint(-3, 3)

    # Production meters
    speed_mps = sim.laminator_mpm / 60.0
    sim.running_meter += speed_mps * UPDATE_INTERVAL
    sim.total_meter   += speed_mps * UPDATE_INTERVAL

    # GSM / Gram
    sim.gsm  = 30.5  + _rand(-0.2, 0.2)
    sim.gram = 150.0 + _rand(-0.5, 0.5)

    # Tension
    sim.uw_set_tension = 400
    sim.uw_pv_tension  = 400 + random.randint(-15, 15)

    # Voltages
    sim.ext_speed_vol  = sim.extruder_pct  * 0.1
    sim.lam_speed_vol  = sim.laminator_pct * 0.1
    sim.winder_ten_vol = sim.winder_ten_pct * 0.08


def write_registers(context: ModbusServerContext):
    """Write latest sensor values into the Modbus data store."""
    slave = context[0]  # slave-id 0 (unit-id 0 / broadcast)

    # ── uint16 Holding Registers ──
    slave.setValues(3, HREG_EXTRUDER_SPEED_PCT,  [sim.extruder_pct])
    slave.setValues(3, HREG_LAMINATOR_SPEED_PCT, [sim.laminator_pct])
    slave.setValues(3, HREG_WINDER_TENSION_PCT,  [sim.winder_ten_pct])
    slave.setValues(3, HREG_SPLICE_SPEED,        [sim.laminator_pct])
    slave.setValues(3, HREG_UW_SET_TENSION,      [sim.uw_set_tension])
    slave.setValues(3, HREG_UW_PV_TENSION,       [sim.uw_pv_tension])

    # ── float Holding Registers (Big-Endian word order) ──
    slave.setValues(3, HREG_RUNNING_METER,       float_to_regs(sim.running_meter))
    slave.setValues(3, HREG_TOTAL_METER,         float_to_regs(sim.total_meter))
    slave.setValues(3, HREG_WINDER_TENSION_VOL,  float_to_regs(sim.winder_ten_vol))
    slave.setValues(3, HREG_EXTRUDER_RPM,        float_to_regs(sim.extruder_rpm))
    slave.setValues(3, HREG_LAMINATOR_MPM,       float_to_regs(sim.laminator_mpm))
    slave.setValues(3, HREG_EXTRUDER_AMP,        float_to_regs(sim.extruder_amp))
    slave.setValues(3, HREG_LAMINATOR_AMP,       float_to_regs(sim.laminator_amp))
    slave.setValues(3, HREG_WINDER_AMP,          float_to_regs(sim.winder_amp))
    slave.setValues(3, HREG_EXTRUDER_SPEED_VOL,  float_to_regs(sim.ext_speed_vol))
    slave.setValues(3, HREG_LAMINATOR_SPEED_VOL, float_to_regs(sim.lam_speed_vol))
    slave.setValues(3, HREG_GSM_ENTRY,           float_to_regs(sim.gsm))
    slave.setValues(3, HREG_GRAM_ENTRY,          float_to_regs(sim.gram))

    # ── Coils ──
    slave.setValues(1, COIL_EMG_STOP,         [sim.emg_stop])
    slave.setValues(1, COIL_EXTRUDER_FAULT,   [False])
    slave.setValues(1, COIL_LAMINATOR_FAULT,  [False])
    slave.setValues(1, COIL_WINDER_FAULT,     [False])
    slave.setValues(1, COIL_EXTRUDER_ON_OFF,  [True])
    slave.setValues(1, COIL_LAMINATOR_ON_OFF, [True])
    slave.setValues(1, COIL_WINDER_ON_OFF,    [True])
    slave.setValues(1, COIL_SPLICE_ON_OFF,    [False])
    slave.setValues(1, COIL_ALARM_IND,        [False])


# ── Remote Backend Push ───────────────────────────────────────
def push_to_remote():
    """
    POST IngestBatch JSON to the remote backend.
    Schema: { machineId, machineRevision, sentAt, seq, tags[] }
    """
    now = datetime.now(timezone.utc).isoformat()

    tags = [
        {"tagSlug": "EXTRUDER_RPM",        "value": round(sim.extruder_rpm, 2),  "ts": now},
        {"tagSlug": "EXTRUDER_AMP",        "value": round(sim.extruder_amp, 2),  "ts": now},
        {"tagSlug": "EXTRUDER_SPEED_PCT",  "value": sim.extruder_pct,            "ts": now},
        {"tagSlug": "LAMINATOR_MPM",       "value": round(sim.laminator_mpm, 2), "ts": now},
        {"tagSlug": "LAMINATOR_AMP",       "value": round(sim.laminator_amp, 2), "ts": now},
        {"tagSlug": "LAMINATOR_SPEED_PCT", "value": sim.laminator_pct,           "ts": now},
        {"tagSlug": "WINDER_AMP",          "value": round(sim.winder_amp, 2),    "ts": now},
        {"tagSlug": "WINDER_TENSION_PCT",  "value": sim.winder_ten_pct,          "ts": now},
        {"tagSlug": "RUNNING_METER",       "value": round(sim.running_meter, 1), "ts": now},
        {"tagSlug": "TOTAL_METER",         "value": round(sim.total_meter, 1),   "ts": now},
        {"tagSlug": "GSM_ENTRY",           "value": round(sim.gsm, 2),           "ts": now},
        {"tagSlug": "GRAM_ENTRY",          "value": round(sim.gram, 2),          "ts": now},
        {"tagSlug": "UW_SET_TENSION",      "value": sim.uw_set_tension,          "ts": now},
        {"tagSlug": "UW_PV_TENSION",       "value": sim.uw_pv_tension,           "ts": now},
        {"tagSlug": "EXTRUDER_SPEED_VOL",  "value": round(sim.ext_speed_vol, 2), "ts": now},
        {"tagSlug": "LAMINATOR_SPEED_VOL", "value": round(sim.lam_speed_vol, 2), "ts": now},
        {"tagSlug": "WINDER_TENSION_VOL",  "value": round(sim.winder_ten_vol, 2),"ts": now},
        {"tagSlug": "MASTER_SPEED_PCT",    "value": sim.extruder_pct,            "ts": now},
        {"tagSlug": "EMG_STOP",            "value": sim.emg_stop,                "ts": now},
        {"tagSlug": "EXTRUDER_ON_OFF",     "value": True,                        "ts": now},
        {"tagSlug": "LAMINATOR_ON_OFF",    "value": True,                        "ts": now},
        {"tagSlug": "WINDER_ON_OFF",       "value": True,                        "ts": now},
    ]

    payload = {
        "machineId":       MACHINE_ID,
        "machineRevision": MACHINE_REVISION,
        "sentAt":          now,
        "seq":             sim.ingest_seq,
        "tags":            tags,
    }
    sim.ingest_seq += 1

    try:
        resp = requests.post(
            REMOTE_URL,
            json=payload,
            headers={
                "Content-Type":  "application/json",
                "Authorization": f"Bearer {API_AUTH_TOKEN}",
            },
            timeout=10,
        )
        if resp.status_code == 200:
            log.info("[HTTP] ✓ 200 OK  (seq=%d, %d tags)", sim.ingest_seq - 1, len(tags))
        else:
            log.warning("[HTTP] ✗ %d — %s", resp.status_code, resp.text[:200])
    except requests.RequestException as exc:
        log.error("[HTTP] ✗ Connection failed: %s", exc)


# ── Async Background Tasks ───────────────────────────────────
async def register_update_loop(context: ModbusServerContext):
    """Update Modbus registers with fresh sensor data every UPDATE_INTERVAL."""
    log.info("[Loop] Register update loop started (%.1fs interval)", UPDATE_INTERVAL)
    while True:
        update_sensors()
        write_registers(context)
        await asyncio.sleep(UPDATE_INTERVAL)


async def remote_push_loop():
    """Push telemetry to the remote backend every PUSH_INTERVAL."""
    log.info("[Loop] Remote push loop started (%.1fs interval)", PUSH_INTERVAL)
    while True:
        await asyncio.sleep(PUSH_INTERVAL)
        # Run the blocking HTTP call in a thread so we don't stall the event loop
        await asyncio.get_event_loop().run_in_executor(None, push_to_remote)


async def status_log_loop():
    """Periodic console status log."""
    while True:
        await asyncio.sleep(5.0)
        log.info(
            "[Status] RPM=%.1f  MPM=%.1f  AMP=%.1f  RunM=%.0f  TotalM=%.0f  EMG=%s  seq=%d",
            sim.extruder_rpm, sim.laminator_mpm, sim.extruder_amp,
            sim.running_meter, sim.total_meter, sim.emg_stop, sim.ingest_seq,
        )


# ── Main ──────────────────────────────────────────────────────
async def main(port: int):
    # Build the Modbus data store
    # zero_mode=True  →  client address is used as-is (no +1 offset)
    store = ModbusSlaveContext(
        co=ModbusSequentialDataBlock(0, [0] * COIL_COUNT),
        hr=ModbusSequentialDataBlock(0, [0] * HREG_COUNT),
        di=ModbusSequentialDataBlock(0, [0] * 10),    # unused but required
        ir=ModbusSequentialDataBlock(0, [0] * 10),    # unused but required
        zero_mode=True,
    )
    # Unit-ID 0 is broadcast; also respond to unit-id 1
    context = ModbusServerContext(slaves={0: store, 1: store}, single=False)

    # Set initial coil states
    write_registers(context)

    # Banner
    print("=" * 52)
    print("  Nonwoven Modbus TCP Server — Raspberry Pi 4")
    print("=" * 52)
    print(f"  Bind:       {BIND_IP}:{port}")
    print(f"  Remote:     {REMOTE_URL}")
    print(f"  Machine:    {MACHINE_ID} ({MACHINE_REVISION})")
    print(f"  Update:     every {UPDATE_INTERVAL}s")
    print(f"  Push:       every {PUSH_INTERVAL}s")
    print("=" * 52)

    # Launch background tasks
    asyncio.create_task(register_update_loop(context))
    asyncio.create_task(remote_push_loop())
    asyncio.create_task(status_log_loop())

    # Start the Modbus TCP server (blocks forever)
    log.info("[Modbus TCP] Starting server on %s:%d …", BIND_IP, port)
    await StartAsyncTcpServer(
        context=context,
        address=(BIND_IP, port),
        allow_reuse_address=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RPi 4 Modbus TCP data source")
    parser.add_argument("--port", type=int, default=MODBUS_PORT,
                        help=f"Modbus TCP port (default: {MODBUS_PORT}; use 5020 for non-root)")
    args = parser.parse_args()

    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        log.info("Shutting down …")
