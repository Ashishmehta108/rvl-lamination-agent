import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: config.nodeEnv === "production" ? "info" : "debug",
  redact: {
    paths: ["req.headers.authorization"],
    remove: true
  }
});

