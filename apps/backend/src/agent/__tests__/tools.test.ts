/**
 * agent/__tests__/tools.test.ts
 * Tests for the LangChain DynamicStructuredTool wrappers.
 * DB clients are mocked at the module level.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildChatTools } from "../tools.js";

// ─── Mock the underlying tool functions ───────────────────────────

vi.mock("../../services/chatTools.js", () => ({
  toolGetTags: vi.fn(),
  toolGetAlerts: vi.fn(),
  toolGetReports: vi.fn(),
  toolGetProductionMetrics: vi.fn(),
  findTagsFuzzy: vi.fn(),
}));

import {
  toolGetTags,
  toolGetAlerts,
  toolGetReports,
  toolGetProductionMetrics,
  findTagsFuzzy,
} from "../../services/chatTools.js";

const MACHINE_ID = "test-machine";

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── Schema validation ─────────────────────────────────────────────

describe("buildChatTools — schema validation", () => {
  it("get_tags accepts empty args", async () => {
    vi.mocked(toolGetTags).mockResolvedValueOnce("LIVE TAG VALUES: ...");
    const { getTags } = buildChatTools(MACHINE_ID);
    const result = await getTags.invoke({});
    expect(result).toContain("LIVE TAG VALUES");
  });

  it("get_tags passes tagIds array", async () => {
    vi.mocked(toolGetTags).mockResolvedValueOnce("LIVE TAG VALUES: EXTRUDER_RPM = 75");
    const { getTags } = buildChatTools(MACHINE_ID);
    await getTags.invoke({ tagIds: ["EXTRUDER_RPM"] });
    expect(toolGetTags).toHaveBeenCalledWith(MACHINE_ID, { tagIds: ["EXTRUDER_RPM"], limit: undefined });
  });

  it("get_alerts passes from/to date args", async () => {
    vi.mocked(toolGetAlerts).mockResolvedValueOnce("ALERTS: none");
    const { getAlerts } = buildChatTools(MACHINE_ID);
    await getAlerts.invoke({ from: "2026-04-27", to: "2026-04-28" });
    expect(toolGetAlerts).toHaveBeenCalledWith(
      MACHINE_ID,
      expect.objectContaining({ from: "2026-04-27", to: "2026-04-28" })
    );
  });

  it("get_production_metrics uses default granularity daily", async () => {
    vi.mocked(toolGetProductionMetrics).mockResolvedValueOnce("PRODUCTION METRICS: ...");
    const { getProductionMetrics } = buildChatTools(MACHINE_ID);
    await getProductionMetrics.invoke({ granularity: "daily", buckets: 7 });
    expect(toolGetProductionMetrics).toHaveBeenCalledWith(
      MACHINE_ID,
      expect.objectContaining({ granularity: "daily", buckets: 7 })
    );
  });

  it("find_tags passes query string", async () => {
    vi.mocked(findTagsFuzzy).mockResolvedValueOnce([
      { tagId: "t1", slug: "EXTRUDER_RPM", name: "Extruder RPM", unit: "RPM", score: 0.95 },
    ]);
    const { findTags } = buildChatTools(MACHINE_ID);
    const result = await findTags.invoke({ query: "extruder speed" });
    expect(result).toContain("EXTRUDER_RPM");
    expect(result).toContain("FIND_TAGS");
  });
});

// ─── Error handling ────────────────────────────────────────────────

describe("buildChatTools — error fallbacks (never throw)", () => {
  it("get_tags returns error string when toolGetTags throws", async () => {
    vi.mocked(toolGetTags).mockRejectedValueOnce(new Error("DB connection refused"));
    const { getTags } = buildChatTools(MACHINE_ID);
    const result = await getTags.invoke({});
    expect(result).toContain("Tool error");
    expect(result).toContain("tag data");
  });

  it("get_alerts returns error string when toolGetAlerts throws", async () => {
    vi.mocked(toolGetAlerts).mockRejectedValueOnce(new Error("Postgres timeout"));
    const { getAlerts } = buildChatTools(MACHINE_ID);
    const result = await getAlerts.invoke({});
    expect(result).toContain("Tool error");
    expect(result).toContain("alert data");
  });

  it("get_reports returns error string when toolGetReports throws", async () => {
    vi.mocked(toolGetReports).mockRejectedValueOnce(new Error("Query failed"));
    const { getReports } = buildChatTools(MACHINE_ID);
    const result = await getReports.invoke({});
    expect(result).toContain("Tool error");
    expect(result).toContain("report data");
  });

  it("get_production_metrics returns error string on throw", async () => {
    vi.mocked(toolGetProductionMetrics).mockRejectedValueOnce(new Error("Aggregation failed"));
    const { getProductionMetrics } = buildChatTools(MACHINE_ID);
    const result = await getProductionMetrics.invoke({ granularity: "daily", buckets: 7 });
    expect(result).toContain("Tool error");
    expect(result).toContain("production data");
  });

  it("find_tags returns error string when findTagsFuzzy throws", async () => {
    vi.mocked(findTagsFuzzy).mockRejectedValueOnce(new Error("Mongo failed"));
    const { findTags } = buildChatTools(MACHINE_ID);
    const result = await findTags.invoke({ query: "extruder" });
    expect(result).toContain("Tool error");
    expect(result).toContain("tag definitions");
  });

  it("find_tags returns empty-match string when no candidates found", async () => {
    vi.mocked(findTagsFuzzy).mockResolvedValueOnce([]);
    const { findTags } = buildChatTools(MACHINE_ID);
    const result = await findTags.invoke({ query: "xyz-unknown" });
    expect(result).toContain("No definitions matched");
  });
});
