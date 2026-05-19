/**
 * detectIntent.ts — Hybrid Intent Detection for Lamination Machine AI Assistant
 *
 * Architecture:
 *   Layer 1 — Rule-Based (fast, deterministic): greeting, escalation, unsafe, out_of_scope
 *   Layer 2 — Fuse.js Fuzzy Matching: alerts, tags, status, production
 *   Layer 3 — Confidence Arbitration: trust fuzzy if score is strong, else fallback to rules
 *   Layer 4 — Multi-intent resolution: counts confirmed intents only
 *
 * Why hybrid?
 *   - Pure regex is brittle on short/noisy industrial queries ("rpm high?", "show all")
 *   - Pure ML is overkill, non-deterministic, and GPU-dependent
 *   - Fuse.js gives semantic proximity matching on a CLOSED domain vocabulary
 *     without any training or inference cost
 */

import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedInput {
  clean: string;         // lowercased, stripped text
  tokens: string[];      // whitespace-split tokens
  wordCount: number;
  isVeryShort: boolean;
}

export interface IntentSignals {
  // Main intents
  wantsAlerts: boolean;
  wantsTags: boolean;
  wantsStatus: boolean;
  wantsReports: boolean;
  wantsProduction: boolean;

  // Meta
  isGreeting: boolean;
  isCorrection: boolean;
  isEscalation: boolean;
  isMultiIntent: boolean;
  isOutOfScope: boolean;
  isAmbiguous: boolean;
  isRepeat: boolean;
  isEmotional: boolean;
  isSarcasm: boolean;
  wantsGuess: boolean;
  wantsCertainty: boolean;
  wantsDifferentPersona: boolean;

  // Extracted entities
  mentionedSlugs: string[];

  // Debug / observability (optional but invaluable in production)
  _debug?: IntentDebugInfo;
}

/**
 * Debug payload attached to every result in non-production mode.
 * Log this to your observability pipeline to trace misclassifications.
 */
export interface IntentDebugInfo {
  fuzzyScores: Record<string, number>;   // raw Fuse scores per intent
  fuzzyHits: Record<string, boolean>;    // did fuzzy pass threshold?
  ruleHits: Record<string, boolean>;     // did rule-based pass?
  finalDecisions: Record<string, boolean>; // merged result
  strategy: Record<string, "fuzzy" | "rule" | "both" | "none">;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN VOCABULARY — The Core of the Fuzzy Layer
//
// WHY: Fuse.js matches the user's query against these phrase lists.
//      Keeping vocabulary small and domain-specific is what makes this
//      approach BETTER than generic embeddings for industrial systems.
//      Add/remove phrases here to tune without touching logic.
// ─────────────────────────────────────────────────────────────────────────────

interface IntentVocab {
  intent: string;
  phrases: string[];
}

const INTENT_VOCABULARY: IntentVocab[] = [
  {
    intent: "alerts",
    phrases: [
      "alert", "alerts", "warning", "warnings", "critical", "fault", "faults",
      "alarm", "alarms", "fired", "active alarm", "active fault", "triggered alarm",
      "any alarms", "check alerts", "show alerts", "machine fault", "error state",
      "what went wrong", "problems", "issues", "failures", "abnormal",
    ],
  },
  {
    intent: "tags",
    phrases: [
      "tag value", "sensor reading", "current reading", "live reading",
      "rpm", "speed", "tension", "gsm", "gram weight", "mpm", "meters per minute",
      "ampere", "amps", "voltage", "pressure", "temperature",
      "what is rpm", "show rpm", "current speed", "live data",
      "sensor data", "tag list", "readings", "machine readings",
      "what is tension", "check tension", "current values", "show values",
      "what is the value", "show me the readings",
    ],
  },
  {
    intent: "status",
    phrases: [
      "machine status", "current status", "how is machine", "is machine running",
      "machine health", "overall state", "system state", "machine overview",
      "what is happening", "what is going on", "machine condition",
      "running or stopped", "operational status", "uptime", "downtime",
      "right now", "current situation", "is it running", "machine up",
    ],
  },
  {
    intent: "production",
    phrases: [
      "production output", "meters produced", "daily production", "weekly output",
      "monthly production", "throughput", "efficiency", "production rate",
      "how much produced", "output today", "production summary", "shift output",
      "meters run", "total meters", "production metrics", "job output",
      "production numbers", "how many meters", "what was produced",
    ],
  },
  {
    intent: "reports",
    phrases: [
      "report", "run report", "last report", "performance report",
      "generate report", "summary report", "metrics report",
      "show report", "performance summary", "shift report",
      "production report", "maintenance report", "historical data",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// FUSE.JS SETUP
//
// WHY these options:
//   - threshold 0.35: permissive enough to catch typos ("aler", "prodcution")
//     but tight enough to reject "show" or "all" matching "alerts"
//   - minMatchCharLength 3: prevents single chars from triggering matches
//   - distance 80: allows matches anywhere in phrase, not just prefix
//   - useExtendedSearch: false — we don't need complex query syntax
//   - includeScore: true — we need raw scores for confidence arbitration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fuse score is inverted: 0.0 = perfect match, 1.0 = no match.
 * We convert to a 0–1 confidence where 1.0 = best.
 */
const FUSE_OPTIONS: IFuseOptions<{ phrase: string; intent: string }> = {
  keys: ["phrase"],
  threshold: 0.35,          // lower = stricter. 0.35 catches typos without false positives
  distance: 80,             // how far from start of string to look for match
  minMatchCharLength: 3,    // "go" won't match "gsm", "ai" won't match "alarm"
  includeScore: true,
  shouldSort: true,
};

// Flatten vocabulary into a single searchable list
const FUSE_CORPUS = INTENT_VOCABULARY.flatMap(({ intent, phrases }) =>
  phrases.map((phrase) => ({ phrase, intent }))
);

// Single shared Fuse instance — instantiate once at module load (zero runtime cost)
const fuse = new Fuse(FUSE_CORPUS, FUSE_OPTIONS);

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE THRESHOLDS
//
// WHY separate thresholds:
//   STRONG_FUZZY_THRESHOLD — if fuzzy is this confident, trust it alone
//   WEAK_FUZZY_THRESHOLD   — below this, ignore fuzzy entirely
//   Between them → require rule confirmation (belt-and-suspenders)
// ─────────────────────────────────────────────────────────────────────────────

const STRONG_FUZZY_THRESHOLD = 0.72;  // fuzzy alone is sufficient
const WEAK_FUZZY_THRESHOLD   = 0.40;  // below this, fuzzy is noise

// ─────────────────────────────────────────────────────────────────────────────
// RULE-BASED FALLBACK PATTERNS (narrow, non-generic)
//
// WHY rewritten:
//   Old regexes matched "show", "all", "what is" as tag triggers.
//   These new patterns only fire on DOMAIN-SPECIFIC terms, not generic verbs.
//   Generic query verbs (show, list, all, what is) are REMOVED from triggers.
// ─────────────────────────────────────────────────────────────────────────────

const RULE_PATTERNS: Record<string, RegExp> = {
  alerts:     /\b(alert|alerts|warning|warnings|critical|fault|faults|alarm|alarms|fired|triggered)\b/,
  tags:       /\b(rpm|amp|amps|mpm|tension|gsm|gram|voltage|pressure|temperature|sensor\s+reading|tag\s+value|live\s+data)\b/,
  status:     /\b(machine\s+status|system\s+state|machine\s+health|is\s+(it|machine)\s+running|operational\s+status|uptime|downtime)\b/,
  production: /\b(production|meters\s+produced|daily\s+output|weekly\s+output|throughput|efficiency|shift\s+output|total\s+meters)\b/,
  reports:    /\b(report|reports|performance\s+summary|shift\s+report|run\s+report)\b/,
};

// ─────────────────────────────────────────────────────────────────────────────
// RULE-BASED ONLY PATTERNS (Layer 1 — never replaced by fuzzy)
//
// WHY kept as pure rules:
//   These are categorical signals with high-precision patterns.
//   Fuzzy matching would add noise without benefit here.
// ─────────────────────────────────────────────────────────────────────────────

const GREETING_PATTERN    = /^(hi|hello|hey|thanks|thank\s+you|good\s+(morning|evening|afternoon)|howdy|sup|yo)\b/;
const CORRECTION_PATTERN  = /\b(wrong|incorrect|that'?s\s+not|actually|no[,\s]|mistake|you\s+said|but\s+you|it\s+(should|is)\s+actually)\b/;
const EMOTIONAL_PATTERN   = /\b(frustrated|angry|worried|scared|confused|stressed|panic|urgent|asap|immediately)\b/;
const SARCASM_PATTERN     = /\b(great\s+job|wow\s+amazing|very\s+helpful|thanks\s+for\s+nothing|brilliant|genius)\b/;
const SARCASM_PUNCT       = /(!{2,}|\?{2,})/;
const GUESS_PATTERN       = /\b(guess|estimate|probably|maybe|roughly|approximately|around|ballpark)\b/;
const CERTAINTY_PATTERN   = /\b(definitely|exactly|100%|certain|guarantee|for\s+sure|absolute)\b/;
const PERSONA_PATTERN     = /\b(be\s+more\s+(casual|formal|friendly)|sound\s+like|talk\s+like|respond\s+as)\b/;

// These should be imported from your existing modules
declare const ESCALATION_PATTERNS: RegExp[];
declare const OUT_OF_SCOPE_PATTERNS: RegExp[];
declare const KNOWN_SLUGS: Set<string>;
declare function normalizeForRepeatCheck(input: string): string;

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY INTENT SCORER
//
// Runs the user query (and individual tokens) through Fuse.
// Returns a confidence score (0–1) per intent.
//
// WHY query both full string AND tokens:
//   "rpm high?" → full query may not match well, but token "rpm" matches tags perfectly
//   "show alerts and production" → full query catches "alerts" and "production"
// ─────────────────────────────────────────────────────────────────────────────

function scoreFuzzyIntents(
  query: string,
  tokens: string[]
): Record<string, number> {
  const scores: Record<string, number> = {
    alerts: 0, tags: 0, status: 0, production: 0, reports: 0,
  };

  // Search full query
  const queryResults = fuse.search(query);
  for (const result of queryResults) {
    const intent = result.item.intent;
    // Fuse score: 0=perfect, 1=no match → invert to confidence
    const confidence = 1 - (result.score ?? 1);
    if (confidence > (scores[intent] ?? 0)) {
      scores[intent] = confidence;
    }
  }

  // Search individual tokens — critical for short queries like "rpm?" or "tension"
  for (const token of tokens) {
    if (token.length < 3) continue; // skip noise tokens
    const tokenResults = fuse.search(token);
    for (const result of tokenResults) {
      const intent = result.item.intent;
      const confidence = 1 - (result.score ?? 1);
      // Token matches get a slight penalty (0.9x) vs full-query matches
      // WHY: a single token is weaker signal than a full phrase match
      const adjustedConfidence = confidence * 0.9;
      if (adjustedConfidence > (scores[intent] ?? 0)) {
        scores[intent] = adjustedConfidence;
      }
    }
  }

  return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE ARBITRATION
//
// Merges fuzzy scores + rule hits into a final boolean per intent.
//
// Decision matrix:
//   fuzzy >= STRONG  → true  (fuzzy alone sufficient)
//   fuzzy >= WEAK && rule → true  (both agree, trust it)
//   fuzzy < WEAK && rule → true   (rule catches what fuzzy missed, e.g. exact slug match)
//   fuzzy >= WEAK && !rule → ambiguous, treat as false (reduce false positives)
//   fuzzy < WEAK && !rule → false
//
// WHY this matrix:
//   The middle band (WEAK ≤ fuzzy < STRONG) is the noisy zone.
//   Requiring rule confirmation in that zone eliminates false positives
//   from generic words without discarding real domain queries.
// ─────────────────────────────────────────────────────────────────────────────

function arbitrate(
  intent: string,
  fuzzyScore: number,
  ruleHit: boolean
): { result: boolean; strategy: "fuzzy" | "rule" | "both" | "none" } {
  if (fuzzyScore >= STRONG_FUZZY_THRESHOLD) {
    return { result: true, strategy: "fuzzy" };
  }
  if (fuzzyScore >= WEAK_FUZZY_THRESHOLD && ruleHit) {
    return { result: true, strategy: "both" };
  }
  if (fuzzyScore < WEAK_FUZZY_THRESHOLD && ruleHit) {
    return { result: true, strategy: "rule" };
  }
  return { result: false, strategy: "none" };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT: detectIntent()
// ─────────────────────────────────────────────────────────────────────────────

export function detectIntent(
  input: NormalizedInput,
  previousQuery?: string,
  debug = false
): IntentSignals {
  const q = input.clean.toLowerCase();
  const tokens = input.tokens;

  // ── Layer 1: Pure Rule-Based (categorical, high-precision) ──────────────

  const isGreeting =
    input.wordCount <= 6 && GREETING_PATTERN.test(q);

  const isCorrection = CORRECTION_PATTERN.test(q);

  const isEscalation = ESCALATION_PATTERNS.some((p) => p.test(input.clean));

  const isEmotional = EMOTIONAL_PATTERN.test(q);

  const isSarcasm =
    SARCASM_PATTERN.test(q) && SARCASM_PUNCT.test(input.clean);

  const wantsGuess = GUESS_PATTERN.test(q);
  const wantsCertainty = CERTAINTY_PATTERN.test(q);
  const wantsDifferentPersona = PERSONA_PATTERN.test(q);

  // ── Layer 2: Fuzzy Scoring ───────────────────────────────────────────────

  const fuzzyScores = scoreFuzzyIntents(q, tokens);

  // ── Layer 3: Rule-Based Fallback Hits (domain-specific only) ────────────

  const ruleHits: Record<string, boolean> = {
    alerts:     RULE_PATTERNS["alerts"]!.test(q),
    tags:       RULE_PATTERNS["tags"]!.test(q),
    status:     RULE_PATTERNS["status"]!.test(q),
    production: RULE_PATTERNS["production"]!.test(q),
    reports:    RULE_PATTERNS["reports"]!.test(q),
  };

  // ── Layer 4: Arbitration per Intent ─────────────────────────────────────

  const alertsArb     = arbitrate("alerts",     fuzzyScores["alerts"]!,     ruleHits["alerts"]!);
  const tagsArb       = arbitrate("tags",        fuzzyScores["tags"]!,       ruleHits["tags"]!);
  const statusArb     = arbitrate("status",      fuzzyScores["status"]!,     ruleHits["status"]!);
  const productionArb = arbitrate("production",  fuzzyScores["production"]!, ruleHits["production"]!);
  const reportsArb    = arbitrate("reports",     fuzzyScores["reports"]!,    ruleHits["reports"]!);

  const wantsAlerts     = alertsArb.result;
  const wantsTags       = tagsArb.result;
  const wantsStatus     = statusArb.result;
  const wantsProduction = productionArb.result;
  const wantsReports    = reportsArb.result;

  // ── Multi-Intent Detection ───────────────────────────────────────────────
  //
  // WHY changed: previously counted raw booleans that could all be false-positives.
  // Now we count CONFIRMED intents (passed arbitration), so isMultiIntent is only
  // true when the system is actually confident about 2+ distinct intents.

  const confirmedIntents = [
    wantsAlerts, wantsTags, wantsStatus, wantsReports, wantsProduction,
  ].filter(Boolean);

  const isMultiIntent = confirmedIntents.length >= 2;

  // ── Out-of-Scope ─────────────────────────────────────────────────────────
  //
  // Only flag out-of-scope if NO machine-relevant intent was detected.
  // WHY: a query can match an OOS pattern AND an intent pattern
  // (e.g. "google what is rpm") — intent should win.

  const anyMachineIntent =
    wantsAlerts || wantsTags || wantsStatus || wantsReports || wantsProduction;

  const isOutOfScope =
    OUT_OF_SCOPE_PATTERNS.some((p) => p.test(input.clean)) && !anyMachineIntent;

  // ── Ambiguity ────────────────────────────────────────────────────────────

  const isAmbiguous =
    input.isVeryShort && !isGreeting && !anyMachineIntent;

  // ── Repeat Detection ─────────────────────────────────────────────────────

  const isRepeat =
    !!previousQuery &&
    normalizeForRepeatCheck(previousQuery) === normalizeForRepeatCheck(input.clean);

  // ── Slug Extraction ──────────────────────────────────────────────────────

  const mentionedSlugs = tokens
    .map((t) => t.toUpperCase())
    .filter((t) => KNOWN_SLUGS.has(t));

  // ── Debug Payload ────────────────────────────────────────────────────────
  //
  // Attach debug info when requested. Use this to build a logging/tracing
  // middleware in your pipeline (e.g. log to your APM tool on misclassification).

  const _debug: IntentDebugInfo | undefined = debug
    ? {
        fuzzyScores,
        fuzzyHits: {
          alerts:     fuzzyScores["alerts"]!     >= WEAK_FUZZY_THRESHOLD,
          tags:       fuzzyScores["tags"]!       >= WEAK_FUZZY_THRESHOLD,
          status:     fuzzyScores["status"]!     >= WEAK_FUZZY_THRESHOLD,
          production: fuzzyScores["production"]! >= WEAK_FUZZY_THRESHOLD,
          reports:    fuzzyScores["reports"]!    >= WEAK_FUZZY_THRESHOLD,
        },
        ruleHits,
        finalDecisions: {
          alerts: wantsAlerts,
          tags: wantsTags,
          status: wantsStatus,
          production: wantsProduction,
          reports: wantsReports,
        },
        strategy: {
          alerts:     alertsArb.strategy,
          tags:       tagsArb.strategy,
          status:     statusArb.strategy,
          production: productionArb.strategy,
          reports:    reportsArb.strategy,
        },
      }
    : undefined;

  return {
    wantsAlerts,
    wantsTags,
    wantsStatus,
    wantsReports,
    wantsProduction,
    isGreeting,
    isCorrection,
    isEscalation,
    isMultiIntent,
    isOutOfScope,
    isAmbiguous,
    isRepeat,
    isEmotional,
    isSarcasm,
    wantsGuess,
    wantsCertainty,
    wantsDifferentPersona,
    mentionedSlugs,
    _debug,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: Logging Hook
//
// Drop this into your pipeline middleware to trace every intent decision.
// Integrate with your APM (Datadog, Sentry, etc.) for production monitoring.
// ─────────────────────────────────────────────────────────────────────────────

export function logIntentDecision(
  input: NormalizedInput,
  signals: IntentSignals
): void {
  if (!signals._debug) return;

  const { fuzzyScores, strategy, finalDecisions } = signals._debug;

  console.debug("[intent]", {
    query: input.clean,
    intents: finalDecisions,
    strategy,
    fuzzyScores: Object.fromEntries(
      Object.entries(fuzzyScores).map(([k, v]) => [k, v.toFixed(3)])
    ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: Calibration Helper
//
// Run this in a test/dev environment to tune thresholds against real queries.
// Pass in your golden test set and inspect score distributions.
// ─────────────────────────────────────────────────────────────────────────────

export function calibrateFuzzyScores(testQueries: string[]): void {
  console.table(
    testQueries.map((q) => {
      const tokens = q.toLowerCase().split(/\s+/);
      const scores = scoreFuzzyIntents(q.toLowerCase(), tokens);
      return { query: q, ...scores };
    })
  );
}