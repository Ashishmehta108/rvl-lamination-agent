import assert from "node:assert/strict";
import {
  assembleFinalResponse,
  buildContextPacket,
  detectIntent,
  detectMissingContext,
  detectRisk,
  normalizeInput,
  selectHandler,
} from "../handlers/chatHandler.js";
import {
  buildChatSessionKey,
  getChatHistoryCached,
  mergeHistoryWithRequest,
  putChatHistoryCached,
} from "../services/chatHistoryCache.js";

function runProductionAndAlertScenario(): void {
  const input = normalizeInput("also tell the production data today");
  const intent = detectIntent(input);
  const risk = detectRisk(input);
  const liveContexts = [
    {
      source: "alerts_db",
      text: `ACTIVE ALERTS:
ALERT #1: [CRITICAL] status: open | title: "Seed: Winder tension high" | detected at: 27/4/2026, 2:27:22 pm | description: Dev-only seeded alert event for UI testing.`,
    },
    {
      source: "production_db",
      text: `PRODUCTION METRICS (daily, 1 buckets, 2026-04-13T18:47:57.952Z → 2026-04-27T18:47:57.952Z):
- 2026-04-27: runningMeters=853.2 avgRpm=84.1 avgMpm=55 avgGsm=44.8 samples=3396`,
    },
  ];
  const ctx = detectMissingContext(liveContexts, intent);
  const decision = selectHandler(input, risk, intent, ctx);
  assert.equal(decision.handler, "status");

  const packet = buildContextPacket(
    decision,
    input,
    intent,
    ctx,
    liveContexts,
    "lamination-01",
    "12:20 AM",
    "critical"
  );

  const rendered = assembleFinalResponse("Current status is critical due to an open alert.", packet, decision);
  assert.ok(rendered.includes("Production Today"));
  assert.ok(rendered.includes("Running meters"));
}

function runHistoryCacheScenario(): void {
  const sessionKey = buildChatSessionKey({
    machineId: "lamination-01",
    explicitSessionId: "operator-1",
    ip: "127.0.0.1",
  });
  const snapshot = putChatHistoryCached(
    sessionKey,
    "lamination-01",
    [
      { role: "user", content: "What alerts fired today?", timestamp: 1000 },
      { role: "assistant", content: "One critical alert is open.", timestamp: 1100 },
    ],
    2000
  );
  assert.equal(snapshot.messages.length, 2);
  const cached = getChatHistoryCached(sessionKey, 2500);
  assert.ok(cached);
  const merged = mergeHistoryWithRequest(
    [
      { role: "user", content: "also tell production data today" },
      { role: "assistant", content: "Here's production data." },
    ],
    cached?.messages ?? [],
    6
  );
  assert.equal(merged.length, 4);

  const expired = getChatHistoryCached(sessionKey, 2000 + 31 * 60 * 1000);
  assert.equal(expired, null);
}

function main(): void {
  runProductionAndAlertScenario();
  runHistoryCacheScenario();
  console.log("verifyChatPlan: all checks passed");
}

main();
