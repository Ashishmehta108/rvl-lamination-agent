/**
 * auth routes — POST /auth/login only
 *
 * No registration endpoint. The single pre-built user is seeded by the
 * migrateAuthTables() migration on backend startup.
 *
 * JWT payload: { userId, tenantId, role }
 * Secret: env JWT_SECRET  |  Expiry: 8 h
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { getPostgresDb, schema } from "../db/postgres.js";
import { migrateAuthTables } from "../db/migrations/auth.js";

// ── JWT payload shape ─────────────────────────────────────────────────────────
export interface JwtUser {
  userId: string;
  tenantId: string;
  role: "operator" | "engineer" | "admin";
}

/**
 * Augment @fastify/jwt so that jwtVerify() returns JwtUser.
 * This is the correct approach — do NOT redeclare FastifyRequest.user
 * because @fastify/jwt already owns that property.
 */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

// Extend FastifyRequest with a typed jwtUser field set by requireAuth
declare module "fastify" {
  interface FastifyRequest {
    jwtUser?: JwtUser;
  }
}

// ── requireAuth preHandler ────────────────────────────────────────────────────
/**
 * Attach as a preHandler hook on any route that needs a valid JWT.
 * Sets req.jwtUser = { userId, tenantId, role } on success.
 */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  try {
    const payload = await req.jwtVerify<JwtUser>();
    req.jwtUser = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role
    };
  } catch {
    const err = new Error("Unauthorized");
    // @ts-expect-error fastify error shape
    err.statusCode = 401;
    throw err;
  }
}

// ── Route registration ────────────────────────────────────────────────────────
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Run migration + seed on startup
  await migrateAuthTables();

  // POST /auth/login
  app.post("/login", async (req, reply) => {
    const body = req.body as { email?: string; password?: string };

    if (!body.email || !body.password) {
      return reply.code(400).send({ error: "email and password are required" });
    }

    const email = body.email.trim().toLowerCase();
    const db = getPostgresDb();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email));

    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const match = await bcrypt.compare(body.password, user.passwordHash);
    if (!match) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const jwtPayload: JwtUser = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role as JwtUser["role"]
    };
    const token = app.jwt.sign(jwtPayload, { expiresIn: "8h" });

    req.log.info({ userId: user.id, tenantId: user.tenantId }, "auth_login_ok");
    return reply.send({ token, userId: user.id, tenantId: user.tenantId, role: user.role });
  });
}
