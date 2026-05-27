import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import fjwt from "@fastify/jwt";
import { config } from "./config.js";
import { log } from "./log.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoutes } from "./routes/query.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerMlRoutes } from "./routes/ml.js";
import { registerEmailRoutes } from "./routes/email.js";
import { startWorkers } from "./workers/index.js";
import { getPgPool } from "@rvl/db-postgres";
import { getNativeDb } from "@rvl/db-mongo";
import { tryGetBoss } from "./queue/boss.js";
import { closeMongo } from "./db/mongo.js";
import { closePostgres } from "./db/postgres.js";
import { ensureProductionMetricsIndexes } from "./services/productionMetrics.js";

async function main() {
  const app = Fastify({
    loggerInstance: log,
    genReqId: () => randomUUID()
  });

  await app.register(helmet);
  if (config.enableCors) {
    await app.register(cors, { origin: true });
  }
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute"
  });
  await app.register(websocket);
  await app.register(fjwt, { secret: config.jwtSecret });

  app.get("/health", async () => ({ ok: true, service: "backend", time: new Date().toISOString() }));
  app.get("/ready", async (_req, reply) => {
    const startedAt = Date.now();
    const checks: Record<string, { ok: boolean; error?: string; models?: unknown; warning?: string }> = {};

    // Postgres
    try {
      await getPgPool().query("select 1 as ok");
      checks.postgres = { ok: true };
    } catch (err: any) {
      checks.postgres = { ok: false, error: String(err?.message ?? err) };
    }

    // Mongo
    try {
      const db = await getNativeDb();
      await db.command({ ping: 1 });
      checks.mongo = { ok: true };
    } catch (err: any) {
      checks.mongo = { ok: false, error: String(err?.message ?? err) };
    }

    // Queue (pg-boss)
    try {
      const boss = await tryGetBoss();
      checks.queue = { ok: Boolean(boss) };
      if (!boss) checks.queue.error = "pg-boss unavailable";
    } catch (err: any) {
      checks.queue = { ok: false, error: String(err?.message ?? err) };
    }

    checks.ai = config.aiProvider === "bedrock"
      ? {
        ok: Boolean(config.bedrockRegion && config.bedrockModelId),
        models: {
          provider: "bedrock",
          region: config.bedrockRegion,
          chatModel: config.bedrockModelId,
          reportModel: config.bedrockReportModelId,
          embeddingProvider: config.embeddingProvider,
          embeddingModel: config.embeddingProvider === "bedrock" ? config.bedrockEmbeddingModelId : config.geminiEmbeddingModel
        }
      }
      : {
        ok: Boolean(config.geminiApiKey),
        models: {
          provider: "gemini",
          chatModel: config.geminiModel,
          reportModel: config.geminiReportModel,
          embeddingProvider: config.embeddingProvider,
          embeddingModel: config.geminiEmbeddingModel
        },
        error: config.geminiApiKey ? undefined : "GEMINI_API_KEY_missing"
      };

    const ok = Object.values(checks).every((c) => c.ok);
    if (!ok) return reply.code(503).send({ ok: false, checks, latencyMs: Date.now() - startedAt });
    return reply.send({ ok: true, checks, latencyMs: Date.now() - startedAt });
  });

  await registerIngestRoutes(app as any);
  await registerQueryRoutes(app as any);
  await app.register(registerAuthRoutes, { prefix: "/auth" });
  await app.register(registerChatRoutes, { prefix: "/chat" });
  await registerMlRoutes(app as any);
  await registerEmailRoutes(app as any);

  await ensureProductionMetricsIndexes();
  await startWorkers({ logger: app.log });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutdown_started");
    try {
      await app.close();
      await closeMongo();
      await closePostgres();
    } catch (err) {
      app.log.error({ err }, "shutdown_failed");
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port, host: config.host }, "backend listening");
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});

