import { newId } from "@rvl/shared";
import type { IngestBatch } from "@rvl/shared";

const API_URL = process.env.SIM_API_URL ?? "http://127.0.0.1:7000/ingest/tags";
const DEFINITIONS_URL_BASE = process.env.SIM_DEFINITIONS_BASE_URL ?? "http://127.0.0.1:7000";
const AUTH_TOKEN = process.env.SIM_AUTH_TOKEN ?? "dev-local-token";
const MACHINES = (process.env.SIM_MACHINES ? process.env.SIM_MACHINES.split(",") : ["machine_1", "machine_2"]).map((s) => s.trim()).filter(Boolean);
const REVISION = process.env.SIM_REVISION ?? "v1.4.0";
const SIM_SEED = process.env.SIM_SEED ? Number(process.env.SIM_SEED) : null;

const TAGS = [
  { id: "roller_temp_01", type: "number", min: 220, max: 220, unit: "C" },
  { id: "roller_temp_02", type: "number", min: 180, max: 220, unit: "C" },
  { id: "line_speed", type: "number", min: 45, max: 55, unit: "m/min" },
  { id: "nip_pressure", type: "number", min: 2.5, max: 3.2, unit: "bar" },
  { id: "tension_inlet", type: "number", min: 120, max: 140, unit: "N" },
  { id: "tension_outlet", type: "number", min: 125, max: 145, unit: "N" },
  { id: "emergency_stop", type: "boolean", probability: 0.001 },
  { id: "operator_mode", type: "string", options: ["AUTO", "MANUAL", "READY"] },
];

let seq = 0;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = SIM_SEED === null || Number.isNaN(SIM_SEED) ? Math.random : mulberry32(SIM_SEED);

function generateValue(tag: any, state: any) {
  if (tag.type === "number") {
    // Random walk with drift back to center
    const current = state[tag.id] ?? (tag.min + tag.max) / 2;
    const center = (tag.min + tag.max) / 2;
    const drift = (center - current) * 0.15;
    const noise = (rand() - 0.5) * 4;

    // Occasional spike
    const spike = rand() > 0.95 ? (rand() - 0.5) * 15 : 0;

    let next = current + drift + noise + spike;
    state[tag.id] = next;
    return Number(next.toFixed(2));
  }

  if (tag.type === "boolean") {
    return rand() > tag.probability;
  }

  if (tag.type === "string") {
    return tag.options[Math.floor(rand() * tag.options.length)];
  }

  return null;
}

const machineStates: Record<string, Record<string, any>> = {};

async function seedDefinitions() {
  console.log("🌱 Seeding Tag Definitions with thresholds...");
  for (const machineId of MACHINES) {
    const definitions = TAGS.map(t => ({
      tagId: t.id,
      slug: t.id,
      name: t.id.replace(/_/g, ' '),
      dataType: t.type,
      min: t.min ?? null,
      max: t.max ?? null,
      warnHigh: t.max ? t.max - 5 : null,
      alarmHigh: t.max ? t.max - 2 : null,
      warnLow: t.min ? t.min + 5 : null,
      alarmLow: t.min ? t.min + 2 : null,
      sampleEveryMs: 5000,
      deadband: 0.1
    }));

    try {
      await fetch(`${DEFINITIONS_URL_BASE}/machines/${machineId}/revisions/${REVISION}/definitions`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AUTH_TOKEN}`
        },
        body: JSON.stringify(definitions)
      });
    } catch (err) {
      console.error(`Failed to seed definitions for ${machineId}`);
    }
  }
}

async function runSimulation() {
  await seedDefinitions();
  console.log(`🚀 Starting Lamination Simulation Engine...`);

  console.log(`📡 Targeting: ${API_URL}`);

  while (true) {
    for (const machineId of MACHINES) {
      if (!machineStates[machineId]) machineStates[machineId] = {};

      const batch: IngestBatch = {
        machineId,
        machineRevision: REVISION,
        sentAt: new Date(),
        seq: seq++,
        tags: TAGS.map(t => ({
          tagId: t.id,
          value: generateValue(t, machineStates[machineId]),
          ts: new Date()
        }))
      };

      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${AUTH_TOKEN}`
          },
          body: JSON.stringify(batch)
        });

        if (!res.ok) {
          console.error(`❌ [${machineId}] Ingest failed:`, await res.text());
        } else {
          const data = (await res.json()) as any;
          console.log(`✅ [${machineId}] Batch ${batch.seq} | Accepted: ${data?.accepted} | Rejected: ${data?.rejected}`);
        }
      } catch (err: any) {
        console.error(`💥 [${machineId}] Network error:`, err.message);
      }
    }

    // Wait 2 seconds between batches
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

runSimulation();
