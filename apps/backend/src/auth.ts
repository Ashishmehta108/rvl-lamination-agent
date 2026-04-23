import type { FastifyRequest } from "fastify";
import { config } from "./config.js";

export function requireApiAuth(req: FastifyRequest) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || token !== config.apiAuthToken) {
    const err = new Error("Unauthorized");
    // @ts-expect-error fastify error shape
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Validates that the current request is authorized to access the given machineId.
 * In a full production system, this would check the user's site/org permissions.
 */
export function validateMachineAccess(machineId: string) {
  if (!machineId) {
    const err = new Error("machineId_required");
    // @ts-expect-error fastify error shape
    err.statusCode = 400;
    throw err;
  }

  // For now, we perform a sanity check. 
  // In the future, this would lookup the machine in the DB or check the JWT payload.
  const allowedPrefixes = ["machine_", "line_"];
  const isValid = allowedPrefixes.some(p => machineId.startsWith(p));

  if (!isValid) {
    const err = new Error(`Forbidden: Access to machine '${machineId}' is not allowed`);
    // @ts-expect-error fastify error shape
    err.statusCode = 403;
    throw err;
  }
}

