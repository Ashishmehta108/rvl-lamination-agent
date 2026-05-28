import type { ToolContext } from "../../execute-tool.js";
import type { GetTagHistoryArgs } from "./schema.js";
import { getPrismaClient } from "src/db/mongo.js";
import { resolveTagId } from "../../shared/helpers.js";
import { tagValue } from "../../shared/args.js";
import { parseTime } from "../../shared/time.js";
import { summarizeNumbers } from "../../shared/stats.js";

export async function execute(args: GetTagHistoryArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const query = args.tag;
  const def = await resolveTagId(query, machineId);
  if (!def) {
    return {
      error: `Tag not found: ${query}. Use search_tags to find available tags.`,
    };
  }
  const to = args.to ? parseTime(args.to, 0) : new Date();
  const from = parseTime(args.from || "1h", 3_600_000);
  const limit = Math.min(1000, Math.max(1, Math.floor(args.limit ?? 200)));

  const prisma = getPrismaClient();
  const rows = await prisma.tagSample.findMany({
    where: { machineId, tagId: def.tagId, ts: { gte: from, lte: to } },
    select: { ts: true, valueNumber: true, valueBool: true, valueString: true },
    orderBy: { ts: "asc" },
    take: limit,
  });

  const numbers: number[] = [];
  const samples = rows.map((row: any) => {
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
