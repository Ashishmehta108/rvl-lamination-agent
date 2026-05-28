import type { ToolContext } from "../../execute-tool.js";
import type { GetLiveTagValuesArgs } from "./schema.js";
import { resolveTagMatches, latestByTagId } from "../../shared/helpers.js";
import { tagValue, isTrueValue } from "../../shared/args.js";
import { formatTagValue } from "../../shared/formatting.js";
import { computeStatus, thresholdText } from "../../shared/thresholds.js";
import { isStale } from "../../shared/time.js";

export async function execute(args: GetLiveTagValuesArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const tagQueries = args.tags;
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
    const rawVal = tagValue(row);
    return {
      tagId: def.tagId,
      slug: def.slug,
      name: def.name,
      unit: def.unit,
      value: rawVal,
      displayValue: formatTagValue(def, rawVal),
      quality: row?.quality ?? "missing",
      status: computeStatus(def, rawVal),
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
