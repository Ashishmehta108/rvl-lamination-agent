/**
 * agent.ts — Multi-step pipeline agent for lamination machine AI
 *
 * Pipeline: PLAN → EXECUTE → REFLECT → FINALIZE
 *
 * Key improvements over the original loop-based agent:
 * - Structured planning phase before any tool execution
 * - Tool call deduplication (same tool+args = single DB hit)
 * - Per-tool timeout with configurable fallback
 * - Retry on transient failures (max 2 attempts per tool)
 * - Hard cap: MAX_TOOL_CALLS per request
 * - Reflection step: detects missing data and triggers follow-up
 * - Structured AgentTrace returned alongside the reply
 * - Gemini + Bedrock both use the same pipeline
 */

import type { FastifyBaseLogger } from "fastify";
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type Part
} from "@google/generative-ai";
import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config.js";
import { executeLoggedTool } from "./tools.js";
import {
  bedrockConverse,
  bedrockToolsFromDeclarations,
  extractText as extractBedrockText,
  extractToolUses,
  toBedrockMessages
} from "./bedrock.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type StoredChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type FunctionCallPart = Part & {
  functionCall: { name: string; args?: Record<string, unknown> };
};

export type AgentToolStep = {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  durationMs: number;
  status: "success" | "error" | "timeout" | "skipped";
  attempt: number;
  error?: string;
  result?: any;
};

type PlanStep = {
  id: string;
  tool?: string;
  description: string;
  status: "pending" | "done" | "failed";
};

export type AgentPlan = {
  intent: string;
  requiresTools: boolean;
  steps: PlanStep[];
};

export type AgentTrace = {
  plan: AgentPlan;
  queryClass: string;
  toolSteps: AgentToolStep[];
  toolsUsed: string[];
  totalToolCalls: number;
  durationMs: number;
  reflectionNote?: string;
  reflectionSeverity: "ok" | "partial" | "degraded" | "failed";
};

export type AgentChart = {
  type: "line" | "bar" | "area";
  title: string;
  series: {
    name: string;
    data: { x: string; y: number }[];
  }[];
  unit?: string;
};

export type AgentResult = {
  reply: string;
  toolsUsed: string[];
  toolSteps: AgentToolStep[];
  tokenCount?: number;
  trace: AgentTrace;
  charts?: AgentChart[];
};


const MAX_TOOL_CALLS = 12;   // hard cap per request
const MAX_RETRIES = 2;       // per tool on transient error
const TOOL_TIMEOUT_MS = 8000; // per-tool execution timeout
const LLM_TIMEOUT_MS = config.llmTimeoutMs ?? 25000;

// ─── System Prompt ────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Ravi, a senior AI assistant for a Nonwoven Lamination Machine manufacturing plant.
Audience: plant operators, electrical engineers, maintenance engineers, production managers.
Machine: lamination-01 (v1)
Subsystems: Extruder, Laminator, Winder, Unwinder, Splice, Production, Safety.

SECTION 1 — QUERY CLASSIFICATION (do this first, always)

Before selecting any tool, classify the query into exactly one category:

HISTORICAL — query contains a specific past time, date, window, or event
  Triggers: "13:00", "14:45", "yesterday", "last shift", "between X and Y",
            "what happened", "why did", "dropped", "stopped", "tripped",
            "went down", "went off", "was it", "show me what"
  → Use ONLY: get_tag_history, get_alert_history, get_tag_definition
  → FORBIDDEN: get_all_live_tags, get_machine_status, get_live_tag_values
  → Never call a present-state tool at any step, including as a follow-up

CURRENT — query asks about the present state of the machine
  Triggers: "current", "live", "now", "right now", "status", "active alerts",
            "is the machine running", "what is X"
  → Use: get_machine_status, get_all_live_tags, get_active_alerts, get_live_tag_values

DIAGNOSTIC — query asks for root cause, correlation, or explanation across time
  Triggers: "why", "cause", "related", "after the fault", "before the alarm",
            "correlated", "extruder fault and winder tension"
  → Start with HISTORICAL tools for the event window
  → Then use get_tag_definition to check thresholds if a breach is suspected
  → Only use present-state tools if user explicitly asks "and what is it now?"

PRODUCTION — query asks about meters, GSM, efficiency, speed targets
  Triggers: "production", "efficiency", "how many meters", "GSM", "output"
  → Use: get_production_summary, then get_tag_history if a time range is mentioned

INFORMATIONAL — general question answerable from knowledge
  Triggers: "what is", "how does", "explain", "describe" — with no machine state context
  → No tools needed. Answer directly.

SECTION 2 — TOOL SELECTION RULES

HISTORICAL queries — mandatory tool sequence:
  1. get_alert_history — from/to set to the event window ± 30 min
  2. get_tag_history — for tags named in the query (RUNNING_METER, MASTER_SPEED_PCT,
     LAMINATOR_MPM, EMG_STOP, ALARM_IND, *_FAULT, tension tags)
     Use explicit ISO from/to: YYYY-MM-DDT{time}:00+05:30
  3. get_tag_definition — only if a threshold breach is suspected from step 2
  Never call get_all_live_tags or get_machine_status for historical queries.

CURRENT / STATUS queries — mandatory tool sequence:
  1. get_machine_status — always first for any status query
  2. get_active_alerts — if alerts are mentioned or machine is not healthy
  3. get_all_live_tags or get_live_tag_values — if specific tag values requested

DIAGNOSTIC / ROOT CAUSE queries — mandatory tool sequence:
  1. get_alert_history — for the event window
  2. get_tag_history — for primary tags (speed, RPM, MPM) in the window
  3. get_tag_history — for secondary tags (tension, faults) if step 1-2 show anomalies
  4. get_tag_definition — only if you need thresholds to confirm a breach
  Do not stop after step 1 if it returns zero alerts — that is itself a finding.

Date/time construction for IST:
  "13:00 today"    → from: {today}T12:30:00+05:30  to: {today}T14:00:00+05:30
  "14:45 today"    → from: {today}T14:15:00+05:30  to: {today}T15:15:00+05:30
  "yesterday"      → from: {yesterday}T00:00:00+05:30  to: {today}T00:00:00+05:30
  "last 1 hour"    → use relative: from: "1h"
  Always use ± 30 min around a point-in-time event unless user specifies a range.

SECTION 3 — ANSWER CONSTRUCTION (critical)

Your final answer MUST synthesize ALL tool results called in this conversation.
Do not summarize only the last tool. Do not discard earlier tool results.

Structure every answer in this order:
  1. One-sentence verdict — plain language, what is happening RIGHT NOW or what happened.
  2. Evidence table — key values from tool results with timestamps.
  3. What this means — explain in simple terms what the data tells an operator.
  4. Bottom line — one sentence conclusion: is this serious, minor, or needs action?
  5. What to do — concrete, step-by-step operator actions. No vague advice.

TONE RULES (critical — follow every time):
  - Write for a plant floor operator, NOT an electrical engineer. Use plain, simple English.
  - Avoid jargon: do NOT write "GSM deviation", "threshold breach", "correlation", "subsystem interaction".
  - Instead write: "material weight is lower than usual", "the value crossed the safe limit", "both dropped together", "the extruder affected the winder".
  - Replace technical terms: "MASTER_SPEED_PCT" → "line speed", "LAMINATOR_MPM" → "laminator speed", "tension deviation" → "material tension".
  - Verdict must be a single sentence a supervisor could read in 5 seconds.
  - "What to do" steps must be numbered and start with an action verb: "Check ...", "Increase ...", "Call ...", "Stop ..."
  - Never say "efficiency shortfall", "compounded by", "mitigated by", "indicative of". Use everyday words.

For HISTORICAL queries, the verdict must reference the past window, not current state.
  Correct:   "The machine was stopped from 13:00–14:00 IST — no meters were produced."
  Incorrect: "All subsystems are running normally." (present-state answer to past question)

For HISTORICAL queries with zero alerts:
  State explicitly: "No alerts fired between 13:00–14:00 IST."
  Then state what the tag history showed.
  Then conclude: planned stop (no fault/alarm) OR unexplained gap (data missing).

For DIAGNOSTIC queries:
  Show what changed first, then what followed — in plain terms.
  Example: "The extruder slowed down first, then the laminator followed, then the winder tension rose."
  If values moved together, say "both dropped at the same time". If not, say "they moved independently".

Explicit rules to never break:
  - Never report current live values as the answer to a historical question.
  - Never say "all systems normal" when you have not checked the relevant time window.
  - Never omit a tool result from your answer — if you called it, use it.
  - Never guess a value. If get_tag_history returned no samples for a window, say:
    "No data recorded for {tag} between {from} and {to}."
  - Never call the same tool twice with identical arguments.

═══════════════════════════════════════════════════════
SECTION 4 — SAFETY-CRITICAL RULES
═══════════════════════════════════════════════════════

Tags: EMG_STOP, ALARM_IND, EXTRUDER_FAULT, LAMINATOR_FAULT, WINDER_FAULT
  - If any of these were active during a historical window, lead with that finding.
  - Format: "⚠ EXTRUDER_FAULT was active from HH:MM to HH:MM IST."
  - Always check whether the fault cleared before or after production resumed.
  - If EMG_STOP was active: flag as emergency stop, not planned stop.

For active faults right now:
  - Open with: "⚠ FAULT ACTIVE: {tag}" before any other content.
  - Do not bury safety findings inside a table.

═══════════════════════════════════════════════════════
SECTION 5 — FORMATTING
═══════════════════════════════════════════════════════

- Lead with the verdict sentence, not a greeting or preamble.
- Use compact Markdown tables for tag values. Columns: Tag | Value | Timestamp | Status
- Use bullet points only for lists of 3+ items.
- Bold critical findings: **Emergency stop active**, **no alerts fired**, **Winder fault at 13:42**
- Do not show raw boolean values (0/1). Use: ON/OFF, Active/Clear, Fault/Clear.
- Do not duplicate data across multiple formats in the same response.
- Timestamps: always show in IST (Asia/Kolkata), format HH:MM IST.
- Tag names in tables are fine (MASTER_SPEED_PCT), but in prose always use plain names:
    MASTER_SPEED_PCT → line speed
    LAMINATOR_MPM → laminator speed
    RUNNING_METER → meters produced
    WINDER_TENSION / LAMINATOR_TENSION → material tension
    EMG_STOP → emergency stop
    EXTRUDER_RPM → extruder speed
    GSM → material weight (GSM)
- "Next action" / "What to do" must be numbered steps starting with an action verb.
  Good: "1. Increase line speed to 80%."
  Bad:  "Consider adjusting the operational parameters."

CHARTING RULES (for trend/history queries):
  - When the user asks about a trend, history, comparison over time, or chart:
    ALWAYS call get_tag_history for EACH tag they mention.
  - Never skip the tool call and answer from memory — the system auto-generates charts from tool results.
  - If the user asks about two related tags (e.g. line speed and laminator speed), call get_tag_history for BOTH.
  - Use the same from/to time range for all tags so they appear on one comparative chart.

RESPONSE LENGTH RULES:
  - Default: keep responses under 30 lines. Focus on the most important tags only.
  - EXCEPTION — show ALL tags with NO truncation when the user says ANY of:
      "all tags", "all live tags", "all live values", "all tag values",
      "full tag list", "show all", "list all", "every tag", "complete tag list",
      "all readings", "all current values", "all sensor values".
    In this case: output every tag from get_all_live_tags, grouped by subsystem.
    Use one table per subsystem: Subsystem | Tag | Value | Unit | Status | Timestamp.
    Do NOT omit any tag. Do NOT say "key tags only". Show them all.`;

function buildSystemPrompt(): string {
  const now = new Date();
  const indiaDate = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short"
  }).format(now);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(now);

  return `${SYSTEM_PROMPT}

Today is ${today} in Asia/Kolkata.
Current date/time: ${now.toISOString()} UTC (${indiaDate} IST).

Date handling rules:
- Use the current date above. Do not rely on your training-time date.
- If the user asks for alerts on a particular date, call get_alert_history.
- Convert a date-only request into a full-day local window: from YYYY-MM-DDT00:00:00+05:30 to next day YYYY-MM-DDT00:00:00+05:30.
- Examples:
  - "alerts on 27 April 2026" -> from 2026-04-27T00:00:00+05:30, to 2026-04-28T00:00:00+05:30.
  - "critical alerts yesterday" -> use the full previous local day and severity critical.
- Never say a requested date is future unless it is after the current date/time shown above.`;
}

// ─── Tool Declarations ────────────────────────────────────────────────────────

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
    description: "Fetch currently open, acknowledged, resolved, or recently triggered alerts. Use this for current alert state.",
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
    description: "Fetch historical alerts with optional time range. Use this for questions like alerts on a date, alerts yesterday, alerts last week.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        machineId: { type: SchemaType.STRING },
        from: { type: SchemaType.STRING },
        to: { type: SchemaType.STRING },
        severity: { type: SchemaType.STRING, format: "enum", enum: ["info", "warning", "critical", "all"] },
        tagSlug: { type: SchemaType.STRING },
        limit: { type: SchemaType.NUMBER }
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
  }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertProviderConfigured(): void {
  if (config.aiProvider === "gemini" && !config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for POST /chat");
  }
}

function isFunctionCallPart(part: Part): part is FunctionCallPart {
  return "functionCall" in part && typeof part.functionCall?.name === "string";
}

function extractGeminiText(parts: Part[]): string {
  return parts
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

function toGeminiHistory(history: StoredChatMessage[]): Content[] {
  const mapped = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): Content => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

  const normalized: Content[] = [];
  for (const item of mapped) {
    const prev = normalized[normalized.length - 1];
    if (prev?.role === item.role) {
      prev.parts.push(...item.parts);
      continue;
    }
    normalized.push(item);
  }
  // Gemini history must not end with a user turn (we send it fresh)
  if (normalized[normalized.length - 1]?.role === "user") normalized.pop();
  return normalized;
}

function labelForTool(name: string): string {
  const labels: Record<string, string> = {
    get_live_tag_values: "Fetched selected live tags",
    get_all_live_tags: "Fetched all live machine tags",
    get_tag_history: "Loaded tag history",
    get_active_alerts: "Checked active alerts",
    get_alert_history: "Loaded alert history",
    get_tag_definition: "Checked tag thresholds",
    get_production_summary: "Built production summary",
    search_tags: "Searched tag definitions",
    get_machine_status: "Checked machine health",
    acknowledge_alert: "Acknowledged alert",
    get_chat_sessions: "Loaded chat sessions"
  };
  return labels[name] ?? `Ran ${name}`;
}

/** Stable cache key for a tool call — prevents duplicate DB hits within one request */
function toolCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

/** Wraps a promise with a hard timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool timeout after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

// ─── Query classifier ─────────────────────────────────────────────────────────
// Classifies user message into one of 6 query types before planning.

type QueryClass = "informational" | "all_tags" | "current" | "historical" | "diagnostic" | "production" | "complex";

function classifyQuery(msg: string): QueryClass {
  const m = msg.toLowerCase();

  // Explicit request for every tag value — must be checked first
  const isAllTags =
    /\b(all tag|all live|all current|all sensor|all reading|all value|every tag|full tag|complete tag|list all|show all|all the tag|all the live|all the current|all the sensor)\b/.test(m);
  if (isAllTags) return "all_tags";

  // Pure knowledge question with no machine context
  const isInfoOnly =
    /^(what is|who is|how does|explain|define|tell me about|describe)\b/.test(m) &&
    !/\b(current|live|now|status|alert|fault|running|value|reading|rpm|mpm|tension|meter)\b/.test(m);
  if (isInfoOnly) return "informational";

  // Complex / multi-part: contains causal, diagnostic, or compound connectors
  const isComplex =
    /\b(why|cause|root cause|explain why|what caused|drop.*and|fault.*and|after.*fault|before.*alarm)\b/.test(m) ||
    (/\b(and (what|how|should|recommend)\b)/.test(m) && m.length > 60) ||
    /\b(correlat|relate|impact|effect on|led to)\b/.test(m);
  if (isComplex) return "diagnostic";

  // Historical: contains a past time reference
  const isHistorical =
    /\b(yesterday|last shift|last hour|last \d|on \d{1,2}|april|may|at \d{1,2}:\d{2}|between|from.*to|\d{4}-\d{2}-\d{2}|what happened|why did|dropped|stopped|tripped|went down)\b/.test(m);
  if (isHistorical) return "historical";

  // Production focus
  if (/\b(production|meter|gsm|efficiency|output|how many|how much produced)\b/.test(m)) return "production";

  // Current state
  if (/\b(current|live|now|right now|status|is.*running|active alert|what is|reading|value)\b/.test(m)) return "current";

  // Multi-part pattern: two distinct questions in one message
  if ((m.match(/\?/g) ?? []).length >= 2) return "diagnostic";

  return "current"; // safe default
}

// ─── Query decomposer ─────────────────────────────────────────────────────────
// For complex/diagnostic queries, generates human-readable sub-question labels
// that map to tool steps. This makes the trace readable and helps the LLM.

type SubQuery = {
  question: string;
  tool: string;
  args: Record<string, unknown>;
};

function decomposeComplexQuery(msg: string): SubQuery[] {
  const m = msg.toLowerCase();
  const subQueries: SubQuery[] = [];

  // Detect production drop scenario
  if (/\b(production.*drop|drop.*production|why.*drop|efficiency.*drop)\b/.test(m)) {
    subQueries.push(
      { question: "What was production output in the affected window?", tool: "get_production_summary", args: {} },
      { question: "Were there any alerts during the production drop?", tool: "get_alert_history", args: {} },
      { question: "What did speed/RPM/MPM tags show?", tool: "get_tag_history", args: { tag: "MASTER_SPEED_PCT" } },
      { question: "Were any faults active during this period?", tool: "get_tag_history", args: { tag: "EXTRUDER_FAULT" } }
    );
    return subQueries;
  }

  // Detect fault root cause scenario
  if (/\b(why.*fault|fault.*cause|fault.*reason|extruder.*fault|winder.*fault|laminator.*fault)\b/.test(m)) {
    subQueries.push(
      { question: "What alerts fired around the fault?", tool: "get_alert_history", args: {} },
      { question: "What did RPM/speed tags show before the fault?", tool: "get_tag_history", args: { tag: "EXTRUDER_RPM" } },
      { question: "Were there tension anomalies?", tool: "get_tag_history", args: { tag: "WINDER_TENSION" } },
      { question: "What are the fault thresholds for this tag?", tool: "get_tag_definition", args: {} }
    );
    return subQueries;
  }

  // Detect machine-stopped scenario
  if (/\b(stopped|machine stop|emg|emergency|went down|not running)\b/.test(m)) {
    subQueries.push(
      { question: "Were there any emergency stop events?", tool: "get_alert_history", args: {} },
      { question: "Was EMG_STOP tag active?", tool: "get_tag_history", args: { tag: "EMG_STOP" } },
      { question: "What was the machine running status before stop?", tool: "get_tag_history", args: { tag: "MASTER_SPEED_PCT" } }
    );
    return subQueries;
  }

  // Generic multi-part: build steps from keywords
  if (/\b(production|meter|output)\b/.test(m)) subQueries.push({ question: "Fetch production data", tool: "get_production_summary", args: {} });
  if (/\b(alert|alarm|fault)\b/.test(m)) subQueries.push({ question: "Check alert history", tool: "get_alert_history", args: {} });
  if (/\b(speed|rpm|mpm|tension)\b/.test(m)) subQueries.push({ question: "Check tag trends", tool: "get_tag_history", args: {} });
  if (!subQueries.length) {
    subQueries.push({ question: "Check machine status", tool: "get_machine_status", args: {} });
    subQueries.push({ question: "Check active alerts", tool: "get_active_alerts", args: {} });
  }

  return subQueries;
}

// ─── Heuristic planner ────────────────────────────────────────────────────────
// Classifies query → (optionally) decomposes → builds observable plan.
// The actual tool calls are still driven by the LLM; this is for
// observability, guardrails, and injecting decomposed context into the prompt.

function buildHeuristicPlan(userMessage: string): AgentPlan {
  const queryClass = classifyQuery(userMessage);

  if (queryClass === "informational") {
    return {
      intent: "Informational — answerable from knowledge, no tools needed",
      requiresTools: false,
      steps: [{ id: "s1", description: "Answer from knowledge", status: "pending" }]
    };
  }

  const steps: PlanStep[] = [];
  let id = 0;
  const push = (tool: string, description: string) =>
    steps.push({ id: `s${++id}`, tool, description, status: "pending" });

  if (queryClass === "all_tags") {
    // User explicitly asked for every tag — one tool only.
    // The model will render the complete grouped table from its output.
    push("get_all_live_tags", "Fetch ALL live tag values grouped by subsystem");
  } else if (queryClass === "diagnostic") {
    // Use decomposer for complex queries
    const subQueries = decomposeComplexQuery(userMessage);
    for (const sq of subQueries) {
      push(sq.tool, sq.question);
    }
    // Always add correlation step at end
    steps.push({ id: `s${++id}`, description: "Correlate findings and generate root cause + recommendation", status: "pending" });
  } else if (queryClass === "historical") {
    push("get_alert_history", "Load alerts in the requested time window");
    push("get_tag_history", "Load primary tag values in the window (speed, meter, RPM)");
  } else if (queryClass === "production") {
    push("get_production_summary", "Fetch production metrics");
    if (/\b(history|yesterday|last|trend)\b/.test(userMessage.toLowerCase())) {
      push("get_tag_history", "Load historical speed/meter trends");
    }
  } else {
    // current (default)
    push("get_machine_status", "Check overall machine health");
    if (/\b(alert|alarm|fault|warning)\b/.test(userMessage.toLowerCase())) {
      push("get_active_alerts", "Check active alerts");
    }
    if (/\b(tag|value|reading|live)\b/.test(userMessage.toLowerCase())) {
      push("get_all_live_tags", "Fetch all live tag values");
    }
    if (!steps.some(s => s.tool === "get_active_alerts")) {
      push("get_active_alerts", "Check active alerts");
    }
  }

  // Threshold check: add only when explicitly needed
  if (/\b(threshold|limit|config|spec|definition)\b/.test(userMessage.toLowerCase())) {
    push("get_tag_definition", "Get tag threshold configuration");
  }

  return {
    intent: `[${queryClass.toUpperCase()}] ${userMessage.slice(0, 100)}`,
    requiresTools: true,
    steps
  };
}

// ─── Tool executor with deduplication, timeout, retry ─────────────────────────

async function runTool(opts: {
  name: string;
  args: Record<string, unknown>;
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  cache: Map<string, unknown>;
  toolSteps: AgentToolStep[];
  toolsUsed: string[];
}): Promise<{ functionResponse: { name: string; response: { result?: unknown; error?: string } } }> {
  const { name, args, machineId, sessionId, logger, cache, toolSteps, toolsUsed } = opts;
  const cacheKey = toolCacheKey(name, args);

  // Deduplication: same tool+args within one request returns cached result
  if (cache.has(cacheKey)) {
    toolSteps.push({
      tool: name,
      label: `${labelForTool(name)} (cached)`,
      args,
      durationMs: 0,
      status: "skipped",
      attempt: 0
    });
    return { functionResponse: { name, response: { result: cache.get(cacheKey) } } };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        executeLoggedTool({ name, toolArgs: args, machineId, sessionId, logger }),
        TOOL_TIMEOUT_MS,
        name
      );
      const durationMs = Math.max(1, Date.now() - startedAt);
      cache.set(cacheKey, result);
      toolsUsed.push(name);
      toolSteps.push({ tool: name, label: labelForTool(name), args, durationMs, status: "success", attempt, result });
      return { functionResponse: { name, response: { result } } };
    } catch (error) {
      const durationMs = Math.max(1, Date.now() - startedAt);
      lastError = error instanceof Error ? error.message : String(error);
      const isTimeout = lastError.includes("timeout");
      const isFinal = attempt === MAX_RETRIES;

      if (isFinal) {
        toolsUsed.push(name);
        toolSteps.push({
          tool: name,
          label: `${labelForTool(name)} failed`,
          args,
          durationMs,
          status: isTimeout ? "timeout" : "error",
          attempt,
          error: lastError
        });
        return { functionResponse: { name, response: { error: lastError } } };
      }

      // Brief back-off before retry
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }

  // Should not reach here, but satisfies TypeScript
  return { functionResponse: { name, response: { error: lastError } } };
}

// ─── Reflection ───────────────────────────────────────────────────────────────
// Scans tool steps for systemic failure patterns.
// Returns: a human-readable note, severity, and whether a follow-up is needed.

type ReflectionSeverity = "ok" | "partial" | "degraded" | "failed";

function reflect(toolSteps: AgentToolStep[]): {
  note: string;
  needsFollowUp: boolean;
  severity: ReflectionSeverity;
} {
  const failed = toolSteps.filter(s => s.status === "error" || s.status === "timeout");
  const succeeded = toolSteps.filter(s => s.status === "success");
  const total = toolSteps.filter(s => s.status !== "skipped").length;

  if (!failed.length) return { note: "", needsFollowUp: false, severity: "ok" };

  const allFailed = succeeded.length === 0 && failed.length > 0;
  const criticalTools = ["get_machine_status", "get_active_alerts", "get_all_live_tags", "get_alert_history"];
  const criticalFailed = failed.some(s => criticalTools.includes(s.tool));
  const failRate = failed.length / Math.max(1, total);

  if (allFailed) {
    return {
      note: `⚠ All ${failed.length} tool(s) failed — no live data available. Answer is based on prior context only.`,
      needsFollowUp: false,
      severity: "failed"
    };
  }

  if (criticalFailed || failRate >= 0.5) {
    const names = failed.map(s => s.tool).join(", ");
    return {
      note: `⚠ Critical data unavailable (${names}). Answer may be incomplete — verify with a follow-up query.`,
      needsFollowUp: true,
      severity: "degraded"
    };
  }

  return {
    note: `${failed.length} of ${total} tool(s) failed and were skipped. Partial data used.`,
    needsFollowUp: false,
    severity: "partial"
  };
}

// ─── Chart Helpers ────────────────────────────────────────────────────────────

/** Detect whether the user's query implies they want a trend/chart. */
function shouldGenerateChart(userMessage: string): boolean {
  const m = userMessage.toLowerCase();
  return (
    m.includes("trend") ||
    m.includes("history") ||
    m.includes("last") ||
    m.includes("over time") ||
    m.includes("graph") ||
    m.includes("chart") ||
    m.includes("plot") ||
    m.includes("past") ||
    m.includes("compare")
  );
}

/** Infer a display unit from a tag slug or name. */
function inferUnit(tag: string): string {
  const t = tag.toUpperCase();
  if (t.includes("PCT") || t.includes("PERCENT") || t.includes("EFFICIENCY")) return "%";
  if (t.includes("MPM")) return "m/min";
  if (t.includes("RPM")) return "RPM";
  if (t.includes("GSM")) return "g/m²";
  if (t.includes("TEMP") || t.includes("°C")) return "°C";
  if (t.includes("TENSION")) return "%";
  if (t.includes("METER") && !t.includes("MPM")) return "m";
  return "";
}

/**
 * Downsample a series to at most `maxPoints` using LTTB-like bucket averaging.
 * Preserves first and last points for accurate range display.
 */
function downsampleSeries(
  data: { x: string; y: number }[],
  maxPoints = 500
): { x: string; y: number }[] {
  if (data.length <= maxPoints) return data;
  const bucketSize = Math.ceil(data.length / maxPoints);
  const result: { x: string; y: number }[] = [data[0]];
  for (let i = 1; i < data.length - 1; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length - 1));
    const avgY = bucket.reduce((s, p) => s + p.y, 0) / bucket.length;
    // Pick the point closest to bucket midpoint for representative timestamp
    const mid = Math.floor(bucket.length / 2);
    result.push({ x: bucket[mid].x, y: Math.round(avgY * 100) / 100 });
  }
  result.push(data[data.length - 1]);
  return result;
}

// ─── Chart Generator ──────────────────────────────────────────────────────────
// Scans tool steps for tag history and converts it to frontend-ready chart data.
// Groups tags with the same time window into a single comparative chart.

function generateChartsFromHistory(toolSteps: AgentToolStep[]): AgentChart[] {
  const charts: AgentChart[] = [];

  const historySteps = toolSteps.filter(
    (s) => s.tool === "get_tag_history" && s.status === "success" && s.result
  );

  if (historySteps.length === 0) return charts;

  // Group steps by their resolved time window to combine tags into one chart
  const groups: Record<string, AgentToolStep[]> = {};
  for (const step of historySteps) {
    const from = step.result?.from || step.args.from || "default";
    const to = step.result?.to || step.args.to || "default";
    const key = `${from}-${to}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(step);
  }

  for (const [, steps] of Object.entries(groups)) {
    const seriesList = steps.map(step => {
      const samples: any[] = step.result?.samples || (Array.isArray(step.result) ? step.result : []);
      const slug: string = step.result?.tag?.slug || String(step.args.tag || "");
      const tagName: string = step.result?.tag?.name || slug || "Unknown";

      // Clean data mapping with NaN filtering
      const rawData = samples
        .map((d: any) => ({
          x: (d.ts || d.timestamp || d.t || "") as string,
          y: Number(d.value ?? d.val ?? 0)
        }))
        .filter(p => p.x && !isNaN(p.y));

      return {
        name: slug || tagName,
        displayName: tagName,
        slug,
        unit: inferUnit(slug || tagName),
        data: downsampleSeries(rawData)
      };
    }).filter(s => s.data.length >= 2);

    if (seriesList.length === 0) continue;

    // Build title
    const title = seriesList.length === 1
      ? `Trend: ${seriesList[0].displayName}`
      : `Comparative Trend: ${seriesList.map(s => s.displayName).join(" vs ")}`;

    // Determine chart-level unit (use first series, or blank if mixed)
    const units = [...new Set(seriesList.map(s => s.unit).filter(Boolean))];
    const chartUnit = units.length === 1 ? units[0] : units.length > 1 ? "mixed" : undefined;

    charts.push({
      type: "line",
      title,
      unit: chartUnit,
      series: seriesList.map(s => ({ name: s.name, data: s.data }))
    });
  }

  return charts;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runGeminiAgent(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<AgentResult> {
  assertProviderConfigured();
  const start = Date.now();
  const plan = buildHeuristicPlan(args.userMessage);

  const result =
    config.aiProvider === "bedrock"
      ? await runBedrockPipeline({ ...args, plan })
      : await runGeminiPipeline({ ...args, plan });

  const reflection = reflect(result.toolSteps);

  // Only attempt chart generation when user intent implies trend/history
  const charts = shouldGenerateChart(args.userMessage)
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

  return {
    ...result,
    charts: charts.length > 0 ? charts : undefined,
    trace: {
      plan,
      queryClass: plan.intent.match(/^\[([A-Z]+)\]/)?.[1]?.toLowerCase() ?? "unknown",
      toolSteps: result.toolSteps,
      toolsUsed: result.toolsUsed,
      totalToolCalls: result.toolSteps.filter((s) => s.status !== "skipped").length,
      durationMs: Date.now() - start,
      reflectionNote: reflection.note || undefined,
      reflectionSeverity: reflection.severity
    }
  };
}

// ─── Gemini Pipeline ──────────────────────────────────────────────────────────

async function runGeminiPipeline(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  plan: AgentPlan;
}): Promise<Omit<AgentResult, "trace">> {
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);

  // Relax safety settings: industrial terms like "fault", "alarm", "emergency stop"
  // frequently trigger Gemini's content filters, causing silent empty responses.
  const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }
  ];

  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: buildSystemPrompt(),
    generationConfig: { temperature: 0.2, topP: 0.85 },
    safetySettings
  });

  const chat = model.startChat({
    history: toGeminiHistory(args.history),
    tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS }]
  });

  const toolsUsed: string[] = [];
  const toolSteps: AgentToolStep[] = [];
  const cache = new Map<string, unknown>();
  let totalCalls = 0;
  let tokenCount: number | undefined;

  // ── EXECUTE phase: initial LLM call ───────────────────────────────────────
  let response = await withTimeout(
    chat.sendMessage(args.userMessage),
    LLM_TIMEOUT_MS,
    "gemini_initial"
  );
  tokenCount = response.response.usageMetadata?.totalTokenCount;

  for (let round = 0; round < 8; round++) {
    const candidate = response.response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const finishReason = candidate?.finishReason;

    // ── Guard: empty/blocked response ─────────────────────────────────────
    if (!parts.length) {
      args.logger.warn(
        { round, finishReason, sessionId: args.sessionId, model: config.geminiModel },
        "gemini_empty_parts"
      );

      // Round 0: model returned nothing before any tools ran.
      // Retry once as a plain text-only call (no function declarations) to get
      // at least a grounded answer using the system prompt + system context.
      if (round === 0 && totalCalls === 0) {
        args.logger.warn({ sessionId: args.sessionId }, "gemini_round0_empty_retrying_text_only");
        try {
          const textModel = genAI.getGenerativeModel({
            model: config.geminiModel,
            systemInstruction: buildSystemPrompt(),
            generationConfig: { temperature: 0.3 },
            safetySettings
          });
          const textChat = textModel.startChat({ history: toGeminiHistory(args.history) });
          const textResp = await withTimeout(
            textChat.sendMessage(
              `${args.userMessage}\n\n[Note: Live machine data is temporarily unavailable. Answer based on your system knowledge and the information already in this session.]`
            ),
            LLM_TIMEOUT_MS,
            "gemini_text_fallback"
          );
          const fallbackText = extractGeminiText(textResp.response.candidates?.[0]?.content?.parts ?? []);
          if (fallbackText) {
            return {
              reply: `⚠ Live data unavailable (model returned no content; reason: ${finishReason ?? "UNKNOWN"}). Fallback answer based on system context:\n\n${fallbackText}`,
              toolsUsed,
              toolSteps,
              tokenCount
            };
          }
        } catch (retryErr) {
          args.logger.error({ err: String(retryErr), sessionId: args.sessionId }, "gemini_text_fallback_failed");
        }
      }

      // All retries exhausted — return a meaningful diagnostic
      const reason = finishReason ?? "UNKNOWN";
      return {
        reply: [
          `The model returned no content (finishReason: ${reason}).`,
          reason === "SAFETY"
            ? "The query may have triggered a content safety filter. Try rephrasing without terms like 'emergency' or split into simpler questions."
            : "This may be a transient model issue. Please try again in a few seconds."
        ].join(" "),
        toolsUsed,
        toolSteps,
        tokenCount
      };
    }

    const calls = parts.filter(isFunctionCallPart);

    if (!calls.length) {
      // FINALIZE: model returned text with no further tool calls
      const reply = extractGeminiText(parts);
      if (!reply) {
        args.logger.warn({ round, finishReason, sessionId: args.sessionId }, "gemini_text_extraction_empty");
      }
      return {
        reply: reply || `No text content in model response (finishReason: ${finishReason ?? "STOP"}).`,
        toolsUsed,
        toolSteps,
        tokenCount
      };
    }

    // Guard: hard cap on total tool calls
    if (totalCalls + calls.length > MAX_TOOL_CALLS) {
      args.logger.warn({ totalCalls, requested: calls.length, sessionId: args.sessionId }, "agent_tool_cap_reached");
      const reply = extractGeminiText(parts);
      return {
        reply: reply || "Analysis stopped: maximum tool call limit reached for this request.",
        toolsUsed,
        toolSteps,
        tokenCount
      };
    }

    // EXECUTE tools (parallel, with dedup + timeout + retry)
    const toolResults = await Promise.all(
      calls.map((part) =>
        runTool({
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          machineId: args.machineId,
          sessionId: args.sessionId,
          logger: args.logger,
          cache,
          toolSteps,
          toolsUsed
        })
      )
    );
    totalCalls += calls.length;

    response = await withTimeout(
      chat.sendMessage(toolResults as Part[]),
      LLM_TIMEOUT_MS,
      `gemini_round_${round}`
    );
    tokenCount = response.response.usageMetadata?.totalTokenCount ?? tokenCount;
  }

  return {
    reply: "Analysis could not be completed: maximum reasoning rounds reached.",
    toolsUsed,
    toolSteps,
    tokenCount
  };
}

// ─── Bedrock Pipeline ─────────────────────────────────────────────────────────

async function runBedrockPipeline(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  plan: AgentPlan;
}): Promise<Omit<AgentResult, "trace">> {
  const toolsUsed: string[] = [];
  const toolSteps: AgentToolStep[] = [];
  const cache = new Map<string, unknown>();
  const messages = toBedrockMessages(args.history, args.userMessage);
  const tools = bedrockToolsFromDeclarations(ALL_TOOL_DECLARATIONS);
  let totalCalls = 0;

  for (let round = 0; round < 8; round++) {
    // Round 0 with requiresTools=true: force at least one tool call using toolChoice: any.
    // This prevents Claude from returning stopReason: end_turn with empty content
    // instead of actually calling tools (a known Bedrock silent-failure pattern).
    const toolChoice = (round === 0 && args.plan.requiresTools)
      ? { any: {} }
      : { auto: {} };

    const response = await withTimeout(
      bedrockConverse({
        systemPrompt: buildSystemPrompt(),
        messages,
        tools,
        toolChoice,
        modelId: config.bedrockModelId,
        temperature: 0.2,
        timeoutMs: LLM_TIMEOUT_MS
      }),
      LLM_TIMEOUT_MS + 2000,
      `bedrock_round_${round}`
    );

    const stopReason = response.stopReason;
    const message = response.output?.message;
    const content = message?.content ?? [];
    const toolUses = extractToolUses(content);
    const textReply = extractBedrockText(content);

    args.logger.debug(
      { round, stopReason, toolUses: toolUses.length, hasText: !!textReply, contentBlocks: content.length, sessionId: args.sessionId },
      "bedrock_round"
    );

    // Guard: empty or error response
    // Happens when Bedrock throttles, hits max_tokens, or the model returns nothing.
    if (!content.length || (!toolUses.length && !textReply)) {
      args.logger.warn(
        { round, stopReason, sessionId: args.sessionId, modelId: config.bedrockModelId },
        "bedrock_empty_content"
      );

      // Round 0, no tools executed yet: retry once as plain text (no toolConfig)
      // to guarantee at least a knowledge-based answer from the system prompt.
      if (round === 0 && totalCalls === 0) {
        args.logger.warn({ sessionId: args.sessionId }, "bedrock_round0_retrying_text_only");
        try {
          const fallbackResp = await withTimeout(
            bedrockConverse({
              systemPrompt: buildSystemPrompt(),
              messages,
              // intentionally omit tools to force a text answer
              modelId: config.bedrockModelId,
              temperature: 0.3,
              timeoutMs: LLM_TIMEOUT_MS
            }),
            LLM_TIMEOUT_MS + 2000,
            "bedrock_text_fallback"
          );
          const fallbackText = extractBedrockText(fallbackResp.output?.message?.content);
          if (fallbackText) {
            return {
              reply: `\u26a0 Tools unavailable (stopReason: ${stopReason ?? "UNKNOWN"}). Answer based on system context:\n\n${fallbackText}`,
              toolsUsed,
              toolSteps,
              tokenCount: fallbackResp.usage
                ? (fallbackResp.usage.inputTokens ?? 0) + (fallbackResp.usage.outputTokens ?? 0)
                : undefined
            };
          }
        } catch (retryErr) {
          args.logger.error({ err: String(retryErr), sessionId: args.sessionId }, "bedrock_text_fallback_failed");
        }
      }

      // All retries exhausted
      return {
        reply: [
          `Model returned no content (stopReason: ${stopReason ?? "UNKNOWN"}).`,
          stopReason === "max_tokens"
            ? "The request context was too long. Try a more specific or shorter query."
            : stopReason === "end_turn"
              ? "The model finished without producing output. Try rephrasing your query or splitting it into smaller questions."
              : "This may be a transient Bedrock issue. Please retry in a few seconds."
        ].join(" "),
        toolsUsed,
        toolSteps,
        tokenCount: response.usage
          ? (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0)
          : undefined
      };
    }

    // FINALIZE: model returned text with no tool calls
    if (!toolUses.length) {
      return {
        reply: textReply,
        toolsUsed,
        toolSteps,
        tokenCount: response.usage
          ? (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0)
          : undefined
      };
    }

    // Guard: hard cap
    if (totalCalls + toolUses.length > MAX_TOOL_CALLS) {
      args.logger.warn({ totalCalls, requested: toolUses.length, sessionId: args.sessionId }, "agent_tool_cap_reached");
      return {
        reply: extractBedrockText(content) || "Analysis stopped: maximum tool call limit reached.",
        toolsUsed,
        toolSteps
      };
    }

    if (message) messages.push(message);

    const toolResultContent: ContentBlock[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        const name = toolUse.name ?? "unknown_tool";
        const toolArgs =
          toolUse.input && typeof toolUse.input === "object"
            ? (toolUse.input as Record<string, unknown>)
            : {};

        const r = await runTool({
          name,
          args: toolArgs,
          machineId: args.machineId,
          sessionId: args.sessionId,
          logger: args.logger,
          cache,
          toolSteps,
          toolsUsed
        });

        const isError = "error" in r.functionResponse.response;
        return {
          toolResult: {
            toolUseId: toolUse.toolUseId ?? "",
            status: isError ? ("error" as const) : ("success" as const),
            content: [{ json: r.functionResponse.response }]
          }
        } as ContentBlock;
      })
    );
    totalCalls += toolUses.length;

    messages.push({ role: "user", content: toolResultContent });
  }

  return {
    reply: "Analysis could not be completed: maximum reasoning rounds reached.",
    toolsUsed,
    toolSteps,
    charts: generateChartsFromHistory(toolSteps)
  };
}