import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { log } from "./log.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoutes } from "./routes/query.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerMlRoutes } from "./routes/ml.js";
import { startWorkers } from "./workers/index.js";
import { getPgPool } from "@rvl/db-postgres";
import { getNativeDb } from "@rvl/db-mongo";
import { tryGetBoss } from "./queue/boss.js";

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

    // Ollama (optional dependency for chat + reports)
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(t);
      checks.ollama = { ok: res.ok };
      if (!res.ok) checks.ollama.error = `status_${res.status}`;
      else {
        const body = (await res.json()) as { models?: { name?: string }[] };
        const names = new Set(
          (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string" && n.length > 0)
        );
        const needChat = config.ollamaModel.split(":")[0];
        const needReport = config.ollamaReportModel.split(":")[0];
        const hasChat = [...names].some((n) => n === config.ollamaModel || n.startsWith(needChat + ":"));
        const hasReport = [...names].some((n) => n === config.ollamaReportModel || n.startsWith(needReport + ":"));
        checks.ollama.models = { chatModelPresent: hasChat, reportModelPresent: hasReport };
        const warns: string[] = [];
        if (!hasChat) warns.push(`chat_model_missing:${config.ollamaModel}`);
        if (!hasReport && config.ollamaReportModel !== config.ollamaModel) {
          warns.push(`report_model_missing:${config.ollamaReportModel}`);
        }
        if (warns.length) checks.ollama.warning = warns.join(";");
      }
    } catch (err: any) {
      checks.ollama = { ok: false, error: String(err?.name ?? err?.message ?? err) };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    if (!ok) return reply.code(503).send({ ok: false, checks, latencyMs: Date.now() - startedAt });
    return reply.send({ ok: true, checks, latencyMs: Date.now() - startedAt });
  });

  await registerIngestRoutes(app as any);
  await registerQueryRoutes(app as any);
  await registerChatRoutes(app as any);
  await registerMlRoutes(app as any);

  await startWorkers({ logger: app.log });

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port, host: config.host }, "backend listening");
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});

