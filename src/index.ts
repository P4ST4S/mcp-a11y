#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { ping, pingInputSchema } from "./tools/ping.js";

/**
 * Serveur MCP mcp-a11y — « le port USB-C de l'accessibilité ».
 *
 * Transport stdio : stdout est RÉSERVÉ au protocole MCP.
 * Tout log de debug doit passer par stderr (console.error), jamais console.log.
 */
const server = new McpServer({
  name: "mcp-a11y",
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Health check. Returns 'pong', optionally echoing a message.",
    inputSchema: pingInputSchema,
  },
  async ({ message }) => ({
    content: [{ type: "text", text: ping({ message }) }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-a11y server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting mcp-a11y:", err);
  process.exit(1);
});
