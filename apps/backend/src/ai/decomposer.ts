import type { FastifyBaseLogger } from "fastify";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config.js";
import {
  bedrockConverse,
  extractText as extractBedrockText
} from "./bedrock.js";
import type { SubQuery, DecomposerTool } from "./types.js";

/** Tools the diagnostic decomposer may emit (subset of chat tools; no acknowledge / chat sessions). */
export const DECOMPOSER_ALLOWED_TOOLS = [
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

export function isDecomposerTool(name: string): name is DecomposerTool {
  return (DECOMPOSER_ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** Regex-only fallback when planner mode is regex or Bedrock decomposition fails. */
export function decomposeComplexQuery(msg: string): SubQuery[] {
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

export const QUERY_DECOMPOSER_SYSTEM = `You run on AWS Bedrock. Your job is to design a **multi-step reasoning plan** for one user message about nonwoven lamination machine **lamination-01**.

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

export function parseDecomposerPayload(raw: string): SubQuery[] | null {
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
export async function decomposeComplexQueryWithBedrock(
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

export async function resolveDiagnosticSubQueries(
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
