"""
Modbus TCP Reader for Nonwoven Lamination Machine
HMI: EXOR eSMART10 @ 192.168.1.17:502
Protocol: Modicon Modbus (1-based) - offsets are 1-based, pymodbus uses 0-based
"""

from pymodbus.client import ModbusTcpClient
import struct, time, json
from datetime import datetime

HMI_IP   = "192.168.1.17"
HMI_PORT = 502

# ─────────────────────────────────────────────────────────────────
# TAG MAP from ExportedTags.xml
# addr = XML offset - 1 (pymodbus is 0-based)
# fc   = Modbus function code: 3=HREG, 1=OUTP coil, 4=IREG
# ─────────────────────────────────────────────────────────────────
TAGS = {
    # EXTRUDER
    "EXTRUDER_RPM":            {"addr": 401104, "type": "float",  "fc": 3, "label": "Extruder RPM",       "unit": "RPM",   "warn_hi": 80,  "alarm_hi": 100},
    "EXTRUDER_AMP":            {"addr": 401108, "type": "float",  "fc": 3, "label": "Extruder Amps",      "unit": "A",     "warn_hi": 35,  "alarm_hi": 40},
    "EXTRUDER_SPEED_PCT":      {"addr": 400001, "type": "uint16", "fc": 3, "label": "Extruder Speed",     "unit": "%",     "warn_hi": 95,  "alarm_hi": 100},
    "EXTRUDER_ON_OFF":         {"addr": 100,    "type": "bool",   "fc": 1, "label": "Extruder ON/OFF",    "unit": "",      "warn_hi": None,"alarm_hi": None},
    "EXTRUDER_FAULT":          {"addr": 12,     "type": "bool",   "fc": 1, "label": "Extruder Fault",     "unit": "",      "warn_hi": None,"alarm_hi": None},
    "EXTRUDER_SPEED_VOL":      {"addr": 401200, "type": "float",  "fc": 3, "label": "Extruder Speed Vol", "unit": "V",     "warn_hi": None,"alarm_hi": None},

    # LAMINATOR
    "LAMINATOR_MPM":           {"addr": 401106, "type": "float",  "fc": 3, "label": "Laminator MPM",      "unit": "m/min", "warn_hi": 130, "alarm_hi": 150},
    "LAMINATOR_AMP":           {"addr": 401110, "type": "float",  "fc": 3, "label": "Laminator Amps",     "unit": "A",     "warn_hi": 12,  "alarm_hi": 15},
    "LAMINATOR_SPEED_PCT":     {"addr": 400002, "type": "uint16", "fc": 3, "label": "Laminator Speed",    "unit": "%",     "warn_hi": 95,  "alarm_hi": 100},
    "LAMINATOR_ON_OFF":        {"addr": 101,    "type": "bool",   "fc": 1, "label": "Laminator ON/OFF",   "unit": "",      "warn_hi": None,"alarm_hi": None},
    "LAMINATOR_FAULT":         {"addr": 13,     "type": "bool",   "fc": 1, "label": "Laminator Fault",    "unit": "",      "warn_hi": None,"alarm_hi": None},
    "LAMINATOR_SPEED_VOL":     {"addr": 401202, "type": "float",  "fc": 3, "label": "Laminator Speed Vol","unit": "V",     "warn_hi": None,"alarm_hi": None},

    # WINDER
    "WINDER_AMP":              {"addr": 401112, "type": "float",  "fc": 3, "label": "Winder Amps",        "unit": "A",     "warn_hi": 8,   "alarm_hi": 12},
    "WINDER_TENSION_PCT":      {"addr": 400003, "type": "uint16", "fc": 3, "label": "Winder Tension",     "unit": "%",     "warn_hi": 80,  "alarm_hi": 90},
    "WINDER_ON_OFF":           {"addr": 102,    "type": "bool",   "fc": 1, "label": "Winder ON/OFF",      "unit": "",      "warn_hi": None,"alarm_hi": None},
    "WINDER_FAULT":            {"addr": 14,     "type": "bool",   "fc": 1, "label": "Winder Fault",       "unit": "",      "warn_hi": None,"alarm_hi": None},
    "WINDER_TENSION_VOL":      {"addr": 401040, "type": "float",  "fc": 3, "label": "Winder Tension Vol", "unit": "V",     "warn_hi": None,"alarm_hi": None},

    # MASTER / LINE
    "MASTER_SPEED_PCT":        {"addr": 400000, "type": "uint16", "fc": 3, "label": "Master Speed",       "unit": "%",     "warn_hi": 95,  "alarm_hi": 100},

    # UNWINDER TENSION
    "UW_SET_TENSION":          {"addr": 403502, "type": "uint16", "fc": 3, "label": "UW Set Tension",     "unit": "",      "warn_hi": None,"alarm_hi": None},
    "UW_PV_TENSION":           {"addr": 403880, "type": "uint16", "fc": 3, "label": "UW Actual Tension",  "unit": "",      "warn_hi": None,"alarm_hi": None},

    # PRODUCTION METERS
    "RUNNING_METER":           {"addr": 400008, "type": "float",  "fc": 3, "label": "Running Meter",      "unit": "m",     "warn_hi": None,"alarm_hi": None},
    "TOTAL_METER":             {"addr": 400010, "type": "float",  "fc": 3, "label": "Total Meter",        "unit": "m",     "warn_hi": None,"alarm_hi": None},

    # GSM / GRAM
    "GSM_ENTRY":               {"addr": 401300, "type": "float",  "fc": 3, "label": "GSM Entry",          "unit": "g/m²",  "warn_hi": None,"alarm_hi": None},
    "GRAM_ENTRY":              {"addr": 403004, "type": "float",  "fc": 3, "label": "Gram Entry",         "unit": "g",     "warn_hi": None,"alarm_hi": None},

    # ALARMS & SAFETY
    "ALARM_IND":               {"addr": 125,    "type": "bool",   "fc": 1, "label": "Alarm Indicator",    "unit": "",      "warn_hi": None,"alarm_hi": None},
    "EMG_STOP":                {"addr": 9,      "type": "bool",   "fc": 1, "label": "Emergency Stop",     "unit": "",      "warn_hi": None,"alarm_hi": None},

    # SPLICE
    "SPLICE_ON_OFF":           {"addr": 111,    "type": "bool",   "fc": 1, "label": "Splice ON/OFF",      "unit": "",      "warn_hi": None,"alarm_hi": None},
    "SPLICE_SPEED":            {"addr": 400018, "type": "uint16", "fc": 3, "label": "Splice Speed",       "unit": "",      "warn_hi": None,"alarm_hi": None},
}

def read_float(client, addr):
    """Read a 32-bit float from two consecutive holding registers."""
    base = addr - 400001  # convert to 0-based
    result = client.read_holding_registers(base, count=2)
    if result.isError():
        return None
    raw = struct.pack(">HH", result.registers[0], result.registers[1])
    return struct.unpack(">f", raw)[0]

def read_uint16(client, addr):
    base = addr - 400001
    result = client.read_holding_registers(base, count=1)
    if result.isError():
        return None
    return result.registers[0]

def read_ireg_short(client, addr):
    base = addr - 300001
    result = client.read_input_registers(base, count=1)
    if result.isError():
        return None
    val = result.registers[0]
    # convert to signed short
    return val if val < 32768 else val - 65536

def read_coil(client, addr):
    base = addr - 1
    result = client.read_coils(base, count=1)
    if result.isError():
        return None
    return result.bits[0]

def read_all_tags(client):
    data = {"timestamp": datetime.now().isoformat(), "tags": {}}
    for name, cfg in TAGS.items():
        try:
            if cfg["fc"] == 3:
                if cfg["type"] == "float":
                    val = read_float(client, cfg["addr"])
                else:
                    val = read_uint16(client, cfg["addr"])
            elif cfg["fc"] == 4:
                val = read_ireg_short(client, cfg["addr"])
            elif cfg["fc"] == 1:
                val = read_coil(client, cfg["addr"])
            else:
                val = None
            data["tags"][name] = {
                "value": round(val, 3) if isinstance(val, float) else val,
                "label": cfg["label"],
                "unit":  cfg["unit"],
            }
        except Exception as e:
            data["tags"][name] = {"value": None, "label": cfg["label"], "unit": cfg["unit"], "error": str(e)}
    return data

if __name__ == "__main__":
    print(f"Connecting to HMI at {HMI_IP}:{HMI_PORT} ...")
    client = ModbusTcpClient(HMI_IP, port=HMI_PORT, timeout=3)
    if not client.connect():
        print("ERROR: Could not connect to HMI. Check IP and network.")
        exit(1)
    print("Connected! Reading tags every 2 seconds. Press Ctrl+C to stop.\n")
    try:
        while True:
            data = read_all_tags(client)
            print(json.dumps(data, indent=2))
            time.sleep(2)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        client.close()
