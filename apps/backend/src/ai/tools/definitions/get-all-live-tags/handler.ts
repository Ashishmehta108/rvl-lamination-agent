import type { ToolContext } from "../../execute-tool.js";
import type { GetAllLiveTagsArgs } from "./schema.js";
import { getPrismaClient } from "src/db/mongo.js";
import { latestByTagId, tagDefinitionSelect } from "../../shared/helpers.js";
import { tagValue } from "../../shared/args.js";
import { formatTagValue } from "../../shared/formatting.js";
import { computeStatus, thresholdText, subsystemFor } from "../../shared/thresholds.js";
import { isStale } from "../../shared/time.js";
import type { TagDefinitionRecord } from "../../shared/types.js";

type JsonRecord = Record<string, unknown>;

export async function execute(args: GetAllLiveTagsArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
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
