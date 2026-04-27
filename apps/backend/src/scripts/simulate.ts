import { newId } from "@rvl/shared";
import type { IngestBatch } from "@rvl/shared";

/**
 * Lamination Machine Simulator
 * Matches the real Raspberry Pi Modbus poller (a.py) tag format exactly.
 * Uses tagSlug (not tagId) to match what the production Pi sends.
 */

const API_URL = process.env.SIM_API_URL ?? "http://127.0.0.1:7000/ingest/tags";
const DEFINITIONS_URL_BASE = process.env.SIM_DEFINITIONS_BASE_URL ?? "http://127.0.0.1:7000";
const AUTH_TOKEN = process.env.SIM_AUTH_TOKEN ?? "dev-local-token";
const MACHINE_ID = process.env.SIM_MACHINE_ID ?? "lamination-01";
const MACHINE_REVISION = process.env.SIM_REVISION ?? "v1";
/** Every N ingest cycles, push WINDER_TENSION_PCT above alarmHigh briefly so threshold alerts fire for report testing */
const SIM_INJECT_ALERTS = process.env.SIM_INJECT_ALERTS === "1";
const INJECT_EVERY = Math.max(3, Number(process.env.SIM_INJECT_ALERTS_EVERY ?? "12") || 12);

// ── Tag definitions matching real PLC tags from a.py ──
const TAGS = [
  // Extruder
  { slug: "EXTRUDER_RPM",        name: "Extruder RPM",        type: "float",  unit: "RPM",  min: 0,   max: 120,  nominal: 85 },
  { slug: "EXTRUDER_AMP",        name: "Extruder Amps",       type: "float",  unit: "A",    min: 0,   max: 60,   nominal: 35 },
  { slug: "EXTRUDER_SPEED_PCT",  name: "Extruder Speed %",    type: "uint16", unit: "%",    min: 0,   max: 100,  nominal: 70 },
  { slug: "EXTRUDER_SPEED_VOL",  name: "Extruder Speed Vol",  type: "float",  unit: "V",    min: 0,   max: 10,   nominal: 7 },
  { slug: "EXTRUDER_ON_OFF",     name: "Extruder On/Off",     type: "bool",   probability: 0.999 },
  { slug: "EXTRUDER_FAULT",      name: "Extruder Fault",      type: "bool",   probability: 0.002 },

  // Laminator
  { slug: "LAMINATOR_MPM",       name: "Laminator Speed",     type: "float",  unit: "m/min", min: 20, max: 80,   nominal: 55 },
  { slug: "LAMINATOR_AMP",       name: "Laminator Amps",      type: "float",  unit: "A",    min: 0,   max: 40,   nominal: 22 },
  { slug: "LAMINATOR_SPEED_PCT", name: "Laminator Speed %",   type: "uint16", unit: "%",    min: 0,   max: 100,  nominal: 65 },
  { slug: "LAMINATOR_SPEED_VOL", name: "Laminator Speed Vol", type: "float",  unit: "V",    min: 0,   max: 10,   nominal: 6.5 },
  { slug: "LAMINATOR_ON_OFF",    name: "Laminator On/Off",    type: "bool",   probability: 0.999 },
  { slug: "LAMINATOR_FAULT",     name: "Laminator Fault",     type: "bool",   probability: 0.002 },

  // Winder
  { slug: "WINDER_AMP",          name: "Winder Amps",         type: "float",  unit: "A",    min: 0,   max: 30,   nominal: 15 },
  { slug: "WINDER_TENSION_PCT",  name: "Winder Tension %",    type: "uint16", unit: "%",    min: 0,   max: 100,  nominal: 50 },
  { slug: "WINDER_TENSION_VOL",  name: "Winder Tension Vol",  type: "float",  unit: "V",    min: 0,   max: 10,   nominal: 5 },
  { slug: "WINDER_ON_OFF",       name: "Winder On/Off",       type: "bool",   probability: 0.999 },
  { slug: "WINDER_FAULT",        name: "Winder Fault",        type: "bool",   probability: 0.002 },

  // Master / production
  { slug: "MASTER_SPEED_PCT",    name: "Master Speed %",      type: "uint16", unit: "%",    min: 0,   max: 100,  nominal: 70 },
  { slug: "RUNNING_METER",       name: "Running Meter",       type: "float",  unit: "m",    min: 0,   max: 99999, nominal: 0, accumulator: true },
  { slug: "TOTAL_METER",         name: "Total Meter",         type: "float",  unit: "m",    min: 0,   max: 999999, nominal: 12500, accumulator: true },
  { slug: "GSM_ENTRY",           name: "GSM Entry",           type: "float",  unit: "g/m2", min: 10,  max: 100,  nominal: 45 },
  { slug: "GRAM_ENTRY",          name: "Gram Entry",          type: "float",  unit: "g",    min: 50,  max: 500,  nominal: 200 },

  // Unwinder tension
  { slug: "UW_SET_TENSION",      name: "UW Set Tension",      type: "uint16", unit: "N",    min: 0,   max: 500,  nominal: 150 },
  { slug: "UW_PV_TENSION",       name: "UW PV Tension",       type: "uint16", unit: "N",    min: 0,   max: 500,  nominal: 148 },

  // Safety
  { slug: "EMG_STOP",            name: "Emergency Stop",      type: "bool",   probability: 0.001 },
  { slug: "ALARM_IND",           name: "Alarm Indicator",     type: "bool",   probability: 0.005 },
  { slug: "SPLICE_ON_OFF",       name: "Splice On/Off",       type: "bool",   probability: 0.95 },
  { slug: "SPLICE_SPEED",        name: "Splice Speed",        type: "uint16", unit: "m/min", min: 5,  max: 30,   nominal: 15 },
] as const;

let seq = 0;
const state: Record<string, number> = {};

function generateValue(tag: any): number | boolean | string {
  if (tag.type === "bool") {
    // For ON/OFF tags, probability is chance of being TRUE
    // For fault/alarm tags, probability is chance of being TRUE (low)
    return Math.random() < (tag.probability ?? 0.5);
  }

  if (tag.type === "uint16") {
    // Integer values - random walk around nominal
    const current = state[tag.slug] ?? tag.nominal;
    const drift = ((tag.nominal ?? 50) - current) * 0.1;
    const noise = (Math.random() - 0.5) * (tag.max - tag.min) * 0.04;
    const spike = Math.random() > 0.97 ? (Math.random() - 0.5) * (tag.max - tag.min) * 0.15 : 0;
    let next = current + drift + noise + spike;
    next = Math.max(tag.min, Math.min(tag.max, next));
    state[tag.slug] = next;
    return Math.round(next);
  }

  // float type
  if (tag.accumulator) {
    // Accumulators only go up
    const current = state[tag.slug] ?? tag.nominal;
    const increment = Math.random() * 2; // 0-2 meters per cycle
    state[tag.slug] = current + increment;
    return Number((current + increment).toFixed(1));
  }

  const current = state[tag.slug] ?? tag.nominal;
  const drift = ((tag.nominal ?? (tag.min + tag.max) / 2) - current) * 0.12;
  const noise = (Math.random() - 0.5) * (tag.max - tag.min) * 0.06;
  const spike = Math.random() > 0.96 ? (Math.random() - 0.5) * (tag.max - tag.min) * 0.2 : 0;
  let next = current + drift + noise + spike;
  next = Math.max(tag.min, Math.min(tag.max, next));
  state[tag.slug] = next;
  return Number(next.toFixed(2));
}

async function seedDefinitions() {
  console.log("Seeding Tag Definitions with thresholds...");
  const definitions = TAGS.map(t => ({
    tagId: t.slug,
    slug: t.slug,
    name: t.name,
    dataType: t.type === "bool" ? "boolean" : t.type === "uint16" ? "number" : "number",
    unit: (t as any).unit ?? null,
    min: (t as any).min ?? null,
    max: (t as any).max ?? null,
    warnHigh: (t as any).max ? (t as any).max * 0.9 : null,
    alarmHigh: (t as any).max ? (t as any).max * 0.95 : null,
    warnLow: (t as any).min != null ? (t as any).min + ((t as any).max - (t as any).min) * 0.1 : null,
    alarmLow: (t as any).min != null ? (t as any).min + ((t as any).max - (t as any).min) * 0.05 : null,
    sampleEveryMs: 5000,
    deadband: 0.1
  }));

  try {
    const res = await fetch(`${DEFINITIONS_URL_BASE}/machines/${MACHINE_ID}/revisions/${MACHINE_REVISION}/definitions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify(definitions)
    });
    if (res.ok) {
      console.log(`  Seeded ${definitions.length} definitions for ${MACHINE_ID}`);
    } else {
      console.error(`  Failed to seed definitions: ${res.status} ${await res.text()}`);
    }
  } catch (err: any) {
    console.error(`  Failed to seed definitions: ${err.message}`);
  }
}

async function runSimulation() {
  await seedDefinitions();
  console.log(`\nStarting Lamination Simulation Engine`);
  console.log(`  Machine:  ${MACHINE_ID} (${MACHINE_REVISION})`);
  console.log(`  Target:   ${API_URL}`);
  console.log(`  Tags:     ${TAGS.length}`);
  console.log(`  Interval: 5s`);
  if (SIM_INJECT_ALERTS) console.log(`  SIM_INJECT_ALERTS: on (every ${INJECT_EVERY} cycles → WINDER_TENSION_PCT spike)`);
  console.log("");

  while (true) {
    const now = new Date().toISOString();

    // Build payload matching a.py format (tagSlug, not tagId)
    const tagsPayload = TAGS.map((t) => ({
      tagSlug: t.slug,
      value: generateValue(t),
      ts: now
    }));

    if (SIM_INJECT_ALERTS && seq % INJECT_EVERY === 0) {
      const tension = tagsPayload.find((x) => x.tagSlug === "WINDER_TENSION_PCT");
      if (tension) tension.value = 98;
    }

    const batch = {
      machineId: MACHINE_ID,
      machineRevision: MACHINE_REVISION,
      sentAt: now,
      seq: seq++,
      tags: tagsPayload
    };

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify(batch)
      });

      if (!res.ok) {
        console.error(`  [${MACHINE_ID}] Ingest failed: ${await res.text()}`);
      } else {
        const data = (await res.json()) as any;
        console.log(`  [${MACHINE_ID}] Batch ${batch.seq} | Accepted: ${data?.accepted} | Rejected: ${data?.rejected}`);
      }
    } catch (err: any) {
      console.error(`  [${MACHINE_ID}] Network error: ${err.message}`);
    }

    // Wait 5 seconds (matching real PUSH_INTERVAL)
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

runSimulation();
