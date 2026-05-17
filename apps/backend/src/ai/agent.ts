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
import type { ContentBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config.js";
import { executeLoggedTool } from "./tools.js";
import {
  bedrockConverse,
  bedrockToolsFromDeclarations,
  extractText as extractBedrockText,
  extractToolUses,
  toBedrockMessages
} from "./bedrock.js";

type StoredChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
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
Subsystems: Extruder, Laminator, Winder, Unwinder (Main + Sandwich), Hotplate,
            Splice, Production, Safety, PLC, Web Aligner, Brush Blower.

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

For CURRENT / STATUS / "WHAT'S WRONG" queries — mandatory tool sequence:
  Triggers: "what is the issue", "what's going on", "any problems", "is something wrong",
  "current situation", "status", "right now" — even when the user does not say "today".
  1. get_machine_status — always first
  2. get_active_alerts with status "open" — always second for issue/status questions
  3. get_all_live_tags or get_live_tag_values — only if specific tag values are requested
  FORBIDDEN on CURRENT queries: get_alert_history with 24h/7d defaults (pulls yesterday's
  resolved alerts). Use get_alert_history ONLY when the user names a past date or time window.
  For "today" without a past window, use from={today}T00:00:00+05:30 and to=now — never 24h.

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

Answer shape (adapt to query type — do not force five sections on a simple status check):

CURRENT / "what's going on" (keep short, under 20 lines):
  1. **Verdict** — one sentence: healthy, degraded, or stopped; mention open faults first.
  2. **Right now** — compact table: subsystem | key reading | status (only tags that matter).
  3. **Open alerts** — list only OPEN alerts from get_active_alerts; if none, say "No open alerts."
     Do NOT list yesterday's or last week's resolved alerts unless the user asked for history.
     Do NOT treat resolved alerts as current problems on CURRENT queries.
     For resolved alerts in history, explain clearance using resolution.reason from tool data.
     For acknowledged alerts, cite the operator note via statusReason or acknowledgements (latest entry).
  4. **What to do** — numbered steps only if action is needed; skip if all clear.

HISTORICAL / DIAGNOSTIC (use full structure):
  1. One-sentence verdict for that time window.
  2. Evidence table with timestamps (IST).
  3. What this means in plain language.
  4. Bottom line — serious, minor, or needs action.
  5. What to do — numbered operator steps.

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

Alert status from tool data (get_active_alerts / get_alert_history):
  - status=resolved → use resolution.reason (auto-cleared when the tag returned in range); do not list as an active problem on CURRENT queries.
  - status=acknowledged → use statusReason or the latest acknowledgements entry (actor + note).
  - status=open → describe the breach from title/description; statusReason may be omitted.

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
SECTION 5 — FORMATTING (Markdown + math; rendered in the chat UI)
═══════════════════════════════════════════════════════

Structure (use every time; no plain wall of text):
- Open with a blockquote verdict (one sentence, **bold** the key outcome inside it):
  > **Verdict:** The line is running normally with no open alerts.
- Then ## section headers with blank lines between sections (e.g. "## Right now", "## Open alerts", "## What to do").
- Put tag/sensor data in GFM pipe tables only (header row + separator). Example columns: Tag | Value | Time (IST) | Status
- Use numbered lists starting with "1." for operator actions; use "-" bullets only for 3+ equal items.
- **Bold** all critical findings: faults, emergency stop, severity, threshold breaches, times.
- Leave a blank line before and after each table, list, and display-math block.

Typography rules:
- Lead with the verdict blockquote, not a greeting or preamble.
- Do not show raw boolean values (0/1). Use: ON/OFF, Active/Clear, Fault/Clear.
- Do not duplicate the same data in prose and table.
- Timestamps: IST (Asia/Kolkata), format HH:MM IST in tables and prose.
- Keep line length readable (~80 chars in prose); one idea per paragraph.

Math (KaTeX — use when a formula clarifies numbers):
- Inline math with single dollars: $\\text{efficiency} = \\frac{\\text{actual}}{\\text{target}} \\times 100$
- Display math on its own line with double dollars:
  $$\\text{line speed (m/min)} = \\frac{\\text{MASTER\\_SPEED\\_PCT}}{100} \\times \\text{max line speed}$$
- Use for efficiency %, speed/RPM conversions, threshold comparisons, GSM deltas.
- Escape underscores inside math with backslash (example: \\text{WINDER\\_TENSION\\_PCT}).
- Do not use HTML tags; Markdown + LaTeX only.
- Tag names in tables are fine (MASTER_SPEED_PCT), but in prose always use plain names:
    MASTER_SPEED_PCT → line speed
    LAMINATOR_MPM → laminator speed
    RUNNING_METER → meters produced
    WINDER_TENSION_PCT → winder tension
    EMG_STOP → emergency stop
    EXTRUDER_RPM → extruder speed
    GSM → material weight (GSM)
    HOTPLATE_CLOSE / HOTPLATE_OPEN → hotplate position
    SANDWICH_UW_ENABLE → second film layer (sandwich unwinder)
    CONTACT_WINDER → contact winder mode
    WINDER_DANCER_MODE → dancer roll tension mode
    GSM_SELECTION → GSM control mode active
    GRAM_LOGIC_SELECTION → gram control mode active
    LOGIC_ENABLE → machine logic gate
    AIR_PRESSURE_LOW → pneumatic pressure fault
    MACHINE_MAX_LINE_SPEED → maximum line speed (m/min)
    EXTRUDER_MAX_RPM → extruder RPM ceiling
    LAMINATOR_MAX_RPM → laminator RPM ceiling
    UW_PV_TENSION / SUW_PV_TENSION → unwinder actual tension (raw counts)
- Also classify these as mode/state queries and read these tags:
    HOTPLATE_ENABLE, HOTPLATE_CLOSE, SANDWICH_UW_ENABLE, CONTACT_WINDER,
    LOGIC_ENABLE, GSM_SELECTION, GRAM_LOGIC_SELECTION
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

/** Asia/Kolkata calendar day bounds for tool args and prompt anchoring. */
function getIstTodayWindow(now = new Date()): {
  dateOnly: string;
  fromIso: string;
  toIso: string;
  todayLabel: string;
  indiaDateTime: string;
} {
  const dateOnly = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const todayLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(now);
  const indiaDateTime = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short"
  }).format(now);
  return {
    dateOnly,
    fromIso: `${dateOnly}T00:00:00+05:30`,
    toIso: now.toISOString(),
    todayLabel,
    indiaDateTime
  };
}

function userNamesExplicitPastWindow(msg: string): boolean {
  const m = msg.toLowerCase();
  return /\b(yesterday|last week|last month|last shift|last hour|last \d|on \d{1,2}|april|may|june|july|august|september|october|november|december|between|from .+ to|\d{4}-\d{2}-\d{2}|at \d{1,2}:\d{2}|what happened|when we|that day)\b/.test(
    m
  );
}

function buildRuntimePlanContext(
  queryClass: QueryClass,
  userMessage: string,
  plan: AgentPlan
): string {
  const { dateOnly, fromIso, toIso, todayLabel } = getIstTodayWindow();
  const lines: string[] = [
    "",
   
    "RUNTIME CONTEXT (this request only — follow over generic defaults)",
   
    `Query class: ${queryClass.toUpperCase()}`,
    `User message: ${userMessage.slice(0, 500)}`,
    `Today's calendar date (IST): ${dateOnly} (${todayLabel})`,
    `Today's window for alert history when needed: from=${fromIso}, to=${toIso}`
  ];

  if (queryClass === "current") {
    lines.push(
      "Investigation order: get_machine_status → get_active_alerts (status=open).",
      "Do NOT call get_alert_history unless the user named a past date or time.",
      "In your answer, report OPEN alerts and live faults only — not old resolved alerts from prior days."
    );
  } else if (queryClass === "historical") {
    lines.push(
      "Use get_alert_history and get_tag_history for the user's stated window only.",
      "Do NOT use get_machine_status or get_active_alerts as the primary answer."
    );
  } else if (queryClass === "diagnostic") {
    lines.push(
      "Build a causal chain from tool evidence in time order.",
      userNamesExplicitPastWindow(userMessage)
        ? "User named a past window — anchor all history tools to that window."
        : `No explicit past window — prefer today's IST range (${fromIso} → now) unless tools show a clear event time.`
    );
  }

  if (plan.steps.length) {
    lines.push("Suggested plan steps (you may adapt if evidence requires it):");
    for (const step of plan.steps) {
      if (step.tool) lines.push(`- ${step.tool}: ${step.description}`);
      else lines.push(`- ${step.description}`);
    }
  }

  return lines.join("\n");
}

function buildSystemPrompt(plan?: AgentPlan, queryClass?: QueryClass, userMessage?: string): string {
  const now = new Date();
  const { todayLabel, indiaDateTime, fromIso, toIso, dateOnly } = getIstTodayWindow(now);

  let prompt = `${SYSTEM_PROMPT}

Today is ${todayLabel} in Asia/Kolkata.
Current date/time: ${now.toISOString()} UTC (${indiaDateTime} IST).
Today's IST date (YYYY-MM-DD): ${dateOnly}
Today's alert window (if you must use get_alert_history for "today"): from ${fromIso} to ${toIso}

Date handling rules:
- Use the current date above. Do not rely on your training-time date.
- If the user asks for alerts on a particular date, call get_alert_history.
- Convert a date-only request into a full-day local window: from YYYY-MM-DDT00:00:00+05:30 to next day YYYY-MM-DDT00:00:00+05:30.
- Examples:
  - "alerts on 27 April 2026" -> from 2026-04-27T00:00:00+05:30, to 2026-04-28T00:00:00+05:30.
  - "critical alerts yesterday" -> use the full previous local day and severity critical.
- Never say a requested date is future unless it is after the current date/time shown above.
- "What is the issue" / "what's going on" / "any problems" = CURRENT (live data), not encyclopedia.`;

  if (plan && queryClass && userMessage) {
    prompt += buildRuntimePlanContext(queryClass, userMessage, plan);
  }

  return prompt;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertProviderConfigured(): void {
  if (config.aiProvider === "gemini" && !config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for POST /chat");
  }
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
    get_chat_sessions: "Loaded chat sessions",
    get_tag_comparison: "Compared tag trends"
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

type QueryClass =
  | "informational"
  | "all_tags"
  | "current"
  | "historical"
  | "diagnostic"
  | "production";

/** Compiled once — avoids per-call RegExp parse and shares lastIndex-free .test() */
const RE_CLASSIFY_ALL_TAGS =
  /\b(all tag|all live|all current|all sensor|all reading|all value|every tag|full tag|complete tag|list all|show all|all the tag|all the live|all the current|all the sensor)\b/;
const RE_CLASSIFY_INFORMATIONAL_PREFIX =
  /^(what is|who is|how does|explain|define|tell me about|describe)\b/;
const RE_CLASSIFY_INFORMATIONAL_DENY =
  /\b(current|live|now|status|alert|fault|running|value|reading|rpm|mpm|tension|meter|issue|problem|wrong|happening|going on|machine|line|plant|tripped|stopped)\b/;
const RE_CLASSIFY_DIAGNOSTIC =
  /\b(why|cause|root cause|explain why|what caused|drop.*and|fault.*and|after.*fault|before.*alarm|correlat|relate|impact|effect on|led to)\b/;
const RE_CLASSIFY_DIAGNOSTIC_AND_FOLLOW =
  /\b(and (what|how|should|recommend)\b)/;
const RE_CLASSIFY_HISTORICAL =
  /\b(yesterday|last shift|last hour|last \d|on \d{1,2}|april|may|at \d{1,2}:\d{2}|between|from.*to|\d{4}-\d{2}-\d{2}|what happened|why did|dropped|stopped|tripped|went down)\b/;
const RE_CLASSIFY_PRODUCTION =
  /\b(production|meter|gsm|efficiency|output|how many|how much produced)\b/;
const RE_CLASSIFY_CURRENT =
  /\b(current|live|now|right now|status|is.*running|active alert|reading|value|issue|problem|wrong|going on|what's happening|happening now|any problem|something wrong)\b/;

function hasSecondQuestionMark(s: string): boolean {
  const first = s.indexOf("?");
  return first !== -1 && s.indexOf("?", first + 1) !== -1;
}

function classifyQueryWithRegex(msg: string): QueryClass {
  if (!msg) return "current";
  const m = msg.toLowerCase();

  if (RE_CLASSIFY_ALL_TAGS.test(m)) return "all_tags";

  if (
    RE_CLASSIFY_INFORMATIONAL_PREFIX.test(m) &&
    !RE_CLASSIFY_INFORMATIONAL_DENY.test(m)
  ) {
    return "informational";
  }

  if (
    RE_CLASSIFY_DIAGNOSTIC.test(m) ||
    (RE_CLASSIFY_DIAGNOSTIC_AND_FOLLOW.test(m) && m.length > 60)
  ) {
    return "diagnostic";
  }

  if (RE_CLASSIFY_HISTORICAL.test(m)) return "historical";
  if (RE_CLASSIFY_PRODUCTION.test(m)) return "production";
  if (RE_CLASSIFY_CURRENT.test(m)) return "current";
  if (hasSecondQuestionMark(m)) return "diagnostic";

  return "current";
}

const QUERY_CLASS_LABELS = [
  "informational",
  "all_tags",
  "current",
  "historical",
  "diagnostic",
  "production"
] as const satisfies readonly QueryClass[];

const QUERY_CLASSIFIER_SYSTEM = `You are a routing assistant for a nonwoven lamination machine (lamination-01). Each user message must map to exactly ONE JSON field "queryClass".

## Your job (keep it simple)
Read the message once, then pick the single best label using the rules below. Output JSON only: {"queryClass":"<label>"}.

## Labels — what each one means

**informational**
- The user wants definitions, theory, or general "how does lamination work" style answers.
- They are NOT asking for live numbers, alerts, tag values, production totals, or a specific past incident on THIS machine.
- If they mention "this machine" / "our line" / "right now" / "current" / alerts / RPM / tension → NOT informational.

**all_tags**
- They want a broad dump: "all tags", "every sensor", "list all live values", "complete readings", "show everything".
- Not the same as asking for one or two specific tags.

**diagnostic**
- Root cause, correlation, "why did X happen", "what caused", "relationship between A and B".
- Multiple distinct asks in one message (e.g. two question marks with different topics).
- Long troubleshooting messages (> ~60 chars) that combine faults, production, and recommendations.

**historical**
- Any explicit past window: dates, "yesterday", "last shift", "last hour", "between … and …", "when we tripped", "what happened at 14:30".
- If they want data for a past time range, choose historical even if they also mention production.

**production**
- Throughput, meters, GSM, efficiency, "how much did we make", output counters — without a strong historical time window.
- If BOTH a clear past window AND production appear, prefer **historical** (they need time-series + alerts in context).

**current**
- Default when none of the above clearly wins: present status, "what is running now", live values for a few tags, "any open alerts" without a past date.
- "What is the issue", "what's going on", "any problems", "is something wrong" → **current** (live machine data), never informational.

## Tie-breakers (apply in order)
1) If text clearly asks for **every** tag → all_tags.
2) If a **past time or date** is explicit → historical (over production/current).
3) If they only want encyclopedia-style explanation with zero machine data → informational.
4) If they want **why / cause / correlate** or clearly **multi-part** troubleshooting → diagnostic.
5) If production/output/GSM/meters without a dated window → production.
6) Else → current.

## Mini examples (class → reason)
- "List every live tag" → all_tags
- "What is GSM in lamination?" → informational
- "What is our GSM right now on the line?" → current
- "Alerts on 12 May 2026" → historical
- "Why did production drop after the winder fault?" → diagnostic
- "How many meters today?" → production (if no explicit historical window) OR current if clearly "so far this run"
- "Is the extruder running?" → current
- "What is the issue going on?" → current
- "Anything wrong with the line?" → current`;

function parseQueryClassFromModelText(raw: string): QueryClass | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/m, "")
    .trim();
  const tryParse = (s: string): QueryClass | null => {
    try {
      const o = JSON.parse(s) as { queryClass?: unknown };
      const v = o.queryClass;
      if (typeof v !== "string") return null;
      const q = v.trim().toLowerCase();
      return (QUERY_CLASS_LABELS as readonly string[]).includes(q) ? (q as QueryClass) : null;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(trimmed);
  if (parsed) return parsed;
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) parsed = tryParse(brace[0]);
  return parsed;
}

async function classifyQueryWithGemini(msg: string, timeoutMs: number): Promise<QueryClass | null> {
  const key = config.geminiApiKey?.trim();
  if (!key) return null;
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: QUERY_CLASSIFIER_SYSTEM,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 128,
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          queryClass: {
            type: SchemaType.STRING,
            format: "enum",
            enum: [...QUERY_CLASS_LABELS]
          }
        },
        required: ["queryClass"]
      }
    }
  });
  const prompt = `Classify the following message:\n${JSON.stringify(msg.slice(0, 4000))}`;
  const result = await withTimeout(
    model.generateContent(prompt),
    timeoutMs + 250,
    "query_classifier_gemini"
  );
  const text = result.response.text();
  return parseQueryClassFromModelText(text);
}

async function classifyQueryWithBedrock(msg: string, timeoutMs: number): Promise<QueryClass | null> {
  const messages: Message[] = [
    { role: "user", content: [{ text: JSON.stringify(msg.slice(0, 4000)) }] }
  ];
  const response = await bedrockConverse({
    systemPrompt: `${QUERY_CLASSIFIER_SYSTEM}

Output format: a single JSON object only, no markdown:
{"queryClass":"informational|all_tags|current|historical|diagnostic|production"}`,
    messages,
    temperature: 0,
    timeoutMs
  });
  const text = extractBedrockText(response.output?.message?.content);
  return parseQueryClassFromModelText(text);
}

async function classifyQueryWithSmallModel(
  msg: string,
  logger: FastifyBaseLogger
): Promise<QueryClass> {
  if (!msg.trim()) return "current";
  console.log(`\x1b[35m[Agent Classifier]\x1b[0m Classifying query: "${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}"`);
  if (config.queryClassifierMode === "regex") {
    const res = classifyQueryWithRegex(msg);
    console.log(`\x1b[35m[Agent Classifier]\x1b[0m Mode: regex | Result: ${res}`);
    return res;
  }
  try {
    const timeoutMs = config.queryClassifierTimeoutMs;
    const fromModel =
      config.aiProvider === "gemini"
        ? await classifyQueryWithGemini(msg, timeoutMs)
        : await classifyQueryWithBedrock(msg, timeoutMs);
    if (fromModel) {
      logger.debug({ queryClass: fromModel, classifier: "model" }, "query_classified");
      console.log(`\x1b[35m[Agent Classifier]\x1b[0m Mode: model (${config.aiProvider}) | Result: ${fromModel}`);
      return fromModel;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "query_classifier_failed");
    console.error(`\x1b[31m[Agent Classifier]\x1b[0m Model classification failed: ${err}`);
  }
  const fallback = classifyQueryWithRegex(msg);
  logger.debug({ queryClass: fallback, classifier: "regex_fallback" }, "query_classified");
  console.log(`\x1b[35m[Agent Classifier]\x1b[0m Mode: regex_fallback | Result: ${fallback}`);
  return fallback;
}

// ─── Query decomposer ─────────────────────────────────────────────────────────
// For complex/diagnostic queries, generates human-readable sub-question labels
// that map to tool steps. This makes the trace readable and helps the LLM.

type SubQuery = {
  question: string;
  tool: string;
  args: Record<string, unknown>;
};

/** Regex-only fallback when planner mode is regex or Bedrock decomposition fails. */
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
      { question: "Were there tension anomalies?", tool: "get_tag_history", args: { tag: "WINDER_TENSION_PCT" } },
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

/** Tools the diagnostic decomposer may emit (subset of chat tools; no acknowledge / chat sessions). */
const DECOMPOSER_ALLOWED_TOOLS = [
  "get_live_tag_values",
  "get_all_live_tags",
  "get_tag_history",
  "get_active_alerts",
  "get_alert_history",
  "get_tag_definition",
  "get_production_summary",
  "search_tags",
  "get_machine_status",
  "get_tag_comparison"
] as const;

type DecomposerTool = (typeof DECOMPOSER_ALLOWED_TOOLS)[number];

function isDecomposerTool(name: string): name is DecomposerTool {
  return (DECOMPOSER_ALLOWED_TOOLS as readonly string[]).includes(name);
}

const QUERY_DECOMPOSER_SYSTEM = `You run on AWS Bedrock. Your job is to design a **multi-step reasoning plan** for one user message about nonwoven lamination machine **lamination-01**.

The downstream agent will execute your steps in order, then **synthesize** a single answer. Each step must move the investigation forward: new evidence, a refined hypothesis, or a cross-check—not redundant reads.

---

## Reasoning contract (follow mentally, then encode as steps)

1. **Frame** — What is the user really asking (symptom, window, subsystem, comparison)? What would falsify a wrong guess?
2. **Anchor in time or mode** — If the question is about the past, anchor with \`from\`/\`to\` (ISO +05:30). If "now" or "what's wrong", use \`get_machine_status\` then \`get_active_alerts\` (status=open); avoid \`get_alert_history\` with 24h. For undated "today", use IST midnight → now, not 24h.
3. **Evidence chain** — Order steps so later steps **depend** on earlier context: e.g. resolve ambiguous names (\`search_tags\`) before \`get_tag_definition\` / \`get_tag_history\`; load alerts in the window before pulling trends that explain them.
4. **Narrow** — Prefer a few **high-signal** tags over \`get_all_live_tags\` unless the user asked for everything.
5. **Cross-check** — When comparing causes (speed vs tension vs fault), use \`get_tag_comparison\` or aligned \`get_tag_history\` with the **same** time window in \`args\`.
6. **Thresholds** — When "why did we trip" or limits matter, include \`get_tag_definition\` for the relevant slug **after** you know which tag (from message or \`search_tags\`).

---

## JSON output (strict)

Return **only** valid JSON (no markdown, no prose outside JSON):

{"steps":[{"question":"…","tool":"<exact tool name>","args":{}}]}

- **question** — One line that states the **reasoning purpose** of this step, not just the tool name. Start with a verb: "Establish whether…", "Load alerts to…", "Compare X vs Y over…", "Resolve tag name for…". This appears in the plan UI for operators.
- **tool** — Must be exactly one of: ${DECOMPOSER_ALLOWED_TOOLS.join(", ")}
- **args** — Valid for that tool; use {} only when all parameters are optional. Do not invent \`machineId\` unless the user supplied one.

---

## Step count and flow

- Emit **4–8** steps (aim for **5–6**). Too few skips reasoning; too many adds noise.
- **First step** should establish context (time scope, live snapshot, or broad alert/production picture) as the question demands.
- **Last step** should supply evidence that **directly supports** answering the user's main "why" or "what happened" (e.g. trend or definition), not a generic duplicate of step 1.

---

## Tool discipline (must satisfy)

- \`get_tag_history\` — always include \`"tag"\` (slug or name). Include \`from\`/\`to\` when not purely "live".
- \`get_tag_definition\` — always include \`"tag"\`.
- \`get_live_tag_values\` — \`"tags"\` must be a non-empty array of strings.
- \`get_tag_comparison\` — \`"tags"\` must have **at least two** entries; align time window with the rest of the plan.
- Do **not** use tools outside the allowed list (no acknowledge, no chat sessions).

---

## Domain shortcuts (when the message fits)

Use these slugs when they clearly match the scenario (still justify in **question**):

- Speed / run state: MASTER_SPEED_PCT, EXTRUDER_RPM  
- Tension: WINDER_TENSION_PCT  
- Safety / stop: EMG_STOP  
- Fault bits: EXTRUDER_FAULT  
- Production counters: RUNNING_METER, GSM_ENTRY  

If the user names something fuzzy, **search_tags** first, then history/definition on the resolved slug.

---

## Multi-step reasoning examples (shape, not copy-paste)

- **"Why production dropped after noon"** — Narrow window in args → alert history → production summary → speed/tension trends → optional tag_definition on the faulted channel.  
- **"Is winder fault related to tension spike"** — alerts → comparison or paired histories with identical \`from\`/\`to\` → definition for thresholds.

Your output is only the JSON \`steps\` array wrapper as specified above.`;

function parseDecomposerPayload(raw: string): SubQuery[] | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/m, "")
    .trim();
  const tryParse = (s: string): SubQuery[] | null => {
    try {
      const o = JSON.parse(s) as { steps?: unknown };
      if (!Array.isArray(o.steps)) return null;
      const out: SubQuery[] = [];
      for (const item of o.steps) {
        if (!item || typeof item !== "object") continue;
        const row = item as { question?: unknown; tool?: unknown; args?: unknown };
        if (typeof row.question !== "string" || typeof row.tool !== "string") continue;
        const tool = row.tool.trim();
        if (!isDecomposerTool(tool)) continue;
        const args =
          row.args && typeof row.args === "object" && !Array.isArray(row.args)
            ? (row.args as Record<string, unknown>)
            : {};
        out.push({ question: row.question.trim(), tool, args });
      }
      if (out.length < 1) return null;
      return out.slice(0, 10);
    } catch {
      return null;
    }
  };
  let parsed = tryParse(trimmed);
  if (parsed) return parsed;
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) parsed = tryParse(brace[0]);
  return parsed;
}

/** Diagnostic plan steps: always Bedrock JSON (see QUERY_DECOMPOSER_SYSTEM). Regex fallback: decomposeComplexQuery. */
async function decomposeComplexQueryWithBedrock(
  msg: string,
  timeoutMs: number,
): Promise<SubQuery[] | null> {
  const messages: Message[] = [
    { role: "user", content: [{ text: JSON.stringify(msg.slice(0, 6000)) }] },
  ];
  const response = await bedrockConverse({
    systemPrompt: `${QUERY_DECOMPOSER_SYSTEM}

Return only valid JSON: {"steps":[...]} — no markdown, no commentary.`,
    messages,
    modelId: config.bedrockModelId,
    temperature: 0.1,
    timeoutMs,
  });
  const text = extractBedrockText(response.output?.message?.content);
  return parseDecomposerPayload(text);
}

async function resolveDiagnosticSubQueries(
  userMessage: string,
  logger: FastifyBaseLogger,
): Promise<SubQuery[]> {
  console.log(`\x1b[36m[Agent Decomposer]\x1b[0m Resolving diagnostic sub-queries for complex request...`);
  if (config.queryClassifierMode === "regex") {
    const res = decomposeComplexQuery(userMessage);
    console.log(`\x1b[36m[Agent Decomposer]\x1b[0m Mode: regex | Steps resolved:`, res.map(r => r.question));
    return res;
  }
  try {
    const timeoutMs = config.queryDecomposerTimeoutMs;
    const fromModel = await decomposeComplexQueryWithBedrock(userMessage, timeoutMs);
    if (fromModel?.length) {
      logger.debug(
        { stepCount: fromModel.length, decomposer: "bedrock" },
        "query_decomposed",
      );
      console.log(`\x1b[36m[Agent Decomposer]\x1b[0m Mode: bedrock | Steps resolved:`, fromModel.map(r => r.question));
      return fromModel;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "query_decomposer_failed");
    console.error(`\x1b[31m[Agent Decomposer]\x1b[0m Bedrock decomposition failed: ${err}`);
  }
  const fallback = decomposeComplexQuery(userMessage);
  logger.debug(
    { stepCount: fallback.length, decomposer: "regex_fallback" },
    "query_decomposed",
  );
  console.log(`\x1b[36m[Agent Decomposer]\x1b[0m Mode: regex_fallback | Steps resolved:`, fallback.map(r => r.question));
  return fallback;
}

// ─── Agent planner ────────────────────────────────────────────────────────────
// Classifies query (small LLM by default) → builds plan → injects runtime context
// into the system prompt. Tool calls are still chosen by the main model, with
// guardrails (e.g. today's alert window) applied at execution time.

async function buildAgentPlan(
  userMessage: string,
  logger: FastifyBaseLogger,
): Promise<{ plan: AgentPlan; queryClass: QueryClass }> {
  console.log(`\x1b[34m[Agent Planner]\x1b[0m Building operational plan for: "${userMessage}"`);
  const queryClass = await classifyQueryWithSmallModel(userMessage, logger);

  if (queryClass === "informational") {
    const result = {
      queryClass,
      plan: {
        intent: "Informational — answerable from knowledge, no tools needed",
        requiresTools: false,
        steps: [{ id: "s1", description: "Answer from knowledge", status: "pending" as const }]
      }
    };
    console.log(`\x1b[34m[Agent Planner]\x1b[0m Plan generated for informational query (No tools needed).`);
    return result;
  }

  const steps: PlanStep[] = [];
  let id = 0;
  const push = (tool: string, description: string) =>
    steps.push({ id: `s${++id}`, tool, description, status: "pending" });

  if (queryClass === "all_tags") {
    push("get_all_live_tags", "Fetch ALL live tag values grouped by subsystem");
  } else if (queryClass === "diagnostic") {
    const subQueries = await resolveDiagnosticSubQueries(userMessage, logger);
    for (const sq of subQueries) {
      push(sq.tool, sq.question);
    }
    steps.push({
      id: `s${++id}`,
      description: "Synthesize root cause and operator actions from evidence",
      status: "pending"
    });
  } else if (queryClass === "historical") {
    push("get_alert_history", "Load alerts in the requested time window");
    push("get_tag_history", "Load primary tag values in the window (speed, meter, RPM)");
  } else if (queryClass === "production") {
    push("get_production_summary", "Fetch production metrics for the relevant window");
    if (queryClass === "production" && userNamesExplicitPastWindow(userMessage)) {
      push("get_tag_history", "Load speed/meter trends for the stated past window");
    }
  } else {
    // current — fixed live-data path; model chooses extra tags if needed
    push("get_machine_status", "Establish live machine health and subsystem state");
    push("get_active_alerts", "List open alerts only (status=open)");
  }

  const plan = {
    intent: `[${queryClass.toUpperCase()}] ${userMessage.slice(0, 100)}`,
    requiresTools: true,
    steps
  };

  console.log(`\x1b[34m[Agent Planner]\x1b[0m Generated Plan [${queryClass.toUpperCase()}]:`);
  for (const step of plan.steps) {
    console.log(`  - \x1b[33m${step.id}\x1b[0m: [${step.tool || 'NO TOOL'}] ${step.description}`);
  }

  return {
    queryClass,
    plan
  };
}

/** Scope alert history to today IST when the user did not ask for a past window. */
function normalizeToolArgsForQuery(
  name: string,
  args: Record<string, unknown>,
  ctx: { queryClass: QueryClass; userMessage: string }
): Record<string, unknown> {
  if (name !== "get_alert_history") return args;
  if (ctx.queryClass === "historical" || userNamesExplicitPastWindow(ctx.userMessage)) {
    return args;
  }

  const from = args.from;
  const fromStr = typeof from === "string" ? from.trim().toLowerCase() : "";
  const vagueDefault =
    !fromStr || fromStr === "24h" || fromStr === "8h" || fromStr === "7d" || fromStr === "1d";

  if (!vagueDefault) return args;

  const { fromIso, toIso } = getIstTodayWindow();
  return {
    ...args,
    from: fromIso,
    to: typeof args.to === "string" && args.to.trim() ? args.to : toIso
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
  queryClass: QueryClass;
  userMessage: string;
}): Promise<{ functionResponse: { name: string; response: { result?: unknown; error?: string } } }> {
  const { name, machineId, sessionId, logger, cache, toolSteps, toolsUsed, queryClass, userMessage } =
    opts;
  const args = normalizeToolArgsForQuery(name, opts.args, { queryClass, userMessage });
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
    console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[36m[CACHED]\x1b[0m Tool "${name}" using cached result. Args:`, args);
    return { functionResponse: { name, response: { result: cache.get(cacheKey) } } };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[33m[Attempt ${attempt}/${MAX_RETRIES}]\x1b[0m Invoking "${name}" with args:`, args);
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
      console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[32m[SUCCESS]\x1b[0m Tool "${name}" succeeded in ${durationMs}ms.`);
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
        console.error(`\x1b[31m[Agent Tool]\x1b[0m \x1b[31m[FAILED]\x1b[0m Tool "${name}" failed permanently after ${attempt} attempts in ${durationMs}ms. Error: ${lastError}`);
        return { functionResponse: { name, response: { error: lastError } } };
      }

      console.warn(`\x1b[33m[Agent Tool]\x1b[0m \x1b[33m[RETRYING]\x1b[0m Tool "${name}" failed on attempt ${attempt} in ${durationMs}ms. Retrying... Error: ${lastError}`);
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
  console.log(`\x1b[34m[Agent Reflection]\x1b[0m Analyzing operational health of ${toolSteps.length} step(s)...`);
  const failed = toolSteps.filter(s => s.status === "error" || s.status === "timeout");
  const succeeded = toolSteps.filter(s => s.status === "success");
  const total = toolSteps.filter(s => s.status !== "skipped").length;

  if (!failed.length) {
    const res = { note: "", needsFollowUp: false, severity: "ok" as const };
    console.log(`\x1b[34m[Agent Reflection]\x1b[0m \x1b[32m[OK]\x1b[0m All operational tool calls executed successfully.`);
    return res;
  }

  const allFailed = succeeded.length === 0 && failed.length > 0;
  const criticalTools = ["get_machine_status", "get_active_alerts", "get_all_live_tags", "get_alert_history"];
  const criticalFailed = failed.some(s => criticalTools.includes(s.tool));
  const failRate = failed.length / Math.max(1, total);

  if (allFailed) {
    const res = {
      note: `⚠ All ${failed.length} tool(s) failed — no live data available. Answer is based on prior context only.`,
      needsFollowUp: false,
      severity: "failed" as const
    };
    console.warn(`\x1b[31m[Agent Reflection]\x1b[0m \x1b[31m[FAILED]\x1b[0m All tool calls failed! Severity: failed. Note: ${res.note}`);
    return res;
  }

  if (criticalFailed || failRate >= 0.5) {
    const names = failed.map(s => s.tool).join(", ");
    const res = {
      note: `⚠ Critical data unavailable (${names}). Answer may be incomplete — verify with a follow-up query.`,
      needsFollowUp: true,
      severity: "degraded" as const
    };
    console.warn(`\x1b[33m[Agent Reflection]\x1b[0m \x1b[33m[DEGRADED]\x1b[0m Critical tool(s) failed: [${names}]. Severity: degraded. Note: ${res.note}`);
    return res;
  }

  const res = {
    note: `${failed.length} of ${total} tool(s) failed and were skipped. Partial data used.`,
    needsFollowUp: false,
    severity: "partial" as const
  };
  console.log(`\x1b[33m[Agent Reflection]\x1b[0m \x1b[33m[PARTIAL]\x1b[0m Some non-critical tool calls failed. Severity: partial. Note: ${res.note}`);
  return res;
}

// ─── Chart Helpers ────────────────────────────────────────────────────────────

/** Detect whether the user's query implies they want a trend/chart.
 *  Takes toolSteps to verify numeric data was actually returned before
 *  generating a chart — prevents boolean-only charts (EMG_STOP, faults etc.).
 */
function shouldGenerateChart(userMessage: string, toolSteps: AgentToolStep[]): boolean {
  const m = userMessage.toLowerCase();
  const wantsChart =
    m.includes("trend") ||
    m.includes("history") ||
    m.includes("over time") ||
    m.includes("graph") ||
    m.includes("chart") ||
    m.includes("plot") ||
    m.includes("past") ||
    m.includes("compare");

  if (!wantsChart) return false;

  // Require at least one history or comparison step with real numeric (non-boolean) data
  const chartSteps = toolSteps.filter(
    (s) => (s.tool === "get_tag_history" || s.tool === "get_tag_comparison") && s.status === "success"
  );
  
  const hasNumericData = chartSteps.some((s) => {
    // For comparison, samples are inside each series item
    const seriesArr: any[] = s.tool === "get_tag_comparison" 
      ? (s.result?.series ?? []) 
      : [{ samples: s.result?.samples ?? [] }];

    return seriesArr.some(series => {
      const samples: any[] = series.samples ?? [];
      return (
        samples.length >= 2 &&
        samples.some((d: any) => {
          const v = Number(d.value ?? d.val ?? NaN);
          return !isNaN(v) && v !== 0 && v !== 1;
        })
      );
    });
  });

  return hasNumericData;
}

/** Infer a display unit from a tag slug or name. */
function inferUnit(tag: string): string {
  const t = tag.toUpperCase();
  // Raw analog voltage — never label as engineering unit
  if (t.includes("_VOL") || t.endsWith("_V")) return "V";
  // Raw loadcell counts — not %
  if (
    t.includes("UW_PV") || t.includes("SUW_PV") ||
    t.includes("UW_SET") || t.includes("SUW_SET")
  ) return "counts";
  if (t.includes("PCT") || t.includes("PERCENT") || t.includes("EFFICIENCY")) return "%";
  if (t.includes("MPM")) return "m/min";
  if (t.includes("RPM")) return "RPM";
  if (t.includes("GSM")) return "g/m²";
  if (t.includes("TEMP") || t.includes("°C")) return "°C";
  if (t.includes("TENSION_PCT") || t.includes("WINDER_TENSION")) return "%";
  if (t.includes("METER") && !t.includes("MPM")) return "m";
  if (t.includes("AMP")) return "A";
  return "";
}

/**
 * Compute actual line speed in m/min from speed % and max speed reference.
 * Use when both MASTER_SPEED_PCT and MACHINE_MAX_LINE_SPEED are available.
 * Example output: "Line speed is 82% = 98.4 m/min (max: 120 m/min, headroom: 21.6 m/min)"
 */
export function computeActualSpeed(
  masterSpeedPct: number,
  machineMaxSpeed: number
): number {
  return Math.round((masterSpeedPct / 100) * machineMaxSpeed * 10) / 10;
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
  const result: { x: string; y: number }[] = [data[0]!];
  for (let i = 1; i < data.length - 1; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length - 1));
    const avgY = bucket.reduce((s, p) => s + p.y, 0) / bucket.length;
    // Pick the point closest to bucket midpoint for representative timestamp
    const mid = Math.floor(bucket.length / 2);
    const midPoint = bucket[mid];
    if (midPoint) result.push({ x: midPoint.x, y: Math.round(avgY * 100) / 100 });
  }
  result.push(data[data.length - 1]!);
  return result;
}

// ─── Chart Generator ──────────────────────────────────────────────────────────
// Scans tool steps for tag history and converts it to frontend-ready chart data.
// Groups tags with the same time window into a single comparative chart.

function generateChartsFromHistory(toolSteps: AgentToolStep[]): AgentChart[] {
  console.log(`\x1b[36m[Agent Charts]\x1b[0m Starting chart generation process from operational history...`);
  const charts: AgentChart[] = [];

  const historySteps = toolSteps.filter(
    (s) => s.tool === "get_tag_history" && s.status === "success" && s.result
  );

  if (historySteps.length === 0) {
    console.log(`\x1b[36m[Agent Charts]\x1b[0m No successful tag history steps to chart.`);
    return charts;
  }

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
      ? `Trend: ${seriesList[0]!.displayName}`
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

  console.log(`\x1b[36m[Agent Charts]\x1b[0m Generated ${charts.length} trend chart(s):`, charts.map(c => c.title));
  return charts;
}

// ─── Public entry point ───────────────────────────────────────────────────────

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



// ─── Bedrock Pipeline ─────────────────────────────────────────────────────────

async function runBedrockPipeline(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  plan: AgentPlan;
  queryClass: QueryClass;
}): Promise<Omit<AgentResult, "trace">> {
  const toolsUsed: string[] = [];
  const toolSteps: AgentToolStep[] = [];
  const cache = new Map<string, unknown>();
  const messages = toBedrockMessages(args.history, args.userMessage);
  const tools = bedrockToolsFromDeclarations(ALL_TOOL_DECLARATIONS);
  let totalCalls = 0;

  console.log(`\x1b[35m[Agent Pipeline]\x1b[0m Starting Bedrock Reasoning Pipeline with provider configuration:`, config.aiProvider);

  for (let round = 0; round < 8; round++) {
    // Round 0 with requiresTools=true: force at least one tool call using toolChoice: any.
    // This prevents Claude from returning stopReason: end_turn with empty content
    // instead of actually calling tools (a known Bedrock silent-failure pattern).
    const toolChoice = (round === 0 && args.plan.requiresTools)
      ? { any: {} }
      : { auto: {} };

    console.log(`\x1b[35m[Agent Pipeline] [Round ${round}]\x1b[0m Querying model: ${config.bedrockModelId}. ToolChoice:`, toolChoice);
    const roundStart = Date.now();
    
    const response = await withTimeout(
      bedrockConverse({
        systemPrompt: buildSystemPrompt(args.plan, args.queryClass, args.userMessage),
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

    const roundDuration = Date.now() - roundStart;
    const stopReason = response.stopReason;
    const message = response.output?.message;
    const content = message?.content ?? [];
    const toolUses = extractToolUses(content);
    const textReply = extractBedrockText(content);

    args.logger.debug(
      { round, stopReason, toolUses: toolUses.length, hasText: !!textReply, contentBlocks: content.length, sessionId: args.sessionId },
      "bedrock_round"
    );
    console.log(`\x1b[35m[Agent Pipeline] [Round ${round}]\x1b[0m Model responded in ${roundDuration}ms. StopReason: "${stopReason}" | ContentBlocks: ${content.length} | ToolUses: ${toolUses.length} | TextReplyLength: ${textReply ? textReply.length : 0}`);

    // Guard: empty or error response
    // Happens when Bedrock throttles, hits max_tokens, or the model returns nothing.
    if (!content.length || (!toolUses.length && !textReply)) {
      args.logger.warn(
        { round, stopReason, sessionId: args.sessionId, modelId: config.bedrockModelId },
        "bedrock_empty_content"
      );
      console.warn(`\x1b[33m[Agent Pipeline] [Round ${round}]\x1b[0m Empty or invalid content returned from model.`);

      // Round 0, no tools executed yet: retry once as plain text (no toolConfig)
      // to guarantee at least a knowledge-based answer from the system prompt.
      if (round === 0 && totalCalls === 0) {
        args.logger.warn({ sessionId: args.sessionId }, "bedrock_round0_retrying_text_only");
        console.warn(`\x1b[33m[Agent Pipeline] [Round ${round}]\x1b[0m Round 0, no tool calls yet. Retrying text-only fallback...`);
        try {
          const fallbackResp = await withTimeout(
            bedrockConverse({
              systemPrompt: buildSystemPrompt(args.plan, args.queryClass, args.userMessage),
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
            console.log(`\x1b[32m[Agent Pipeline] [Round ${round}]\x1b[0m Successfully recovered via text-only fallback.`);
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
          console.error(`\x1b[31m[Agent Pipeline] [Round ${round}]\x1b[0m Text-only fallback retry failed: ${retryErr}`);
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
      console.log(`\x1b[32m[Agent Pipeline] [Round ${round}] [FINALIZE]\x1b[0m Reasoning pipeline complete. Final reply generated: "${textReply.slice(0, 100).replace(/\n/g, ' ')}${textReply.length > 100 ? '...' : ''}"`);
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
      console.warn(`\x1b[31m[Agent Pipeline] [Round ${round}]\x1b[0m Tool call limit cap reached (${MAX_TOOL_CALLS}). Terminating reasoning early.`);
      return {
        reply: extractBedrockText(content) || "Analysis stopped: maximum tool call limit reached.",
        toolsUsed,
        toolSteps
      };
    }

    if (message) messages.push(message);

    console.log(`\x1b[32m[Agent Pipeline] [Round ${round}]\x1b[0m Executing ${toolUses.length} tool call(s) sequentially...`);
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
          toolsUsed,
          queryClass: args.queryClass,
          userMessage: args.userMessage
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

  console.error(`\x1b[31m[Agent Pipeline]\x1b[0m Maximum reasoning rounds reached (8). Returning early.`);
  return {
    reply: "Analysis could not be completed: maximum reasoning rounds reached.",
    toolsUsed,
    toolSteps,
    charts: generateChartsFromHistory(toolSteps)
  };
}