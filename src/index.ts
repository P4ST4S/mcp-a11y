#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { ping, pingInputSchema } from "./tools/ping.js";
import { auditPage, auditPageInputSchema } from "./tools/auditPage.js";
import { fixContrast, fixContrastInputSchema } from "./tools/fixContrast.js";
import { simpleFixes, simpleFixesInputSchema } from "./tools/simpleFixes.js";
import { generateAltText, generateAltTextInputSchema } from "./tools/generateAltText.js";
import { generateReport, generateReportInputSchema } from "./tools/generateReport.js";
import { openPr, openPrInputSchema } from "./tools/openPr.js";

/**
 * Serveur MCP mcp-a11y - « le port USB-C de l'accessibilité ».
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

server.registerTool(
  "audit_page",
  {
    title: "Audit page (WCAG)",
    description:
      "Audit a web page against WCAG rules with axe-core (Playwright headless Chromium). " +
      "100% deterministic detection - no LLM. Returns structured violations with selectors and colors.",
    inputSchema: auditPageInputSchema,
  },
  async ({ url }) => {
    const result = await auditPage({ url });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "fix_contrast",
  {
    title: "Fix contrast (WCAG)",
    description:
      "Compute the closest WCAG-compliant foreground color for a fg/bg pair (AA 4.5:1 normal text). " +
      "Deterministic - no LLM.",
    inputSchema: fixContrastInputSchema,
  },
  async ({ fg, bg, target }) => {
    const result = fixContrast({ fg, bg, target });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "simple_fixes",
  {
    title: "Simple fixes (deterministic a11y)",
    description:
      "Apply deterministic structural fixes to HTML: missing lang, missing title, unlabeled form controls. " +
      "Returns the patched HTML and the list of fixes. No LLM.",
    inputSchema: simpleFixesInputSchema,
  },
  async ({ html, lang }) => {
    const result = simpleFixes({ html, lang });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "generate_alt_text",
  {
    title: "Generate alt text (vision)",
    description:
      "Describe an image for an HTML alt attribute using a vision model. The ONLY LLM-backed tool. " +
      "Provide either `imageUrl`, or `selector` + `pageUrl` to locate an <img> on a page.",
    inputSchema: generateAltTextInputSchema,
  },
  async ({ imageUrl, pageUrl, selector }) => {
    try {
      const result = await generateAltText({ imageUrl, pageUrl, selector });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `generate_alt_text failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "generate_report",
  {
    title: "Generate before/after report",
    description:
      "Build a self-contained before/after HTML accessibility report from an audit and applied fixes. " +
      "No LLM. Returns the HTML string.",
    inputSchema: generateReportInputSchema,
  },
  async (args) => {
    // The schema validates the shape; the inferred zod type is structurally
    // looser than ReportInput, so cast through unknown.
    const html = generateReport(args as unknown as Parameters<typeof generateReport>[0]);
    return { content: [{ type: "text", text: html }] };
  },
);

server.registerTool(
  "open_pr",
  {
    title: "Open a remediation PR",
    description:
      "Open a mergeable PR with the remediated files. STRICT GUARDRAIL: only ever operates on the repo " +
      "configured in A11Y_TARGET_REPO - never an arbitrary repo.",
    inputSchema: openPrInputSchema,
  },
  async ({ title, body, branch, files, commitMessage, repo }) => {
    try {
      const result = await openPr({ title, body, branch, files, commitMessage, repo });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `open_pr failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
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
