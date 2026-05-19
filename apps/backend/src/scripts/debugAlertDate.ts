import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getPgDb, getPgPool, schema } from "@rvl/db-postgres";
import { getMongoClient } from "@rvl/db-mongo";
import "../config.js";

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function localDayWindow(date: string): { from: Date; to: Date; fromLocal: string; toLocal: string } {
  const fromLocal = `${date}T00:00:00+05:30`;
  const toLocalDate = new Date(`${date}T00:00:00+05:30`);
  toLocalDate.setUTCDate(toLocalDate.getUTCDate() + 1);
  const from = new Date(fromLocal);
  const to = toLocalDate;
  return { from, to, fromLocal, toLocal: to.toISOString() };
}

async function main(): Promise<void> {
  const machineId = arg("machineId", "lamination-01");
  const date = arg("date", "2026-04-27");
  const db = getPgDb();
  const { from, to, fromLocal } = localDayWindow(date);

  console.log(JSON.stringify({
    machineId,
    requestedLocalDate: date,
    istWindowInput: {
      from: fromLocal,
      toExclusive: `${date} + 1 day at 00:00:00+05:30`
    },
    utcWindowUsedByPostgres: {
      fromInclusive: from.toISOString(),
      toExclusive: to.toISOString()
    }
  }, null, 2));

  const exactRows = await db
    .select({
      id: schema.alertEvents.id,
      machineId: schema.alertEvents.machineId,
      severity: schema.alertEvents.severity,
      status: schema.alertEvents.status,
      title: schema.alertEvents.title,
      startsAt: schema.alertEvents.startsAt,
      endsAt: schema.alertEvents.endsAt
    })
    .from(schema.alertEvents)
    .where(and(eq(schema.alertEvents.machineId, machineId), gte(schema.alertEvents.startsAt, from), lt(schema.alertEvents.startsAt, to)))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(100);

  const nearbyRows = await db
    .select({
      id: schema.alertEvents.id,
      machineId: schema.alertEvents.machineId,
      severity: schema.alertEvents.severity,
      status: schema.alertEvents.status,
      title: schema.alertEvents.title,
      startsAt: schema.alertEvents.startsAt
    })
    .from(schema.alertEvents)
    .where(and(
      eq(schema.alertEvents.machineId, machineId),
      gte(schema.alertEvents.startsAt, new Date(from.getTime() - 2 * 86_400_000)),
      lt(schema.alertEvents.startsAt, new Date(to.getTime() + 2 * 86_400_000))
    ))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(200);

  const rawDateRows = await db.execute(sql`
    select id, machine_id, severity, status, title, starts_at,
           starts_at at time zone 'Asia/Kolkata' as starts_at_ist
    from alert_events
    where machine_id = ${machineId}
      and (starts_at at time zone 'Asia/Kolkata')::date = ${date}::date
    order by starts_at desc
    limit 100
  `);

  const totalByMachine = await db.execute(sql`
    select machine_id, count(*)::int as count,
           min(starts_at) as first_starts_at,
           max(starts_at) as last_starts_at
    from alert_events
    group by machine_id
    order by count desc, machine_id asc
  `);

  const latestAnyMachine = await db
    .select({
      id: schema.alertEvents.id,
      machineId: schema.alertEvents.machineId,
      severity: schema.alertEvents.severity,
      status: schema.alertEvents.status,
      title: schema.alertEvents.title,
      startsAt: schema.alertEvents.startsAt,
      createdAt: schema.alertEvents.createdAt
    })
    .from(schema.alertEvents)
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(20);

  const prisma = getMongoClient();
  const definitions = await prisma.tagDefinition.findMany({
    where: {
      machineId,
      dataType: "number",
      OR: [
        { warnHigh: { not: null } },
        { warnLow: { not: null } },
        { alarmHigh: { not: null } },
        { alarmLow: { not: null } }
      ]
    },
    select: {
      tagId: true,
      slug: true,
      name: true,
      unit: true,
      warnHigh: true,
      warnLow: true,
      alarmHigh: true,
      alarmLow: true
    }
  });
  const defByTagId = new Map<string, any>(definitions.map((def: any) => [def.tagId, def]));
  const samples = await prisma.tagSample.findMany({
    where: {
      machineId,
      tagId: { in: [...defByTagId.keys()] },
      ts: { gte: from, lt: to },
      valueNumber: { not: null }
    },
    select: { tagId: true, ts: true, valueNumber: true },
    orderBy: { ts: "asc" },
    take: 20_000
  });
  const derived = new Map<string, {
    slug: string;
    name: string;
    unit: string | null;
    severity: "warning" | "critical";
    sampleCount: number;
    firstAt: Date;
    lastAt: Date;
    minValue: number;
    maxValue: number;
    threshold: number;
  }>();
  for (const sample of samples) {
    if (typeof sample.valueNumber !== "number") continue;
    const def = defByTagId.get(sample.tagId);
    if (!def) continue;
    const highCritical = def.alarmHigh !== null && sample.valueNumber >= def.alarmHigh;
    const lowCritical = def.alarmLow !== null && sample.valueNumber <= def.alarmLow;
    const highWarning = def.warnHigh !== null && sample.valueNumber >= def.warnHigh;
    const lowWarning = def.warnLow !== null && sample.valueNumber <= def.warnLow;
    const severity = highCritical || lowCritical ? "critical" : highWarning || lowWarning ? "warning" : null;
    if (!severity) continue;
    const threshold = highCritical ? def.alarmHigh! : lowCritical ? def.alarmLow! : highWarning ? def.warnHigh! : def.warnLow!;
    const existing = derived.get(sample.tagId);
    if (!existing) {
      derived.set(sample.tagId, {
        slug: def.slug,
        name: def.name,
        unit: def.unit,
        severity,
        sampleCount: 1,
        firstAt: sample.ts,
        lastAt: sample.ts,
        minValue: sample.valueNumber,
        maxValue: sample.valueNumber,
        threshold
      });
      continue;
    }
    existing.sampleCount += 1;
    existing.lastAt = sample.ts;
    existing.minValue = Math.min(existing.minValue, sample.valueNumber);
    existing.maxValue = Math.max(existing.maxValue, sample.valueNumber);
    if (existing.severity !== "critical" && severity === "critical") existing.severity = "critical";
  }

  console.log("\nExact range rows via Drizzle:");
  console.log(JSON.stringify(exactRows.map((row: any) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null
  })), null, 2));

  console.log("\nRaw SQL rows where local IST date matches:");
  console.log(JSON.stringify((rawDateRows as { rows?: unknown[] }).rows ?? [], null, 2));

  console.log("\nNearby alerts +/- 2 days:");
  console.log(JSON.stringify(nearbyRows.map((row: any) => ({
    ...row,
    startsAt: row.startsAt.toISOString()
  })), null, 2));

  console.log("\nAlert counts by machine:");
  console.log(JSON.stringify((totalByMachine as { rows?: unknown[] }).rows ?? [], null, 2));

  console.log("\nLatest 20 alerts in this Postgres database, any machine:");
  console.log(JSON.stringify(latestAnyMachine.map((row: any) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  })), null, 2));

  console.log("\nDerived threshold breaches from Mongo TagSample for requested day:");
  console.log(JSON.stringify([...derived.values()].map((row: any) => ({
    ...row,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString()
  })), null, 2));

  await prisma.$disconnect();
  await getPgPool().end();
}

main().catch(async (error) => {
  console.error(error);
  await getMongoClient().$disconnect().catch(() => undefined);
  await getPgPool().end().catch(() => undefined);
  process.exit(1);
});
