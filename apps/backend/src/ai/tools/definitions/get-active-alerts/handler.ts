import { and, eq, desc } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { GetActiveAlertsArgs } from "./schema.js";

import { getPostgresDb,schema } from "src/db/postgres.js";
import { alertRowsWithTags } from "../../shared/helpers.js";

export async function execute(args: GetActiveAlertsArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const status = args.status || "open";
  const severity = args.severity || "all";
  const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 20)));

  const filters = [eq(schema.alertEvents.machineId, machineId)];
  if (status !== "all") {
    filters.push(
      eq(
        schema.alertEvents.status,
        status as "open" | "acknowledged" | "resolved",
      ),
    );
  }
  if (severity !== "all") {
    filters.push(
      eq(
        schema.alertEvents.severity,
        severity as "info" | "warning" | "critical",
      ),
    );
  }
  const rows = await getPostgresDb()
    .select()
    .from(schema.alertEvents)
    .where(and(...filters))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(limit);

  return alertRowsWithTags(rows);
}
