import { and, eq, count } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { GetProductionSummaryArgs } from "./schema.js";
import { findDefinitionsBySlugs, latestByTagId } from "../../shared/helpers.js";
import { tagValue, isTrueValue } from "../../shared/args.js";
import { getPostgresDb, schema } from "src/db/postgres.js";

export async function execute(args: GetProductionSummaryArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
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
