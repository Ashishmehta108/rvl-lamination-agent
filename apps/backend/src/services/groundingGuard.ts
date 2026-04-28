import type { ContextPacket } from "../handlers/chatHandler.js";

type LiveContext = { source: string; text: string };

/**
 * Confidence states for grounding decisions.
 * - grounded: answer matches evidence well
 * - partial: some claims unsupported but not contradicted
 * - insufficient: no evidence basis for answer; use contextPacket.fallback
 * - contradicted: answer directly contradicts known live state
 */
export type GroundingConfidence = "grounded" | "partial" | "insufficient" | "contradicted";

export interface GroundingGuardResult {
  /** Derived: true when confidence is "grounded" or "partial". */
  valid: boolean;
  confidence: GroundingConfidence;
  reason: string;
  cleaned: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractOpenAlertCounts(liveContexts: LiveContext[]) {
  const counts = { critical: 0, warning: 0, info: 0 };
  const alertBlock = liveContexts.find((c) => c.source === "alerts_db");
  if (!alertBlock) return counts;

  for (const line of alertBlock.text.split("\n")) {
    const m = line.match(/ALERT\s*#\d+:\s*\[(\w+)\]\s*status:\s*(\w+)/i);
    if (!m) continue;
    const severity = m[1]?.toLowerCase();
    const status = m[2]?.toLowerCase();
    if (status !== "open") continue;
    if (severity === "critical" || severity === "warning" || severity === "info") {
      counts[severity] += 1;
    }
  }
  return counts;
}

function hasProductionData(liveContexts: LiveContext[]): boolean {
  return liveContexts.some(
    (c) =>
      c.source === "production_db" &&
      !c.text.includes("No production metrics") &&
      !c.text.includes("0 buckets")
  );
}

function hasTagData(liveContexts: LiveContext[]): boolean {
  return liveContexts.some(
    (c) =>
      (c.source === "tags_db" || c.source === "tags_selected") &&
      !c.text.includes("No tags found") &&
      !c.text.includes("No latest values found")
  );
}

function buildEvidenceText(packet: ContextPacket, liveContexts: LiveContext[]): string {
  return normalizeWhitespace(
    [
      packet.brief,
      packet.preRendered.introLine,
      packet.preRendered.alertsBlock ?? "",
      packet.preRendered.productionBlock ?? "",
      packet.preRendered.watchBlock ?? "",
      packet.preRendered.readingsBlock ?? "",
      packet.preRendered.missingNote ?? "",
      ...liveContexts.map((c) => c.text),
    ].join("\n")
  );
}

function extractNumberTokens(text: string): string[] {
  // Extract numbers and normalize (strip trailing % or units for matching)
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)(?:\s*%|%)?\b/g)].map((m) => m[1]!);
}

function collectUnsupportedNumbers(answer: string, evidenceText: string): string[] {
  const evidence = new Set(extractNumberTokens(evidenceText));
  const seen = new Set<string>();
  const unsupported: string[] = [];
  for (const token of extractNumberTokens(answer)) {
    if (evidence.has(token) || seen.has(token)) continue;
    seen.add(token);
    unsupported.push(token);
  }
  return unsupported;
}

/**
 * Scores how well the answer's numeric claims are grounded in the evidence.
 * Returns 0–1: 0 means no numbers in the answer appear in the evidence.
 * Returns 1 when: (a) answer has no numbers, or (b) all answer numbers appear in evidence.
 */
export function groundingScore(answer: string, evidenceText: string): number {
  const answerNums = extractNumberTokens(answer);
  if (answerNums.length === 0) return 1; // no numeric claims — no grounding issue
  const evidenceNums = new Set(extractNumberTokens(evidenceText));
  const matched = answerNums.filter((n) => evidenceNums.has(n));
  return matched.length / answerNums.length;
}

/**
 * Detects temporal claims (yesterday, last week, previously, etc.) in the answer
 * when the evidence has no corresponding time-range data to support them.
 * Returns the violation reason string, or null if clean.
 */
export function unsupportedClaimDetector(answer: string, evidenceText: string): string | null {
  const temporalPattern =
    /\b(yesterday|last\s+week|last\s+month|previously|earlier\s+today|this\s+morning|before|prior\s+shift)\b/i;
  if (!temporalPattern.test(answer)) return null;

  // If the evidence itself contains time-range language, claims are at least grounded
  const evidenceHasRange =
    /\b(from|to|between|during|over\s+the\s+past|in\s+the\s+last|since)\b/i.test(evidenceText);
  if (evidenceHasRange) return null;

  return "temporal_claim_without_evidence";
}

function contradictsKnownState(answer: string, liveContexts: LiveContext[]): string | null {
  const text = answer.toLowerCase();
  const alerts = extractOpenAlertCounts(liveContexts);
  const production = hasProductionData(liveContexts);
  const tags = hasTagData(liveContexts);

  if (
    (alerts.critical > 0 || alerts.warning > 0) &&
    /\b(no alerts|no active alerts|all clear|everything looks normal)\b/i.test(text)
  ) {
    return "contradicts_active_alerts";
  }

  if (alerts.critical > 0 && /\b(healthy|normal|running fine|looks good)\b/i.test(text)) {
    return "contradicts_critical_alerts";
  }

  if (
    production &&
    /\b(no production data|production unavailable|no production metrics)\b/i.test(text)
  ) {
    return "contradicts_production_data";
  }

  if (
    tags &&
    /\b(no live data|no readings|cannot access live data|don't have live data)\b/i.test(text)
  ) {
    return "contradicts_live_tag_data";
  }

  return null;
}

function makeResult(
  confidence: GroundingConfidence,
  reason: string,
  cleaned: string
): GroundingGuardResult {
  return {
    valid: confidence === "grounded" || confidence === "partial",
    confidence,
    reason,
    cleaned,
  };
}

export function enforceGroundingGuard(
  answer: string,
  packet: ContextPacket,
  liveContexts: LiveContext[]
): GroundingGuardResult {
  const cleaned = normalizeWhitespace(answer);
  if (!cleaned) return makeResult("insufficient", "empty_after_cleaning", cleaned);

  // 1. Hard contradiction check
  const contradiction = contradictsKnownState(cleaned, liveContexts);
  if (contradiction) {
    return makeResult("contradicted", contradiction, cleaned);
  }

  const evidenceText = buildEvidenceText(packet, liveContexts);

  // 2. Temporal claim without evidence
  const temporalViolation = unsupportedClaimDetector(cleaned, evidenceText);
  if (temporalViolation) {
    return makeResult("partial", temporalViolation, cleaned);
  }

  // 3. Grounding score — if answer has numbers but none match evidence, reject
  const score = groundingScore(cleaned, evidenceText);
  if (score === 0 && extractNumberTokens(cleaned).length >= 2) {
    const nums = extractNumberTokens(cleaned).slice(0, 4).join(",");
    return makeResult("insufficient", `ungrounded_numbers:${nums}`, cleaned);
  }

  // 4. Unsupported number count (2+ numbers not in evidence)
  const unsupportedNumbers = collectUnsupportedNumbers(cleaned, evidenceText);
  if (unsupportedNumbers.length >= 2) {
    return makeResult(
      "partial",
      `unsupported_numbers:${unsupportedNumbers.slice(0, 4).join(",")}`,
      cleaned
    );
  }

  // 5. Overconfidence without fresh evidence
  const noData =
    !hasTagData(liveContexts) &&
    !hasProductionData(liveContexts) &&
    extractOpenAlertCounts(liveContexts).critical === 0;

  if (noData && /\b(currently|right now|at the moment)\b/i.test(cleaned) && cleaned.length > 160) {
    return makeResult("insufficient", "overconfident_without_fresh_evidence", cleaned);
  }

  return makeResult("grounded", "grounded", cleaned);
}
