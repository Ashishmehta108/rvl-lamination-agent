// import pino from "pino";
// import { config } from "./config.js";

// export const log = pino({
//   level: config.nodeEnv === "production" ? "info" : "debug",
//   redact: {
//     paths: ["req.headers.authorization"],
//     remove: true
//   }
// });


import pino from "pino";
import path from "path";

const LOG_DIR = process.env.LOG_DIR ?? "./logs";
const LOG_FILE = path.join(LOG_DIR, "chat.log");

export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? "debug",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  },
  pino.multistream([
    // ── Console: pretty for humans ─────────────────────────────────
    {
      stream: (await import("pino-pretty")).default({
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{correlationId} | {msg}",
      }),
      level: "debug",
    },
    // ── File: raw JSON for debug / grep ───────────────────────────
    {
      stream: await (await import("pino-roll")).default({
        file: LOG_FILE,
        frequency: "daily",       // new file each day
        limit: { count: 7 },      // keep 7 days
        mkdir: true,
      }),
      level: "debug",
    },
  ])
);