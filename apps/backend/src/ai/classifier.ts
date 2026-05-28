import type { FastifyBaseLogger } from "fastify";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config.js";
import {
  bedrockConverse,
  extractText as extractBedrockText
} from "./bedrock.js";
import type { QueryClass } from "./types.js";
import { withTimeout } from "./executor.js";

/** Compiled once — avoids per-call RegExp parse and shares lastIndex-free .test() */
export const RE_CLASSIFY_ALL_TAGS =
  /\b(all tag|all live|all current|all sensor|all reading|all value|every tag|full tag|complete tag|list all|show all|all the tag|all the live|all the current|all the sensor)\b/;
export const RE_CLASSIFY_INFORMATIONAL_PREFIX =
  /^(what is|who is|how does|explain|define|tell me about|describe)\b/;
export const RE_CLASSIFY_INFORMATIONAL_DENY =
  /\b(current|live|now|status|alert|fault|running|value|reading|rpm|mpm|tension|meter|issue|problem|wrong|happening|going on|machine|line|plant|tripped|stopped)\b/;
export const RE_CLASSIFY_DIAGNOSTIC =
  /\b(why|cause|root cause|explain why|what caused|drop.*and|fault.*and|after.*fault|before.*alarm|correlat|relate|impact|effect on|led to)\b/;
export const RE_CLASSIFY_DIAGNOSTIC_AND_FOLLOW =
  /\b(and (what|how|should|recommend)\b)/;
export const RE_CLASSIFY_HISTORICAL =
  /\b(yesterday|last shift|last hour|last \d|on \d{1,2}|april|may|at \d{1,2}:\d{2}|between|from.*to|\d{4}-\d{2}-\d{2}|what happened|why did|dropped|stopped|tripped|went down)\b/;
export const RE_CLASSIFY_PRODUCTION =
  /\b(production|meter|gsm|efficiency|output|how many|how much produced)\b/;
export const RE_CLASSIFY_CURRENT =
  /\b(current|live|now|right now|status|is.*running|active alert|reading|value|issue|problem|wrong|going on|what's happening|happening now|any problem|something wrong)\b/;

export function hasSecondQuestionMark(s: string): boolean {
  const first = s.indexOf("?");
  return first !== -1 && s.indexOf("?", first + 1) !== -1;
}

export function classifyQueryWithRegex(msg: string): QueryClass {
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

export const QUERY_CLASS_LABELS = [
  "informational",
  "all_tags",
  "current",
  "historical",
  "diagnostic",
  "production"
] as const satisfies readonly QueryClass[];

export const QUERY_CLASSIFIER_SYSTEM = `You are a routing assistant for a nonwoven lamination machine (lamination-01). Each user message must map to exactly ONE JSON field "queryClass".

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

export function parseQueryClassFromModelText(raw: string): QueryClass | null {
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

export async function classifyQueryWithGemini(msg: string, timeoutMs: number): Promise<QueryClass | null> {
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

export async function classifyQueryWithBedrock(msg: string, timeoutMs: number): Promise<QueryClass | null> {
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

export async function classifyQueryWithSmallModel(
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
    const fromModel = await classifyQueryWithBedrock(msg, timeoutMs);
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
