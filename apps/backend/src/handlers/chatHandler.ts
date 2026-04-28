/**
 * chatHandlers.ts
 * ─────────────────────────────────────────────────────────────────
 * Deterministic handler layer for the Ravi chat system.
 * All edge-case routing, safety, and context-building happens here.
 * The LLM only handles the final natural-language sentence(s).
 *
 * HANDLER PIPELINE (for every request):
 *   1. normalizeInput()
 *   2. detectRisk()
 *   3. detectIntent()
 *   4. detectMissingContext()
 *   5. selectHandler()
 *   6. buildContextPacket()
 *   7. [LLM writes narrative]
 *   8. validateOutput()
 *   9. applyFallbackIfNeeded()
 * ─────────────────────────────────────────────────────────────────
 */

/* ─────────────────────────────────────────────────────────────────
   TAG CATALOG — used for flag thresholds and anomaly detection
   ───────────────────────────────────────────────────────────────── */
   export interface TagConfig {
    label: string;
    unit: string;
    warn_hi: number | null;
    alarm_hi: number | null;
  }
  
  export const TAGS: Record<string, TagConfig> = {
    // EXTRUDER
    EXTRUDER_RPM: { label: "Extruder RPM", unit: "RPM", warn_hi: 80, alarm_hi: 100 },
    EXTRUDER_AMP: { label: "Extruder Amps", unit: "A", warn_hi: 35, alarm_hi: 40 },
    EXTRUDER_SPEED_PCT: { label: "Extruder Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },
    EXTRUDER_ON_OFF: { label: "Extruder ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
    EXTRUDER_FAULT: { label: "Extruder Fault", unit: "", warn_hi: null, alarm_hi: null },
    EXTRUDER_SPEED_VOL: { label: "Extruder Speed Vol", unit: "V", warn_hi: null, alarm_hi: null },
    // LAMINATOR
    LAMINATOR_MPM: { label: "Laminator MPM", unit: "m/min", warn_hi: 130, alarm_hi: 150 },
    LAMINATOR_AMP: { label: "Laminator Amps", unit: "A", warn_hi: 12, alarm_hi: 15 },
    LAMINATOR_SPEED_PCT: { label: "Laminator Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },
    LAMINATOR_ON_OFF: { label: "Laminator ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
    LAMINATOR_FAULT: { label: "Laminator Fault", unit: "", warn_hi: null, alarm_hi: null },
    LAMINATOR_SPEED_VOL: { label: "Laminator Speed Vol", unit: "V", warn_hi: null, alarm_hi: null },
    // WINDER
    WINDER_AMP: { label: "Winder Amps", unit: "A", warn_hi: 8, alarm_hi: 12 },
    WINDER_TENSION_PCT: { label: "Winder Tension", unit: "%", warn_hi: 80, alarm_hi: 90 },
    WINDER_ON_OFF: { label: "Winder ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
    WINDER_FAULT: { label: "Winder Fault", unit: "", warn_hi: null, alarm_hi: null },
    WINDER_TENSION_VOL: { label: "Winder Tension Vol", unit: "V", warn_hi: null, alarm_hi: null },
    // MASTER / LINE
    MASTER_SPEED_PCT: { label: "Master Speed", unit: "%", warn_hi: 95, alarm_hi: 100 },
    // UNWINDER TENSION
    UW_SET_TENSION: { label: "UW Set Tension", unit: "", warn_hi: null, alarm_hi: null },
    UW_PV_TENSION: { label: "UW Actual Tension", unit: "", warn_hi: null, alarm_hi: null },
    // PRODUCTION METERS
    RUNNING_METER: { label: "Running Meter", unit: "m", warn_hi: null, alarm_hi: null },
    TOTAL_METER: { label: "Total Meter", unit: "m", warn_hi: null, alarm_hi: null },
    // GSM / GRAM
    GSM_ENTRY: { label: "GSM Entry", unit: "g/m2", warn_hi: null, alarm_hi: null },
    GRAM_ENTRY: { label: "Gram Entry", unit: "g", warn_hi: null, alarm_hi: null },
    // ALARMS & SAFETY
    ALARM_IND: { label: "Alarm Indicator", unit: "", warn_hi: null, alarm_hi: null },
    EMG_STOP: { label: "Emergency Stop", unit: "", warn_hi: null, alarm_hi: null },
    // SPLICE
    SPLICE_ON_OFF: { label: "Splice ON/OFF", unit: "", warn_hi: null, alarm_hi: null },
    SPLICE_SPEED: { label: "Splice Speed", unit: "", warn_hi: null, alarm_hi: null },
  };
  
  /* ─────────────────────────────────────────────────────────────────
     TYPES
     ───────────────────────────────────────────────────────────────── */
  
  export type HandlerType =
    | "greeting"
    | "status"
    | "alerts"
    | "tags"
    | "missing_data"
    | "no_context"
    | "ambiguous"
    | "conflicting_context"
    | "unsafe"
    | "out_of_scope"
    | "multi_intent"
    | "tool_failure"
    | "hallucination_risk"
    | "user_correction"
    | "stale_data"
    | "partial_telemetry"
    | "escalation"
    | "short_query"
    | "repeated_question"
    | "general";
  
  export type RiskLevel = "safe" | "low" | "medium" | "high" | "block";
  
  export interface NormalizedInput {
    raw: string;
    clean: string;
    tokens: string[];
    charCount: number;
    wordCount: number;
    isVeryShort: boolean;      // < 4 words
    isVeryLong: boolean;       // > 200 words
    hasWeirdSymbols: boolean;
    isAllCaps: boolean;
    language: "en" | "unknown";
  }
  
  export interface RiskAssessment {
    level: RiskLevel;
    reason: string;
    block: boolean;
  }
  
  export interface IntentSignals {
    wantsAlerts: boolean;
    wantsTags: boolean;
    wantsStatus: boolean;
    wantsReports: boolean;
    wantsProduction: boolean;
    isGreeting: boolean;
    isCorrection: boolean;
    isEscalation: boolean;
    isMultiIntent: boolean;
    isOutOfScope: boolean;
    isAmbiguous: boolean;
    isRepeat: boolean;
    isEmotional: boolean;
    isSarcasm: boolean;
    wantsGuess: boolean;          // "guess", "estimate", "probably"
    wantsCertainty: boolean;      // "definitely", "exactly", "100%"
    wantsDifferentPersona: boolean;
    mentionedSlugs: string[];     // known tag slugs found in query
  }
  
  export interface ContextAssessment {
    hasTagData: boolean;
    hasAlertData: boolean;
    hasReportData: boolean;
  hasProductionData: boolean;
    hasMissingFields: boolean;
    isStale: boolean;             // all timestamps > 10 min old
    isPartial: boolean;           // < 5 tags returned when many expected
    hasConflict: boolean;         // e.g. fault=0 but alarm active
    faultSlugs: string[];         // tags with fault flag
    anomalySlugs: string[];       // tags exceeding warn_hi
    staleSlugs: string[];         // tags with stale timestamps
  }
  
  export interface HandlerDecision {
    handler: HandlerType;
    reason: string;
    fallbackAnswer?: string;      // set when handler is fully deterministic
    requiresLlm: boolean;
  }
  
  export interface ContextPacket {
    handler: HandlerType;
    machineId: string;
    capturedAt: string;
  promptProfile: "small-model-safe";
    brief: string;               // compact, token-efficient LLM input
  evidenceSummary: {
    tagCount: number;
    alertCount: number;
    productionBucketCount: number;
    stale: boolean;
    partial: boolean;
    hasConflict: boolean;
  };
    preRendered: {
      introLine: string;
      alertsBlock: string | null;
      productionBlock: string | null;
      watchBlock: string | null;
      readingsBlock: string | null;
      missingNote: string | null;
    };
    constraints: string[];        // rules the LLM must follow for this packet
    fallback: string;             // used if LLM output fails validation
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 1 — normalizeInput
     ───────────────────────────────────────────────────────────────── */
  
  const MAX_INPUT_LEN = 800;
  
  export function normalizeInput(raw: string): NormalizedInput {
    if (typeof raw !== "string") raw = "";
  
    // Truncate extremely long inputs
    const truncated = raw.slice(0, MAX_INPUT_LEN);
  
    // Strip known injection vectors
    const clean = truncated
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\[.*?\]\(.*?\)/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/system\s*:/gi, "")
      .replace(/\bignore\b.{0,50}\binstructions?\b/gi, "")
      .replace(/\bact as\b.{0,60}/gi, "")
      .replace(/\bpretend\b.{0,60}/gi, "")
      .replace(/\byou are now\b.{0,60}/gi, "")
      .replace(/\bforget\b.{0,40}\bprevious\b/gi, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
      .trim();
  
    const tokens = clean
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  
    const hasWeirdSymbols = /[^\x20-\x7E\u0900-\u097F\n\r\t]/.test(clean);
    const isAllCaps = clean.length > 10 && clean === clean.toUpperCase() && /[A-Z]/.test(clean);
  
    return {
      raw: truncated,
      clean,
      tokens,
      charCount: clean.length,
      wordCount: tokens.length,
      isVeryShort: tokens.length < 4,
      isVeryLong: tokens.length > 200,
      hasWeirdSymbols,
      isAllCaps,
      language: "en",
    };
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 2 — detectRisk
     ───────────────────────────────────────────────────────────────── */
  
  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions?/i,
    /system\s*prompt/i,
    /\bact\s+as\s+(a\s+)?(different|new|another)/i,
    /pretend\s+you\s+(are|were|have)/i,
    /you\s+are\s+now\s+a/i,
    /disregard\s+(all\s+)?rules/i,
    /jailbreak/i,
    /\bdan\b.*mode/i,
    /\bdevmode\b/i,
    /override\s+(safety|policy|restrictions?)/i,
    /forget\s+your\s+(previous\s+)?(instructions?|training|rules)/i,
    /respond\s+(only\s+)?in\s+(a\s+)?different\s+(language|persona|format)/i,
  ];
  
  const OUT_OF_SCOPE_PATTERNS = [
    /\b(recipe|cook|weather|sports|news|stock|crypto|bitcoin|forex)\b/i,
    /\b(movie|song|music|celebrity|politics|election)\b/i,
    /\b(write\s+code|debug\s+my|build\s+an?\s+app)\b/i,
    /\b(translate|grammar|essay|poem)\b/i,
  ];
  
  const ESCALATION_PATTERNS = [
    /\b(emergency|fire|explosion|injury|accident|blood|hospital|ambulance)\b/i,
    /\b(call\s+(maintenance|supervisor|manager|engineer))\b/i,
    /\b(shut\s+down\s+(everything|all|line|machine))\b/i,
    /machine\s+(on\s+fire|burning|smoke)/i,
  ];
  
  export function detectRisk(input: NormalizedInput): RiskAssessment {
    const text = input.clean;
  
    for (const p of INJECTION_PATTERNS) {
      if (p.test(text)) {
        return { level: "block", reason: "prompt_injection_detected", block: true };
      }
    }
  
    for (const p of ESCALATION_PATTERNS) {
      if (p.test(text)) {
        return { level: "high", reason: "escalation_keyword", block: false };
      }
    }
  
    if (input.hasWeirdSymbols && input.charCount > 40) {
      return { level: "medium", reason: "unusual_characters", block: false };
    }
  
    if (input.wordCount > 150) {
      return { level: "low", reason: "very_long_input", block: false };
    }
  
    return { level: "safe", reason: "clean", block: false };
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 3 — detectIntent
     ───────────────────────────────────────────────────────────────── */
  
  const KNOWN_SLUGS = new Set(Object.keys(TAGS));
  
  export function detectIntent(
    input: NormalizedInput,
    previousQuery?: string
  ): IntentSignals {
    const q = input.clean.toLowerCase();
    const tokens = new Set(input.tokens);
  
    const wantsAlerts = /\b(alert|alerts|aler|alers|warning|warnings|critical|fired|fault|faults|alarm|alarms)\b/.test(q);
    const wantsTags = /\b(tag|tags|value|values|reading|readings|sensor|current|show|list|all|dashboard|what is|what's)\b/.test(q)
      || /\b(rpm|amp|mpm|speed|tension|gsm|gram|meter|voltage|pressure)\b/.test(q);
    const wantsStatus = /\b(status|overview|how\s+is|running|health|state|right\s+now|situation)\b/.test(q);
    const wantsReports = /\b(report|reports|run|runs|performance|summary|metrics|last\s+report)\b/.test(q);
    const wantsProduction = /\b(production|meters|output|throughput|efficiency|daily|weekly|monthly)\b/.test(q);
  
    const isGreeting = input.wordCount <= 6 && /^(hi|hello|hey|thanks|thank|good\s+(morning|evening|afternoon)|howdy|sup|yo)\b/.test(q);
    const isCorrection = /\b(wrong|incorrect|that'?s\s+not|actually|no[,\s]|mistake|you\s+said|but\s+you|it\s+(should|is)\s+actually)\b/.test(q);
    const isEscalation = ESCALATION_PATTERNS.some(p => p.test(input.clean));
    const isEmotional = /\b(frustrated|angry|worried|scared|confused|stressed|panic|urgent|asap|immediately)\b/.test(q);
    const isSarcasm = /\b(great\s+job|wow\s+amazing|very\s+helpful|thanks\s+for\s+nothing|brilliant|genius)\b/.test(q)
      && /(!{2,}|\?{2,})/.test(input.clean);
    const wantsGuess = /\b(guess|estimate|probably|maybe|roughly|approximately|around|ballpark)\b/.test(q);
    const wantsCertainty = /\b(definitely|exactly|100%|certain|guarantee|for\s+sure|absolute)\b/.test(q);
    const wantsDifferentPersona = /\b(be\s+more\s+(casual|formal|friendly)|sound\s+like|talk\s+like|respond\s+as)\b/.test(q);
  
    // Detect if the user is asking two distinct things at once
    const intentCount = [wantsAlerts, wantsTags, wantsStatus, wantsReports, wantsProduction].filter(Boolean).length;
    const isMultiIntent = intentCount >= 2;
  
    const isOutOfScope = OUT_OF_SCOPE_PATTERNS.some(p => p.test(input.clean)) && !wantsAlerts && !wantsTags && !wantsStatus;
  
    const isAmbiguous = input.isVeryShort && !isGreeting && !wantsAlerts && !wantsTags && !wantsStatus;
  
    const isRepeat = !!previousQuery && normalizeForRepeatCheck(previousQuery) === normalizeForRepeatCheck(input.clean);
  
    // Extract known slugs mentioned in the query
    const mentionedSlugs = input.tokens
      .map(t => t.toUpperCase())
      .filter(t => KNOWN_SLUGS.has(t));
  
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
    };
  }
  
  function normalizeForRepeatCheck(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 4 — detectMissingContext
     ───────────────────────────────────────────────────────────────── */
  
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  
  export function detectMissingContext(
    liveContexts: { source: string; text: string }[],
    intent: IntentSignals
  ): ContextAssessment {
    const hasTagData = liveContexts.some(c =>
      (c.source === "tags_db" || c.source === "tags_selected") &&
      !c.text.includes("No tags found") &&
      !c.text.includes("No latest values found")
    );
    const hasAlertData = liveContexts.some(c =>
      c.source === "alerts_db" &&
      !c.text.includes("No alerts found") &&
      !c.text.includes("No open or recent")
    );
    const hasReportData = liveContexts.some(c =>
      c.source === "reports_db" &&
      !c.text.includes("No report runs")
    );
  const hasProductionData = liveContexts.some(c =>
    c.source === "production_db" &&
    !c.text.includes("No production metrics") &&
    !c.text.includes("0 buckets")
  );
  
    // Parse tag lines to detect staleness, faults, anomalies
    const tagBlock = liveContexts.find(c => c.source === "tags_db" || c.source === "tags_selected");
    const faultSlugs: string[] = [];
    const anomalySlugs: string[] = [];
    const staleSlugs: string[] = [];
    const tagCount = tagBlock ? (tagBlock.text.match(/^\* /gm)?.length ?? 0) : 0;
  
    if (tagBlock) {
      const now = Date.now();
      for (const line of tagBlock.text.split("\n")) {
        const m = line.trim().match(/^\*\s+([A-Z][A-Z0-9_]+):\s*(.+?)\s*(?:\[(.+?)\])?$/);
        if (!m) continue;
        const [, slug, rawValue, rawTime] = m;
        const cfg = TAGS[slug!];
  
        // Fault detection
        const upperSlug = slug!.toUpperCase();
        if (
          (upperSlug.includes("FAULT") || upperSlug.includes("EMG") || upperSlug.includes("ALARM_IND")) &&
          (rawValue!.trim() === "1" || rawValue!.trim().toLowerCase() === "true")
        ) {
          faultSlugs.push(slug!);
        }
  
        // Anomaly detection using known thresholds
        if (cfg?.alarm_hi != null) {
          const num = parseFloat(rawValue!);
          if (!isNaN(num) && num >= cfg.alarm_hi) anomalySlugs.push(slug!);
        } else if (cfg?.warn_hi != null) {
          const num = parseFloat(rawValue!);
          if (!isNaN(num) && num >= cfg.warn_hi) anomalySlugs.push(slug!);
        }
  
        // Staleness detection
        if (rawTime) {
          try {
            const parsed = parseTimeString(rawTime);
            if (parsed && (now - parsed) > STALE_THRESHOLD_MS) {
              staleSlugs.push(slug!);
            }
          } catch { /* skip */ }
        }
      }
    }
  
    const isStale = tagCount > 0 && staleSlugs.length === tagCount;
    const isPartial = intent.wantsTags && tagCount > 0 && tagCount < 5;
  
    // Conflict: alarm indicator active but no critical alerts
    const hasConflict = faultSlugs.length > 0 && !hasAlertData;
  
    const hasMissingFields =
      (intent.wantsAlerts && !hasAlertData) ||
      (intent.wantsTags && !hasTagData) ||
      (intent.wantsReports && !hasReportData) ||
      (intent.wantsProduction && !hasProductionData);
  
    return {
      hasTagData,
      hasAlertData,
      hasReportData,
      hasProductionData,
      hasMissingFields,
      isStale,
      isPartial,
      hasConflict,
      faultSlugs,
      anomalySlugs,
      staleSlugs,
    };
  }
  
  /** Parse "2:43 PM" style time strings to epoch ms using today's date */
  function parseTimeString(t: string): number | null {
    try {
      const today = new Date();
      const d = new Date(`${today.toDateString()} ${t}`);
      return isNaN(d.getTime()) ? null : d.getTime();
    } catch {
      return null;
    }
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 5 — selectHandler
     ───────────────────────────────────────────────────────────────── */
  
  export function selectHandler(
    input: NormalizedInput,
    risk: RiskAssessment,
    intent: IntentSignals,
    ctx: ContextAssessment
  ): HandlerDecision {
  
    // Hard blocks
    if (risk.block) {
      return {
        handler: "unsafe",
        reason: risk.reason,
        fallbackAnswer: "I can only help with lamination machine operations. Let's keep it focused on the production line.",
        requiresLlm: false,
      };
    }
  
    if (intent.isEscalation) {
      return {
        handler: "escalation",
        reason: "escalation_keyword_detected",
        requiresLlm: false,
      };
    }
  
    if (intent.isOutOfScope) {
      return {
        handler: "out_of_scope",
        reason: "topic_outside_lamination_domain",
        fallbackAnswer: "I'm set up specifically for the lamination line. I can help with machine status, alerts, tag readings, or production reports.",
        requiresLlm: false,
      };
    }
  
    if (intent.isGreeting) {
      return {
        handler: "greeting",
        reason: "greeting_detected",
        requiresLlm: false,
      };
    }
  
    if (intent.wantsDifferentPersona) {
      return {
        handler: "out_of_scope",
        reason: "persona_change_request",
        fallbackAnswer: "I'm Ravi, the lamination assistant. I'll keep helping you with the machine — what do you need?",
        requiresLlm: false,
      };
    }
  
    if (intent.isSarcasm) {
      return {
        handler: "general",
        reason: "sarcasm_detected_softened",
        requiresLlm: true,
      };
    }
  
    // Tool/context failures
    if (!ctx.hasTagData && !ctx.hasAlertData && !ctx.hasReportData && !ctx.hasProductionData) {
      return {
        handler: "no_context",
        reason: "no_live_data_available",
        fallbackAnswer: "I don't have live data right now. The machine connection may be down — check the data pipeline or try again in a moment.",
        requiresLlm: false,
      };
    }
  
    if (ctx.isStale) {
      return {
        handler: "stale_data",
        reason: "all_tags_stale",
        requiresLlm: true,
      };
    }
  
    if (ctx.isPartial && !ctx.hasAlertData) {
      return {
        handler: "partial_telemetry",
        reason: "fewer_than_5_tags_returned",
        requiresLlm: true,
      };
    }
  
    if (ctx.hasConflict) {
      return {
        handler: "conflicting_context",
        reason: "fault_flags_without_matching_alerts",
        requiresLlm: true,
      };
    }
  
    if (ctx.hasMissingFields) {
      return {
        handler: "missing_data",
        reason: "requested_data_source_empty",
        requiresLlm: true,
      };
    }
  
    // Guardrails on certainty / guessing
    if (intent.wantsGuess) {
      return {
        handler: "general",
        reason: "user_wants_estimate_no_guessing",
        requiresLlm: true,
      };
    }
  
    // Multi-intent (split and address primary)
    if (intent.isMultiIntent) {
      return {
        handler: "multi_intent",
        reason: "multiple_data_intents_detected",
        requiresLlm: true,
      };
    }
  
    if (intent.isCorrection) {
      return {
        handler: "user_correction",
        reason: "user_correcting_previous_answer",
        requiresLlm: true,
      };
    }
  
    if (intent.isAmbiguous) {
      return {
        handler: "ambiguous",
        reason: "query_too_short_or_vague",
        requiresLlm: false,
      };
    }
  
    if (intent.isRepeat) {
      return {
        handler: "repeated_question",
        reason: "same_query_as_previous",
        requiresLlm: true,
      };
    }
  
  if (intent.wantsProduction) {
    return { handler: "status", reason: "production_intent_prioritized", requiresLlm: true };
  }

    // Primary intents
    if (intent.wantsAlerts) {
      return { handler: "alerts", reason: "alert_intent", requiresLlm: true };
    }
  
    if (intent.wantsTags || intent.mentionedSlugs.length > 0) {
      return { handler: "tags", reason: "tag_reading_intent", requiresLlm: true };
    }
  
    if (intent.wantsStatus) {
      return { handler: "status", reason: "status_overview_intent", requiresLlm: true };
    }
  
  if (intent.wantsReports) {
      return { handler: "status", reason: "reports_production_intent", requiresLlm: true };
    }
  
    return { handler: "general", reason: "no_specific_intent_matched", requiresLlm: true };
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 6 — buildContextPacket
     Builds the compact brief + constraints + preRendered blocks
     tailored per handler. The LLM only sees the brief + constraints.
     ───────────────────────────────────────────────────────────────── */
  
  interface ParsedTag {
    slug: string;
    label: string;
    value: string;
    unit: string;
    time: string;
    numericValue: number | null;
    flag: "fault" | "alarm" | "warn" | "normal" | null;
    group: string;
  }
  
  interface ParsedAlert {
    severity: string;
    status: string;
    title: string;
    detectedAt: string;
    description: string | null;
  }

interface ParsedProductionBucket {
  label: string;
  runningMeters: number | null;
  avgRpm: number | null;
  avgMpm: number | null;
  avgGsm: number | null;
  samples: number | null;
}
  
  export function buildContextPacket(
    handler: HandlerDecision,
    input: NormalizedInput,
    intent: IntentSignals,
    ctx: ContextAssessment,
    liveContexts: { source: string; text: string }[],
    machineId: string,
    capturedAt: string,
    health: "healthy" | "degraded" | "critical" | "unknown"
  ): ContextPacket {
    const tags = parseTags(liveContexts);
    const alerts = parseAlerts(liveContexts);
  const production = parseProduction(liveContexts);
  
  const preRendered = buildPreRendered(tags, alerts, production, ctx, handler.handler, intent);
  const brief = buildBrief(handler.handler, tags, alerts, production, ctx, health, input, intent);
    const constraints = buildConstraints(handler.handler, intent, ctx);
    const fallback = buildFallback(handler.handler, ctx, health);
  
    return {
      handler: handler.handler,
      machineId,
      capturedAt,
      promptProfile: "small-model-safe",
      brief,
      evidenceSummary: {
        tagCount: tags.length,
        alertCount: alerts.length,
        productionBucketCount: production.length,
        stale: ctx.isStale,
        partial: ctx.isPartial,
        hasConflict: ctx.hasConflict,
      },
      preRendered,
      constraints,
      fallback,
    };
  }
  
  /* ─────────────────────────────────────────────────────────────────
     TAG + ALERT PARSERS
     ───────────────────────────────────────────────────────────────── */
  
  const GROUP_MAP: [string, string][] = [
    ["EXTRUDER", "Extruder"],
    ["LAMINATOR", "Laminator"],
    ["WINDER", "Winder"],
    ["UW_", "Unwinder"],
    ["SPLICE", "Splice"],
    ["MASTER", "General"],
    ["RUNNING", "Production"],
    ["TOTAL", "Production"],
    ["GSM", "Quality"],
    ["GRAM", "Quality"],
    ["ALARM", "Safety"],
    ["EMG", "Safety"],
  ];
  
  function groupForSlug(slug: string): string {
    const u = slug.toUpperCase();
    for (const [prefix, group] of GROUP_MAP) {
      if (u.startsWith(prefix)) return group;
    }
    return "General";
  }
  
  function parseTags(liveContexts: { source: string; text: string }[]): ParsedTag[] {
    const block = liveContexts.find(c => c.source === "tags_db" || c.source === "tags_selected");
    if (!block) return [];
  
    const result: ParsedTag[] = [];
  
    for (const line of block.text.split("\n")) {
      const m = line.trim().match(/^\*\s+([A-Z][A-Z0-9_]+):\s*(.+?)\s*(?:\[(.+?)\])?$/);
      if (!m) continue;
      const [, slug, rawValue, rawTime] = m;
  
      const cfg = TAGS[slug!];
      const label = cfg?.label ?? slugToLabel(slug!);
      const unit = cfg?.unit ?? "";
      const numericValue = parseFloat(rawValue!.replace(/[^\d.-]/g, "")) || null;
  
      let flag: ParsedTag["flag"] = null;
      const u = slug!.toUpperCase();
      if (u.includes("FAULT") || u.includes("EMG_STOP") || u.includes("ALARM_IND")) {
        const isActive = rawValue!.trim() === "1" || rawValue!.trim().toLowerCase() === "true";
        flag = isActive ? "fault" : "normal";
      } else if (numericValue !== null) {
        if (cfg?.alarm_hi != null && numericValue >= cfg.alarm_hi) flag = "alarm";
        else if (cfg?.warn_hi != null && numericValue >= cfg.warn_hi) flag = "warn";
        else flag = "normal";
      }
  
      result.push({
        slug: slug!,
        label,
        value: rawValue!.trim(),
        unit,
        time: rawTime?.trim() ?? "",
        numericValue,
        flag,
        group: groupForSlug(slug!),
      });
    }
  
    return result;
  }
  
  function parseAlerts(liveContexts: { source: string; text: string }[]): ParsedAlert[] {
    const block = liveContexts.find(c => c.source === "alerts_db");
    if (!block) return [];
  
    const result: ParsedAlert[] = [];
    for (const line of block.text.split("\n")) {
      const m = line.match(
        /ALERT\s*#\d+:\s*\[(\w+)\]\s*status:\s*(\w+)\s*\|\s*title:\s*"([^"]+)"\s*\|\s*detected at:\s*([^|]+)(?:\|\s*description:\s*(.+))?/i
      );
      if (!m) continue;
      result.push({
        severity: m[1]!.toLowerCase(),
        status: m[2]!.toLowerCase(),
        title: m[3]!.trim(),
        detectedAt: m[4]!.trim(),
        description: m[5]?.trim() ?? null,
      });
    }
  
    return result.sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
    });
  }

function parseProduction(liveContexts: { source: string; text: string }[]): ParsedProductionBucket[] {
  const block = liveContexts.find(c => c.source === "production_db");
  if (!block || !block.text) return [];
  const result: ParsedProductionBucket[] = [];
  for (const line of block.text.split("\n")) {
    const m = line.match(
      /^-\s+([^:]+):\s+runningMeters=([^\s]+)\s+avgRpm=([^\s]+)\s+avgMpm=([^\s]+)\s+avgGsm=([^\s]+)\s+samples=([^\s]+)\s*$/i
    );
    if (!m) continue;
    const toNum = (v: string): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    result.push({
      label: m[1]!.trim(),
      runningMeters: toNum(m[2]!),
      avgRpm: toNum(m[3]!),
      avgMpm: toNum(m[4]!),
      avgGsm: toNum(m[5]!),
      samples: toNum(m[6]!),
    });
  }
  return result;
}
  
  function slugToLabel(slug: string): string {
    return slug
      .split("_")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
  
  /* ─────────────────────────────────────────────────────────────────
     PRE-RENDERED BLOCKS (deterministic markdown — never LLM)
     ───────────────────────────────────────────────────────────────── */
  
  const SEVERITY_EMOJI: Record<string, string> = { critical: "🔴", warning: "🟡", info: "ℹ️" };
  const FLAG_SUFFIX: Record<string, string> = { fault: " ⚠️", alarm: " 🔴", warn: " 👀", normal: "" };
  
  function buildPreRendered(
    tags: ParsedTag[],
    alerts: ParsedAlert[],
  production: ParsedProductionBucket[],
    ctx: ContextAssessment,
  handler: HandlerType,
  intent: IntentSignals
  ): ContextPacket["preRendered"] {
  
    // Intro line (fully deterministic)
  const introLine = buildIntroLine(ctx, alerts, tags, production);
  
    // Alerts block
    let alertsBlock: string | null = null;
    if (alerts.length > 0 && (handler === "alerts" || handler === "status" || handler === "conflicting_context")) {
      const rows = alerts.slice(0, 8).map(a => {
        const emoji = SEVERITY_EMOJI[a.severity] ?? "ℹ️";
        const desc = a.description ? a.description.slice(0, 120).replace(/\|/g, "\\|") : "";
        return `| ${emoji} ${capitalize(a.severity)} | ${capitalize(a.status)} | ${a.title.replace(/\|/g, "\\|")} | ${a.detectedAt.replace(/\|/g, "\\|")} | ${desc} |`;
      });
      alertsBlock = [
        "**Alerts Today**",
        "| Severity | Status | Title | Detected At | Description |",
        "|---|---|---|---|---|",
        ...rows,
      ].join("\n");
    }

  // Production block
  let productionBlock: string | null = null;
  if (production.length > 0 && (handler === "status" || handler === "multi_intent" || intent.wantsProduction)) {
    const top = production[0]!;
    const fmt = (n: number | null) => (n == null ? "n/a" : String(n));
    const lines = [
      `• **Period:** ${top.label}`,
      `• **Running meters:** ${fmt(top.runningMeters)}`,
      `• **Avg RPM:** ${fmt(top.avgRpm)}`,
      `• **Avg m/min:** ${fmt(top.avgMpm)}`,
      `• **Avg GSM:** ${fmt(top.avgGsm)}`,
      `• **Samples:** ${fmt(top.samples)}`,
    ];
    productionBlock = `**Production Today**\n${lines.join("\n")}`;
  }
  
    // Watch block
    let watchBlock: string | null = null;
    const watchTags = tags.filter(t => t.flag === "fault" || t.flag === "alarm" || t.flag === "warn");
    if (watchTags.length > 0) {
      const lines = watchTags.slice(0, 5).map(t => {
        const suffix = FLAG_SUFFIX[t.flag ?? "normal"] ?? "";
        return `| ${t.label} | ${t.value}${t.unit ? " " + t.unit : ""} | ${t.time || "n/a"} | ${suffix.trim() || "normal"} |`;
      });
      watchBlock = [
        "| Metric | Value | Time | Flag |",
        "|---|---|---|---|",
        ...lines,
      ].join("\n");
    }
  
    // Readings block (grouped)
    let readingsBlock: string | null = null;
    if (tags.length > 0 && (handler === "tags" || handler === "status")) {
      const groups = new Map<string, ParsedTag[]>();
      const GROUP_ORDER = ["Extruder", "Laminator", "Winder", "Unwinder", "Splice", "Production", "Quality", "Safety", "General"];
      for (const t of tags) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      }
      const sections: string[] = [];
      for (const grp of GROUP_ORDER) {
        const grpTags = groups.get(grp);
        if (!grpTags || grpTags.length === 0) continue;
        const lines = grpTags.slice(0, 8).map(t => {
          const suffix = FLAG_SUFFIX[t.flag ?? "normal"] ?? "";
          const time = t.time ? ` (${t.time})` : "";
          return `• **${t.label}:** ${t.value}${t.unit ? " " + t.unit : ""}${time}${suffix}`;
        });
        sections.push(`**${grp}**\n${lines.join("\n")}`);
      }
      if (sections.length > 0) readingsBlock = sections.join("\n\n");
    }
  
    // Stale / partial / missing notes
    let missingNote: string | null = null;
    if (ctx.isStale && ctx.staleSlugs.length > 0) {
      missingNote = `⚠️ Data may be stale (last update >10 min ago for: ${ctx.staleSlugs.slice(0, 4).join(", ")}).`;
    } else if (ctx.isPartial) {
      missingNote = `Only partial readings available (${tags.length} tags received).`;
    }
  
  return { introLine, alertsBlock, productionBlock, watchBlock, readingsBlock, missingNote };
  }
  
  function buildIntroLine(
    ctx: ContextAssessment,
    alerts: ParsedAlert[],
  tags: ParsedTag[],
  production: ParsedProductionBucket[]
  ): string {
    const critCount = alerts.filter(a => a.severity === "critical" && a.status === "open").length;
    const warnCount = alerts.filter(a => a.severity === "warning" && a.status === "open").length;
    const faultCount = ctx.faultSlugs.length;
  
    if (critCount > 0) return `There ${critCount === 1 ? "is" : "are"} ${critCount} critical alert${critCount > 1 ? "s" : ""} that need attention now.`;
    if (faultCount > 0) return `Fault detected on: ${ctx.faultSlugs.slice(0, 3).join(", ")}.`;
    if (warnCount > 0) return `Running with ${warnCount} active warning${warnCount > 1 ? "s" : ""}.`;
    if (ctx.isStale) return "Data connection looks stale — readings may not be current.";
    if (ctx.isPartial) return "Partial data only — some readings are unavailable right now.";
  if (tags.length === 0 && production.length > 0) return "Production metrics are available for the latest period.";
  if (tags.length === 0) return "No live readings available at this moment.";
    return "Machine is running. Here's what I'm seeing.";
  }
  
  /* ─────────────────────────────────────────────────────────────────
     BRIEF BUILDER (compact LLM input — one paragraph, token-efficient)
     ───────────────────────────────────────────────────────────────── */
  
  function buildBrief(
    handler: HandlerType,
    tags: ParsedTag[],
    alerts: ParsedAlert[],
  production: ParsedProductionBucket[],
    ctx: ContextAssessment,
    health: string,
    input: NormalizedInput,
    intent: IntentSignals
  ): string {
    const parts: string[] = [];
  
    parts.push(`MACHINE HEALTH: ${health.toUpperCase()}`);
  
    if (alerts.length > 0) {
      const crit = alerts.filter(a => a.severity === "critical").length;
      const warn = alerts.filter(a => a.severity === "warning").length;
      parts.push(`ALERTS: ${crit} critical, ${warn} warning`);
      alerts.slice(0, 3).forEach(a =>
        parts.push(`  [${a.severity.toUpperCase()}] ${a.title} — ${a.status}`)
      );
    } else {
      parts.push("ALERTS: none");
    }
  
    if (ctx.faultSlugs.length > 0) {
      parts.push(`FAULTS: ${ctx.faultSlugs.join(", ")}`);
    }
  
    if (ctx.anomalySlugs.length > 0) {
      parts.push(`ABOVE THRESHOLD: ${ctx.anomalySlugs.join(", ")}`);
    }

  if (production.length > 0) {
    const top = production[0]!;
    parts.push(
      `PRODUCTION: period=${top.label}, runningMeters=${top.runningMeters ?? "n/a"}, avgRpm=${top.avgRpm ?? "n/a"}, avgMpm=${top.avgMpm ?? "n/a"}, avgGsm=${top.avgGsm ?? "n/a"}, samples=${top.samples ?? "n/a"}`
    );
  } else if (intent.wantsProduction) {
    parts.push("PRODUCTION: unavailable");
  }
  
    if (handler === "tags" || handler === "status") {
      const relevant = intent.mentionedSlugs.length > 0
        ? tags.filter(t => intent.mentionedSlugs.includes(t.slug))
        : tags.slice(0, 12);
  
      relevant.forEach(t => {
        const cfg = TAGS[t.slug!                ];
        let extra = "";
        if (t.numericValue !== null && cfg?.warn_hi != null) {
          const pct = Math.round((t.numericValue / cfg.warn_hi) * 100);
          extra = ` (${pct}% of warn threshold)`;
        }
        parts.push(`  ${t.label}: ${t.value}${t.unit ? " " + t.unit : ""}${t.time ? " @ " + t.time : ""}${extra}`);
      });
    }
  
    if (ctx.isStale) parts.push("NOTE: readings may be stale (>10 min old)");
    if (ctx.isPartial) parts.push("NOTE: only partial tag data available");
    if (ctx.hasConflict) parts.push("NOTE: fault flags present but no matching DB alert — verify manually");
  
    // Handler-specific context
    if (handler === "stale_data") {
      parts.push(`STALE TAGS: ${ctx.staleSlugs.join(", ")}`);
    }
  
    if (handler === "user_correction") {
      parts.push(`NOTE: operator indicated previous answer was wrong. Re-check data and be explicit.`);
    }
  
    if (handler === "repeated_question") {
      parts.push("NOTE: this is a repeat question. Confirm the answer is the same or note if data has changed.");
    }
  
    if (intent.wantsGuess) {
      parts.push("INSTRUCTION: operator asked for an estimate. State only what the data shows. Do NOT guess or extrapolate.");
    }
  
    if (intent.wantsCertainty) {
      parts.push("INSTRUCTION: operator wants certainty. You can only state what the data explicitly shows — never assert 100% certainty.");
    }
  
    if (intent.isEmotional) {
      parts.push("TONE: operator seems stressed. Keep your response calm, brief, and actionable.");
    }
  
    return parts.join("\n");
  }
  
  /* ─────────────────────────────────────────────────────────────────
     CONSTRAINTS BUILDER (per-handler LLM rules)
     ───────────────────────────────────────────────────────────────── */
  
  const BASE_CONSTRAINTS = [
    "Write 2-4 sentences ONLY.",
    "Use ONLY facts from the BRIEF. Never invent values, labels, or states.",
    "Never mention tag slugs (e.g. EXTRUDER_RPM) — use human labels (e.g. Extruder RPM).",
    "Never end with 'Let me know if you need anything' or similar filler.",
    "No chain-of-thought. No reasoning disclosure. No 'as an AI'.",
    "No code fences unless explicitly asked.",
    "Do not list readings — those appear separately.",
    "Do not repeat the machine name unless natural.",
  ];
  
  function buildConstraints(
    handler: HandlerType,
    intent: IntentSignals,
    ctx: ContextAssessment
  ): string[] {
    const c = [...BASE_CONSTRAINTS];
  
    switch (handler) {
      case "alerts":
        c.push("Focus on the alert situation. Name the most critical one first.");
        c.push("Do not infer causes — state only what the BRIEF shows.");
        c.push("Do not claim production is unavailable unless BRIEF explicitly says production unavailable.");
        c.push("Do not provide recommendations, suggestions, or offers to help.");
        c.push("Do not ask follow-up questions.");
        break;
  
      case "tags":
        c.push("Give a quick sense of overall system health based on what the data shows.");
        c.push("If any tag is above threshold, mention it without fabricating cause.");
        break;
  
      case "status":
        c.push("Give a confident, grounded overview. Do not be vague.");
        c.push("If alerts exist, mention the most important one.");
        c.push("If production metrics are present in BRIEF, mention them briefly and do not suppress them because of alerts.");
        c.push("Do not provide recommendations, suggestions, or offers to help.");
        break;
  
      case "stale_data":
        c.push("Lead with the fact that data may be stale. Do not state readings as current fact.");
        c.push("Suggest the operator verify or refresh the connection.");
        break;
  
      case "partial_telemetry":
        c.push("Acknowledge that only partial data is available.");
        c.push("State what you can see; note what's missing by system name, not slug.");
        break;
  
      case "conflicting_context":
        c.push("Fault flags are active but no DB alert matches. Flag this discrepancy explicitly.");
        c.push("Do not resolve the conflict — surface it for the operator to investigate.");
        break;
  
      case "missing_data":
        c.push("State clearly which data is unavailable. Do not fabricate alternatives.");
        c.push("If some data is present, summarize what you do have.");
        break;
  
      case "user_correction":
        c.push("Acknowledge the correction. State the current data clearly.");
        c.push("Do not argue. Do not repeat the previous answer.");
        break;
  
      case "multi_intent":
        c.push("If production metrics are present, include them even when alerts are critical.");
        c.push("Cover both alert severity and production values in one concise response.");
        break;
  
      case "repeated_question":
        c.push("If data has changed since last asked, say so. If unchanged, confirm briefly.");
        break;
  
      case "tool_failure":
        c.push("Do not invent data. State that the data source was unavailable.");
        break;
  
      case "general":
        if (intent.wantsGuess) {
          c.push("Do NOT guess or estimate. Only state what the data explicitly shows.");
        }
        if (intent.wantsCertainty) {
          c.push("Do not claim certainty beyond what the data shows. Use 'based on current readings' style language.");
        }
        if (intent.isEmotional) {
          c.push("Be calm and reassuring. Get straight to the point.");
        }
        if (intent.isSarcasm) {
          c.push("Ignore the sarcastic tone. Just answer the underlying question factually.");
        }
        break;
    }
  
    return c;
  }
  
  /* ─────────────────────────────────────────────────────────────────
     FALLBACK BUILDER (fully deterministic — no LLM needed)
     ───────────────────────────────────────────────────────────────── */
  
  function buildFallback(
    handler: HandlerType,
    ctx: ContextAssessment,
    health: string
  ): string {
    switch (handler) {
      case "alerts":
        if (!ctx.hasAlertData) return "No alert data is available right now. Check the alert pipeline.";
        return "Here's the current alert status based on available data.";
  
      case "tags":
        if (!ctx.hasTagData) return "No tag readings are available right now. The data connection may be down.";
        return "Here are the current readings from the machine.";
  
      case "status":
        return `Machine health is ${health}. Check the readings panel for details.`;
  
      case "stale_data":
        return `Readings may be stale. The last update was more than 10 minutes ago. Please verify the data connection.`;
  
      case "partial_telemetry":
        return `Only partial data is available right now. Some systems are not reporting.`;
  
      case "conflicting_context":
        return `Fault indicators are active but no matching alert was found in the system. Investigate manually.`;
  
      case "missing_data":
        return "Some requested data isn't available. Try again or check the data source.";
  
      case "escalation":
        return `⚠️ This sounds urgent. Contact your supervisor or maintenance team immediately. Do not rely solely on this system for emergency decisions.`;
  
      case "tool_failure":
        return "The data tool failed to return results. This is a temporary issue — please try again.";
  
      case "general":
        return "I don't have enough data to answer that right now.";
  
      default:
        return "I don't have enough context to answer confidently right now.";
    }
  }
  
  /* ─────────────────────────────────────────────────────────────────
     STEP 8 — validateOutput
     Checks LLM output for safety and quality issues.
     Returns the clean string or null (means: use fallback).
     ───────────────────────────────────────────────────────────────── */
  
  const KNOWN_SLUGS_LIST = Object.keys(TAGS);
  
  export function validateOutput(
    answer: string,
    packet: ContextPacket,
    liveContexts: { source: string; text: string }[]
  ): { valid: boolean; reason: string; cleaned: string } {
    if (!answer || answer.trim().length < 5) {
      return { valid: false, reason: "empty_or_too_short", cleaned: "" };
    }
  
    let cleaned = answer.trim();
  
    // Strip any leaked internal headers
    cleaned = cleaned
      .replace(/---\s*TOOL_RESULTS\s*---/gi, "")
      .replace(/\[TOOL_DATA:[^\]]*\]/gi, "")
      .replace(/\[DOCUMENTS\]/gi, "")
      .replace(/FIND_TAGS:[^\n]*/gi, "")
      .replace(/ACTIVE ALERTS \(last \d+ days\):\n?/gi, "")
      .replace(/MACHINE STATE SNAPSHOT[^\n]*:\n?/gi, "")
      .replace(/CURRENT TELEMETRY[^\n]*:\n?/gi, "")
      .replace(/TELEMETRY SNAPSHOT:\n?/gi, "")
      .replace(/BRIEF:\n?/gi, "")
      .trim();
  
    // Reject if LLM leaked raw slugs (3+ unknown ones)
    const allowedSlugs = extractLiveSlugsFromContexts(liveContexts);
    const mentionedSlugs = extractSlugMentions(cleaned);
    const unknownSlugs = mentionedSlugs.filter(s => !allowedSlugs.has(s));
    if (unknownSlugs.length >= 3) {
      return { valid: false, reason: `hallucinated_slugs:${unknownSlugs.slice(0, 4).join(",")}`, cleaned };
    }
  
    // Reject filler endings
    const fillerPattern = /let me know if (you need|there's anything)/i;
    if (fillerPattern.test(cleaned)) {
      cleaned = cleaned.replace(/\.?\s*Let me know if [\s\S]+$/, "").trim();
    }
  cleaned = cleaned
    .replace(/\s*Please let us know how we can assist further[\s\S]*$/i, "")
    .replace(/\s*If there's anything else you'd like assistance[\s\S]*$/i, "")
    .replace(/\s*what specific information you need[\s\S]*$/i, "")
    .trim();
  
    // Reject if too long (LLM ignored the 4-sentence rule)
    const sentenceCount = (cleaned.match(/[.!?]+/g) ?? []).length;
    if (sentenceCount > 6) {
      // Trim to first 4 sentences
      const sentences = cleaned.split(/(?<=[.!?])\s+/);
      cleaned = sentences.slice(0, 4).join(" ");
    }
  
    // Reject if still has "as an AI"
    if (/\b(as an AI|I am an AI|I'm an AI|I cannot|I am not able to)\b/i.test(cleaned)) {
      return { valid: false, reason: "ai_disclosure_leaked", cleaned };
    }
  
    return { valid: true, reason: "ok", cleaned };
  }
  
  function extractLiveSlugsFromContexts(liveContexts: { source: string; text: string }[]): Set<string> {
    const s = new Set<string>();
    for (const c of liveContexts) {
      if (c.source !== "tags_db" && c.source !== "tags_selected") continue;
      for (const m of c.text.matchAll(/^\s*\*\s+([A-Z][A-Z0-9_]{2,})\s*:/gm)) {
        if (m[1]) s.add(m[1]);
      }
    }
    return s;
  }
  
  function extractSlugMentions(text: string): string[] {
    const s = new Set<string>();
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g)) {
      if (m[1]) s.add(m[1]);
    }
    return [...s];
  }
  
  /* ─────────────────────────────────────────────────────────────────
     FULLY DETERMINISTIC HANDLERS (no LLM required)
     ───────────────────────────────────────────────────────────────── */
  
  export function handleGreeting(machineName = "RVL Laminator"): string {
    const greetings = [
      `Hey — I'm watching the ${machineName}. Ask me about status, alerts, or any readings.`,
      `Hi there. Ready to help with the lamination line. What do you need?`,
      `Hello. I've got live data from the ${machineName} — what would you like to know?`,
    ];
    // Deterministic selection based on hour
    const idx = new Date().getHours() % greetings.length;
    return greetings[idx] ?? greetings[0]!;
  }
  
  export function handleEscalation(): string {
    return `⚠️ **This sounds like an emergency situation.**\n\nContact your supervisor or maintenance team immediately. For machine fires, injuries, or explosions — follow your facility's emergency procedures. Do not rely on this system for emergency decisions.`;
  }
  
  export function handleUnsafeInput(): string {
    return "I can only help with lamination machine operations. Let's keep it focused on the production line.";
  }
  
  export function handleOutOfScope(): string {
    return "I'm set up specifically for the lamination line. I can help with machine status, alerts, tag readings, or production reports.";
  }
  
  export function handleAmbiguous(): string {
    return "Could you be a bit more specific? I can show you **machine status**, **alerts**, **tag readings**, or **production reports**.";
  }
  
  export function handleNoContext(): string {
    return "I don't have live data right now. The machine connection may be down — check the data pipeline or try again in a moment.";
  }
  
  export function handleToolFailure(): string {
    return "I couldn't reach the data source right now. This is usually temporary — please try again in a moment.";
  }
  
  /* ─────────────────────────────────────────────────────────────────
     LLM SYSTEM PROMPT BUILDER
     Builds the final system prompt that the small model receives.
     This is deliberately compact and rule-driven.
     ───────────────────────────────────────────────────────────────── */
  
  export function buildLlmSystemPrompt(packet: ContextPacket): string {
    const constraintBlock = packet.constraints
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
  
    return `You are Ravi, the RVL Lamination Assistant. Calm, experienced, direct.
  
  RULES (follow exactly):
  ${constraintBlock}
  
  BRIEF:
  ${packet.brief}
  
  Write your response now (2-4 sentences only):`;
  }
  
  /* ─────────────────────────────────────────────────────────────────
     FINAL ASSEMBLY
     Combines LLM narrative with deterministic blocks.
     ───────────────────────────────────────────────────────────────── */
  
  export function assembleFinalResponse(
    narrative: string,
    packet: ContextPacket,
    handler: HandlerDecision
  ): string {
    const { preRendered } = packet;
    const sections: string[] = [];
  
    if (narrative.trim()) sections.push(narrative.trim());
  
    if (preRendered.alertsBlock) sections.push(preRendered.alertsBlock);

  if (preRendered.productionBlock) sections.push(preRendered.productionBlock);
  
  if (preRendered.watchBlock && handler.handler !== "alerts") {
      sections.push(`**Worth watching:**\n${preRendered.watchBlock}`);
    }
  
    if (preRendered.readingsBlock) sections.push(preRendered.readingsBlock);
  
    if (preRendered.missingNote) sections.push(`_${preRendered.missingNote}_`);
  
    if (sections.length === 0) return packet.fallback;
  
    return sections.join("\n\n");
  }