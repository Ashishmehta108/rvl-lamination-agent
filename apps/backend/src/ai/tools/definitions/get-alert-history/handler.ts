import { and, eq, desc, gte, lte } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { GetAlertHistoryArgs } from "./schema.js";
import { getPostgresDb, schema } from "src/db/postgres.js";
import {
  isDateOnly,
  parseIstDateOnlyStart,
  parseTime,
  nextDay
} from "../../shared/time.js";
import {
  resolveTagId,
  alertRowsWithTags,
  getDerivedThresholdAlerts
} from "../../shared/helpers.js";

export async function execute(args: GetAlertHistoryArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const fromInput = args.from || "24h";
  const toInput = args.to;
  const from = isDateOnly(fromInput)
    ? parseIstDateOnlyStart(fromInput)
    : parseTime(fromInput, 86_400_000);
  let to = toInput
    ? isDateOnly(toInput)
      ? nextDay(parseIstDateOnlyStart(toInput))
      : parseTime(toInput, 0)
    : new Date();
  if (isDateOnly(fromInput) && (!toInput || to.getTime() <= from.getTime())) {
    to = nextDay(from);
  }
  const severity = args.severity || "all";
  const tagSlug = args.tagSlug;
  const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 50)));

  const filters = [
    eq(schema.alertEvents.machineId, machineId),
    gte(schema.alertEvents.startsAt, from),
    lte(schema.alertEvents.startsAt, to),
  ];
  if (severity !== "all") {
    filters.push(
      eq(
        schema.alertEvents.severity,
        severity as "info" | "warning" | "critical",
      ),
    );
  }
  let rows = await getPostgresDb()
    .select()
    .from(schema.alertEvents)
    .where(and(...filters))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(limit);

  if (tagSlug) {
    const def = await resolveTagId(tagSlug, machineId);
    if (!def) {
      return {
        error: `Tag not found: ${tagSlug}. Use search_tags to find available tags.`,
      };
    }
    const db = getPostgresDb();
    const tags = await db
      .select()
      .from(schema.alertTags)
      .where(eq(schema.alertTags.tagId, def.tagId));
    const allowed = new Set(tags.map((tag) => tag.alertEventId));
    rows = rows.filter((row) => allowed.has(row.id));
  }

  const includeSampleDerived = args.includeSampleDerivedThresholds === true;
  const excludeSampleDerived = args.includeSampleDerivedThresholds === false;
  const sampleDerivedMode = excludeSampleDerived
    ? "off"
    : includeSampleDerived
      ? "on"
      : "auto";
  const shouldDeriveFromSamples =
    !excludeSampleDerived && (includeSampleDerived || rows.length === 0);

  const alerts = await alertRowsWithTags(rows);
  const derivedAlerts = shouldDeriveFromSamples
    ? await getDerivedThresholdAlerts({
        machineId,
        from,
        to,
        severity,
        tagSlug: tagSlug || "",
        limit,
      })
    : [];

  return {
    query: {
      machineId,
      from: from.toISOString(),
      to: to.toISOString(),
      sampleDerivedThresholds: sampleDerivedMode,
      timezoneAssumption:
        isDateOnly(fromInput) || (toInput && isDateOnly(toInput))
          ? "date-only inputs interpreted as full Asia/Kolkata local days"
          : "explicit timestamps",
    },
    total: alerts.length,
    derivedTotal: derivedAlerts.length,
    note:
      !shouldDeriveFromSamples && rows.length > 0
        ? "Sample-derived threshold scan was skipped because persisted alert_events matched this query (saves a large Mongo TagSample read). Pass includeSampleDerivedThresholds=true only if you must also recompute breaches from raw samples alongside stored events."
        : !shouldDeriveFromSamples && rows.length === 0
          ? "No persisted alert_events rows for this window, and sample-derived threshold scan was disabled (includeSampleDerivedThresholds=false)."
          : alerts.length === 0 && derivedAlerts.length > 0
            ? "No persisted alert_events rows were found, but threshold breaches were derived from TagSample history for this window. This usually means the alert detection worker/queue did not persist events at that time."
            : alerts.length === 0
              ? "No persisted alert_events rows or threshold breaches were found for this machine and window."
              : undefined,
    bySeverity: {
      info: alerts.filter((alert) => alert.severity === "info").length,
      warning:
        alerts.filter((alert) => alert.severity === "warning").length +
        derivedAlerts.filter((alert) => alert.severity === "warning").length,
      critical:
        alerts.filter((alert) => alert.severity === "critical").length +
        derivedAlerts.filter((alert) => alert.severity === "critical").length,
    },
    byStatus: {
      open: alerts.filter((alert) => alert.status === "open").length,
      acknowledged: alerts.filter((alert) => alert.status === "acknowledged")
        .length,
      resolved: alerts.filter((alert) => alert.status === "resolved").length,
    },
    alerts,
    derivedAlerts,
  };
}
