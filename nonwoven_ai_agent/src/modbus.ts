import ModbusRTU from "modbus-serial";
import { config } from "./config";

export interface TagConfig {
  addr: number;
  type: "float" | "uint16" | "bool";
  fc: number; // 3=HREG, 1=COIL, 4=IREG
  label: string;
  unit: string;
  warn_hi?: number | null;
  alarm_hi?: number | null;
}

export const TAGS: Record<string, TagConfig> = {
  // EXTRUDER
  EXTRUDER_RPM: { addr: 401104, type: "float", fc: 3, label: "Extruder RPM", unit: "RPM", warn_hi: 80, alarm_hi: 100 },
  EXTRUDER_AMP: { addr: 401108, type: "float", fc: 3, label: "Extruder Amps", unit: "A", warn_hi: 35, alarm_hi: 40 },
  EXTRUDER_SPEED_PCT: { addr: 400001, type: "uint16", fc: 3, label: "Extruder Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },
  EXTRUDER_ON_OFF: { addr: 100, type: "bool", fc: 1, label: "Extruder ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
  EXTRUDER_FAULT: { addr: 12, type: "bool", fc: 1, label: "Extruder Fault", unit: "", warn_hi: null, alarm_hi: null },
  EXTRUDER_SPEED_VOL: { addr: 401200, type: "float", fc: 3, label: "Extruder Speed Vol", unit: "V", warn_hi: null, alarm_hi: null },

  // LAMINATOR
  LAMINATOR_MPM: { addr: 401106, type: "float", fc: 3, label: "Laminator MPM", unit: "m/min", warn_hi: 130, alarm_hi: 150 },
  LAMINATOR_AMP: { addr: 401110, type: "float", fc: 3, label: "Laminator Amps", unit: "A", warn_hi: 12, alarm_hi: 15 },
  LAMINATOR_SPEED_PCT: { addr: 400002, type: "uint16", fc: 3, label: "Laminator Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },
  LAMINATOR_ON_OFF: { addr: 101, type: "bool", fc: 1, label: "Laminator ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
  LAMINATOR_FAULT: { addr: 13, type: "bool", fc: 1, label: "Laminator Fault", unit: "", warn_hi: null, alarm_hi: null },
  LAMINATOR_SPEED_VOL: { addr: 401202, type: "float", fc: 3, label: "Laminator Speed Vol", unit: "V", warn_hi: null, alarm_hi: null },

  // WINDER
  WINDER_AMP: { addr: 401112, type: "float", fc: 3, label: "Winder Amps", unit: "A", warn_hi: 8, alarm_hi: 12 },
  WINDER_TENSION_PCT: { addr: 400003, type: "uint16", fc: 3, label: "Winder Tension", unit: "%", warn_hi: 80, alarm_hi: 90 },
  WINDER_ON_OFF: { addr: 102, type: "bool", fc: 1, label: "Winder ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
  WINDER_FAULT: { addr: 14, type: "bool", fc: 1, label: "Winder Fault", unit: "", warn_hi: null, alarm_hi: null },
  WINDER_TENSION_VOL: { addr: 401040, type: "float", fc: 3, label: "Winder Tension Vol", unit: "V", warn_hi: null, alarm_hi: null },

  // MASTER / LINE
  MASTER_SPEED_PCT: { addr: 400000, type: "uint16", fc: 3, label: "Master Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },

  // UNWINDER TENSION
  UW_SET_TENSION: { addr: 403502, type: "uint16", fc: 3, label: "UW Set Tension", unit: "", warn_hi: null, alarm_hi: null },
  UW_PV_TENSION: { addr: 403880, type: "uint16", fc: 3, label: "UW Actual Tension", unit: "", warn_hi: null, alarm_hi: null },

  // PRODUCTION METERS
  RUNNING_METER: { addr: 400008, type: "float", fc: 3, label: "Running Meter", unit: "m", warn_hi: null, alarm_hi: null },
  TOTAL_METER: { addr: 400010, type: "float", fc: 3, label: "Total Meter", unit: "m", warn_hi: null, alarm_hi: null },

  // GSM / GRAM
  GSM_ENTRY: { addr: 401300, type: "float", fc: 3, label: "GSM Entry", unit: "g/m²", warn_hi: null, alarm_hi: null },
  GRAM_ENTRY: { addr: 403004, type: "float", fc: 3, label: "Gram Entry", unit: "g", warn_hi: null, alarm_hi: null },

  // ALARMS & SAFETY
  ALARM_IND: { addr: 125, type: "bool", fc: 1, label: "Alarm Indicator", unit: "", warn_hi: null, alarm_hi: null },
  EMG_STOP: { addr: 9, type: "bool", fc: 1, label: "Emergency Stop", unit: "", warn_hi: null, alarm_hi: null },

  // SPLICE
  SPLICE_ON_OFF: { addr: 111, type: "bool", fc: 1, label: "Splice ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
  SPLICE_SPEED: { addr: 400018, type: "uint16", fc: 3, label: "Splice Speed", unit: "", warn_hi: null, alarm_hi: null },
};

// Simulation State
const simState = {
  running_meter: 0,
  total_meter: 1000,
  extruder_rpm: 60,
  extruder_amp: 20,
  laminator_mpm: 100,
  laminator_amp: 6,
  timeToAlert: 15 // simulate an alert every ~30s (15 polls)
};

function generateSimulatedSnapshot(): Record<string, { value: number | boolean | null; label: string; unit: string; error?: string }> {
  // Wandering values
  simState.extruder_rpm += (Math.random() - 0.5) * 2;
  simState.extruder_amp += (Math.random() - 0.5) * 1;
  simState.laminator_mpm += (Math.random() - 0.5) * 3;
  simState.laminator_amp += (Math.random() - 0.5) * 0.5;
  simState.running_meter += (simState.laminator_mpm / 60) * config.MODBUS_POLL_INTERVAL;
  simState.total_meter += (simState.laminator_mpm / 60) * config.MODBUS_POLL_INTERVAL;

  // Simulate an occasional spike leading to an alert
  simState.timeToAlert -= 1;
  if (simState.timeToAlert <= 0) {
    simState.extruder_amp = 45; // Triggers ALARM
    simState.timeToAlert = 60; // Next alert in ~2 mins
  } else if (simState.extruder_amp > 30) {
    // Bring it back down
    simState.extruder_amp -= 5;
  }

  const tags: any = {};
  for (const [name, cfg] of Object.entries(TAGS)) {
    let val: number | boolean = 0;
    
    if (name === "EXTRUDER_RPM") val = Math.max(0, simState.extruder_rpm);
    else if (name === "EXTRUDER_AMP") val = Math.max(0, simState.extruder_amp);
    else if (name === "LAMINATOR_MPM") val = Math.max(0, simState.laminator_mpm);
    else if (name === "LAMINATOR_AMP") val = Math.max(0, simState.laminator_amp);
    else if (name === "WINDER_AMP") val = 5 + Math.random();
    else if (name === "RUNNING_METER") val = simState.running_meter;
    else if (name === "TOTAL_METER") val = simState.total_meter;
    else if (name === "GSM_ENTRY") val = 30 + Math.random();
    else if (cfg.type === "bool") val = false; // Add random faults if needed
    else val = 50 + Math.random() * 10;

    tags[name] = {
      value: typeof val === "number" ? Number(val.toFixed(3)) : val,
      label: cfg.label,
      unit: cfg.unit
    };
  }

  return tags;
}

export class ModbusReader {
  private client: ModbusRTU | null = null;
  private connected: boolean = false;

  async connect(): Promise<boolean> {
    if (config.SIMULATION_MODE) {
      console.log(`[Modbus] SIMULATION MODE ACTIVE — Generating synthetic data instead of connecting to ${config.HMI_IP}:${config.HMI_PORT}`);
      this.connected = true;
      return true;
    }

    try {
      this.client = new ModbusRTU();
      await this.client.connectTCP(config.HMI_IP, { port: config.HMI_PORT });
      this.client.setTimeout(3000);
      this.connected = true;
      return true;
    } catch (error) {
      console.error(`[Modbus] Failed to connect to ${config.HMI_IP}:${config.HMI_PORT}`, error);
      this.connected = false;
      return false;
    }
  }

  close() {
    if (this.client) {
      this.client.close(() => {});
    }
    this.connected = false;
  }

    async readAllTags(): Promise<{ timestamp: string; tags: any }> {
      const timestamp = new Date().toISOString();
      
      if (config.SIMULATION_MODE) {
        return { timestamp, tags: generateSimulatedSnapshot() };
      }

      if (!this.connected || !this.client) {
        throw new Error("Modbus client not connected");
      }

      const tags: any = {};
      for (const [name, cfg] of Object.entries(TAGS)) {
        try {
          let val: number | boolean | null = null;
          
          if (cfg.fc === 3) {
            if (cfg.type === "float") {
              const base = cfg.addr - 400001;
              const res = await this.client.readHoldingRegisters(base, 2);
              // Convert 2 uint16s to float32
              const buf = Buffer.alloc(4);
              buf.writeUInt16BE(res.data[0], 0);
              buf.writeUInt16BE(res.data[1], 2);
              val = buf.readFloatBE(0);
            } else {
              const base = cfg.addr - 400001;
              const res = await this.client.readHoldingRegisters(base, 1);
              val = res.data[0];
            }
          } else if (cfg.fc === 4) {
            const base = cfg.addr - 300001;
            const res = await this.client.readInputRegisters(base, 1);
            const v = res.data[0];
            val = v < 32768 ? v : v - 65536; // signed short
          } else if (cfg.fc === 1) {
            const base = cfg.addr - 1;
            const res = await this.client.readCoils(base, 1);
            val = res.data[0];
          }

          tags[name] = {
            value: typeof val === "number" ? Number(val.toFixed(3)) : val,
            label: cfg.label,
            unit: cfg.unit
          };
        } catch (err: any) {
          tags[name] = { value: null, label: cfg.label, unit: cfg.unit, error: err.message };
        }
      }

      return { timestamp, tags };
    }
}
