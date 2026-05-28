import type { TagDefinitionRecord, TagLatestRecord } from "./types.js";

export function parseTime(input: string | undefined, fallbackMs: number): Date {
  if (!input) return new Date(Date.now() - fallbackMs);
  const value = input.trim().toLowerCase();
  const relative = /^(\d+)(m|h|d)$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * mult);
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime())
    ? new Date(Date.now() - fallbackMs)
    : parsed;
}

export function isDateOnly(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
}

export function parseIstDateOnlyStart(input: string): Date {
  return new Date(`${input.trim()}T00:00:00+05:30`);
}

export function nextDay(date: Date): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function isStale(
  def: TagDefinitionRecord,
  latest: TagLatestRecord | null,
  now = new Date(),
): boolean {
  if (!latest) return true;
  if (!def.staleAfterMs) return false;
  return now.getTime() - latest.ts.getTime() > def.staleAfterMs;
}
