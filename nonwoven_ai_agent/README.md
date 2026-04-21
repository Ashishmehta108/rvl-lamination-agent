# Nonwoven Machine AI Monitor

## Files
- `modbus_reader.py`  — Reads all 30 live tags from HMI via Modbus TCP
- `ai_agent.py`       — Flask server + AI anomaly detection engine
- `dashboard/index.html` — Live web dashboard (phone + PC)
- `install.sh`        — One-click installer

## Quick Start

### 1. Connect hardware
- Raspberry Pi 4 and HMI both connected to factory network switch via RJ45
- HMI IP must be 192.168.1.17 (verify in EXOR settings, or update HMI_IP in modbus_reader.py)

### 2. Install
```bash
bash install.sh
```

### 3. Run
```bash
python3 ai_agent.py
```

### 4. Open dashboard
On any phone or PC on factory WiFi:
```
http://<raspberry-pi-ip>:5000
```

## API Endpoints
| Endpoint | Description |
|---|---|
| GET /api/live | All tag values right now |
| GET /api/alerts | Alert log (last 500) |
| GET /api/history/<TAG_NAME> | Trend data for one tag |
| GET /api/summary | Key KPIs only |

## Alert Logic
| Type | Trigger |
|---|---|
| ALARM | Value exceeds hard limit (e.g. Extruder AMP > 40) |
| WARNING | Value exceeds warning limit (e.g. AMP > 35) |
| ANOMALY | Statistical spike > 3 standard deviations from rolling mean |
| FAULT | Drive fault bit = TRUE |
| CRITICAL | Emergency stop activated |

## Thresholds (edit in modbus_reader.py)
| Tag | Warning | Alarm |
|---|---|---|
| Extruder RPM | 80 | 100 |
| Extruder AMP | 35 A | 40 A |
| Laminator MPM | 130 | 150 |
| Laminator AMP | 12 A | 15 A |
| Winder AMP | 8 A | 12 A |
| Winder Tension | 80% | 90% |
