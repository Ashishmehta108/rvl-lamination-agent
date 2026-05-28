const path = require("path");
const fs = require("fs");

// Load .env manually so PM2 resurrect picks up all env vars after reboot
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

module.exports = {
  apps: [
    {
      name: "rvl-backend",
      cwd: __dirname,
      script: "apps/backend/dist/index.js",
      interpreter: "node",
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        PORT: process.env.BACKEND_PORT || "7000",
        API_AUTH_TOKEN: process.env.API_AUTH_TOKEN || "dev-local-token",
        MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN || "dev-local-token",
        POSTGRES_URL: process.env.POSTGRES_URL || "",
        MONGODB_URL: process.env.MONGODB_URL || "",
        GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
        AI_PROVIDER: process.env.AI_PROVIDER || "bedrock",
        AWS_REGION: process.env.AWS_REGION || "",
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "",
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "",
        BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID || "",
        BEDROCK_REPORT_MODEL_ID: process.env.BEDROCK_REPORT_MODEL_ID || "",
        EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || "",
        BEDROCK_EMBEDDING_MODEL_ID: process.env.BEDROCK_EMBEDDING_MODEL_ID || "",
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
        OLLAMA_MODEL: process.env.OLLAMA_MODEL || "",
        SMTP_HOST: process.env.SMTP_HOST || "",
        SMTP_PORT: process.env.SMTP_PORT || "587",
        SMTP_USER: process.env.SMTP_USER || "",
        SMTP_PASS: process.env.SMTP_PASS || "",
        SENDER_NAME: process.env.SENDER_NAME || "",
        SENDER_EMAIL: process.env.SENDER_EMAIL || "",
        REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO || "",
        RAG_DB_DIR: process.env.RAG_DB_DIR || "./data/rag",
        ARTIFACTS_DIR: process.env.ARTIFACTS_DIR || "./data/artifacts",
      },
      max_memory_restart: "600M",
      max_restarts: 10,
      restart_delay: 2000,
      autorestart: true,
      time: true
    },
    {
      name: "rvl-ngrok",
      cwd: __dirname,
      script: "ngrok-start.cjs",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      },
      max_restarts: 5,
      restart_delay: 5000,
      autorestart: true,
      time: true
    }
  ]
};
