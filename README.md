# mcp-a11y

> The USB-C port of accessibility: one MCP server that audits any web page against WCAG and applies fixes, drivable from any MCP client (Claude Desktop, etc.).

## The problem

Web accessibility is a solved science (WCAG tells you exactly what is broken) but a chronic practice. Every team rebuilds the same audit-and-fix loop, glued to one framework or one CI vendor, behind one proprietary dashboard. The knowledge does not travel.

mcp-a11y turns that loop into a standard interface. Detection stays 100% deterministic (axe-core decides what is broken, never a model). The only place a model is used is to describe images for alt text. Any MCP client can plug in, audit a page, get deterministic fixes back, and open a mergeable PR. That is the thesis: a universal, boring, reliable port for accessibility, not another walled garden.

## How it works

```
audit_page  ──►  fix_contrast        ──►  generate_report  ──►  open_pr
(axe-core)       simple_fixes              (before/after)         (controlled repo)
                 generate_alt_text
                 (the only LLM step)
```

Detection is deterministic. Structural and contrast fixes are deterministic. A vision model is called only for alt text. Fixes are reinjected into the source by CSS selector (not by raw color value), so the patched file is what gets committed.

## Tools

| Tool | What it does | Deterministic? |
| --- | --- | --- |
| `audit_page(url)` | Playwright + axe-core, returns structured WCAG violations (with selectors and colors) | Yes, no LLM |
| `fix_contrast(fg, bg)` | Closest WCAG-compliant foreground color (AA 4.5:1 normal text) | Yes, no LLM |
| `simple_fixes(html)` | Missing `lang`, missing `<title>`, unlabeled form controls | Yes, no LLM |
| `generate_alt_text(imageUrl \| selector)` | Vision model describes an image for an HTML `alt` attribute | No, the only LLM step |
| `generate_report(...)` | Self-contained before/after HTML report | Yes, no LLM |
| `open_pr(...)` | Opens a mergeable PR via Octokit. Strict guardrail: only ever touches `A11Y_TARGET_REPO` | Yes, no LLM |

Each tool's logic is isolated and testable off-MCP, with no shared state between tools. The deterministic helpers in `src/lib` are pure (no I/O); `audit_page`, `generate_alt_text`, and `open_pr` perform I/O (browser, model, GitHub) by nature.

## Stack

TypeScript end-to-end, ESM, Node 20+. MCP TypeScript SDK 1.x, Playwright + axe-core, Octokit, Anthropic SDK, Zod v3.

## Quick start

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env   # fill in keys (see Configuration)
```

Run the MCP server (stdio):

```bash
pnpm dev
```

Inspect it with the MCP Inspector:

```bash
pnpm inspect
```

Run the full demo loop (audit, fix, report) on the bundled broken page:

```bash
pnpm exec tsx src/runner/demo.ts demo-site/index.html --report a11y-report.html
# add --alt to also generate alt text (needs ANTHROPIC_API_KEY)
# add --pr  to open a PR on A11Y_TARGET_REPO (needs GITHUB_TOKEN)
```

## Configuration

Copy `.env.example` to `.env`:

```
ANTHROPIC_API_KEY=...     # used ONLY by generate_alt_text
GITHUB_TOKEN=...          # used ONLY by open_pr
A11Y_TARGET_REPO=owner/repo   # STRICT guardrail: the only repo open_pr will touch
A11Y_ALT_TEXT_MODEL=claude-haiku-4-5   # optional, defaults to Haiku
```

The server boots even without keys. Only the tool that needs a key fails, with a clear message.

## Use from Claude Desktop

Add this to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-a11y": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/mcp-a11y", "dev"]
    }
  }
}
```

Then ask Claude to audit a URL, fix the issues, and open a PR.

## Demo target

`demo-site/index.html` is an intentionally broken page (images without alt, poor contrast, no `lang`, form without labels). It is 100% static with zero JavaScript, so the rendered DOM equals the source file, and all colors live in a single `<style>` block. That invariant is what makes deterministic reinjection of fixes into the source reliable.

For a coherent audit-to-PR loop, that page is meant to live inside `A11Y_TARGET_REPO` (served via GitHub Pages or the raw file URL): you audit the file that is in the repo, fix it, and re-PR it.

## Guardrail

`open_pr` never accepts an arbitrary repo. The target comes only from `A11Y_TARGET_REPO`, validated as exactly `owner/repo`. Passing a different `repo` is refused before any network call. This is a controlled demo target by design.

## Tests

```bash
pnpm test        # node:test via tsx
pnpm typecheck   # tsc on src and test
```

The deterministic core (contrast math) is unit tested, and the full remediation loop has an end-to-end test (audit, fix, reinject, re-audit clears the violations).

## License

MIT
