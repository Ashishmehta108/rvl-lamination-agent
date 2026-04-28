
import type { FastifyInstance } from "fastify";
import { ChatRequestSchema } from "@rvl/shared";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { config } from "../config.js";
import {
  buildChatSessionKey,
  getChatHistoryCached,
  putChatHistoryCached,
} from "../services/chatHistoryCache.js";
import { runChatPipeline } from "../agent/graph.js";

/* ─────────────────────────────────────────────────────────────────
   ROUTE REGISTRATION
   ───────────────────────────────────────────────────────────────── */

export async function registerChatRoutes(app: FastifyInstance) {
  const chatRate = (app as any).rateLimit?.bind(app);
  const chatRateHandler = chatRate
    ? chatRate({
      max: config.chatRateLimitMax,
      timeWindow: "1 minute",
      keyGenerator: (request: any) => {
        const auth = request.headers["authorization"] ?? request.headers["Authorization"] ?? "";
        const a = Array.isArray(auth) ? auth[0] : auth;
        return `${request.ip}|${String(a ?? "").slice(0, 64)}`;
      },
    })
    : undefined;

  app.post(
    "/chat",
    chatRateHandler ? { preHandler: [chatRateHandler] } : {},
    async (req, reply) => {
      const reqLog = req.log.child({ correlationId: req.id });
      const t0 = Date.now();
      requireApiAuth(req);

      // ── Validate request ─────────────────────────────────────────
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reqLog.warn({ issues: parsed.error.issues }, "chat_validation_failed");
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }

      const reqBody = parsed.data;
      reqLog.info(
        {
          machineId: reqBody.machineId ?? "(none)",
          messageCount: reqBody.messages.length,
          tagIds: reqBody.tagIds ?? [],
        },
        "chat_request_received"
      );

      if (reqBody.machineId) validateMachineAccess(reqBody.machineId);
      const machineId = reqBody.machineId || "lamination-01";

      // ── Session key ───────────────────────────────────────────────
      const rawAuth = req.headers["authorization"] ?? req.headers["Authorization"] ?? "";
      const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const rawSession = req.headers["x-chat-session-id"];
      const sessionHeader = Array.isArray(rawSession) ? rawSession[0] : rawSession;
      const sessionKey = buildChatSessionKey({
        machineId,
        explicitSessionId: typeof sessionHeader === "string" ? sessionHeader : null,
        authHeader: typeof authHeader === "string" ? authHeader : null,
        ip: req.ip,
      });

      const cachedHistory = getChatHistoryCached(sessionKey);

      // ── Extract last user message ─────────────────────────────────
      const lastUser = [...reqBody.messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

      reqLog.info({ query: lastUser.content.slice(0, 120) }, "chat_user_query");

      // ── Run the LangGraph pipeline ────────────────────────────────
      let result: Awaited<ReturnType<typeof runChatPipeline>>;
      try {
        result = await runChatPipeline(
          {
            message: lastUser.content,
            machineId,
            sessionId: typeof sessionHeader === "string" ? sessionHeader : undefined,
            tagIds: reqBody.tagIds,
            requestedAt: new Date().toISOString(),
          },
          sessionKey,
          cachedHistory?.machineId === machineId ? cachedHistory.messages : []
        );
      } catch (err) {
        reqLog.error({ err: String(err), totalMs: Date.now() - t0 }, "agent_pipeline_failed");
        return reply.code(503).send({ error: "pipeline_error", message: "The agent pipeline failed unexpectedly." });
      }

      reqLog.info(
        {
          traceId: result.traceId,
          handler: result.handler,
          fallbackUsed: result.fallbackUsed,
          groundingConfidence: result.groundingConfidence,
          totalMs: result.totalLatencyMs,
          answerLen: result.answer.length,
          answerPreview: result.answer.slice(0, 150),
        },
        "chat_response_ready"
      );

      // ── Persist to history cache ──────────────────────────────────
      const now = Date.now();
      const historyToPersist = [
        ...(cachedHistory?.machineId === machineId ? cachedHistory.messages : []),
        { role: "user" as const, content: lastUser.content, timestamp: now },
        { role: "assistant" as const, content: result.answer, timestamp: now },
      ];
      try {
        putChatHistoryCached(sessionKey, machineId, historyToPersist, now);
      } catch (err) {
        reqLog.warn({ err: String(err), sessionKey }, "chat_history_cache_write_failed");
      }

      reply.header("x-correlation-id", req.id);
      reply.header("x-trace-id", result.traceId);

      return reply.send({
        answer: result.answer,
        grounded: result.groundingConfidence !== "insufficient",
        health: result.groundingConfidence === "contradicted" ? "degraded" : "unknown",
        handler: result.handler,
        traceId: result.traceId,
        fallbackUsed: result.fallbackUsed,
        groundingConfidence: result.groundingConfidence,
        steps: [],
        citations: [],
        contextBlocks: [],
      });
    }
  );
}
