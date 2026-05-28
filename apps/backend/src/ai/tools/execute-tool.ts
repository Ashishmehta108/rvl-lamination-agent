import type { FastifyBaseLogger } from "fastify";
import { ZodError } from "zod";
import { toolRegistry } from "./registery.js";

export type ToolContext = {
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
};

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(`[Validation Error] ${message}`);
    this.name = "ToolValidationError";
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string, public originalError: unknown) {
    super(`[Execution Error] ${message}`);
    this.name = "ToolExecutionError";
  }
}

export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
) {
  const tool = toolRegistry[toolName as keyof typeof toolRegistry];
  if (!tool) {
    throw new UnknownToolError(toolName);
  }

  // 1. Schema Validation (if the tool schema is a Zod schema)
  let parsedArgs: any = args;
  if (tool.schema && typeof tool.schema.parse === "function") {
    try {
      parsedArgs = tool.schema.parse(args);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ToolValidationError(err.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; "));
      }
      throw err;
    }
  }

  // 2. Logging & Execution Timing
  const start = Date.now();
  context.logger.info({ toolName, sessionId: context.sessionId }, "Starting tool execution");

  try {
    const result = await tool.execute(parsedArgs, context);
    const duration = Date.now() - start;
    context.logger.info({ toolName, duration, success: true }, "Finished tool execution");
    return result;
  } catch (err) {
    context.logger.error({ toolName, err }, "Tool execution failed");
    throw new ToolExecutionError(err instanceof Error ? err.message : String(err), err);
  }
}


export async function executeLoggedTool(args: {
  name: string;
  toolArgs: Record<string, unknown>;
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<unknown> {
  args.logger.info(
    { tool: args.name, args: args.toolArgs, machineId: args.machineId, sessionId: args.sessionId },
    "chat_tool_call",
  );
  try {
    return await executeTool(args.name, args.toolArgs, {
      machineId: args.machineId,
      sessionId: args.sessionId,
      logger: args.logger,
    });
  } catch (error) {
    args.logger.error(
      { err: error, tool: args.name, machineId: args.machineId, sessionId: args.sessionId },
      "chat_tool_failed",
    );
    throw error;
  }
}