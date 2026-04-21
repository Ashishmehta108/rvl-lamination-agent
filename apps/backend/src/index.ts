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
import { startWorkers } from "./workers/index.js";
import { startMcpServer } from "./mcp/server.js";

async function main() {
  const app = Fastify({ logger: log });

  await app.register(helmet);
  if (config.enableCors) {
    await app.register(cors, { origin: true });
  }
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute"
  });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, service: "backend", time: new Date().toISOString() }));

  await registerIngestRoutes(app);
  await registerQueryRoutes(app);
  await registerChatRoutes(app);

  await startWorkers({ logger: app.log });
  await startMcpServer({ logger: app.log });

  await app.listen({ port: config.port, host: "127.0.0.1" });
  app.log.info({ port: config.port }, "backend listening");
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});

