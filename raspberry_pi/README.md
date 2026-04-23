# Raspberry Pi 4 — Modbus TCP Data Source

Replaces the ESP32 Arduino sketch (`arduino/data_source.ino`).  
Runs **directly on the Raspberry Pi 4** — no ESP32 needed.

## What It Does

1. **Modbus TCP Server** (port 502) — the `nonwoven_ai_agent` polls this for live sensor data  
2. **HTTP POST** to the remote ngrok backend every 5 seconds with the `IngestBatch` schema

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Copy and edit environment config
cp .env.example .env

# 3. Run (port 502 requires sudo)
sudo python3 data_source.py

# Or use a non-privileged port for testing
python3 data_source.py --port 5020
```

## Register Map

Identical to `nonwoven_ai_agent/src/modbus.ts`:

| Tag                  | Addr    | FC | Type   | Offset   |
|----------------------|---------|----|--------|----------|
| EXTRUDER_SPEED_PCT   | 400001  | 3  | uint16 | 0        |
| LAMINATOR_SPEED_PCT  | 400002  | 3  | uint16 | 1        |
| WINDER_TENSION_PCT   | 400003  | 3  | uint16 | 2        |
| RUNNING_METER        | 400008  | 3  | float  | 7–8      |
| TOTAL_METER          | 400010  | 3  | float  | 9–10     |
| EXTRUDER_RPM         | 401104  | 3  | float  | 1103–04  |
| LAMINATOR_MPM        | 401106  | 3  | float  | 1105–06  |
| EXTRUDER_AMP         | 401108  | 3  | float  | 1107–08  |
| LAMINATOR_AMP        | 401110  | 3  | float  | 1109–10  |
| WINDER_AMP           | 401112  | 3  | float  | 1111–12  |
| EMG_STOP             | 9       | 1  | bool   | coil 8   |
| EXTRUDER_ON_OFF      | 100     | 1  | bool   | coil 99  |
| *(see data_source.py for full list)* | | | | |

## File Server

The file server (`arduino/server.js`) serves this folder:

```bash
cd arduino && node server.js
# GET  /download         → download all as .zip
# GET  /download/:file   → download single file
# GET  /view/:file       → view raw content
```
