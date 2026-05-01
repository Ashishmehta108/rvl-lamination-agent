import type { HandlerType } from "../handlers/chatHandler.js";

/**
 * Style rewriter — deterministic pass only.
 * No second LLM call. No risk of new hallucinations.
 *
 * Purpose: make approved fact-packet answers sound more natural and operator-friendly
 * WITHOUT inventing any new facts, numbers, diagnoses, or recommendations.
 *
 * Contract:
 * - Only rewrites tone/phrasing of content already present in approvedFactPacket
 * - Strips hollow closings, robotic phrases, and redundant hedges
 * - Applies handler-specific tone rules
 * - If the answer is already concise and clean, returns it unchanged (changed: false)
 */

export interface StyleRewriteInput {
  /** Locked fact content — the evidence the LLM was given. Numbers in here are allowed in output. */
  approvedFactPacket: string;
  /** Raw LLM answer after grounding guard passed. */
  rawLlmAnswer: string;
  /** Handler type used to select tone rules. */
  handler: HandlerType;
}

export interface StyleRewriteResult {
  rewritten: string;
  changed: boolean;
  reason: string;
}

// ─── Hollow closing patterns — always strip ───────────────────────────────────

const HOLLOW_CLOSING_PATTERNS = [
  /\blet me know if (you have|you need|there('s| is) anything)\b.*/gi,
  /\bfeel free to (ask|reach out)\b.*/gi,
  /\bif you (need|have) (any|more|further|additional) (questions?|help|information|clarification)\b.*/gi,
  /\bi('m| am) here (to help|if you need)\b.*/gi,
  /\bplease don't hesitate\b.*/gi,
  /\bhope (that|this) helps?\b.*/gi,
  /\bis there anything else\b.*/gi,
];

// ─── Robotic / over-formal phrase replacements ────────────────────────────────

const PHRASE_REPLACEMENTS: [RegExp, string][] = [
  [/\bI am unable to\b/gi, "I can't"],
  [/\bIt is important to note that\b/gi, "Note:"],
  [/\bPlease be advised that\b/gi, ""],
  [/\bAs per the data provided\b/gi, "Based on the data"],
  [/\bAt this point in time\b/gi, "Right now"],
  [/\bIn order to\b/gi, "To"],
  [/\bDue to the fact that\b/gi, "Because"],
  [/\bIt should be noted that\b/gi, ""],
  [/\bAs an AI(?: language model| assistant)?\b/gi, ""],
  [/\bI (must|need to) (inform|advise|mention) (you )?(that )?\b/gi, ""],
];

// ─── Handler-specific tone hints ──────────────────────────────────────────────

const HANDLER_TONE: Partial<Record<HandlerType, string>> = {
  alerts: "direct", // lead with the problem, no softening
  escalation: "direct",
  greeting: "warm",
  status: "confident",
  tags: "factual",
  stale_data: "cautious",
  no_context: "honest",
};

function stripHollowClosings(text: string): string {
  let result = text;
  for (const pattern of HOLLOW_CLOSING_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }
  return result;
}

function applyPhraseReplacements(text: string): string {
  let result = text;
  for (const [from, to] of PHRASE_REPLACEMENTS) {
    result = result.replace(from, to);
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")   // max 2 consecutive blank lines
    .replace(/[ \t]+$/gm, "")      // trailing spaces
    .trim();
}

/**
 * Main deterministic style pass.
 * Returns the rewritten answer and whether anything changed.
 */
export function applyStyleRewrite(input: StyleRewriteInput): StyleRewriteResult {
  const { rawLlmAnswer, handler } = input;

  let text = rawLlmAnswer;
  let changed = false;
  const reasons: string[] = [];

  // 1. Strip hollow closings
  const afterClosings = stripHollowClosings(text);
  if (afterClosings !== text) {
    changed = true;
    reasons.push("stripped_hollow_closing");
    text = afterClosings;
  }

  // 2. Apply phrase replacements
  const afterPhrases = applyPhraseReplacements(text);
  if (afterPhrases !== text) {
    changed = true;
    reasons.push("replaced_robotic_phrases");
    text = afterPhrases;
  }

  // 3. Normalize whitespace
  const afterWhitespace = normalizeWhitespace(text);
  if (afterWhitespace !== text) {
    changed = true;
    text = afterWhitespace;
  }

  // 4. Tone guard — for alert handlers, ensure answer doesn't start with soft openers
  const tone = HANDLER_TONE[handler];
  if (tone === "direct") {
    const softOpeners = /^(Sure|Certainly|Of course|Absolutely|Great|No problem)[,!.]\s*/i;
    const afterSoft = text.replace(softOpeners, "");
    if (afterSoft !== text) {
      changed = true;
      reasons.push("removed_soft_opener_for_alert_handler");
      text = afterSoft;
    }
  }

  return {
    rewritten: text,
    changed,
    reason: reasons.length > 0 ? reasons.join(";") : "no_changes_needed",
  };
}
