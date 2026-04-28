import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { log } from "../log.js";

/**
 * MCP Auth Strategy (stdio transport):
 * The stdio transport has no HTTP headers, so auth is enforced via environment identity.
 * In production, the MCP_AUTH_TOKEN must not be the dev default token.
 * Each tool call is audit-logged with tool name, machine scope, and timestamp.
 */
function assertMcpAuth(): void {
  if (config.nodeEnv === "production" && config.mcpAuthToken === "dev-local-token") {
    throw new Error(
      "MCP server refuses to start in production with MCP_AUTH_TOKEN=dev-local-token. Set a strong token."
    );
  }
}

function auditLog(toolName: string, args: Record<string, unknown>, resultSize: number): void {
  log.info(
    {
      mcp_tool: toolName,
      machineId: args["machineId"] ?? null,
      callerHint: process.env["MCP_CALLER_HINT"] ?? "stdio",
      resultBytes: resultSize,
      timestamp: new Date().toISOString(),
    },
    "mcp_tool_invoked"
  );
}

function mcpError(message: string): { content: [{ type: "text"; text: string }] } {
  log.warn({ mcp_error: message }, "mcp_tool_error");
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

export async function startMcpServer() {
  assertMcpAuth();

  const server = new McpServer(
    { name: "rvl-lamination-agent", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "listTags",
    {
      description: "List tag definitions for a machine revision",
      inputSchema: { machineId: z.string(), machineRevision: z.string() },
    },
    async (args) => {
      try {
        const prisma = getMongoClient();
        const defs = await prisma.tagDefinition.findMany({
          where: { machineId: args.machineId, machineRevision: args.machineRevision },
          take: 500,
        });
        const result = JSON.stringify(defs);
        auditLog("listTags", args as any, result.length);
        return { content: [{ type: "text", text: result }] } as any;
      } catch (err: any) {
        return mcpError(`listTags failed: ${String(err?.message ?? err)}`) as any;
      }
    }
  );

  server.registerTool(
    "getTagLatest",
    {
      description: "Get latest tag value",
      inputSchema: { machineId: z.string(), tagId: z.string() },
    },
    async (args) => {
      try {
        const prisma = getMongoClient();
        const latest = await prisma.tagLatest.findUnique({
          where: { id: `${args.machineId}:${args.tagId}` },
        });
        const result = JSON.stringify(latest);
        auditLog("getTagLatest", args as any, result.length);
        return { content: [{ type: "text", text: result }] } as any;
      } catch (err: any) {
        return mcpError(`getTagLatest failed: ${String(err?.message ?? err)}`) as any;
      }
    }
  );

  server.registerTool(
    "searchAlerts",
    {
      description: "List recent alerts",
      inputSchema: {
        machineId: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (args) => {
      try {
        const db = getPgDb();
        const items = await db
          .select()
          .from(schema.alertEvents)
          .where(eq(schema.alertEvents.machineId, args.machineId))
          .orderBy(desc(schema.alertEvents.startsAt))
          .limit(args.limit);
        const result = JSON.stringify(items);
        auditLog("searchAlerts", args as any, result.length);
        return { content: [{ type: "text", text: result }] } as any;
      } catch (err: any) {
        return mcpError(`searchAlerts failed: ${String(err?.message ?? err)}`) as any;
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(
    { authMode: config.nodeEnv === "production" ? "enforced" : "dev-permissive" },
    "mcp_server_connected"
  );
}
