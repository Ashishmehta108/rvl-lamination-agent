import express from "express";
import cors from "cors";
import path from "path";
import cron from "node-cron";
import { config } from "./config";
import { initDb, storeReading, getDailyStats, getRecentReadings, getMonthlyReports, getMonthlyReport, getAlertsSince, cleanupOldReadings, storeDailySummary } from "./db";
import { ModbusReader, TAGS } from "./modbus";
import { analyzeAlert, generateDailyInsights, generateMonthlyReport } from "./langgraphAgent";

const app = express();
app.use(express.json());
app.use(cors());

// State
let latestSnapshot: any = {};
const inMemoryAlerts: any[] = [];
const history: any[] = [];
const HISTORY_SIZE = 1800; // ~1hr at 2s interval

let sampleCounter = 0;
const sampleIntervalTrigger = Math.max(1, Math.floor(config.DB_SAMPLE_INTERVAL / config.MODBUS_POLL_INTERVAL));
const pendingAlerts: any[] = [];
let lastAlertTime: Record<string, number> = {};
let latestInsights = { date: null as string | null, text: "No insights generated yet." };

// Rolling stats for anomalies
const rolling: Record<string, number[]> = {};
for (const tag of Object.keys(TAGS)) rolling[tag] = [];

function checkAnomalies(snapshot: any) {
  const tags = snapshot.tags || {};
  const currentTs = Date.now();
  
  for (const [name, cfg] of Object.entries(TAGS)) {
    const val = tags[name]?.value;
    if (val === null || val === undefined || typeof val === "boolean") continue;

    rolling[name].push(val);
    if (rolling[name].length > 60) rolling[name].shift();

    if (cfg.alarm_hi !== null && cfg.alarm_hi !== undefined && val > cfg.alarm_hi) {
      fireAlert(name, cfg.label, val, cfg.unit, "ALARM", `Value ${val.toFixed(1)} ${cfg.unit} exceeded alarm limit ${cfg.alarm_hi}`);
    } else if (cfg.warn_hi !== null && cfg.warn_hi !== undefined && val > cfg.warn_hi) {
      fireAlert(name, cfg.label, val, cfg.unit, "WARNING", `Value ${val.toFixed(1)} ${cfg.unit} exceeded warning limit ${cfg.warn_hi}`);
    }

    if (rolling[name].length >= 20) {
      const arr = rolling[name];
      const mean = arr.reduce((a,b) => a+b, 0) / arr.length;
      const variance = arr.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / arr.length;
      const stdev = Math.sqrt(variance);
      if (stdev > 0 && Math.abs(val - mean) > 3 * stdev) {
        fireAlert(name, cfg.label, val, cfg.unit, "ANOMALY", `Statistical spike detected: ${val.toFixed(1)} (mean=${mean.toFixed(1)}, σ=${stdev.toFixed(1)})`);
      }
    }
  }

  if (tags["EMG_STOP"]?.value === true) fireAlert("EMG_STOP", "Emergency Stop", 1, "", "CRITICAL", "EMERGENCY STOP ACTIVATED!");
  if (tags["EXTRUDER_FAULT"]?.value === true) fireAlert("EXTRUDER_FAULT", "Extruder Fault", 1, "", "FAULT", "Extruder drive fault detected!");
  if (tags["LAMINATOR_FAULT"]?.value === true) fireAlert("LAMINATOR_FAULT", "Laminator Fault", 1, "", "FAULT", "Laminator drive fault detected!");
  if (tags["WINDER_FAULT"]?.value === true) fireAlert("WINDER_FAULT", "Winder Fault", 1, "", "FAULT", "Winder drive fault detected!");

  const sv = tags["UW_SET_TENSION"]?.value as number;
  const pv = tags["UW_PV_TENSION"]?.value as number;
  if (sv && pv && sv > 0) {
    const devPct = Math.abs(pv - sv) / sv * 100;
    if (devPct > 25) {
      fireAlert("UW_TENSION_DEV", "Unwinder Tension", pv, "", "WARNING", `Tension deviation ${devPct.toFixed(1)}% (SV=${sv}, PV=${pv})`);
    }
  }
}

function fireAlert(tag: string, label: string, value: number, unit: string, level: string, message: string) {
  const currentTs = Date.now();
  const cooldownKey = `${tag}_${level}`;
  
  if (currentTs - (lastAlertTime[cooldownKey] || 0) < config.ALERT_COOLDOWN_SECONDS * 1000) {
    return;
  }
  lastAlertTime[cooldownKey] = currentTs;

  const alert = { timestamp: new Date().toISOString(), tag, label, value, unit, level, message };
  inMemoryAlerts.unshift(alert);
  if (inMemoryAlerts.length > 500) inMemoryAlerts.pop();
  pendingAlerts.push(alert);
  console.log(`[${level}] ${alert.timestamp} — ${message}`);
}

// ── Background Jobs ──────────────────────────────────────────────

const modbusReader = new ModbusReader();

async function jobCollectData() {
  try {
    if (!modbusReader["connected"]) {
      await modbusReader.connect();
    }
    const snapshot = await modbusReader.readAllTags();
    checkAnomalies(snapshot);

    latestSnapshot = snapshot;
    history.push(snapshot);
    if (history.length > HISTORY_SIZE) history.shift();

    sampleCounter++;
    if (sampleCounter >= sampleIntervalTrigger) {
      sampleCounter = 0;
      storeReading(snapshot);
    }
  } catch (err: any) {
    console.error(`[Data Collection Error]`, err.message);
    modbusReader.close();
  }
}

async function jobAnalyzeAlerts() {
  const batch = pendingAlerts.splice(0, pendingAlerts.length);
  if (batch.length === 0) return;
  console.log(`Processing ${batch.length} queued alert(s) via LangGraph...`);
  
  for (const alert of batch) {
    await analyzeAlert(alert);
  }
}

async function jobDailySummary() {
  const dateStr = new Date().toISOString().split("T")[0];
  console.log(`Generating daily summary for ${dateStr}...`);
  try {
    const stats = getDailyStats(dateStr);
    const todayAlerts = getAlertsSince(24);
    const readings = getRecentReadings("TOTAL_METER", 24);
    
    let production = 0;
    if (readings.length >= 2) production = readings[0].value - readings[readings.length - 1].value;
    
    const uptimeMinutes = Math.floor((readings.length * config.DB_SAMPLE_INTERVAL) / 60);
    const insightsText = await generateDailyInsights(dateStr);
    
    latestInsights = { date: dateStr, text: insightsText };
    storeDailySummary(dateStr, stats, production, uptimeMinutes, todayAlerts.length, insightsText);
  } catch (err) {
    console.error(`[Daily Summary Error]`, err);
  }
}

// ── Express API ──────────────────────────────────────────────────

app.get("/api/live", (req, res) => {
  res.json(latestSnapshot);
});

app.get("/api/alerts", (req, res) => {
  if (req.query.source === "db") {
    res.json(getAlertsSince(Number(req.query.hours || 24)));
  } else {
    res.json(inMemoryAlerts);
  }
});

app.get("/api/history/:tagName", (req, res) => {
  const result = history.map(snap => ({
    t: snap.timestamp,
    v: snap.tags[req.params.tagName]?.value
  })).filter(r => r.v !== null && r.v !== undefined);
  res.json(result);
});

app.get("/api/summary", (req, res) => {
  const tags = latestSnapshot.tags || {};
  res.json({
    extruder_rpm: tags["EXTRUDER_RPM"]?.value,
    extruder_amp: tags["EXTRUDER_AMP"]?.value,
    laminator_mpm: tags["LAMINATOR_MPM"]?.value,
    laminator_amp: tags["LAMINATOR_AMP"]?.value,
    winder_amp: tags["WINDER_AMP"]?.value,
    running_meter: tags["RUNNING_METER"]?.value,
    total_meter: tags["TOTAL_METER"]?.value,
    master_speed: tags["MASTER_SPEED_PCT"]?.value,
    gsm: tags["GSM_ENTRY"]?.value,
    alarm_active: tags["ALARM_IND"]?.value,
    emg_stop: tags["EMG_STOP"]?.value,
    active_alerts: inMemoryAlerts.length,
    timestamp: latestSnapshot.timestamp,
  });
});

app.get("/api/insights", (req, res) => res.json(latestInsights));
app.get("/api/reports", (req, res) => res.json(getMonthlyReports()));
app.get("/api/reports/:id", (req, res) => {
  const r = getMonthlyReport(Number(req.params.id));
  if (r) res.json(r);
  else res.status(404).json({ error: "Report not found" });
});
app.get("/api/stats/daily", (req, res) => {
  const d = (req.query.date as string) || new Date().toISOString().split("T")[0];
  res.json({ date: d, stats: getDailyStats(d) });
});
app.get("/api/health", (req, res) => {
  res.json({
    status: "running",
    agent: "nonwoven-ai-agent-ts",
    version: "2.5.0",
    simulation_mode: config.SIMULATION_MODE,
    latest_reading: latestSnapshot.timestamp,
    queued_alerts: pendingAlerts.length,
    total_in_memory_alerts: inMemoryAlerts.length,
  });
});

app.use(express.static(path.join(__dirname, "../dashboard")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../dashboard/index.html")));

const startTime = Date.now();

async function start() {
  console.log("=".repeat(60));
  console.log("  [FACTORY] Nonwoven AI Agent v2.5 - LangGraph TS Edition");
  console.log("=".repeat(60));
  
  initDb();

  // Setup cron jobs using node-cron format instead of APScheduler
  cron.schedule(`*/${config.MODBUS_POLL_INTERVAL} * * * * *`, jobCollectData);
  cron.schedule(`*/${config.ANOMALY_CHECK_INTERVAL} * * * * *`, jobAnalyzeAlerts);
  cron.schedule(`59 23 * * *`, jobDailySummary); // 23:59
  cron.schedule(`0 6 1 * *`, () => generateMonthlyReport()); // 1st of month at 6 AM
  cron.schedule(`0 3 * * 0`, () => cleanupOldReadings(90)); // Sundays at 3 AM

  app.listen(config.EXPRESS_PORT, () => {
    console.log(`  Dashboard:    http://localhost:${config.EXPRESS_PORT}`);
    console.log(`  Health:       http://localhost:${config.EXPRESS_PORT}/api/health`);
    console.log(`  Simulation:   ${config.SIMULATION_MODE}`);
    console.log(`  LLM Model:    ${config.OLLAMA_MODEL}`);
    console.log(`  Database:     ${config.DB_PATH}`);
    console.log("=".repeat(60) + "\n");
  });
}

start();
