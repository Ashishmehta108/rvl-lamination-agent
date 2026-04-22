
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq } from "drizzle-orm";

export async function startMcpServer() {
  const server = new McpServer(
    { name: "rvl-lamination-agent", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "listTags",
    {
      description: "List tag definitions for a machine revision",
      inputSchema: { machineId: z.string(), machineRevision: z.string() }
    },
    async (args) => {
      const prisma = getMongoClient();
      const defs = await prisma.tagDefinition.findMany({
        where: { machineId: args.machineId, machineRevision: args.machineRevision },
        take: 500
      });
      return { content: [{ type: "text", text: JSON.stringify(defs) }] } as any;
    }
  );

  server.registerTool(
    "getTagLatest",
    { description: "Get latest tag value", inputSchema: { machineId: z.string(), tagId: z.string() } },
    async (args) => {
      const prisma = getMongoClient();
      const latest = await prisma.tagLatest.findUnique({ where: { id: `${args.machineId}:${args.tagId}` } });
      return { content: [{ type: "text", text: JSON.stringify(latest) }] } as any;
    }
  );

  server.registerTool(
    "searchAlerts",
    { description: "List recent alerts", inputSchema: { machineId: z.string(), limit: z.number().int().min(1).max(200).default(50) } },
    async (args) => {
      const db = getPgDb();
      const items = await db
        .select()
        .from(schema.alertEvents)
        .where(eq(schema.alertEvents.machineId, args.machineId))
        .orderBy(desc(schema.alertEvents.startsAt))
        .limit(args.limit);
      return { content: [{ type: "text", text: JSON.stringify(items) }] } as any;
    }
  );

  // Start MCP over stdio in the backend process.
  // Claude Desktop will spawn this command.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // logger.info({ tokenHint: config.mcpAuthToken ? "set" : "missing" }, "mcp server connected (stdio)");
}

