import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { getPrismaClient } from "src/db/mongo.js";
import { getPostgresDb, schema } from "src/db/postgres.js";
import type { TagDefinitionRecord, TagLatestRecord } from "./types.js";
import { formatTagValue } from "./formatting.js";
import { breachForValue } from "./thresholds.js";

type JsonRecord = Record<string, unknown>;

export const tagDefinitionSelect = {
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

export async function findDefinitionsBySlugs(
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

export async function resolveTagMatches(
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

export async function latestByTagId(
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

export type AlertResolution = {
  source?: string;
  actor?: string;
  at?: string;
  tagSlug?: string;
  value?: number;
  unit?: string | null;
  clearedKind?: string;
  clearedSide?: string;
  threshold?: number;
  reason?: string;
};

export function resolutionFromPayload(payload: unknown): AlertResolution | null {
  if (typeof payload !== "object" || payload === null) return null;
  const resolution = (payload as JsonRecord).resolution;
  if (typeof resolution !== "object" || resolution === null) return null;
  return resolution as AlertResolution;
}

export function statusReasonForAlert(
  status: string,
  resolution: AlertResolution | null,
  acks: Array<{ actor: string; note: string | null; createdAt: Date }>,
): string | undefined {
  if (status === "resolved" && resolution?.reason) return resolution.reason;
  if (status === "acknowledged" && acks.length) {
    const latest = acks[acks.length - 1]!;
    const note = latest.note ? `: ${latest.note}` : "";
    return `Acknowledged by ${latest.actor}${note}`;
  }
  return undefined;
}

export async function alertRowsWithTags(
  alerts: Array<typeof schema.alertEvents.$inferSelect>,
) {
  const db = getPostgresDb();
  if (!alerts.length) return [];
  const ids = alerts.map((alert) => alert.id);
  const [tags, ackRows] = await Promise.all([
    db
      .select()
      .from(schema.alertTags)
      .where(inArray(schema.alertTags.alertEventId, ids)),
    db
      .select()
      .from(schema.acknowledgements)
      .where(inArray(schema.acknowledgements.alertEventId, ids))
      .orderBy(schema.acknowledgements.createdAt),
  ]);
  const tagsByAlert = new Map<
    string,
    Array<typeof schema.alertTags.$inferSelect>
  >();
  for (const tag of tags) {
    const list = tagsByAlert.get(tag.alertEventId) ?? [];
    list.push(tag);
    tagsByAlert.set(tag.alertEventId, list);
  }
  const acksByAlert = new Map<
    string,
    Array<typeof schema.acknowledgements.$inferSelect>
  >();
  for (const ack of ackRows) {
    const list = acksByAlert.get(ack.alertEventId) ?? [];
    list.push(ack);
    acksByAlert.set(ack.alertEventId, list);
  }
  return alerts.map((alert) => {
    const acknowledgements = (acksByAlert.get(alert.id) ?? []).map((ack) => ({
      actor: ack.actor,
      note: ack.note,
      createdAt: ack.createdAt.toISOString(),
    }));
    const resolution = resolutionFromPayload(alert.payload);
    const statusReason = statusReasonForAlert(
      alert.status,
      resolution,
      acknowledgements.map((ack) => ({
        actor: ack.actor,
        note: ack.note,
        createdAt: new Date(ack.createdAt),
      })),
    );
    return {
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
      acknowledgements,
      resolution,
      statusReason,
      llmAnalysis: alert.llmAnalysis,
    };
  });
}

export async function getDerivedThresholdAlerts(args: {
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
