/**
 * ML routes — REST API for the ML pipeline.
 *
 * POST /ml/retrain   — Trigger manual retraining
 * GET  /ml/status    — Model + baseline status
 * POST /ml/predict   — Score a tag snapshot manually
 */

import type { FastifyInstance } from "fastify";
import { requireApiAuth } from "../auth.js";
import { mlGetStatus, mlTriggerRetrain, mlCollectAndPredict } from "../services/mlService.js";
import { tryGetBoss } from "../queue/boss.js";
import { Jobs } from "../workers/jobs.js";

export async function registerMlRoutes(app: FastifyInstance) {
  // ── GET /ml/status ────────────────────────────────────────────
  app.get("/ml/status", async (req, reply) => {
    requireApiAuth(req);
    const status = await mlGetStatus();
    if (!status) {
      return reply.code(503).send({
        error: "ml_server_unavailable",
        hint: "Start the ML server: cd packages/ml && python server.py",
      });
    }
    return reply.send(status);
  });

  // ── POST /ml/retrain ──────────────────────────────────────────
  app.post("/ml/retrain", async (req, reply) => {
    requireApiAuth(req);
    const force = Boolean((req.body as any)?.force ?? false);

    // First try immediate HTTP call to ML server
    const ok = await mlTriggerRetrain(force);
    if (ok) {
      return reply.send({ ok: true, message: "Retraining started on ML server.", force });
    }

    // Fall back: enqueue via pg-boss for when ML server comes online
    const boss = await tryGetBoss();
    if (boss) {
      await boss.send(Jobs.mlRetrain, { force });
      return reply.send({
        ok: true,
        message: "ML server not reachable; retrain job queued via pg-boss.",
        force,
      });
    }

    return reply.code(503).send({
      error: "ml_server_unavailable",
      hint: "Start the ML server: cd packages/ml && python server.py",
    });
  });

  // ── POST /ml/predict ─────────────────────────────────────────
  app.post("/ml/predict", async (req, reply) => {
    requireApiAuth(req);
    const body = (req.body ?? {}) as any;
    const timestamp: string = body.timestamp ?? new Date().toISOString();
    const tags: Record<string, unknown> = body.tags ?? {};

    if (!tags || Object.keys(tags).length === 0) {
      return reply.code(400).send({ error: "tags_required" });
    }

    const result = await mlCollectAndPredict(timestamp, tags);
    if (!result) {
      return reply.code(503).send({
        error: "ml_server_unavailable",
        hint: "Start the ML server: cd packages/ml && python server.py",
      });
    }

    return reply.send(result);
  });
}
