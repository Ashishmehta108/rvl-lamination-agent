/**
 * tools.ts — thin delegation wrapper
 * Replaces the old monolithic tools.ts.
 * All logic lives in src/ai/tools/
 */
import type { FastifyBaseLogger } from "fastify";
import { executeTool as _executeTool, executeLoggedTool as _executeLoggedTool } from "./tools/execute-tool.js";

export { TOOL_NAMES } from "./tools/shared/types.js";
export type { ToolName } from "./tools/shared/types.js";
export { resolveTagId } from "./tools/shared/helpers.js";

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  machineId: string,
): Promise<unknown> {
  return _executeTool(name, args, {
    machineId,
    sessionId: "",
    logger: console as unknown as FastifyBaseLogger,
  });
}

export async function executeLoggedTool(args: {
  name: string;
  toolArgs: Record<string, unknown>;
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<unknown> {
  return _executeLoggedTool(args);
}