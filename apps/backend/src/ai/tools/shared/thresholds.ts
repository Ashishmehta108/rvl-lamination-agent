import { isTrueValue } from "./args.js";
import type { TagDefinitionRecord } from "./types.js";

export function computeStatus(
  def: TagDefinitionRecord,
  value: unknown,
): "normal" | "warn" | "alarm" | "fault" {
  if (def.slug.endsWith("_FAULT") && isTrueValue(value)) return "fault";
  if (
    (def.slug.endsWith("_ON_OFF") || def.slug === "SPLICE_ON_OFF") &&
    !isTrueValue(value)
  )
    return "warn";
  if (
    (def.slug === "EMG_STOP" || def.slug === "ALARM_IND") &&
    isTrueValue(value)
  )
    return "fault";
  if (typeof value !== "number") return "normal";
  if (
    (def.alarmHigh !== null && value >= def.alarmHigh) ||
    (def.alarmLow !== null && value <= def.alarmLow)
  )
    return "alarm";
  if (
    (def.warnHigh !== null && value >= def.warnHigh) ||
    (def.warnLow !== null && value <= def.warnLow)
  )
    return "warn";
  return "normal";
}

export function thresholdText(def: TagDefinitionRecord): string | null {
  const parts: string[] = [];
  if (def.warnHigh !== null) parts.push(`warnHigh ${def.warnHigh}`);
  if (def.alarmHigh !== null) parts.push(`alarmHigh ${def.alarmHigh}`);
  if (def.warnLow !== null) parts.push(`warnLow ${def.warnLow}`);
  if (def.alarmLow !== null) parts.push(`alarmLow ${def.alarmLow}`);
  return parts.length ? parts.join(", ") : null;
}

export function subsystemFor(slug: string, department: string | null): string {
  const key = `${department ?? ""} ${slug}`.toLowerCase();
  if (key.includes("extruder")) return "extruder";
  if (key.includes("laminator")) return "laminator";
  if (key.includes("winder") && !key.includes("unwinder")) return "winder";
  if (key.includes("emg") || key.includes("alarm") || key.includes("fault"))
    return "safety";
  return "production";
}

export function breachForValue(
  def: TagDefinitionRecord,
  value: number,
): {
  severity: "warning" | "critical";
  side: "high" | "low";
  threshold: number;
} | null {
  if (def.alarmHigh !== null && value >= def.alarmHigh)
    return { severity: "critical", side: "high", threshold: def.alarmHigh };
  if (def.alarmLow !== null && value <= def.alarmLow)
    return { severity: "critical", side: "low", threshold: def.alarmLow };
  if (def.warnHigh !== null && value >= def.warnHigh)
    return { severity: "warning", side: "high", threshold: def.warnHigh };
  if (def.warnLow !== null && value <= def.warnLow)
    return { severity: "warning", side: "low", threshold: def.warnLow };
  return null;
}
