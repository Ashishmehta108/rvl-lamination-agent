import type { FastifyRequest } from "fastify";
import { config } from "./config.js";

export function requireApiAuth(req: FastifyRequest) {
  // Allow localhost-only dev runs without auth if explicitly enabled.
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || token !== config.apiAuthToken) {
    const err = new Error("Unauthorized");
    // @ts-expect-error fastify error shape
    err.statusCode = 401;
    throw err;
  }
}

