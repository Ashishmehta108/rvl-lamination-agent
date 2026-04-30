import { sql } from "drizzle-orm";
import { getPostgresDb } from "../postgres.js";

export async function migrateChatTables(): Promise<void> {
  const db = getPostgresDb();
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE chat_role AS ENUM ('user', 'assistant', 'system');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id text PRIMARY KEY,
      machine_id text NOT NULL,
      title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role chat_role NOT NULL,
      content text NOT NULL,
      tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
      token_count integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_sessions_machine_updated_idx ON chat_sessions (machine_id, updated_at);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_sessions_deleted_idx ON chat_sessions (deleted_at);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages (session_id, created_at);`);
}
