# AGENTS.md

Conventions for working in this repo. Read this before changing code. This file mirrors CLAUDE.md; keep the two in sync.

## What this is

An MCP server for web accessibility remediation. It exposes WCAG audit and fix tools over stdio, drivable from any MCP client. See README.md for the product thesis and tool list.

## Hard invariants

These are non-negotiable. A change that breaks one of them is wrong.

1. **Detection is deterministic.** axe-core decides what is broken. No LLM in `audit_page`, `fix_contrast`, `simple_fixes`, `generate_report`, or anything in `src/lib`.
2. **One LLM, one place.** The only model call lives in `src/tools/generateAltText.ts`. Do not add model calls anywhere else.
3. **stdout is the MCP channel.** Never write to stdout outside the protocol. All logs and debug output go to stderr (`console.error`). The runner CLI also logs to stderr.
4. **open_pr only touches `A11Y_TARGET_REPO`.** The target repo is read from config, never taken as a free input. It is validated as exactly `owner/repo`. A mismatching `repo` is refused before any network call.
5. **No long dashes.** Never use em dash or en dash in prose, comments, strings, or docs. Use a plain hyphen, a colon, or parentheses.

## Architecture

- `src/index.ts` registers every tool on the `McpServer` and connects stdio. Tool registration is separate from tool logic.
- `src/tools/*.ts` each hold one tool. The exported function has no shared state, so it is testable off-MCP and reusable by the runner. The `src/lib` helpers are pure (no I/O); `audit_page`, `generate_alt_text`, and `open_pr` perform I/O by nature (browser, model, GitHub).
- `src/lib/*.ts` hold deterministic helpers: `contrast.ts` (WCAG math), `html.ts` (parsing, structural fixes, contrast reinjection glue), `report.ts` (HTML report).
- `src/runner/demo.ts` orchestrates the full loop by calling the tool functions directly, not over MCP.
- `src/config.ts` reads and validates env lazily, so the server boots without keys and only the tool that needs one fails.

## Stack and style

- TypeScript ESM, Node 22+. `"type": "module"`. tsconfig is NodeNext, strict.
- Imports between source files use `.js` extensions (NodeNext resolution), even though the files are `.ts`.
- Zod v3 for tool input schemas. `registerTool` takes a raw shape (`{ url: z.string() }`), not a `z.object`.
- Match the surrounding code: comment density, naming, idiom.

## Reinjection glue (the subtle part)

axe audits the rendered DOM; `open_pr` commits a source file. Fixes are mapped back to the source by element selector, not by color value (swapping a color value globally would hit shared colors like a white foreground and a white page). `reinjectContrastFixes` resolves each axe `target` to its CSS rule and edits only that rule's `color`. This relies on the demo-site invariant: one `<style>`, simple class or tag rules, no cascade ambiguity, zero JS.

## Verifying API versions

Library APIs move. Before coding against a dependency, confirm the real shape in `node_modules` (types, exports) rather than relying on memory. The MCP SDK is pinned to 1.x (not the 2.x pre-alpha on the SDK's main branch).

## Commands

```bash
pnpm dev         # run the MCP server (stdio)
pnpm inspect     # MCP Inspector against the server
pnpm test        # node:test via tsx (avoids relying on native strip-types; engine stays Node 22+)
pnpm typecheck   # tsc --noEmit on src, then on test
pnpm build       # tsc to dist/
```

## Tests

- `node:test` run through `tsx` (so they do not depend on native strip-types, and so types in tests are checked).
- The deterministic core (`contrast.ts`) is unit tested. The remediation loop has an end-to-end test. Network and LLM paths are covered by input-contract tests that fail before any external call.
- Playwright tests need Chromium (`pnpm exec playwright install chromium`).

## Git

Commit or push only when asked. End commit messages with the Co-Authored-By trailer.
