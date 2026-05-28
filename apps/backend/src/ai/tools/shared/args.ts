export type ToolArgs = Record<string, unknown>;

export function textArg(args: ToolArgs, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

export function numberArg(
  args: ToolArgs,
  key: string,
  fallback: number,
  max = 500,
): number {
  const raw = args[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

export function stringArrayArg(args: ToolArgs, key: string): string[] {
  const raw = args[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    )
    .map((item) => item.trim());
}

export function tagValue(
  latest: {
    valueNumber: number | null;
    valueBool: boolean | null;
    valueString: string | null;
  } | null,
): number | boolean | string | null {
  if (!latest) return null;
  if (latest.valueBool !== null && latest.valueBool !== undefined)
    return latest.valueBool;
  if (latest.valueNumber !== null && latest.valueNumber !== undefined)
    return latest.valueNumber;
  if (latest.valueString !== null && latest.valueString !== undefined)
    return latest.valueString;
  return null;
}

export function isTrueValue(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}
