import { buildLLMContext, callGemini } from "../services/geminiService.js";

async function test() {
  console.log("Testing Gemini Context Builder...");
  
  const alertsRaw = `ACTIVE ALERTS:
ALERT #1: [CRITICAL] status: open | title: "High Extruder Temperature" | detected at: 29/04/2026, 12:00:00
ALERT #2: [WARNING] status: open | title: "Low Tension" | detected at: 29/04/2026, 12:05:00`;

  const tagsRaw = `TELEMETRY SNAPSHOT:
* EXTRUDER_RPM: 1200 RPM [12:50]
* LAMINATOR_SPEED: 45 MPM [12:50]
* TENSION_SETPOINT: 5.2 N [12:50]
* ZONE1_TEMP: 185 C [12:50]
* ZONE2_TEMP: 192 C [12:50]
* ZONE3_TEMP: 195 C [12:50]`;

  const productionRaw = `PRODUCTION METRICS (daily, 7 buckets, ...):
- Today: runningMeters=1500 avgRpm=1205 avgMpm=45.2 avgGsm=65.1 samples=120
- Yesterday: runningMeters=4200 avgRpm=1195 avgMpm=44.8 avgGsm=64.9 samples=840`;

  const context = buildLLMContext({ alertsRaw, tagsRaw, productionRaw });
  console.log("Built Context:\n", context);

  console.log("\nCalling Gemini...");
  const answer = await callGemini("What is the status of the machine?", context);
  console.log("Gemini Answer:\n", answer);
}

test().catch(console.error);
