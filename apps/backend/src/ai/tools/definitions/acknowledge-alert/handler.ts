import { eq } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { AcknowledgeAlertArgs } from "./schema.js";
import { newId } from "@rvl/shared";
import { getPostgresDb, schema } from "src/db/postgres.js";

export async function execute(args: AcknowledgeAlertArgs, _context: ToolContext) {
  const alertEventId = args.alertEventId;
  const actor = args.actor || "operator";
  const note = args.note;
  const acknowledgedAt = new Date();
  await getPostgresDb().transaction(async (tx) => {
    await tx
      .insert(schema.acknowledgements)
      .values({
        id: newId("alert"),
        alertEventId,
        actor,
        note: note || null,
        createdAt: acknowledgedAt,
      });
    await tx
      .update(schema.alertEvents)
      .set({ status: "acknowledged" })
      .where(eq(schema.alertEvents.id, alertEventId));
  });
  return {
    success: true,
    alertEventId,
    acknowledgedAt: acknowledgedAt.toISOString(),
    actor,
  };
}
