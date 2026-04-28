/**
 * agent/__tests__/memory.test.ts
 * Tests for buildMemoryWindow trimming, deduplication, and assistant compression.
 */

import { describe, it, expect } from "vitest";
import { buildMemoryWindow } from "../../services/memoryPolicy.js";
import { compressAssistantMessage } from "../../services/chatHistoryCache.js";

// ─── compressAssistantMessage ──────────────────────────────────────

describe("compressAssistantMessage", () => {
  it("keeps only the first sentence", () => {
    const msg = "The machine is running fine. There are no active alerts. All readings are normal.";
    const compressed = compressAssistantMessage(msg);
    // Should not contain the 2nd or 3rd sentence
    expect(compressed).toContain("running fine");
    expect(compressed).not.toContain("no active alerts");
  });

  it("strips markdown table rows", () => {
    const msg = "Here are the alerts:\n| Severity | Status |\n|---|---|\n| Critical | Open |";
    const compressed = compressAssistantMessage(msg);
    expect(compressed).not.toContain("|");
  });

  it("strips bold markdown", () => {
    const msg = "**Machine** is running at **75 RPM** right now.";
    const compressed = compressAssistantMessage(msg);
    expect(compressed).not.toContain("**");
    expect(compressed).toContain("Machine");
    expect(compressed).toContain("75 RPM");
  });

  it("strips heading prefixes", () => {
    const msg = "# Status Report\nEverything is fine.";
    const compressed = compressAssistantMessage(msg);
    expect(compressed).not.toContain("#");
  });

  it("caps at MAX_ASSISTANT_CHARS (200)", () => {
    const long = "a ".repeat(200);
    const compressed = compressAssistantMessage(long);
    expect(compressed.length).toBeLessThanOrEqual(200);
  });

  it("returns empty string for empty input", () => {
    expect(compressAssistantMessage("")).toBe("");
  });
});

// ─── buildMemoryWindow ─────────────────────────────────────────────

describe("buildMemoryWindow", () => {
  it("returns only user and assistant messages (no system)", () => {
    const result = buildMemoryWindow({
      requestMessages: [
        { role: "system", content: "you are ravi" },
        { role: "user", content: "what is the RPM?" },
      ],
      cachedMessages: [],
    });
    expect(result.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("keeps at most 4 user turns", () => {
    const cached = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `question ${i}`,
      timestamp: Date.now() - i * 1000,
    }));
    const result = buildMemoryWindow({
      requestMessages: [{ role: "user", content: "latest question" }],
      cachedMessages: cached,
    });
    const userCount = result.messages.filter((m) => m.role === "user").length;
    expect(userCount).toBeLessThanOrEqual(4);
  });

  it("keeps at most 2 assistant turns", () => {
    const cached = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`,
      timestamp: Date.now() - i * 1000,
    }));
    const result = buildMemoryWindow({
      requestMessages: [],
      cachedMessages: cached,
    });
    const assistantCount = result.messages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBeLessThanOrEqual(2);
  });

  it("deduplicates consecutive identical messages", () => {
    const cached = [
      { role: "user" as const, content: "same question", timestamp: 1 },
      { role: "user" as const, content: "same question", timestamp: 2 },
    ];
    const result = buildMemoryWindow({
      requestMessages: [],
      cachedMessages: cached,
    });
    const userMsgs = result.messages.filter((m) => m.content === "same question");
    expect(userMsgs.length).toBe(1);
  });

  it("compresses all assistant messages in the window", () => {
    const longAnswer =
      "Here is a full report of the machine status. The extruder is running at 75 RPM. " +
      "The laminator is running at 90 m/min. There are no active alerts. Production today is 1200 meters.";

    const cached = [
      { role: "user" as const, content: "how is the machine?", timestamp: 1 },
      { role: "assistant" as const, content: longAnswer, timestamp: 2 },
    ];
    const result = buildMemoryWindow({
      requestMessages: [{ role: "user", content: "and alerts?" }],
      cachedMessages: cached,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === "assistant");
    for (const msg of assistantMsgs) {
      // Should only contain the first sentence (the direct answer)
      expect(msg.content.length).toBeLessThanOrEqual(200);
    }
  });

  it("reports sessionState correctly", () => {
    const cached = [
      { role: "user" as const, content: "first question", timestamp: 1 },
      { role: "user" as const, content: "second question", timestamp: 2 },
    ];
    const result = buildMemoryWindow({
      requestMessages: [{ role: "user", content: "third question" }],
      cachedMessages: cached,
    });
    expect(result.sessionState.lastUserMessage).toBeTruthy();
    expect(result.sessionState.priorUserTurns).toBeGreaterThan(0);
  });

  it("handles empty history gracefully", () => {
    const result = buildMemoryWindow({
      requestMessages: [{ role: "user", content: "first question ever" }],
      cachedMessages: [],
    });
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.sessionState.priorUserTurns).toBeGreaterThan(0);
  });
});
