/**
 * agent/tools.ts
 * ─────────────────────────────────────────────────────────────────
 * LangChain DynamicStructuredTool wrappers for the 5 existing tool
 * functions in chatTools.ts.
 *
 * Rules:
 * - Tool output is always a plain string matching the existing format.
 * - Tool schemas are Zod — same constraints as ChatPlannerSchema.
 * - Tool errors always return a safe fallback string, never throw.
 * - Internal DB complexity is never exposed to the model.
 * ─────────────────────────────────────────────────────────────────
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  toolGetTags,
  toolGetAlerts,
  toolGetReports,
  toolGetProductionMetrics,
  findTagsFuzzy,
} from "../services/chatTools.js";

// ─── Schema definitions (mirrors ChatPlannerSchema args) ──────────

const FindTagsSchema = z.object({
  query: z.string().min(1).max(200).describe("Phrase to search tag definitions"),
});

const GetTagsSchema = z.object({
  tagIds: z.array(z.string()).max(40).optional().describe("Specific tag IDs to retrieve"),
  limit: z.number().int().min(1).max(60).optional().describe("Max tags (default 30)"),
});

const GetAlertsSchema = z.object({
  includeRecentClosed: z.boolean().optional().describe("Include alerts closed in last 24h"),
  from: z.string().optional().describe("ISO date start (YYYY-MM-DD)"),
  to: z.string().optional().describe("ISO date end (YYYY-MM-DD, exclusive)"),
});

const GetReportsSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().describe("Max report runs (default 8)"),
});

const GetProductionMetricsSchema = z.object({
  granularity: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  buckets: z.number().int().min(1).max(90).default(7),
  from: z.string().optional().describe("ISO date start"),
  to: z.string().optional().describe("ISO date end"),
});

// ─── Tool factory ─────────────────────────────────────────────────

/**
 * Build all 5 tools bound to a specific machineId.
 * Tools are stateless otherwise — machineId is the only closure value.
 */
export function buildChatTools(machineId: string) {
  const findTags = new DynamicStructuredTool({
    name: "find_tags",
    description: "Search tag definitions by keyword. Use before get_tags when tag IDs are unknown.",
    schema: FindTagsSchema,
    func: async ({ query }) => {
      try {
        const candidates = await findTagsFuzzy(machineId, query, 12);
        if (candidates.length === 0) {
          return `FIND_TAGS: No definitions matched query "${query}" for machine "${machineId}".`;
        }
        const lines = candidates.map(
          (c, i) => `CANDIDATE #${i + 1}: slug: ${c.slug} | name: ${c.name} | unit: ${c.unit ?? "N/A"}`
        );
        return `FIND_TAGS (top matches for "${query}"):\n${lines.join("\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent/tools:find_tags] error: ${msg}`);
        return `FIND_TAGS: Tool error — could not search tag definitions for machine "${machineId}".`;
      }
    },
  });

  const getTags = new DynamicStructuredTool({
    name: "get_tags",
    description: "Retrieve live tag readings for the machine. Optionally filter by tagIds.",
    schema: GetTagsSchema,
    func: async ({ tagIds, limit }) => {
      try {
        return await toolGetTags(machineId, { tagIds, limit });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent/tools:get_tags] error: ${msg}`);
        return `LIVE TAG VALUES: Tool error — could not retrieve tag data for machine "${machineId}".`;
      }
    },
  });

  const getAlerts = new DynamicStructuredTool({
    name: "get_alerts",
    description: "Retrieve active alerts and recent closed alerts for the machine.",
    schema: GetAlertsSchema,
    func: async ({ includeRecentClosed, from, to }) => {
      try {
        return await toolGetAlerts(machineId, { includeRecentClosed, from, to });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent/tools:get_alerts] error: ${msg}`);
        return `ALERTS: Tool error — could not retrieve alert data for machine "${machineId}".`;
      }
    },
  });

  const getReports = new DynamicStructuredTool({
    name: "get_reports",
    description: "Retrieve recent report run history for the machine.",
    schema: GetReportsSchema,
    func: async ({ limit }) => {
      try {
        return await toolGetReports(machineId, { limit });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent/tools:get_reports] error: ${msg}`);
        return `REPORTS: Tool error — could not retrieve report data for machine "${machineId}".`;
      }
    },
  });

  const getProductionMetrics = new DynamicStructuredTool({
    name: "get_production_metrics",
    description: "Retrieve production throughput metrics aggregated by time bucket.",
    schema: GetProductionMetricsSchema,
    func: async ({ granularity, buckets, from, to }) => {
      try {
        return await toolGetProductionMetrics(machineId, { granularity, buckets, from, to });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent/tools:get_production_metrics] error: ${msg}`);
        return `PRODUCTION METRICS: Tool error — could not retrieve production data for machine "${machineId}".`;
      }
    },
  });

  return { findTags, getTags, getAlerts, getReports, getProductionMetrics };
}

export type ChatToolSet = ReturnType<typeof buildChatTools>;
