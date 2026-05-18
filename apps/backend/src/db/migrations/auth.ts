import { sql } from "drizzle-orm";
import bcrypt from "bcrypt";
import { getPostgresDb } from "../postgres.js";

const SEED_EMAIL = "rvlpolyai@gmail.com";
const SEED_TENANT_ID = "rvl";
const SEED_ROLE = "admin";
const BCRYPT_ROUNDS = 12;

export async function migrateAuthTables(): Promise<void> {
  const db = getPostgresDb();

  // ── user_role enum ───────────────────────────────────────────────────────
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('operator', 'engineer', 'admin');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // ── users table ──────────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id            text PRIMARY KEY,
      email         text NOT NULL,
      password_hash text NOT NULL,
      role          user_role NOT NULL DEFAULT 'operator',
      tenant_id     text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);`);

  // ── Seed the pre-built admin user (idempotent) ───────────────────────────
  const rows = await db.execute(
    sql`SELECT id FROM users WHERE email = ${SEED_EMAIL} LIMIT 1`
  );
  if (rows.rows.length === 0) {
    const passwordHash = await bcrypt.hash("rvlpolyai", BCRYPT_ROUNDS);
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
      VALUES (
        'user_seed_rvl',
        ${SEED_EMAIL},
        ${passwordHash},
        ${SEED_ROLE}::user_role,
        ${SEED_TENANT_ID},
        now(),
        now()
      )
      ON CONFLICT (email) DO NOTHING;
    `);
  }

  // ── chat_sessions — add userId + tenantId columns (idempotent) ───────────
  await db.execute(sql`
    ALTER TABLE chat_sessions
      ADD COLUMN IF NOT EXISTS user_id   text REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS tenant_id text;
  `);

  // Back-fill existing rows so NOT NULL can be enforced (dev safety net only)
  await db.execute(sql`
    UPDATE chat_sessions
    SET
      user_id   = 'user_seed_rvl',
      tenant_id = 'rvl'
    WHERE user_id IS NULL OR tenant_id IS NULL;
  `);

  // Make the columns NOT NULL now that rows are filled
  await db.execute(sql`
    ALTER TABLE chat_sessions
      ALTER COLUMN user_id   SET NOT NULL,
      ALTER COLUMN tenant_id SET NOT NULL;
  `);

  // ── Rebuild / add indexes ────────────────────────────────────────────────
  // Drop the old single-column machine index and replace with tenant-scoped one
  await db.execute(sql`DROP INDEX IF EXISTS chat_sessions_machine_updated_idx;`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS chat_sessions_tenant_machine_updated_idx
      ON chat_sessions (tenant_id, machine_id, updated_at);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS chat_sessions_user_idx ON chat_sessions (user_id);
  `);
}
