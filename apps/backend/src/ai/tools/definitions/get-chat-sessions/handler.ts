import { eq, and, desc, sql } from "drizzle-orm";
import type { ToolContext } from "../../execute-tool.js";
import type { GetChatSessionsArgs } from "./schema.js";
import { getPostgresDb, schema } from "src/db/postgres.js";

export async function execute(args: GetChatSessionsArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 10)));
  const db = getPostgresDb();
  const rows = await db
    .select({
      id: schema.chatSessions.id,
      title: schema.chatSessions.title,
      createdAt: schema.chatSessions.createdAt,
      updatedAt: schema.chatSessions.updatedAt,
      messageCount: sql<number>`count(${schema.chatMessages.id})::int`,
    })
    .from(schema.chatSessions)
    .leftJoin(
      schema.chatMessages,
      eq(schema.chatMessages.sessionId, schema.chatSessions.id),
    )
    .where(
      and(
        eq(schema.chatSessions.machineId, machineId),
        sql`${schema.chatSessions.deletedAt} is null`,
      ),
    )
    .groupBy(schema.chatSessions.id)
    .orderBy(desc(schema.chatSessions.updatedAt))
    .limit(limit);
  return {
    sessions: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}
