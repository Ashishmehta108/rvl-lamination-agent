import { and, eq, count } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { GetMachineStatusArgs } from "./schema.js";
import { findDefinitionsBySlugs, latestByTagId } from "../../shared/helpers.js";
import { tagValue, isTrueValue } from "../../shared/args.js";
import { getPostgresDb, schema } from "src/db/postgres.js";

export async function execute(args: GetMachineStatusArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
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
