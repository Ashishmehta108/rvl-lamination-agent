import type { ToolContext } from "../../execute-tool.js";
import type { GetTagComparisonArgs } from "./schema.js";
import type { TagDefinitionRecord } from "../../shared/types.js";
import { getPrismaClient } from "src/db/mongo.js";
import { resolveTagId } from "../../shared/helpers.js";
import { tagValue } from "../../shared/args.js";
import { parseTime } from "../../shared/time.js";
import { thresholdText } from "../../shared/thresholds.js";
import { summarizeNumbers } from "../../shared/stats.js";
import { detectAnomalies, detectTrend } from "../../shared/anomalies.js";

export async function execute(args: GetTagComparisonArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const tagQueries = args.tags;
  const fromInput = args.from || "8h";
  const toInput = args.to;
  const limit = Math.min(1000, Math.max(1, Math.floor(args.limit ?? 200)));

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

  const summary = defs.map((def, i) => {
    const rows = seriesData[i]!;
    const samples = rows.map((row: any) => ({
      ts: row.ts.toISOString(),
      value: tagValue(row),
    }));
    const numbers = samples
      .map((s: any) => s.value)
      .filter((v: any): v is number => typeof v === "number");
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

  const series = defs.map((def, i) => {
    const rows = seriesData[i]!;
    return {
      slug: def.slug,
      name: def.name,
      unit: def.unit,
      samples: rows.map((row: any) => ({
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
