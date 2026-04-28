/**
 * agent/__tests__/styleRewrite.test.ts
 * Tests for the deterministic style rewrite pass.
 */

import { describe, it, expect } from "vitest";
import { applyStyleRewrite } from "../../services/styleRewriter.js";

const FACT_PACKET = "Machine health: HEALTHY. Extruder RPM: 75. No alerts.";

// ─── Hollow closing removal ────────────────────────────────────────

describe("applyStyleRewrite — hollow closings", () => {
  it("strips 'let me know if you have any questions'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "The machine is running at 75 RPM. Let me know if you have any questions.",
      handler: "status",
    });
    expect(r.rewritten).not.toMatch(/let me know/i);
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("stripped_hollow_closing");
  });

  it("strips 'feel free to ask'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "All readings are normal. Feel free to ask if you need more details.",
      handler: "tags",
    });
    expect(r.rewritten).not.toMatch(/feel free/i);
    expect(r.changed).toBe(true);
  });

  it("strips 'is there anything else'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "No active alerts. Is there anything else I can help you with?",
      handler: "alerts",
    });
    expect(r.rewritten).not.toMatch(/anything else/i);
    expect(r.changed).toBe(true);
  });

  it("strips 'hope this helps'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "RPM is at 75. Hope this helps!",
      handler: "tags",
    });
    expect(r.rewritten).not.toMatch(/hope this helps/i);
    expect(r.changed).toBe(true);
  });
});

// ─── Robotic phrase replacements ──────────────────────────────────

describe("applyStyleRewrite — robotic phrases", () => {
  it("replaces 'I am unable to' with \"I can't\"", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "I am unable to retrieve that data right now.",
      handler: "general",
    });
    expect(r.rewritten).toContain("I can't");
    expect(r.changed).toBe(true);
  });

  it("replaces 'It is important to note that'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "It is important to note that the machine is running.",
      handler: "status",
    });
    expect(r.rewritten).toContain("Note:");
    expect(r.changed).toBe(true);
  });

  it("strips 'As an AI language model'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "As an AI language model, I can see the extruder is at 75 RPM.",
      handler: "general",
    });
    expect(r.rewritten).not.toMatch(/as an ai/i);
    expect(r.changed).toBe(true);
  });

  it("replaces 'Due to the fact that' with 'Because'", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "Due to the fact that RPM is high, check the motor.",
      handler: "alerts",
    });
    expect(r.rewritten).toContain("Because");
    expect(r.changed).toBe(true);
  });
});

// ─── Tone guard — alert handler ────────────────────────────────────

describe("applyStyleRewrite — alert handler tone guard", () => {
  it("removes soft opener 'Sure,' for alert handler", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "Sure, there is a critical alert active right now.",
      handler: "alerts",
    });
    expect(r.rewritten).not.toMatch(/^sure,/i);
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("removed_soft_opener_for_alert_handler");
  });

  it("removes 'Certainly,' for escalation handler", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "Certainly, this is an urgent situation.",
      handler: "escalation",
    });
    expect(r.rewritten).not.toMatch(/^certainly,/i);
    expect(r.changed).toBe(true);
  });

  it("does NOT remove soft openers for greeting handler", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: "",
      rawLlmAnswer: "Sure, I am here to help with the lamination line.",
      handler: "greeting",
    });
    // greeting tone is "warm" — not "direct", so soft openers are not removed
    expect(r.reason).not.toContain("removed_soft_opener");
  });
});

// ─── No-op detection ───────────────────────────────────────────────

describe("applyStyleRewrite — no-op when answer is already clean", () => {
  it("returns changed=false for a clean short answer", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "The extruder is running at 75 RPM with no active faults.",
      handler: "tags",
    });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe("no_changes_needed");
    expect(r.rewritten).toBe("The extruder is running at 75 RPM with no active faults.");
  });

  it("preserves all content when nothing needs changing", () => {
    const original = "No active alerts. Production is at 1200 meters today.";
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: original,
      handler: "status",
    });
    expect(r.rewritten).toBe(original);
  });
});

// ─── Whitespace normalization ──────────────────────────────────────

describe("applyStyleRewrite — whitespace", () => {
  it("collapses more than 2 consecutive blank lines", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "Line one.\n\n\n\n\nLine two.",
      handler: "status",
    });
    expect(r.rewritten).not.toMatch(/\n{3,}/);
  });

  it("removes trailing spaces from lines", () => {
    const r = applyStyleRewrite({
      approvedFactPacket: FACT_PACKET,
      rawLlmAnswer: "Line one.   \nLine two.  ",
      handler: "tags",
    });
    expect(r.rewritten).not.toMatch(/\s+$/m);
  });
});
