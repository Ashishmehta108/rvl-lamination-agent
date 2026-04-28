/**
 * agent/__tests__/grounding.test.ts
 * Tests for groundingScore, unsupportedClaimDetector, enforceGroundingGuard.
 */

import { describe, it, expect } from "vitest";
import {
  groundingScore,
  unsupportedClaimDetector,
  enforceGroundingGuard,
} from "../../services/groundingGuard.js";
import type { ContextPacket } from "../../handlers/chatHandler.js";

// ─── Test fixtures ─────────────────────────────────────────────────

function makePacket(brief = "", fallback = "fallback answer"): ContextPacket {
  return {
    handler: "status",
    machineId: "test-machine",
    capturedAt: "2026-04-28 10:00 AM",
    promptProfile: "small-model-safe",
    brief,
    evidenceSummary: {
      tagCount: 3,
      alertCount: 0,
      productionBucketCount: 0,
      stale: false,
      partial: false,
      hasConflict: false,
    },
    preRendered: {
      introLine: "Machine is running.",
      alertsBlock: null,
      productionBlock: null,
      watchBlock: null,
      readingsBlock: null,
      missingNote: null,
    },
    constraints: [],
    fallback,
  };
}

// ─── groundingScore ────────────────────────────────────────────────

describe("groundingScore", () => {
  it("returns 1.0 when answer has no numbers", () => {
    const score = groundingScore("The machine looks fine", "some evidence text");
    expect(score).toBe(1);
  });

  it("returns 1.0 when all answer numbers appear in evidence", () => {
    const evidence = "Extruder RPM is 75. Tension is 80.";
    const answer = "Running at 75 RPM with 80% tension.";
    expect(groundingScore(answer, evidence)).toBe(1);
  });

  it("returns 0 when answer numbers are completely absent from evidence", () => {
    const evidence = "No numeric data here.";
    const answer = "RPM is 9999 and tension is 8888.";
    expect(groundingScore(answer, evidence)).toBe(0);
  });

  it("returns partial score for partial number match", () => {
    const evidence = "RPM is 75.";
    const answer = "Running at 75 RPM with 9999 tension.";
    const score = groundingScore(answer, evidence);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ─── unsupportedClaimDetector ──────────────────────────────────────

describe("unsupportedClaimDetector", () => {
  it("returns null when no temporal claims in answer", () => {
    expect(unsupportedClaimDetector("The machine is running at 75 RPM.", "some evidence")).toBeNull();
  });

  it("returns violation when 'yesterday' claimed without evidence range", () => {
    const r = unsupportedClaimDetector("Yesterday the RPM was higher.", "No date range data.");
    expect(r).toBe("temporal_claim_without_evidence");
  });

  it("returns null when evidence has matching time-range language", () => {
    const evidence = "From 2026-04-27 to 2026-04-28: RPM averaged 75.";
    const answer = "Yesterday the RPM was 75.";
    expect(unsupportedClaimDetector(answer, evidence)).toBeNull();
  });

  it("returns violation for 'last week' claim without evidence", () => {
    const r = unsupportedClaimDetector("Last week production was higher.", "Today data only.");
    expect(r).toBe("temporal_claim_without_evidence");
  });
});

// ─── enforceGroundingGuard ─────────────────────────────────────────

describe("enforceGroundingGuard", () => {
  it("returns grounded for a clean factual answer", () => {
    const packet = makePacket("Machine health: HEALTHY. Extruder RPM: 75.");
    const liveCtx = [{ source: "tags_db", text: "* EXTRUDER_RPM: 75 RPM [10:00 AM]" }];
    const answer = "The extruder is running at 75 RPM.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    expect(result.confidence).toBe("grounded");
    expect(result.valid).toBe(true);
  });

  it("returns insufficient for an empty answer", () => {
    const result = enforceGroundingGuard("", makePacket(), []);
    expect(result.confidence).toBe("insufficient");
    expect(result.valid).toBe(false);
  });

  it("returns contradicted when answer says 'no alerts' but alerts are open", () => {
    const packet = makePacket("ALERTS: 1 critical");
    const liveCtx = [
      { source: "alerts_db", text: "ALERT #1: [CRITICAL] status: open | title: \"High Temp\" | detected at: 10:00 AM" },
    ];
    const answer = "There are no active alerts. Everything looks normal.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    expect(result.confidence).toBe("contradicted");
    expect(result.valid).toBe(false);
  });

  it("returns contradicted when answer says machine is healthy but critical alert is open", () => {
    const packet = makePacket("ALERTS: 1 critical");
    const liveCtx = [
      { source: "alerts_db", text: "ALERT #1: [CRITICAL] status: open | title: \"Fault\" | detected at: 10:00 AM" },
    ];
    const answer = "The machine looks good and running fine.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    expect(result.confidence).toBe("contradicted");
    expect(result.valid).toBe(false);
  });

  it("returns insufficient when answer has 2+ ungrounded numbers", () => {
    const packet = makePacket("Extruder RPM: 75");
    const liveCtx = [{ source: "tags_db", text: "* EXTRUDER_RPM: 75 RPM [10:00 AM]" }];
    const answer = "RPM is 9999 and tension is 8888, production is 5555 meters.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    expect(result.valid).toBe(false);
  });

  it("returns partial for temporal claim without date evidence", () => {
    const packet = makePacket("Current readings only.");
    const liveCtx = [{ source: "tags_db", text: "* EXTRUDER_RPM: 75 [10:00 AM]" }];
    const answer = "Yesterday the machine was running at higher speed.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    expect(result.confidence).toBe("partial");
  });

  it("does not block an answer that says no live data when live data is absent", () => {
    const packet = makePacket("No data.");
    const liveCtx: { source: string; text: string }[] = [];
    const answer = "I don't have live data right now.";
    const result = enforceGroundingGuard(answer, packet, liveCtx);
    // Should be grounded (no numbers, no contradiction) or at worst partial
    expect(["grounded", "partial"]).toContain(result.confidence);
  });
});
