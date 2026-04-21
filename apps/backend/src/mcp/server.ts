import type { Logger } from "pino";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";

export async function startMcpServer({ logger }: { logger: Logger }) {
  const server = new Server(
    {
      name: "rvl-lamination-agent",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Minimal auth: Claude Desktop config should include the token,
  // and tools will validate it explicitly once we add tool handlers.
  server.setRequestHandler("initialize", async (req) => {
    return req;
  });

  // Start MCP over stdio in the backend process.
  // Claude Desktop will spawn this command.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tokenHint: config.mcpAuthToken ? "set" : "missing" }, "mcp server connected (stdio)");
}

