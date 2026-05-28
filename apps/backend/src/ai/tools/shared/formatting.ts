import { isTrueValue } from "./args.js";
import type { TagDefinitionRecord } from "./types.js";

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

export function formatTagValue(def: TagDefinitionRecord, value: unknown): string {
  if (value === null || value === undefined) return "No data";
  if (def.slug.endsWith("_FAULT"))
    return isTrueValue(value) ? "Fault" : "Clear";
  if (def.slug === "EMG_STOP" || def.slug === "ALARM_IND")
    return isTrueValue(value) ? "Active" : "Clear";
  if (def.slug.endsWith("_ON_OFF") || def.slug === "SPLICE_ON_OFF")
    return isTrueValue(value) ? "ON" : "OFF";
  const suffix = def.unit ? ` ${def.unit}` : "";
  if (typeof value === "number") return `${formatNumber(value)}${suffix}`;
  if (typeof value === "boolean") return value ? "True" : "False";
  return `${value}${suffix}`;
}
