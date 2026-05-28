import type { TagDefinitionRecord } from "./types.js";
import { breachForValue } from "./thresholds.js";
import { formatTagValue } from "./formatting.js";

// ── Boolean tag guard ─────────────────────────────────────────────────────────
const BOOLEAN_TAG_SUFFIXES = ["_FAULT", "_ON_OFF"] as const;
const BOOLEAN_TAG_EXACT = ["EMG_STOP", "ALARM_IND"] as const;

export function isBooleanTag(slug: string): boolean {
  return (
    BOOLEAN_TAG_SUFFIXES.some((s) => slug.endsWith(s)) ||
    (BOOLEAN_TAG_EXACT as readonly string[]).includes(slug)
  );
}

/**
 * Detects threshold-breach anomalies in a numeric sample series.
 *
 * State machine: tracks contiguous breach windows and emits:
 *   1. The first crossing (entry) of each breach window.
 *   2. The peak (most extreme) sample in that window, if different from entry.
 *
 * Boolean tags (e.g. *_FAULT, EMG_STOP) are skipped entirely.
 * Returns at most 10 anomaly entries.
 */
export function detectAnomalies(
  samples: { ts: string; value: unknown }[],
  def: TagDefinitionRecord,
): { ts: string; value: number; reason: string }[] {
  if (isBooleanTag(def.slug)) return [];

  const anomalies: { ts: string; value: number; reason: string }[] = [];
  let inBreach = false;
  let entryValue = 0;
  let peakValue = 0;
  let peakTs = "";
  let peakBreach: { severity: string; side: string; threshold: number } | null = null;

  // Hoist unit string — was recomputed inside breachReason on every call.
  const unit = def.unit ? ` ${def.unit}` : "";

  function breachReason(
    severity: string,
    side: string,
    threshold: number,
    kind: "entered" | "peak",
  ): string {
    return kind === "entered"
      ? `entered ${severity} ${side} threshold ${threshold}${unit}`
      : `peak ${severity} breach (${threshold}${unit} limit)`;
  }

  for (const sample of samples) {
    // Early exit once the 10-anomaly cap is reached —
    // avoids scanning thousands of remaining samples uselessly.
    if (anomalies.length >= 10) break;

    if (typeof sample.value !== "number") continue;
    const value = sample.value;
    const breach = breachForValue(def, value);

    if (breach && !inBreach) {
      // ── New breach window starts ──
      anomalies.push({
        ts: sample.ts,
        value,
        reason: breachReason(breach.severity, breach.side, breach.threshold, "entered"),
      });
      inBreach = true;
      entryValue = value;
      peakValue = value;
      peakTs = sample.ts;
      peakBreach = breach;
    } else if (breach && inBreach) {
      // ── Inside breach window — track peak ──
      const isMoreExtreme =
        breach.side === "high" ? value > peakValue : value < peakValue;
      if (isMoreExtreme) {
        peakValue = value;
        peakTs = sample.ts;
        peakBreach = breach;
      }
    } else if (!breach && inBreach) {
      // ── Breach window ended — emit peak if it differs from entry ──
      if (peakValue !== entryValue && peakBreach && anomalies.length < 10) {
        anomalies.push({
          ts: peakTs,
          value: peakValue,
          reason: breachReason(peakBreach.severity, peakBreach.side, peakBreach.threshold, "peak"),
        });
      }
      inBreach = false;
      peakBreach = null;
    }
  }

  // Still breaching at end of window — emit peak if different from entry
  if (inBreach && peakValue !== entryValue && peakBreach && anomalies.length < 10) {
    anomalies.push({
      ts: peakTs,
      value: peakValue,
      reason: breachReason(peakBreach.severity, peakBreach.side, peakBreach.threshold, "peak") + " (ongoing)",
    });
  }

  return anomalies;
}

/**
 * Compares the average of the first third of `numbers` against the last third.
 * Returns "rising" if last avg > first avg by >5%, "falling" if <5%, else "stable".
 * Always returns "stable" when fewer than 6 numbers are available.
 */
export function detectTrend(numbers: number[]): "rising" | "falling" | "stable" {
  if (numbers.length < 6) return "stable";
  const third = Math.floor(numbers.length / 3);
  const firstSlice = numbers.slice(0, third);
  const lastSlice = numbers.slice(-third);
  const firstAvg = firstSlice.reduce((s, v) => s + v, 0) / firstSlice.length;
  const lastAvg = lastSlice.reduce((s, v) => s + v, 0) / lastSlice.length;
  if (lastAvg > firstAvg * 1.05) return "rising";
  if (lastAvg < firstAvg * 0.95) return "falling";
  return "stable";
}
