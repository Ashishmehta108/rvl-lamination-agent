import process from "node:process";

function getEnv(key: string, defaultValue?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required env var: ${key}`);
}

function getEnvNum(key: string, defaultValue?: number): number {
  const v = process.env[key];
  if (v !== undefined && v !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    throw new Error(`Invalid number for env var: ${key}`);
  }
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required env var: ${key}`);
}

function getEnvBool(key: string, defaultValue?: boolean): boolean {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v.toLowerCase() === "true";
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required env var: ${key}`);
}

export const config = {
  nodeEnv: getEnv("NODE_ENV", "development"),
  port: getEnvNum("BACKEND_PORT", 7000),

  // DBs
  postgresUrl: getEnv("POSTGRES_URL"),
  mongoUrl: getEnv("MONGODB_URL"),

  // Queue (pg-boss uses Postgres)
  queueSchema: getEnv("QUEUE_SCHEMA", "pgboss"),

  // Local LLM via Ollama
  ollamaBaseUrl: getEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
  ollamaModel: getEnv("OLLAMA_MODEL", "phi4-mini"),
  ollamaNumCtx: getEnvNum("OLLAMA_NUM_CTX", 4096),
  ollamaTemperature: getEnvNum("OLLAMA_TEMPERATURE", 0),
  ollamaKeepAlive: getEnv("OLLAMA_KEEP_ALIVE", "30s"),
  llmTimeoutMs: getEnvNum("LLM_TIMEOUT_MS", 25_000),

  // RAG
  ragDbDir: getEnv("RAG_DB_DIR", "./data/rag"),
  embedModel: getEnv("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
  ragTopK: getEnvNum("RAG_TOP_K", 6),

  // Security
  mcpAuthToken: getEnv("MCP_AUTH_TOKEN", "dev-local-token"),
  apiAuthToken: getEnv("API_AUTH_TOKEN", "dev-local-token"),
  enableCors: getEnvBool("ENABLE_CORS", true),

  // Files
  artifactsDir: getEnv("ARTIFACTS_DIR", "./data/artifacts")
};

