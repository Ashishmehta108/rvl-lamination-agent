import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "../../../.env") });

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
  host: getEnv("BACKEND_HOST", getEnv("NODE_ENV", "development") === "production" ? "0.0.0.0" : "127.0.0.1"),

  // DBs
  postgresUrl: getEnv("POSTGRES_URL"),
  mongoUrl: getEnv("MONGODB_URL"),

  // Queue (pg-boss uses Postgres)
  queueSchema: getEnv("QUEUE_SCHEMA", "pgboss"),

  // Local LLM via Ollama
  ollamaBaseUrl: getEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
  ollamaModel: getEnv("OLLAMA_MODEL", "phi4-mini"),
  ollamaNumCtx: getEnvNum("OLLAMA_NUM_CTX", 2048),
  ollamaTemperature: getEnvNum("OLLAMA_TEMPERATURE", 0),
  ollamaTopP: getEnvNum("OLLAMA_TOP_P", 0.9),
  ollamaRepeatPenalty: getEnvNum("OLLAMA_REPEAT_PENALTY", 1.15),
  ollamaKeepAlive: getEnv("OLLAMA_KEEP_ALIVE", "30s"),
  llmTimeoutMs: getEnvNum("LLM_TIMEOUT_MS", 120_000),
  llmSmallModelMode: getEnvBool("LLM_SMALL_MODEL_MODE", true),
  llmTargetMaxPromptTokens: getEnvNum("LLM_TARGET_MAX_PROMPT_TOKENS", 1400),
  llmTargetMaxHistoryMessages: getEnvNum("LLM_TARGET_MAX_HISTORY_MESSAGES", 6),
  llmStrictGrounding: getEnvBool("LLM_STRICT_GROUNDING", true),

  // Google Gemini
  googleApiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"] || "",

  /** Scheduled / narrative reports (defaults to chat model if unset) */
  ollamaReportModel: (() => {
    const r = process.env["OLLAMA_REPORT_MODEL"];
    if (r !== undefined && r.trim() !== "") return r.trim();
    return getEnv("OLLAMA_MODEL", "phi4-mini");
  })(),
  ollamaReportNumCtx: getEnvNum("OLLAMA_REPORT_NUM_CTX", 8192),
  ollamaReportTemperature: getEnvNum("OLLAMA_REPORT_TEMPERATURE", 0),
  ollamaReportStepTimeoutMs: getEnvNum("OLLAMA_REPORT_STEP_TIMEOUT_MS", 60_000),

  /** Comma-separated report recipients; email skipped if empty */
  reportEmailTo: getEnv("REPORT_EMAIL_TO", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // RAG
  ragDbDir: getEnv("RAG_DB_DIR", "./data/rag"),
  embedModel: getEnv("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
  ragTopK: getEnvNum("RAG_TOP_K", 4),

  // Security
  mcpAuthToken: getEnv("MCP_AUTH_TOKEN", "dev-local-token"),
  apiAuthToken: getEnv("API_AUTH_TOKEN", "dev-local-token"),
  enableCors: getEnvBool("ENABLE_CORS", true),

  // Files
  artifactsDir: getEnv("ARTIFACTS_DIR", "./data/artifacts"),

  /** Chat: max requests per IP per minute (stricter than global default) */
  chatRateLimitMax: getEnvNum("CHAT_RATE_LIMIT_MAX", 30)
};

if (config.nodeEnv === "production") {
  if (config.apiAuthToken === "dev-local-token") {
    throw new Error("Refusing to start in production with API_AUTH_TOKEN=dev-local-token");
  }
  if (config.mcpAuthToken === "dev-local-token") {
    throw new Error("Refusing to start in production with MCP_AUTH_TOKEN=dev-local-token");
  }
}

