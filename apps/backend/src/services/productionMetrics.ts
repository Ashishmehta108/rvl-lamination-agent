import { getNativeDb } from "@rvl/db-mongo";

export const TRACKED_SLUGS = ["RUNNING_METER", "EXTRUDER_RPM", "LAMINATOR_MPM", "GSM_ENTRY"] as const;

export type ProductionGranularity = "daily" | "weekly" | "monthly";

export type ProductionBucket = {
  key: string;
  label: string;
  start: string;
  end: string;
  runningMeters: number | null;
  avgExtruderRpm: number | null;
  avgLaminatorMpm: number | null;
  avgGsmEntry: number | null;
  sampleCount: number;
};

const MAX_SPAN_MS: Record<ProductionGranularity, number> = {
  daily: 90 * 86400000,
  weekly: 366 * 86400000,
  monthly: 36 * 30 * 86400000
};

const MAX_BUCKETS_EXPLICIT = 400;

function periodExpression(granularity: ProductionGranularity): Record<string, unknown> {
  if (granularity === "daily") {
    return { $dateToString: { format: "%Y-%m-%d", date: "$ts", timezone: "UTC" } };
  }
  if (granularity === "weekly") {
    return { $dateToString: { format: "%G-W%V", date: "$ts", timezone: "UTC" } };
  }
  return { $dateToString: { format: "%Y-%m", date: "$ts", timezone: "UTC" } };
}

function msPerBucket(granularity: ProductionGranularity): number {
  if (granularity === "daily") return 86400000;
  if (granularity === "weekly") return 7 * 86400000;
  return 30 * 86400000;
}

function clampBuckets(n: number, granularity: ProductionGranularity): number {
  const max = granularity === "daily" ? 90 : granularity === "weekly" ? 52 : 36;
  return Math.min(max, Math.max(1, n));
}

/** Resolve human slug from TagDefinition (handles legacy internal tagIds). */
function slugStages(tags?: string[]): object[] {
  const filter = tags && tags.length > 0 ? tags : [...TRACKED_SLUGS];
  return [
    {
      $lookup: {
        from: "TagDefinition",
        let: { tid: "$tagId", mid: "$machineId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ["$tagId", "$$tid"] }, { $eq: ["$machineId", "$$mid"] }]
              }
            }
          },
          { $sort: { updatedAt: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, slug: 1, unit: 1 } }
        ],
        as: "_defArr"
      }
    },
    {
      $addFields: {
        metricSlug: {
          $let: {
            vars: { d: { $arrayElemAt: ["$_defArr", 0] } },
            in: { $ifNull: ["$$d.slug", "$tagId"] }
          }
        },
        metricUnit: {
          $let: {
            vars: { d: { $arrayElemAt: ["$_defArr", 0] } },
            in: { $ifNull: ["$$d.unit", ""] }
          }
        }
      }
    },
    {
      $match: {
        metricSlug: { $in: filter },
        valueNumber: { $exists: true, $ne: null }
      }
    }
  ];
}

function resolveTimeWindow(args: {
  granularity: ProductionGranularity;
  buckets: number;
  fromISO?: string | null;
  toISO?: string | null;
}): { from: Date; to: Date; bucketCount: number; explicitRange: boolean } {
  const explicit =
    args.fromISO &&
    args.toISO &&
    !Number.isNaN(Date.parse(args.fromISO)) &&
    !Number.isNaN(Date.parse(args.toISO));

  if (explicit) {
    let from = new Date(args.fromISO!);
    let to = new Date(args.toISO!);
    if (from.getTime() > to.getTime()) {
      const t = from;
      from = to;
      to = t;
    }
    const span = to.getTime() - from.getTime();
    const cap = MAX_SPAN_MS[args.granularity];
    if (span > cap) {
      from = new Date(to.getTime() - cap);
    }
    const ms = msPerBucket(args.granularity);
    const derived = Math.min(MAX_BUCKETS_EXPLICIT, Math.max(1, Math.ceil(span / ms) + 1));
    return { from, to, bucketCount: derived, explicitRange: true };
  }

  const bucketCount = clampBuckets(args.buckets, args.granularity);
  const to = new Date();
  const from = new Date(to.getTime() - bucketCount * msPerBucket(args.granularity));
  return { from, to, bucketCount, explicitRange: false };
}

/**
 * Aggregates TagSample rows into time buckets. RUNNING_METER uses max-min per bucket as production proxy.
 * Resolves slugs via TagDefinition so samples keyed by internal tagId still match.
 */
export async function aggregateProductionMetrics(args: {
  machineId: string;
  granularity: ProductionGranularity;
  buckets: number;
  fromISO?: string | null;
  toISO?: string | null;
}): Promise<{ granularity: ProductionGranularity; buckets: ProductionBucket[]; from: string; to: string }> {
  const { from, to, bucketCount, explicitRange } = resolveTimeWindow({
    granularity: args.granularity,
    buckets: args.buckets,
    fromISO: args.fromISO,
    toISO: args.toISO
  });

  const db = await getNativeDb();
  const col = db.collection("TagSample");
  const periodExpr = periodExpression(args.granularity);

  const pipeline: object[] = [
    {
      $match: {
        machineId: args.machineId,
        ts: { $gte: from, $lte: to }
      }
    },
    ...slugStages(),
    {
      $group: {
        _id: { period: periodExpr, metricSlug: "$metricSlug" },
        minV: { $min: "$valueNumber" },
        maxV: { $max: "$valueNumber" },
        avgV: { $avg: "$valueNumber" },
        cnt: { $sum: 1 }
      }
    },
    { $sort: { "_id.period": 1 as const } }
  ];

  const rows = (await col.aggregate(pipeline).toArray()) as Array<{
    _id: { period: string; metricSlug: string };
    minV: number;
    maxV: number;
    avgV: number;
    cnt: number;
  }>;

  const byPeriod = new Map<
    string,
    {
      RUNNING_METER?: { min: number; max: number; cnt: number };
      EXTRUDER_RPM?: { avg: number; cnt: number };
      LAMINATOR_MPM?: { avg: number; cnt: number };
      GSM_ENTRY?: { avg: number; cnt: number };
    }
  >();

  for (const r of rows) {
    const p = r._id.period;
    const tag = r._id.metricSlug;
    if (!p || !tag) continue;
    let m = byPeriod.get(p);
    if (!m) {
      m = {};
      byPeriod.set(p, m);
    }
    if (tag === "RUNNING_METER") {
      m.RUNNING_METER = { min: r.minV, max: r.maxV, cnt: r.cnt };
    } else if (tag === "EXTRUDER_RPM") {
      m.EXTRUDER_RPM = { avg: r.avgV, cnt: r.cnt };
    } else if (tag === "LAMINATOR_MPM") {
      m.LAMINATOR_MPM = { avg: r.avgV, cnt: r.cnt };
    } else if (tag === "GSM_ENTRY") {
      m.GSM_ENTRY = { avg: r.avgV, cnt: r.cnt };
    }
  }

  const sortedKeys = [...byPeriod.keys()].sort();
  let out: ProductionBucket[] = [];

  for (const key of sortedKeys) {
    const m = byPeriod.get(key)!;
    let runningMeters: number | null = null;
    if (m.RUNNING_METER) {
      const d = m.RUNNING_METER.max - m.RUNNING_METER.min;
      runningMeters = Number.isFinite(d) ? Math.max(0, Math.round(d * 10) / 10) : null;
    }

    const sampleCount =
      (m.RUNNING_METER?.cnt ?? 0) +
      (m.EXTRUDER_RPM?.cnt ?? 0) +
      (m.LAMINATOR_MPM?.cnt ?? 0) +
      (m.GSM_ENTRY?.cnt ?? 0);

    out.push({
      key,
      label: key,
      start: key,
      end: to.toISOString(),
      runningMeters,
      avgExtruderRpm: m.EXTRUDER_RPM ? Math.round(m.EXTRUDER_RPM.avg * 10) / 10 : null,
      avgLaminatorMpm: m.LAMINATOR_MPM ? Math.round(m.LAMINATOR_MPM.avg * 10) / 10 : null,
      avgGsmEntry: m.GSM_ENTRY ? Math.round(m.GSM_ENTRY.avg * 10) / 10 : null,
      sampleCount
    });
  }

  if (!explicitRange) {
    out = out.slice(-bucketCount);
  } else if (out.length > MAX_BUCKETS_EXPLICIT) {
    out = out.slice(-MAX_BUCKETS_EXPLICIT);
  }

  return {
    granularity: args.granularity,
    buckets: out,
    from: from.toISOString(),
    to: to.toISOString()
  };
}

const SAMPLE_EXPORT_LIMIT = 50_000;

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Flattened TagSample rows for tracked slugs in a time window (Excel-friendly CSV).
 */
export async function exportProductionSamplesCsv(args: {
  machineId: string;
  fromISO: string;
  toISO: string;
  tags?: string[];
}): Promise<{ csv: string; rowCount: number; from: string; to: string }> {
  let from = new Date(args.fromISO);
  let to = new Date(args.toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("invalid_date_range");
  }
  if (from.getTime() > to.getTime()) {
    const t = from;
    from = to;
    to = t;
  }
  const cap = MAX_SPAN_MS.daily * 4;
  if (to.getTime() - from.getTime() > cap) {
    from = new Date(to.getTime() - cap);
  }

  const db = await getNativeDb();
  const col = db.collection("TagSample");

  const pipeline: object[] = [
    { $match: { machineId: args.machineId, ts: { $gte: from, $lte: to } } },
    ...slugStages(args.tags),
    { $sort: { ts: 1 } },
    { $limit: SAMPLE_EXPORT_LIMIT },
    {
      $project: {
        _id: 0,
        ts: 1,
        tagId: 1,
        slug: "$metricSlug",
        unit: "$metricUnit",
        valueNumber: 1
      }
    }
  ];

  const rows = (await col.aggregate(pipeline).toArray()) as Array<{
    ts: Date;
    tagId: string;
    slug: string;
    unit: string;
    valueNumber: number;
  }>;

  const header = ["ts", "slug", "tagId", "valueNumber", "unit"].join(",");
  const lines = rows.map((r) =>
    [
      csvEscape((r.ts instanceof Date ? r.ts : new Date(r.ts as any)).toISOString()),
      csvEscape(String(r.slug ?? "")),
      csvEscape(String(r.tagId ?? "")),
      r.valueNumber != null && Number.isFinite(r.valueNumber) ? String(r.valueNumber) : "",
      csvEscape(String(r.unit ?? ""))
    ].join(",")
  );

  return {
    csv: [header, ...lines].join("\n"),
    rowCount: rows.length,
    from: from.toISOString(),
    to: to.toISOString()
  };
}
