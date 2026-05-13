import type { FastifyBaseLogger } from "fastify";
import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { getPrismaClient } from "../db/mongo.js";
import { getPostgresDb, schema } from "../db/postgres.js";

type JsonRecord = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;

type TagDefinitionRecord = {
  id: string;
  machineId: string;
  machineRevision: string;
  tagId: string;
  slug: string;
  name: string;
  unit: string | null;
  dataType: string;
  deadband: number | null;
  min: number | null;
  max: number | null;
  maxRatePerSec: number | null;
  sampleEveryMs: number | null;
  staleAfterMs: number | null;
  warnHigh: number | null;
  warnLow: number | null;
  alarmHigh: number | null;
  alarmLow: number | null;
  department: string | null;
  engineerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TagLatestRecord = {
  tagId: string;
  ts: Date;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueString: string | null;
  quality: string;
  lastSampleAt: Date | null;
  updatedAt: Date;
};

export const TOOL_NAMES = [
  "get_live_tag_values",
  "get_all_live_tags",
  "get_tag_history",
  "get_active_alerts",
  "get_alert_history",
  "get_tag_definition",
  "get_production_summary",
  "search_tags",
  "get_machine_status",
  "acknowledge_alert",
  "get_chat_sessions",
  "get_tag_comparison",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

function textArg(args: ToolArgs, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

function numberArg(
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

function stringArrayArg(args: ToolArgs, key: string): string[] {
  const raw = args[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    )
    .map((item) => item.trim());
}

function tagValue(
  latest: Pick<
    TagLatestRecord,
    "valueNumber" | "valueBool" | "valueString"
  > | null,
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

function isTrueValue(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

function parseTime(input: string | undefined, fallbackMs: number): Date {
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

function isDateOnly(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
}

function parseIstDateOnlyStart(input: string): Date {
  return new Date(`${input.trim()}T00:00:00+05:30`);
}

function nextDay(date: Date): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function isStale(
  def: TagDefinitionRecord,
  latest: TagLatestRecord | null,
  now = new Date(),
): boolean {
  if (!latest) return true;
  if (!def.staleAfterMs) return false;
  return now.getTime() - latest.ts.getTime() > def.staleAfterMs;
}

function computeStatus(
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

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

function formatTagValue(def: TagDefinitionRecord, value: unknown): string {
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

function thresholdText(def: TagDefinitionRecord): string | null {
  const parts: string[] = [];
  if (def.warnHigh !== null) parts.push(`warnHigh ${def.warnHigh}`);
  if (def.alarmHigh !== null) parts.push(`alarmHigh ${def.alarmHigh}`);
  if (def.warnLow !== null) parts.push(`warnLow ${def.warnLow}`);
  if (def.alarmLow !== null) parts.push(`alarmLow ${def.alarmLow}`);
  return parts.length ? parts.join(", ") : null;
}

function subsystemFor(slug: string, department: string | null): string {
  const key = `${department ?? ""} ${slug}`.toLowerCase();
  if (key.includes("extruder")) return "extruder";
  if (key.includes("laminator")) return "laminator";
  if (key.includes("winder") && !key.includes("unwinder")) return "winder";
  if (key.includes("emg") || key.includes("alarm") || key.includes("fault"))
    return "safety";
  return "production";
}
function summarizeNumbers(values: number[]) {
  if (!values.length) return { min: null, max: null, avg: null, stdDev: null };
  
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  const avg = sum / values.length;
  let variance = 0;
  for (const v of values) variance += (v - avg) ** 2;

  return { min, max, avg, stdDev: Math.sqrt(variance / values.length) };
}



async function findDefinitionsBySlugs(
  machineId: string,
  slugs: string[],
): Promise<TagDefinitionRecord[]> {
  if (!slugs.length) return [];
  const prisma = getPrismaClient();
  const upper = slugs.map((slug) => slug.toUpperCase());
  return prisma.tagDefinition.findMany({
    where: { machineId, slug: { in: upper } },
    select: tagDefinitionSelect,
  }) as Promise<TagDefinitionRecord[]>;
}

const tagDefinitionSelect = {
  id: true,
  machineId: true,
  machineRevision: true,
  tagId: true,
  slug: true,
  name: true,
  unit: true,
  dataType: true,
  deadband: true,
  min: true,
  max: true,
  maxRatePerSec: true,
  sampleEveryMs: true,
  staleAfterMs: true,
  warnHigh: true,
  warnLow: true,
  alarmHigh: true,
  alarmLow: true,
  department: true,
  engineerEmail: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function resolveTagId(
  query: string,
  machineId: string,
): Promise<TagDefinitionRecord | null> {
  const prisma = getPrismaClient();
  const normalized = query.trim();
  if (!normalized) return null;
  const exactSlug = await prisma.tagDefinition.findFirst({
    where: { machineId, slug: { equals: normalized.toUpperCase() } },
    select: tagDefinitionSelect,
  });
  if (exactSlug) return exactSlug as TagDefinitionRecord;

  const nameMatch = await prisma.tagDefinition.findFirst({
    where: { machineId, name: { contains: normalized, mode: "insensitive" } },
    select: tagDefinitionSelect,
  });
  if (nameMatch) return nameMatch as TagDefinitionRecord;

  const slugMatch = await prisma.tagDefinition.findFirst({
    where: { machineId, slug: { contains: normalized.toUpperCase() } },
    select: tagDefinitionSelect,
  });
  return (slugMatch as TagDefinitionRecord | null) ?? null;
}

async function resolveTagMatches(
  query: string,
  machineId: string,
  limit = 3,
): Promise<TagDefinitionRecord[]> {
  const prisma = getPrismaClient();
  const normalized = query.trim();
  if (!normalized) return [];
  const exact = await prisma.tagDefinition.findMany({
    where: { machineId, slug: { equals: normalized.toUpperCase() } },
    select: tagDefinitionSelect,
    take: limit,
  });
  if (exact.length) return exact as TagDefinitionRecord[];
  return prisma.tagDefinition.findMany({
    where: {
      machineId,
      OR: [
        { name: { contains: normalized, mode: "insensitive" } },
        { slug: { contains: normalized.toUpperCase() } },
        { department: { contains: normalized, mode: "insensitive" } },
      ],
    },
    select: tagDefinitionSelect,
    take: limit,
  }) as Promise<TagDefinitionRecord[]>;
}

async function latestByTagId(
  machineId: string,
  tagIds: string[],
): Promise<Map<string, TagLatestRecord>> {
  const prisma = getPrismaClient();
  if (!tagIds.length) return new Map();
  const latest = await prisma.tagLatest.findMany({
    where: { machineId, tagId: { in: tagIds } },
    select: {
      tagId: true,
      ts: true,
      valueNumber: true,
      valueBool: true,
      valueString: true,
      quality: true,
      lastSampleAt: true,
      updatedAt: true,
    },
  });
  return new Map(
    (latest as TagLatestRecord[]).map((item) => [item.tagId, item]),
  );
}

function breachForValue(
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

async function getDerivedThresholdAlerts(args: {
  machineId: string;
  from: Date;
  to: Date;
  severity: string;
  tagSlug: string;
  limit: number;
}) {
  const prisma = getPrismaClient();
  let definitions = (await prisma.tagDefinition.findMany({
    where: {
      machineId: args.machineId,
      dataType: "number",
      OR: [
        { warnHigh: { not: null } },
        { warnLow: { not: null } },
        { alarmHigh: { not: null } },
        { alarmLow: { not: null } },
      ],
    },
    select: tagDefinitionSelect,
    take: 500,
  })) as TagDefinitionRecord[];

  if (args.tagSlug) {
    const resolved = await resolveTagId(args.tagSlug, args.machineId);
    if (!resolved) return [];
    definitions = definitions.filter((def) => def.tagId === resolved.tagId);
  }

  const defByTagId = new Map(definitions.map((def) => [def.tagId, def]));
  if (!defByTagId.size) return [];

  const samples = await prisma.tagSample.findMany({
    where: {
      machineId: args.machineId,
      tagId: { in: [...defByTagId.keys()] },
      ts: { gte: args.from, lt: args.to },
      valueNumber: { not: null },
    },
    select: { tagId: true, ts: true, valueNumber: true },
    orderBy: { ts: "asc" },
    take: 20_000,
  });

  const byTag = new Map<
    string,
    {
      def: TagDefinitionRecord;
      severity: "warning" | "critical";
      firstAt: Date;
      lastAt: Date;
      maxValue: number;
      minValue: number;
      sampleCount: number;
      threshold: number;
      side: "high" | "low";
    }
  >();

  for (const sample of samples) {
    if (typeof sample.valueNumber !== "number") continue;
    const def = defByTagId.get(sample.tagId);
    if (!def) continue;
    const breach = breachForValue(def, sample.valueNumber);
    if (!breach) continue;
    if (args.severity !== "all" && breach.severity !== args.severity) continue;

    const existing = byTag.get(sample.tagId);
    if (!existing) {
      byTag.set(sample.tagId, {
        def,
        severity: breach.severity,
        firstAt: sample.ts,
        lastAt: sample.ts,
        maxValue: sample.valueNumber,
        minValue: sample.valueNumber,
        sampleCount: 1,
        threshold: breach.threshold,
        side: breach.side,
      });
      continue;
    }
    existing.lastAt = sample.ts;
    existing.maxValue = Math.max(existing.maxValue, sample.valueNumber);
    existing.minValue = Math.min(existing.minValue, sample.valueNumber);
    existing.sampleCount += 1;
    if (existing.severity !== "critical" && breach.severity === "critical") {
      existing.severity = "critical";
      existing.threshold = breach.threshold;
      existing.side = breach.side;
    }
  }

  return [...byTag.values()]
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return b.lastAt.getTime() - a.lastAt.getTime();
    })
    .slice(0, args.limit)
    .map((item) => {
      const representativeValue =
        item.side === "high" ? item.maxValue : item.minValue;
      return {
        id: `derived:${args.machineId}:${item.def.tagId}:${item.firstAt.toISOString()}`,
        source: "derived_from_tag_samples",
        severity: item.severity,
        status: "historical",
        title: `${item.def.name} ${item.severity === "critical" ? "ALARM" : "WARN"} (${item.side})`,
        description: `${item.def.name} (${item.def.slug}) reached ${formatTagValue(item.def, representativeValue)} against ${item.side} threshold ${item.threshold}${item.def.unit ? ` ${item.def.unit}` : ""}.`,
        startsAt: item.firstAt.toISOString(),
        endsAt: item.lastAt.toISOString(),
        sampleCount: item.sampleCount,
        tag: {
          tagId: item.def.tagId,
          slug: item.def.slug,
          name: item.def.name,
          unit: item.def.unit,
          value: representativeValue,
          displayValue: formatTagValue(item.def, representativeValue),
          threshold: item.threshold,
          side: item.side,
        },
      };
    });
}

async function getLiveTagValues(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const tagQueries = stringArrayArg(args, "tags");
  const resolvedGroups = await Promise.all(
    tagQueries.map((query) => resolveTagMatches(query, machineId, 5)),
  );
  const definitions = [
    ...new Map(resolvedGroups.flat().map((def) => [def.tagId, def])).values(),
  ];
  if (!definitions.length) {
    return {
      error: `Tag not found: ${tagQueries.join(", ")}. Use search_tags to find available tags.`,
    };
  }
  const latest = await latestByTagId(
    machineId,
    definitions.map((def) => def.tagId),
  );
  const values = definitions.map((def) => {
    const row = latest.get(def.tagId) ?? null;
    return {
      tagId: def.tagId,
      slug: def.slug,
      name: def.name,
      unit: def.unit,
      value: tagValue(row),
      displayValue: formatTagValue(def, tagValue(row)),
      quality: row?.quality ?? "missing",
      status: computeStatus(def, tagValue(row)),
      ts: row?.ts.toISOString() ?? null,
      isStale: isStale(def, row),
      thresholds: thresholdText(def),
    };
  });
  const safety = values.filter(
    (item) =>
      (item.slug === "EMG_STOP" || item.slug.endsWith("_FAULT")) &&
      isTrueValue(item.value),
  );
  return {
    notice: safety.length
      ? `SAFETY ALERT: ${safety.map((item) => item.slug).join(", ")} active.`
      : undefined,
    values,
  };
}

async function getAllLiveTags(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const prisma = getPrismaClient();
  const definitions = (await prisma.tagDefinition.findMany({
    where: { machineId },
    select: tagDefinitionSelect,
    take: 500,
  })) as TagDefinitionRecord[];
  const latest = await latestByTagId(
    machineId,
    definitions.map((def) => def.tagId),
  );
  const grouped: Record<string, JsonRecord[]> = {
    extruder: [],
    laminator: [],
    winder: [],
    production: [],
    safety: [],
  };
  // Build attention list in the same pass — avoids a second .flat() + .filter()
  // and computes subsystemFor only once per tag instead of twice.
  const attention: JsonRecord[] = [];
  for (const def of definitions) {
    const row = latest.get(def.tagId) ?? null;
    const value = tagValue(row);
    const stale = isStale(def, row);
    const status = stale ? "stale" : computeStatus(def, value);
    const subsystem = subsystemFor(def.slug, def.department);
    const ts = row?.ts.toISOString() ?? null;
    const thresholds = thresholdText(def);
    const displayValue = formatTagValue(def, value);

    grouped[subsystem]?.push({
      slug: def.slug,
      name: def.name,
      value,
      displayValue,
      unit: def.unit,
      status,
      ts,
      isStale: stale,
      thresholds,
    });

    if (status !== "normal") {
      attention.push({
        subsystem,
        slug: def.slug,
        name: def.name,
        displayValue,
        status,
        thresholds,
        ts,
      });
    }
  }
  return {
    machineId,
    capturedAt: new Date().toISOString(),
    attention,
    grouped,
  };
}

async function getTagHistory(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const query = textArg(args, "tag");
  const def = await resolveTagId(query, machineId);
  if (!def)
    return {
      error: `Tag not found: ${query}. Use search_tags to find available tags.`,
    };
  // Read "to" arg once — avoids calling textArg twice (truthy check + value).
  const toInput = textArg(args, "to");
  const to = toInput ? parseTime(toInput, 0) : new Date();
  const from = parseTime(textArg(args, "from", "1h"), 3_600_000);
  const limit = numberArg(args, "limit", 200, 1000);
  const prisma = getPrismaClient();
  const rows = await prisma.tagSample.findMany({
    where: { machineId, tagId: def.tagId, ts: { gte: from, lte: to } },
    select: { ts: true, valueNumber: true, valueBool: true, valueString: true },
    orderBy: { ts: "asc" },
    take: limit,
  });
  // Collect numeric values in the same pass as building samples —
  // eliminates the second .map().filter() chain over the samples array.
  const numbers: number[] = [];
  const samples = rows.map((row) => {
    const value = tagValue(row);
    if (typeof value === "number") numbers.push(value);
    return { ts: row.ts.toISOString(), value };
  });
  const stats = summarizeNumbers(numbers);
  return {
    tag: { slug: def.slug, name: def.name, unit: def.unit },
    samples,
    count: samples.length,
    from: from.toISOString(),
    to: to.toISOString(),
    ...stats,
  };
}

async function alertRowsWithTags(
  alerts: Array<typeof schema.alertEvents.$inferSelect>,
) {
  const db = getPostgresDb();
  if (!alerts.length) return [];
  const ids = alerts.map((alert) => alert.id);
  const tags = await db
    .select()
    .from(schema.alertTags)
    .where(inArray(schema.alertTags.alertEventId, ids));
  const tagsByAlert = new Map<
    string,
    Array<typeof schema.alertTags.$inferSelect>
  >();
  for (const tag of tags) {
    const list = tagsByAlert.get(tag.alertEventId) ?? [];
    list.push(tag);
    tagsByAlert.set(tag.alertEventId, list);
  }
  return alerts.map((alert) => ({
    id: alert.id,
    severity: alert.severity,
    status: alert.status,
    title: alert.title,
    description: alert.description,
    startsAt: alert.startsAt.toISOString(),
    endsAt: alert.endsAt?.toISOString() ?? null,
    durationMinutes: Math.round(
      ((alert.endsAt ?? new Date()).getTime() - alert.startsAt.getTime()) /
        60_000,
    ),
    tags: (tagsByAlert.get(alert.id) ?? []).map((tag) => ({
      tagId: tag.tagId,
      value:
        typeof tag.tagSnapshot === "object" && tag.tagSnapshot !== null
          ? ((tag.tagSnapshot as JsonRecord).value ?? tag.tagSnapshot)
          : tag.tagSnapshot,
    })),
    llmAnalysis: alert.llmAnalysis,
  }));
}

async function getActiveAlerts(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const status = textArg(args, "status", "open");
  const severity = textArg(args, "severity", "all");
  const limit = numberArg(args, "limit", 20, 100);
  const filters = [eq(schema.alertEvents.machineId, machineId)];
  if (status !== "all")
    filters.push(
      eq(
        schema.alertEvents.status,
        status as "open" | "acknowledged" | "resolved",
      ),
    );
  if (severity !== "all")
    filters.push(
      eq(
        schema.alertEvents.severity,
        severity as "info" | "warning" | "critical",
      ),
    );
  const rows = await getPostgresDb()
    .select()
    .from(schema.alertEvents)
    .where(and(...filters))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(limit);
  return alertRowsWithTags(rows);
}

async function getAlertHistory(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const fromInput = textArg(args, "from", "24h");
  const toInput = textArg(args, "to");
  const from = isDateOnly(fromInput)
    ? parseIstDateOnlyStart(fromInput)
    : parseTime(fromInput, 86_400_000);
  let to = toInput
    ? isDateOnly(toInput)
      ? nextDay(parseIstDateOnlyStart(toInput))
      : parseTime(toInput, 0)
    : new Date();
  if (isDateOnly(fromInput) && (!toInput || to.getTime() <= from.getTime())) {
    to = nextDay(from);
  }
  const severity = textArg(args, "severity", "all");
  const tagSlug = textArg(args, "tagSlug");
  const limit = numberArg(args, "limit", 50, 200);
  const filters = [
    eq(schema.alertEvents.machineId, machineId),
    gte(schema.alertEvents.startsAt, from),
    lte(schema.alertEvents.startsAt, to),
  ];
  if (severity !== "all")
    filters.push(
      eq(
        schema.alertEvents.severity,
        severity as "info" | "warning" | "critical",
      ),
    );
  let rows = await getPostgresDb()
    .select()
    .from(schema.alertEvents)
    .where(and(...filters))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(limit);
  if (tagSlug) {
    const def = await resolveTagId(tagSlug, machineId);
    if (!def)
      return {
        error: `Tag not found: ${tagSlug}. Use search_tags to find available tags.`,
      };
    const tags = await getPostgresDb()
      .select()
      .from(schema.alertTags)
      .where(eq(schema.alertTags.tagId, def.tagId));
    const allowed = new Set(tags.map((tag) => tag.alertEventId));
    rows = rows.filter((row) => allowed.has(row.id));
  }
  const includeSampleDerived = isTrueValue(args["includeSampleDerivedThresholds"]);
  const excludeSampleDerived = args["includeSampleDerivedThresholds"] === false;
  const sampleDerivedMode = excludeSampleDerived
    ? "off"
    : includeSampleDerived
      ? "on"
      : "auto";
  const shouldDeriveFromSamples =
    !excludeSampleDerived && (includeSampleDerived || rows.length === 0);
  const alerts = await alertRowsWithTags(rows);
  const derivedAlerts = shouldDeriveFromSamples
    ? await getDerivedThresholdAlerts({
        machineId,
        from,
        to,
        severity,
        tagSlug,
        limit,
      })
    : [];
  return {
    query: {
      machineId,
      from: from.toISOString(),
      to: to.toISOString(),
      sampleDerivedThresholds: sampleDerivedMode,
      timezoneAssumption:
        isDateOnly(fromInput) || isDateOnly(toInput)
          ? "date-only inputs interpreted as full Asia/Kolkata local days"
          : "explicit timestamps",
    },
    total: alerts.length,
    derivedTotal: derivedAlerts.length,
    note:
      !shouldDeriveFromSamples && rows.length > 0
        ? "Sample-derived threshold scan was skipped because persisted alert_events matched this query (saves a large Mongo TagSample read). Pass includeSampleDerivedThresholds=true only if you must also recompute breaches from raw samples alongside stored events."
        : !shouldDeriveFromSamples && rows.length === 0
          ? "No persisted alert_events rows for this window, and sample-derived threshold scan was disabled (includeSampleDerivedThresholds=false)."
          : alerts.length === 0 && derivedAlerts.length > 0
            ? "No persisted alert_events rows were found, but threshold breaches were derived from TagSample history for this window. This usually means the alert detection worker/queue did not persist events at that time."
            : alerts.length === 0
              ? "No persisted alert_events rows or threshold breaches were found for this machine and window."
              : undefined,
    bySeverity: {
      info: alerts.filter((alert) => alert.severity === "info").length,
      warning:
        alerts.filter((alert) => alert.severity === "warning").length +
        derivedAlerts.filter((alert) => alert.severity === "warning").length,
      critical:
        alerts.filter((alert) => alert.severity === "critical").length +
        derivedAlerts.filter((alert) => alert.severity === "critical").length,
    },
    byStatus: {
      open: alerts.filter((alert) => alert.status === "open").length,
      acknowledged: alerts.filter((alert) => alert.status === "acknowledged")
        .length,
      resolved: alerts.filter((alert) => alert.status === "resolved").length,
    },
    alerts,
    derivedAlerts,
  };
}

async function getTagDefinition(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const query = textArg(args, "tag");
  const matches = await resolveTagMatches(query, machineId, 3);
  if (!matches.length)
    return {
      error: `Tag not found: ${query}. Use search_tags to find available tags.`,
    };
  if (matches.length > 1)
    return {
      note: "Multiple matches found. Ask with a more specific tag name or slug.",
      matches,
    };
  return matches[0];
}

async function getProductionSummary(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const slugs = [
    "RUNNING_METER",
    "TOTAL_METER",
    "GSM_ENTRY",
    "GRAM_ENTRY",
    "LAMINATOR_MPM",
    "MASTER_SPEED_PCT",
    "UW_SET_TENSION",
    "UW_PV_TENSION",
    "EXTRUDER_ON_OFF",
    "LAMINATOR_ON_OFF",
    "WINDER_ON_OFF",
    "EXTRUDER_FAULT",
    "LAMINATOR_FAULT",
    "WINDER_FAULT",
  ];
  const defs = await findDefinitionsBySlugs(machineId, slugs);
  const defBySlug = new Map(defs.map((def) => [def.slug, def]));
  const latest = await latestByTagId(
    machineId,
    defs.map((def) => def.tagId),
  );
  const val = (slug: string) =>
    tagValue(latest.get(defBySlug.get(slug)?.tagId ?? "") ?? null);
  const laminatorMpm = val("LAMINATOR_MPM");
  const maxMpm = defBySlug.get("LAMINATOR_MPM")?.max ?? 150;
  const uwSet = val("UW_SET_TENSION");
  const uwPv = val("UW_PV_TENSION");
  const onStates = [
    val("EXTRUDER_ON_OFF"),
    val("LAMINATOR_ON_OFF"),
    val("WINDER_ON_OFF"),
  ].map(isTrueValue);
  const [openCount] = await getPostgresDb()
    .select({ value: count() })
    .from(schema.alertEvents)
    .where(
      and(
        eq(schema.alertEvents.machineId, machineId),
        eq(schema.alertEvents.status, "open"),
      ),
    );
  return {
    runningMeter: val("RUNNING_METER"),
    totalMeter: val("TOTAL_METER"),
    gsm: val("GSM_ENTRY"),
    gramEntry: val("GRAM_ENTRY"),
    laminatorMpm,
    masterSpeedPct: val("MASTER_SPEED_PCT"),
    unwinderSetTension: uwSet,
    unwinderPvTension: uwPv,
    lineEfficiency:
      typeof laminatorMpm === "number" && maxMpm > 0
        ? (laminatorMpm / maxMpm) * 100
        : null,
    tensionDeviation:
      typeof uwSet === "number" && typeof uwPv === "number" && uwSet !== 0
        ? (Math.abs(uwPv - uwSet) / Math.abs(uwSet)) * 100
        : null,
    machineStatus: onStates.every(Boolean)
      ? "running"
      : onStates.some(Boolean)
        ? "partial"
        : "stopped",
    faults: {
      extruder: val("EXTRUDER_FAULT"),
      laminator: val("LAMINATOR_FAULT"),
      winder: val("WINDER_FAULT"),
    },
    openAlerts: openCount?.value ?? 0,
  };
}

async function searchTags(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const query = textArg(args, "query");
  const prisma = getPrismaClient();
  const rows = await prisma.tagDefinition.findMany({
    where: {
      machineId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { slug: { contains: query.toUpperCase() } },
        { unit: { contains: query, mode: "insensitive" } },
        { department: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      slug: true,
      name: true,
      unit: true,
      dataType: true,
      warnHigh: true,
      alarmHigh: true,
    },
    take: 10,
  });
  return rows;
}

async function getMachineStatus(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const slugs = [
    "EMG_STOP",
    "ALARM_IND",
    "EXTRUDER_ON_OFF",
    "EXTRUDER_FAULT",
    "LAMINATOR_ON_OFF",
    "LAMINATOR_FAULT",
    "WINDER_ON_OFF",
    "WINDER_FAULT",
    "SPLICE_ON_OFF",
    "EXTRUDER_RPM",
    "LAMINATOR_MPM",
    "WINDER_TENSION_PCT",
    "MASTER_SPEED_PCT",
  ];
  const defs = await findDefinitionsBySlugs(machineId, slugs);
  const defBySlug = new Map(defs.map((def) => [def.slug, def]));
  const latest = await latestByTagId(
    machineId,
    defs.map((def) => def.tagId),
  );
  const val = (slug: string) =>
    tagValue(latest.get(defBySlug.get(slug)?.tagId ?? "") ?? null);
  const latestTs =
    [...latest.values()]
      .map((item) => item.ts.getTime())
      .sort((a, b) => b - a)[0] ?? null;
  const [openCount] = await getPostgresDb()
    .select({ value: count() })
    .from(schema.alertEvents)
    .where(
      and(
        eq(schema.alertEvents.machineId, machineId),
        eq(schema.alertEvents.status, "open"),
      ),
    );
  const emergencyStop = isTrueValue(val("EMG_STOP"));
  const anyFault = ["EXTRUDER_FAULT", "LAMINATOR_FAULT", "WINDER_FAULT"].some(
    (slug) => isTrueValue(val(slug)),
  );
  const alarmActive = isTrueValue(val("ALARM_IND"));
  const running = ["EXTRUDER_ON_OFF", "LAMINATOR_ON_OFF", "WINDER_ON_OFF"].some(
    (slug) => isTrueValue(val(slug)),
  );
  return {
    overallStatus:
      emergencyStop || anyFault
        ? "critical"
        : alarmActive || (openCount?.value ?? 0) > 0
          ? "warning"
          : running
            ? "healthy"
            : "stopped",
    emergencyStop,
    alarmActive,
    subsystems: {
      extruder: {
        online: isTrueValue(val("EXTRUDER_ON_OFF")),
        fault: isTrueValue(val("EXTRUDER_FAULT")),
        rpm: val("EXTRUDER_RPM"),
      },
      laminator: {
        online: isTrueValue(val("LAMINATOR_ON_OFF")),
        fault: isTrueValue(val("LAMINATOR_FAULT")),
        mpm: val("LAMINATOR_MPM"),
      },
      winder: {
        online: isTrueValue(val("WINDER_ON_OFF")),
        fault: isTrueValue(val("WINDER_FAULT")),
        tensionPct: val("WINDER_TENSION_PCT"),
      },
    },
    openAlerts: openCount?.value ?? 0,
lastDataAt: latestTs ? new Date(latestTs).toISOString() : null,
  };
}


// ── Boolean tag guard ─────────────────────────────────────────────────────────
const BOOLEAN_TAG_SUFFIXES = ["_FAULT", "_ON_OFF"] as const;
const BOOLEAN_TAG_EXACT = ["EMG_STOP", "ALARM_IND"] as const;

function isBooleanTag(slug: string): boolean {
  return (
    BOOLEAN_TAG_SUFFIXES.some((s) => slug.endsWith(s)) ||
    (BOOLEAN_TAG_EXACT as readonly string[]).includes(slug)
  );
}

// ── detectAnomalies ───────────────────────────────────────────────────────────
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
function detectAnomalies(
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

// ── detectTrend ───────────────────────────────────────────────────────────────
/**
 * Compares the average of the first third of `numbers` against the last third.
 * Returns "rising" if last avg > first avg by >5%, "falling" if <5%, else "stable".
 * Always returns "stable" when fewer than 6 numbers are available.
 */
function detectTrend(numbers: number[]): "rising" | "falling" | "stable" {
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

// ── getTagComparison ──────────────────────────────────────────────────────────
/**
 * Fetches time-series data for 2+ tags and returns:
 *
 * `summary` — compact per-tag stats, trend, anomalies.
 *             THIS IS WHAT THE AGENT SHOULD READ FOR ANALYSIS.
 *
 * `series`  — full raw samples for each tag.
 *             FOR CHART RENDERING ONLY. Do not analyse raw samples.
 */
async function getTagComparison(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const tagQueries = stringArrayArg(args, "tags");
  const fromInput = textArg(args, "from", "8h");
  const toInput = textArg(args, "to");
  const limit = numberArg(args, "limit", 200, 1000);

  if (tagQueries.length < 2) {
    return { error: "get_tag_comparison requires at least 2 tags." };
  }

  const to = toInput ? parseTime(toInput, 0) : new Date();
  const from = parseTime(fromInput, 8 * 3_600_000);

  if (from >= to) {
    return { error: "from must be before to." };
  }

  const resolvedDefs = await Promise.all(
    tagQueries.map((query) => resolveTagId(query, machineId)),
  );
  const missing = tagQueries.filter((_, i) => !resolvedDefs[i]);
  if (missing.length) {
    return { error: `Tags not found: ${missing.join(", ")}. Use search_tags.` };
  }

  const defs = resolvedDefs as TagDefinitionRecord[];
  const prisma = getPrismaClient();

  const seriesData = await Promise.all(
    defs.map((def) =>
      prisma.tagSample.findMany({
        where: { machineId, tagId: def.tagId, ts: { gte: from, lte: to } },
        select: { ts: true, valueNumber: true, valueBool: true, valueString: true },
        orderBy: { ts: "asc" },
        take: limit,
      }),
    ),
  );

  const windowHours =
    Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10;

  // ── summary: what the agent reads ─────────────────────────────────────────
  const summary = defs.map((def, i) => {
    const rows = seriesData[i]!;
    const samples = rows.map((row) => ({
      ts: row.ts.toISOString(),
      value: tagValue(row),
    }));
    const numbers = samples
      .map((s) => s.value)
      .filter((v): v is number => typeof v === "number");
    const stats = summarizeNumbers(numbers);
    const trend = detectTrend(numbers);
    const anomalies = detectAnomalies(samples, def);
    const firstAt = samples[0]?.ts ?? null;
    const lastAt = samples[samples.length - 1]?.ts ?? null;

    return {
      slug: def.slug,
      name: def.name,
      unit: def.unit,
      thresholds: thresholdText(def),
      count: samples.length,
      min: stats.min,
      max: stats.max,
      avg: stats.avg,
      stdDev: stats.stdDev,
      trend,
      firstAt,
      lastAt,
      anomalies,
    };
  });

  // ── series: full raw data for chart rendering ──────────────────────────────
  const series = defs.map((def, i) => {
    const rows = seriesData[i]!;
    return {
      slug: def.slug,
      name: def.name,
      unit: def.unit,
      samples: rows.map((row) => ({
        ts: row.ts.toISOString(),
        value: tagValue(row),
      })),
    };
  });

  return {
    machineId,
    from: from.toISOString(),
    to: to.toISOString(),
    windowHours,
    summary,
    series,
  };
}



async function acknowledgeAlert(args: ToolArgs) {
  const alertEventId = textArg(args, "alertEventId");
  const actor = textArg(args, "actor", "operator");
  const note = textArg(args, "note");
  const acknowledgedAt = new Date();
  await getPostgresDb().transaction(async (tx) => {
    await tx
      .insert(schema.acknowledgements)
      .values({
        id: newId("alert"),
        alertEventId,
        actor,
        note: note || null,
        createdAt: acknowledgedAt,
      });
    await tx
      .update(schema.alertEvents)
      .set({ status: "acknowledged" })
      .where(eq(schema.alertEvents.id, alertEventId));
  });
  return {
    success: true,
    alertEventId,
    acknowledgedAt: acknowledgedAt.toISOString(),
    actor,
  };
}

async function getChatSessions(args: ToolArgs, defaultMachineId: string) {
  const machineId = textArg(args, "machineId", defaultMachineId);
  const limit = numberArg(args, "limit", 10, 50);
  const db = getPostgresDb();
  const rows = await db
    .select({
      id: schema.chatSessions.id,
      title: schema.chatSessions.title,
      createdAt: schema.chatSessions.createdAt,
      updatedAt: schema.chatSessions.updatedAt,
      messageCount: sql<number>`count(${schema.chatMessages.id})::int`,
    })
    .from(schema.chatSessions)
    .leftJoin(
      schema.chatMessages,
      eq(schema.chatMessages.sessionId, schema.chatSessions.id),
    )
    .where(
      and(
        eq(schema.chatSessions.machineId, machineId),
        sql`${schema.chatSessions.deletedAt} is null`,
      ),
    )
    .groupBy(schema.chatSessions.id)
    .orderBy(desc(schema.chatSessions.updatedAt))
    .limit(limit);
  return {
    sessions: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function executeTool(
  name: string,
  args: ToolArgs,
  machineId: string,
): Promise<unknown> {
  switch (name) {
    case "get_live_tag_values":
      return getLiveTagValues(args, machineId);
    case "get_all_live_tags":
      return getAllLiveTags(args, machineId);
    case "get_tag_history":
      return getTagHistory(args, machineId);
    case "get_active_alerts":
      return getActiveAlerts(args, machineId);
    case "get_alert_history":
      return getAlertHistory(args, machineId);
    case "get_tag_definition":
      return getTagDefinition(args, machineId);
    case "get_production_summary":
      return getProductionSummary(args, machineId);
    case "search_tags":
      return searchTags(args, machineId);
    case "get_machine_status":
      return getMachineStatus(args, machineId);
    case "acknowledge_alert":
      return acknowledgeAlert(args);
    case "get_chat_sessions":
      return getChatSessions(args, machineId);
    case "get_tag_comparison":
      return getTagComparison(args, machineId);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function executeLoggedTool(args: {
  name: string;
  toolArgs: ToolArgs;
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<unknown> {
  args.logger.info(
    {
      tool: args.name,
      args: args.toolArgs,
      machineId: args.machineId,
      sessionId: args.sessionId,
    },
    "chat_tool_call",
  );
  try {
    return await executeTool(args.name, args.toolArgs, args.machineId);
  } catch (error) {
    args.logger.error(
      {
        err: error,
        tool: args.name,
        machineId: args.machineId,
        sessionId: args.sessionId,
      },
      "chat_tool_failed",
    );
    throw error;
  }
}
