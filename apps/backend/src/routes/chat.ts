
/**
 * chat.route.ts — Fastify chat routes
 *
 * Changes from original:
 * - Stores plan + trace in chatMessages.toolCalls (backward compatible: was string[])
 * - Adds structured fallback responses (LLM failure, session errors)
 * - Exposes plan/trace/reflectionNote in the API response
 * - Keeps full API contract intact
 */

import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { requireAuth } from "./auth.js";
import { validateMachineAccess } from "../auth.js";
import { runAgent, type AgentTrace } from "../ai/agent.js";
import { getPostgresDb, schema } from "../db/postgres.js";
import { migrateChatTables } from "../db/migrations/chat.js";
import {
  chatMessagesParamsSchema,
  chatMessagesQuerySchema,
  chatSessionsQuerySchema,
  deleteChatSessionParamsSchema,
  deleteChatSessionFastifySchema,
  getChatMessagesFastifySchema,
  getChatSessionsFastifySchema,
  postChatBodySchema,
  postChatFastifySchema,
  type PostChatBody
} from "./chat.schema.js";

type ChatRole = "user" | "assistant" | "system";
type HistoryMessage = { role: ChatRole; content: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized || "New conversation";
}

function finalUserMessage(body: PostChatBody): string {
  if (body.message?.trim()) return body.message.trim();
  const lastUser = [...(body.messages ?? [])].reverse().find((msg) => msg.role === "user");
  return lastUser?.content.trim() ?? "";
}

function requestHistory(body: PostChatBody): HistoryMessage[] {
  if (!body.messages?.length) return [];
  return body.messages
    .slice(0, body.messages.length - 1)
    .filter((msg): msg is HistoryMessage =>
      msg.role === "user" || msg.role === "assistant" || msg.role === "system"
    )
    .slice(-50);
}

function isGeminiFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes("gemini") ||
    msg.includes("google") ||
    msg.includes("rate") ||
    msg.includes("quota") ||
    msg.includes("timeout") ||
    msg.includes("api_key")
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function registerChatRoutes(app: FastifyInstance) {
  await migrateChatTables();

  // POST / — Send a message, run agent, persist, return reply
  app.post("/", { schema: postChatFastifySchema, preHandler: requireAuth }, async (req, reply) => {
    const { userId, tenantId } = req.jwtUser!;

    const parsed = postChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues });
    }

    const body = parsed.data;
    const machineId = body.machineId ?? "lamination-01";
    validateMachineAccess(machineId);

    const message = finalUserMessage(body);
    if (!message) return reply.code(400).send({ error: "message_required" });

    const db = getPostgresDb();
    const now = new Date();
    let sessionId = body.sessionId;
    let history: HistoryMessage[] = [];

    // ── Session setup ──────────────────────────────────────────────────────
    try {
      if (sessionId) {
        const [session] = await db
          .select()
          .from(schema.chatSessions)
          .where(
            and(
              eq(schema.chatSessions.id, sessionId),
              eq(schema.chatSessions.tenantId, tenantId),
              sql`${schema.chatSessions.deletedAt} is null`
            )
          );
        if (!session) return reply.code(404).send({ error: "session_not_found" });

        const rows = await db
          .select({
            role: schema.chatMessages.role,
            content: schema.chatMessages.content,
            createdAt: schema.chatMessages.createdAt
          })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.sessionId, sessionId))
          .orderBy(desc(schema.chatMessages.createdAt))
          .limit(50);

        history = rows.reverse().map((row) => ({ role: row.role, content: row.content }));
      } else {
        sessionId = newId("chat");
        await db.insert(schema.chatSessions).values({
          id: sessionId,
          machineId,
          userId,
          tenantId,
          title: titleFromMessage(message),
          createdAt: now,
          updatedAt: now,
          metadata: {}
        });
        history = requestHistory(body);
      }
    } catch (error) {
      req.log.error({ err: error, machineId, sessionId }, "chat_session_prepare_failed");
      return reply.code(500).send({ error: "chat_session_prepare_failed" });
    }

    // ── Agent execution ────────────────────────────────────────────────────
    let agentResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      agentResult = await runAgent({
        userMessage: message,
        history,
        machineId,
        sessionId: sessionId!,
        logger: req.log
      });
    } catch (error) {
      req.log.error({ err: error, machineId, sessionId }, "chat_agent_failed");
      if (isGeminiFailure(error)) {
        return reply.code(503).send({ error: "gemini_unavailable", retryAfter: 30 });
      }
      return reply.code(500).send({ error: "chat_failed" });
    }

    // ── Persist ────────────────────────────────────────────────────────────
    const userMessageId = newId("chat");
    const assistantMessageId = newId("chat");

    // toolCalls column stores the structured trace (backward-compatible: was string[])
    // Consumers that expected string[] will see an object instead — update if needed.
    const tracePayload: AgentTrace = agentResult.trace;

    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.chatMessages).values({
          id: userMessageId,
          sessionId: sessionId!,
          role: "user",
          content: message,
          toolCalls: [],
          tokenCount: null,
          createdAt: new Date()
        });
        await tx.insert(schema.chatMessages).values({
          id: assistantMessageId,
          sessionId: sessionId!,
          role: "assistant",
          content: agentResult.reply,
          toolCalls: tracePayload as unknown as string[], // schema stores JSON; cast for Drizzle
          tokenCount: agentResult.tokenCount ?? null,
          createdAt: new Date()
        });
        await tx
          .update(schema.chatSessions)
          .set({ updatedAt: new Date() })
          .where(eq(schema.chatSessions.id, sessionId!));
      });
    } catch (error) {
      // Persist failure should not block the client response — log and continue
      req.log.error({ err: error, machineId, sessionId }, "chat_persist_failed");
    }

    const responsePayload = {
      sessionId,
      messageId: assistantMessageId,
      reply: agentResult.reply,
      answer: agentResult.reply,
      toolsUsed: agentResult.toolsUsed,
      tokenCount: agentResult.tokenCount,
      citations: [],
      grounded: agentResult.toolsUsed.length > 0,

      // Pipeline-specific additions
      steps: agentResult.toolSteps,
      plan: tracePayload.plan,
      trace: tracePayload,
      queryClass: tracePayload.queryClass,
      reflectionNote: tracePayload.reflectionNote ?? null,
      reflectionSeverity: tracePayload.reflectionSeverity,
      charts: agentResult.charts ?? [],

      // Legacy fields (kept for API contract)
      contextBlocks: [],
      liveTagCount: 0,
      findCandidates: []
    };

    req.log.info({ responseKeys: Object.keys(responsePayload), chartsCount: responsePayload.charts.length }, "chat_response_sent");

    return reply.send(responsePayload);
  });


  // GET /sessions — List sessions for a machine (scoped to tenant)
  app.get("/sessions", { schema: getChatSessionsFastifySchema, preHandler: requireAuth }, async (req, reply) => {
    const { tenantId } = req.jwtUser!;
    const parsed = chatSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues });
    }
    validateMachineAccess(parsed.data.machineId);

    try {
      const rows = await getPostgresDb()
        .select({
          id: schema.chatSessions.id,
          title: schema.chatSessions.title,
          machineId: schema.chatSessions.machineId,
          createdAt: schema.chatSessions.createdAt,
          updatedAt: schema.chatSessions.updatedAt,
          messageCount: sql<number>`count(${schema.chatMessages.id})::int`
        })
        .from(schema.chatSessions)
        .leftJoin(schema.chatMessages, eq(schema.chatMessages.sessionId, schema.chatSessions.id))
        .where(
          and(
            eq(schema.chatSessions.tenantId, tenantId),
            eq(schema.chatSessions.machineId, parsed.data.machineId),
            sql`${schema.chatSessions.deletedAt} is null`
          )
        )
        .groupBy(schema.chatSessions.id)
        .orderBy(desc(schema.chatSessions.updatedAt))
        .limit(parsed.data.limit);

      return reply.send({
        sessions: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString()
        }))
      });
    } catch (error) {
      req.log.error({ err: error }, "chat_sessions_list_failed");
      return reply.code(500).send({ error: "chat_sessions_list_failed" });
    }
  });

  // GET /sessions/:sessionId/messages — Paginated message history
  app.get(
    "/sessions/:sessionId/messages",
    { schema: getChatMessagesFastifySchema, preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId } = req.jwtUser!;
      const params = chatMessagesParamsSchema.safeParse(req.params);
      const query = chatMessagesQuerySchema.safeParse(req.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      try {
        const [session] = await getPostgresDb()
          .select()
          .from(schema.chatSessions)
          .where(
            and(
              eq(schema.chatSessions.id, params.data.sessionId),
              eq(schema.chatSessions.tenantId, tenantId),
              sql`${schema.chatSessions.deletedAt} is null`
            )
          );
        if (!session) return reply.code(404).send({ error: "session_not_found" });

        let beforeCreatedAt: Date | null = null;
        if (query.data.before) {
          const [cursor] = await getPostgresDb()
            .select({ createdAt: schema.chatMessages.createdAt })
            .from(schema.chatMessages)
            .where(
              and(
                eq(schema.chatMessages.sessionId, params.data.sessionId),
                eq(schema.chatMessages.id, query.data.before)
              )
            );
          beforeCreatedAt = cursor?.createdAt ?? null;
        }

        const where = beforeCreatedAt
          ? and(
            eq(schema.chatMessages.sessionId, params.data.sessionId),
            lt(schema.chatMessages.createdAt, beforeCreatedAt)
          )
          : eq(schema.chatMessages.sessionId, params.data.sessionId);

        const rows = await getPostgresDb()
          .select()
          .from(schema.chatMessages)
          .where(where)
          .orderBy(desc(schema.chatMessages.createdAt))
          .limit(query.data.limit);

        return reply.send({
          messages: rows.map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            toolCalls: row.toolCalls,
            tokenCount: row.tokenCount,
            createdAt: row.createdAt.toISOString()
          })),
          nextCursor:
            rows.length === query.data.limit ? (rows[rows.length - 1]?.id ?? null) : null
        });
      } catch (error) {
        req.log.error({ err: error }, "chat_messages_list_failed");
        return reply.code(500).send({ error: "chat_messages_list_failed" });
      }
    }
  );

  // DELETE /sessions/:sessionId — Soft delete (owner only)
  app.delete(
    "/sessions/:sessionId",
    { schema: deleteChatSessionFastifySchema, preHandler: requireAuth },
    async (req, reply) => {
      const { userId, tenantId } = req.jwtUser!;
      const parsed = deleteChatSessionParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues });
      }

      try {
        const result = await getPostgresDb()
          .update(schema.chatSessions)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.chatSessions.id, parsed.data.sessionId),
              eq(schema.chatSessions.userId, userId),
              eq(schema.chatSessions.tenantId, tenantId)
            )
          )
          .returning({ id: schema.chatSessions.id });

        if (!result.length) return reply.code(404).send({ error: "session_not_found" });
        return reply.send({ ok: true, sessionId: parsed.data.sessionId });
      } catch (error) {
        req.log.error({ err: error }, "chat_session_delete_failed");
        return reply.code(500).send({ error: "chat_session_delete_failed" });
      }
    }
  );
}
