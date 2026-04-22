// 🚫 BLOCK ALL STDOUT LOGGING IMMEDIATELY (CRITICAL for MCP stdio protocol)
// We do this before any imports because some packages log on import.
console.log = () => { };
console.info = () => { };
console.debug = () => { };

import { configDotenv } from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── DEBUG: env loading (goes to stderr, which is safe) ───────
const envPath = path.resolve(__dirname, "../../../../.env");
console.error("[MCP-DEBUG] cwd          =", process.cwd());
console.error("[MCP-DEBUG] __dirname     =", __dirname);
console.error("[MCP-DEBUG] envPath       =", envPath);
console.error("[MCP-DEBUG] envFile exists=", fs.existsSync(envPath));

const dotenvResult = configDotenv({ path: envPath });
console.error("[MCP-DEBUG] dotenv error  =", dotenvResult.error ?? "none");
console.error("[MCP-DEBUG] POSTGRES_URL  =", process.env.POSTGRES_URL ? process.env.POSTGRES_URL.substring(0, 30) + "…" : "❌ MISSING");
console.error("[MCP-DEBUG] MONGODB_URL   =", process.env.MONGODB_URL ? process.env.MONGODB_URL.substring(0, 30) + "…" : "❌ MISSING");
// ──────────────────────────────────────────────────────────────

const { startMcpServer } = await import("./server.js");

startMcpServer().catch((err) => {
    console.error("[MCP-FATAL]", err);
    process.exit(1);
});