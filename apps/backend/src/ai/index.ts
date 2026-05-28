import type { FastifyBaseLogger } from "fastify";
import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import { config } from "../config.js";
import { buildAgentPlan } from "./planner.js";
import { runBedrockPipeline } from "./pipeline.js";
import { reflect } from "./reflection.js";
import { shouldGenerateChart, generateChartsFromHistory } from "./charts.js";
import type { AgentResult, StoredChatMessage } from "./types.js";

export * from "./types.js";

export const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_live_tag_values",
    description: "Fetch current values for one or more tags.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "Tag names or slugs to query." },
        machineId: { type: SchemaType.STRING, description: "Machine id. Defaults to lamination-01." }
      },
      required: ["tags"]
    }
  },
  {
    name: "get_all_live_tags",
    description: "Fetch all current tag values for the machine grouped by subsystem.",
    parameters: { type: SchemaType.OBJECT, properties: { machineId: { type: SchemaType.STRING } } }
  },
  {
    name: "get_tag_history",
    description: "Fetch time-series samples for a tag.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tag: { type: SchemaType.STRING, description: "Tag name or slug." },
        machineId: { type: SchemaType.STRING },
        from: { type: SchemaType.STRING, description: "ISO datetime or relative like 1h, 30m, 24h, 7d." },
        to: { type: SchemaType.STRING, description: "ISO datetime, defaults to now." },
        limit: { type: SchemaType.NUMBER }
      },
      required: ["tag"]
    }
  },
  {
    name: "get_active_alerts",
    description:
      "Present-state alerts. Prefer this for 'what is wrong', 'any issues', 'status'. Default status=open. Do not use get_alert_history with 24h for these questions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        machineId: { type: SchemaType.STRING },
        status: { type: SchemaType.STRING, format: "enum", enum: ["open", "acknowledged", "resolved", "all"] },
        severity: { type: SchemaType.STRING, format: "enum", enum: ["info", "warning", "critical", "all"] },
        limit: { type: SchemaType.NUMBER }
      }
    }
  },
  {
    name: "get_alert_history",
    description:
      "Historical alerts for an explicit time window only (named date, yesterday, shift, between X and Y). NOT for 'what is going on now' — use get_active_alerts instead. Default from=24h is for undated history requests only; for 'today' use from=YYYY-MM-DDT00:00:00+05:30 to now.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        machineId: { type: SchemaType.STRING },
        from: { type: SchemaType.STRING },
        to: { type: SchemaType.STRING },
        severity: { type: SchemaType.STRING, format: "enum", enum: ["info", "warning", "critical", "all"] },
        tagSlug: { type: SchemaType.STRING },
        limit: { type: SchemaType.NUMBER },
        includeSampleDerivedThresholds: {
          type: SchemaType.BOOLEAN,
          description:
            "Optional. true = always merge sample-derived threshold breaches (heavy). false = Postgres only. Omit = derive from samples only when no alert_events rows matched (default, cheaper)."
        }
      }
    }
  },
  {
    name: "get_tag_definition",
    description: "Get threshold and configuration details for a tag.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { tag: { type: SchemaType.STRING }, machineId: { type: SchemaType.STRING } },
      required: ["tag"]
    }
  },
  {
    name: "get_production_summary",
    description: "Get current production metrics and efficiency stats.",
    parameters: { type: SchemaType.OBJECT, properties: { machineId: { type: SchemaType.STRING } } }
  },
  {
    name: "search_tags",
    description: "Search for tags by partial name, description, unit, or subsystem.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { query: { type: SchemaType.STRING }, machineId: { type: SchemaType.STRING } },
      required: ["query"]
    }
  },
  {
    name: "get_machine_status",
    description: "Get a quick health overview of the entire machine.",
    parameters: { type: SchemaType.OBJECT, properties: { machineId: { type: SchemaType.STRING } } }
  },
  {
    name: "acknowledge_alert",
    description: "Acknowledge an open alert event.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        alertEventId: { type: SchemaType.STRING },
        actor: { type: SchemaType.STRING },
        note: { type: SchemaType.STRING }
      },
      required: ["alertEventId", "actor"]
    }
  },
  {
    name: "get_chat_sessions",
    description: "List recent chat sessions for the machine.",
    parameters: { type: SchemaType.OBJECT, properties: { machineId: { type: SchemaType.STRING }, limit: { type: SchemaType.NUMBER } } }
  },
  {
    name: "get_tag_comparison",
    description: "Compare multiple tags over a time window. READ THE 'summary' FIELD FOR YOUR ANALYSIS. The 'series' field contains raw data for chart rendering only.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "List of tag names or slugs (min 2)." },
        machineId: { type: SchemaType.STRING },
        from: { type: SchemaType.STRING, description: "ISO datetime or relative like 1h, 8h, 24h. Defaults to 8h." },
        to: { type: SchemaType.STRING, description: "ISO datetime, defaults to now." },
        limit: { type: SchemaType.NUMBER, description: "Max samples per tag. Default 200, max 1000." }
      },
      required: ["tags"]
    }
  }
];

export function assertProviderConfigured(): void {
  if (config.aiProvider === "gemini" && !config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for POST /chat");
  }
}

export async function runAgent(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<AgentResult> {
  assertProviderConfigured();
  const start = Date.now();
  console.log(`\n\x1b[1;36m==================== START AGENT RUN ====================\x1b[0m`);
  console.log(`\x1b[1;36m[Agent Run]\x1b[0m Session ID: ${args.sessionId} | Machine: ${args.machineId}`);
  
  const { plan, queryClass } = await buildAgentPlan(args.userMessage, args.logger);

  const result = await runBedrockPipeline({ ...args, plan, queryClass });

  const reflection = reflect(result.toolSteps);

  // Only attempt chart generation when user intent implies trend/history
  // Pass toolSteps so boolean-only results (EMG_STOP, fault tags) are excluded
  const charts = shouldGenerateChart(args.userMessage, result.toolSteps)
    ? generateChartsFromHistory(result.toolSteps)
    : [];

  if (charts.length) {
    args.logger.info(
      {
        chartsCount: charts.length,
        seriesCounts: charts.map(c => c.series.length),
        titles: charts.map(c => c.title),
        sessionId: args.sessionId
      },
      "agent_charts_generated"
    );
  }

  const durationMs = Date.now() - start;
  console.log(`\x1b[1;32m[Agent Run] Completed in ${durationMs}ms! Reply Length: ${result.reply.length} chars. Tools Used: ${result.toolsUsed.join(", ") || "None"}\x1b[0m`);
  console.log(`\x1b[1;36m===================== END AGENT RUN =====================\x1b[0m\n`);

  return {
    ...result,
    charts: charts.length > 0 ? charts : undefined,
    trace: {
      plan,
      queryClass,
      toolSteps: result.toolSteps,
      toolsUsed: result.toolsUsed,
      totalToolCalls: result.toolSteps.filter((s) => s.status !== "skipped").length,
      durationMs,
      reflectionNote: reflection.note || undefined,
      reflectionSeverity: reflection.severity
    }
  };
}
