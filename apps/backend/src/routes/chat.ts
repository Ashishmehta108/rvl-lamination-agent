import type { FastifyInstance } from "fastify";
import { ChatRequestSchema } from "@rvl/shared";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { ragQuery } from "../rag/store.js";
import { chatOnce, chatOnceWithModel } from "../llm/ollama.js";
import { config } from "../config.js";
import { fetchLiveContext } from "./chatContext.js";
import {
  defaultToolPlan,
  parsePlannerJson,
  PLANNER_SYSTEM,
  wantsToolPipeline,
} from "../services/chatPlanner.js";
import { runToolPlan, type ChatToolCall, type FindTagCandidate } from "../services/chatTools.js";
import {
  buildChatSessionKey,
  getChatHistoryCached,
  putChatHistoryCached,
  type ChatHistoryMessage,
} from "../services/chatHistoryCache.js";
// import {
//   normalizeInput,
//   detectRisk,
//   detectIntent,
//   detectMissingContext,
//   selectHandler,
//   buildContextPacket,
//   assembleFinalResponse,
//   validateOutput,
//   // Fully deterministic handlers (no LLM)
//   handleGreeting,
//   handleEscalation,
//   handleUnsafeInput,
//   handleOutOfScope,
//   handleAmbiguous,
//   handleNoContext,
//   handleToolFailure,
//   type HandlerType,
// } from "../handlers/chatHandler.js";
// import { enforceGroundingGuard } from "../services/groundingGuard.js";
// import {
//   deriveHealthFromLiveContexts,
//   prepareTurn,
// } from "../services/llmOrchestrator.js";
import { toolGetAlerts, toolGetProductionMetrics, toolGetTags } from "../services/chatTools.js";
import { buildLLMContext, callGemini } from "../services/geminiService.js";

/* ─────────────────────────────────────────────────────────────────
   UTILITY
   ───────────────────────────────────────────────────────────────── */

function toolBlocksToLiveContexts(
  toolBlocks: { name: string; text: string }[]
): { source: string; text: string }[] {
  return toolBlocks
    .filter(b => b.name !== "find_tags")
    .map(b => ({
      source:
        b.name === "get_tags" ? "tags_db"
          : b.name === "get_alerts" ? "alerts_db"
            : b.name === "get_reports" ? "reports_db"
              : b.name === "get_production_metrics" ? "production_db"
                : `tool_${b.name}`,
      text: b.text,
    }));
}

function deriveHealth(
  liveContexts: { source: string; text: string }[]
): "healthy" | "degraded" | "critical" | "unknown" {
  const alertBlock = liveContexts.find(c => c.source === "alerts_db");
  const tagBlock = liveContexts.find(c => c.source === "tags_db" || c.source === "tags_selected");

  if (!tagBlock && !alertBlock) return "unknown";

  if (alertBlock && alertBlock.text) {
    if (/\[CRITICAL\].*status:\s*open/i.test(alertBlock.text)) return "critical";
    if (/\[WARNING\].*status:\s*open/i.test(alertBlock.text)) return "degraded";
  }

  if (tagBlock && tagBlock.text) {
    // Check for active fault flags
    if (/:\s*1\s*\[/.test(tagBlock.text) && /(FAULT|ALARM_IND|EMG_STOP)/.test(tagBlock.text)) {
      return "degraded";
    }
  }

  if (tagBlock && tagBlock.text && !tagBlock.text.includes("No tags found")) return "healthy";

  return "unknown";
}

function needsCitationGuard(answer: string, ragCount: number): string {
  if (ragCount === 0) return answer;
  if (/\[#\d+\]/.test(answer)) return answer;
  return `${answer}\n\n_No document citations detected — verify critical values against primary systems._`;
}

/**
 * Prevent contradictory fallback text when tool data actually exists.
 * If we already have live context, never allow "can't access live data" style answers.
 */
function replaceUngroundedNoDataClaims(
  answer: string,
  hasLiveData: boolean,
  groundedFallback: string
): string {
  if (!hasLiveData) return answer;
  const badClaimPattern =
    /\b(tool[_\s-]*pipeline.*did(?:\s+not|n't)\s+respond|unable(?:\s+at\s+this\s+moment)?|cannot\s+provide.*real[-\s]*time|can't\s+provide.*live\s+data|try\s+again\s+later.*live\s+data|i\s+don't\s+have\s+enough\s+data\s+to\s+answer\s+that\s+right\s+now|no\s+(additional\s+)?production\s+data|halts?\s+production\s+operations?|no\s+further\s+production\s+data\s+can\s+be\s+provided)\b/i;
  return badClaimPattern.test(answer) ? groundedFallback : answer;
}

function buildAvailableDataFallback(
  liveContexts: { source: string; text: string }[],
  health: "healthy" | "degraded" | "critical" | "unknown"
): string {
  const hasTags = liveContexts.some(c => c.source === "tags_db" || c.source === "tags_selected");
  const hasAlerts = liveContexts.some(c => c.source === "alerts_db");
  const hasReports = liveContexts.some(c => c.source === "reports_db");
  const hasProduction = liveContexts.some(c => c.source === "production_db");
  const parts: string[] = [];

  if (hasAlerts) parts.push("alerts");
  if (hasTags) parts.push("tag readings");
  if (hasProduction) parts.push("production metrics");
  if (hasReports) parts.push("report history");

  if (parts.length === 0) {
    return "I couldn't extract a reliable machine summary from the current context. Please ask for alerts, tags, or production metrics explicitly.";
  }

  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

  return `Live data available: ${joined}. Current machine health: ${health}.`;
}

/* ─────────────────────────────────────────────────────────────────
   ROUTE REGISTRATION
   ───────────────────────────────────────────────────────────────── */

export async function registerChatRoutes(app: FastifyInstance) {
  const chatRate = (app as any).rateLimit?.bind(app);
  const chatRateHandler = chatRate
    ? chatRate({
      max: config.chatRateLimitMax,
      timeWindow: "1 minute",
      keyGenerator: (request: any) => {
        const auth = request.headers["authorization"] ?? request.headers["Authorization"] ?? "";
        const a = Array.isArray(auth) ? auth[0] : auth;
        return `${request.ip}|${String(a ?? "").slice(0, 64)}`;
      },
    })
    : undefined;

  app.post(
    "/chat",
    chatRateHandler ? { preHandler: [chatRateHandler] } : {},
    async (req, reply) => {
      const reqLog = req.log.child({ correlationId: req.id });
      const t0 = Date.now();
      requireApiAuth(req);

      // ── Validate request ─────────────────────────────────────────
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reqLog.warn({ issues: parsed.error.issues }, "chat_validation_failed");
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }

      const reqBody = parsed.data;
      reqLog.info(
        {
          machineId: reqBody.machineId ?? "(none)",
          messageCount: reqBody.messages.length,
          tagIds: reqBody.tagIds ?? [],
        },
        "chat_request_received"
      );

      if (reqBody.machineId) validateMachineAccess(reqBody.machineId);
      const machineId = reqBody.machineId || "lamination-01";
      const rawAuth = req.headers["authorization"] ?? req.headers["Authorization"] ?? "";
      const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const rawSession = req.headers["x-chat-session-id"];
      const sessionHeader = Array.isArray(rawSession) ? rawSession[0] : rawSession;
      const sessionKey = buildChatSessionKey({
        machineId,
        explicitSessionId: typeof sessionHeader === "string" ? sessionHeader : null,
        authHeader: typeof authHeader === "string" ? authHeader : null,
        ip: req.ip,
      });
      const cachedHistory = getChatHistoryCached(sessionKey);

      const lastUser = [...reqBody.messages].reverse().find(m => m.role === "user");
      if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

      reqLog.info({ query: lastUser.content.slice(0, 120) }, "chat_user_query");

      // ── PIPELINE STEP 1: Normalize input ─────────────────────────
      // const normalized = normalizeInput(lastUser.content);

      // ── NEW GEMINI FLOW ──

      // Step 1: Fetch data (alerts, production, tags) based on query
      const parseTime = (query: string): Date | undefined => {
        const q = query.toLowerCase();
        if (q.includes("yesterday")) {
          const d = new Date();
          d.setDate(d.getDate() - 1);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (q.includes("last hour")) {
          return new Date(Date.now() - 60 * 60 * 1000);
        }
        
        // Handle patterns like "27 april" or "april 27"
        const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
        for (let i = 0; i < months.length; i++) {
          const m = months[i];
          const mShort = m.slice(0, 3);
          const monthRegex = new RegExp(`(${m}|${mShort})`, "i");
          if (monthRegex.test(q)) {
            const dayMatch = q.match(/(\d{1,2})(st|nd|rd|th)?/);
            if (dayMatch) {
              const day = parseInt(dayMatch[1]);
              const d = new Date();
              d.setMonth(i);
              d.setDate(day);
              d.setHours(0, 0, 0, 0);
              // If the date is in the future relative to now (approx), assume last year? 
              // Actually for now just assume current year.
              return d;
            }
          }
        }
        return undefined;
      };

      const since = parseTime(lastUser.content);

      const [alertsRaw, tagsRaw, productionRaw] = await Promise.all([
        toolGetAlerts(machineId, { includeRecentClosed: true, since }),
        toolGetTags(machineId, { tagIds: reqBody.tagIds, limit: 10 }),
        toolGetProductionMetrics(machineId, { granularity: "daily", buckets: 7 })
      ]);

      // Step 2: Build context using buildLLMContext()
      const context = buildLLMContext({ alertsRaw, tagsRaw, productionRaw });

      // Step 3: Call Gemini
      const answer = await callGemini(lastUser.content, context);

      // Step 4: Return Gemini response
      const deriveHealthFromAlerts = (raw: string): "healthy" | "degraded" | "critical" | "unknown" => {
        if (/\[CRITICAL\].*status:\s*open/i.test(raw)) return "critical";
        if (/\[WARNING\].*status:\s*open/i.test(raw)) return "degraded";
        if (raw.includes("No active alerts")) return "healthy";
        return "unknown";
      };

      const health = deriveHealthFromAlerts(alertsRaw);

      return reply.send({
        answer,
        grounded: true,
        health,
      });

      /* OLD PIPELINE COMMENTED OUT
      // ── PIPELINE STEP 2: Risk detection ──────────────────────────
      // const risk = detectRisk(normalized);
      // ... (rest of the file until return reply.send)
      */
    }
  );
}

/* ─────────────────────────────────────────────────────────────────
   LEGACY RAG SYSTEM PROMPT
   Used when the tool pipeline is off (document-grounded path).
   ───────────────────────────────────────────────────────────────── */

// function buildRagSystemPrompt(
//   ragContexts: { text: string; chunkId: string; sourceUri?: string }[],
//   liveContexts: { source: string; text: string }[],
//   handler: HandlerType
// ): string {
//   const hasAny = ragContexts.length > 0 || liveContexts.length > 0;

//   const handlerHint = RAG_HANDLER_HINTS[handler] ?? "";

//   const persona = `You are Ravi, the RVL Lamination Assistant — calm, experienced, direct. Speak plainly. Lead with the answer. Use exact values from CONTEXT. Never invent data. Never end with hollow closings. Write 2-4 sentences only.${handlerHint ? "\n" + handlerHint : ""}`;

//   if (!hasAny) {
//     return `${persona}\n\nCONTEXT:\n(empty — no live data available right now)`;
//   }

//   const parts: string[] = [];

//   if (liveContexts.length > 0) {
//     const clean = liveContexts.filter(
//       c => !c.text.includes("No definitions matched") && !c.text.includes("No tags found")
//     );
//     parts.push(...(clean.length > 0 ? clean : liveContexts).map(c => c.text));
//   }

//   if (ragContexts.length > 0) {
//     parts.push(...ragContexts.map((c, i) => `[#${i + 1}] ${c.text}`));
//   }

//   return `${persona}\n\nCONTEXT:\n${parts.join("\n\n")}`;
// }

// const RAG_HANDLER_HINTS: Partial<Record<HandlerType, string>> = {
//   alerts: "Focus on the alert situation. Name the most important alert first.",
//   stale_data: "Note that data may be stale. Do not state readings as current fact.",
//   partial_telemetry: "Acknowledge that only partial data is available.",
//   user_correction: "Acknowledge the correction. Re-state the current data clearly.",
//   conflicting_context: "Flag the discrepancy between fault flags and alert records.",
// };

// const TOOL_LABEL: Record<string, string> = {
//   find_tags: "Resolved tag candidates (fuzzy)",
//   get_tags: "Fetched live tag values",
//   get_alerts: "Queried alerts",
//   get_reports: "Loaded report runs",
//   get_production_metrics: "Aggregated production metrics",
// };

// const LIVE_CONTEXT_LABEL: Record<string, string> = {
//   alerts_db: "Queried alerts",
//   tags_db: "Fetched live tag values",
//   tags_selected: "Loaded selected tags",
//   reports_db: "Loaded report history",
//   ollama_catalog: "Listed available models",
//   production_db: "Aggregated production data",
// };