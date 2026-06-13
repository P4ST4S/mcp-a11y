#!/usr/bin/env node
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { auditPage } from "../tools/auditPage.js";
import { simpleFixes } from "../tools/simpleFixes.js";
import { generateAltText } from "../tools/generateAltText.js";
import { reinjectContrastFixes, injectAltText, type ContrastFixRequest } from "../lib/html.js";
import { generateReport, type GeneratedAltText } from "../lib/report.js";
import { openPr } from "../tools/openPr.js";

/**
 * Demo runner - orchestrates the full loop audit → fixes → report → (PR) by
 * reusing the pure tool functions directly (not over MCP). Logs to stderr so
 * stdout stays clean; this is a CLI, not the MCP server.
 *
 * Usage:
 *   tsx src/runner/demo.ts <htmlFile> [--url <auditUrl>] [--alt] [--pr] \
 *       [--repo-path demo-site/index.html] [--report out.html]
 *
 *   <htmlFile>      Local HTML source to remediate (default: demo-site/index.html)
 *   --url           URL to audit (default: file:// of <htmlFile>)
 *   --alt           Also run generate_alt_text (needs ANTHROPIC_API_KEY)
 *   --pr            Open a PR on A11Y_TARGET_REPO (needs GITHUB_TOKEN). Off by default.
 *   --repo-path     Path of the file inside the target repo (for --pr)
 *   --report        Where to write the HTML report (default: a11y-report.html)
 */

function log(msg: string): void {
  console.error(msg);
}

function getFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getOpt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const htmlFile = resolve(positional ?? "demo-site/index.html");
  const auditUrl = getOpt("url") ?? pathToFileURL(htmlFile).href;
  const reportPath = resolve(getOpt("report") ?? "a11y-report.html");
  const doAlt = getFlag("alt");
  const doPr = getFlag("pr");
  const repoPath = getOpt("repo-path") ?? "demo-site/index.html";

  const src = readFileSync(htmlFile, "utf8");

  // 1. Audit (deterministic).
  log(`▶ Auditing ${auditUrl} …`);
  const before = await auditPage({ url: auditUrl });
  log(`  ${before.violationCount} violation rule(s): ${before.violations.map((v) => v.id).join(", ")}`);

  // 2. Structural fixes (deterministic).
  log("▶ Applying structural fixes (lang/title/labels) …");
  const structural = simpleFixes({ html: src });
  for (const f of structural.fixes) log(`  • ${f.rule}: ${f.description}`);

  // 3. Contrast reinjection (deterministic), driven by audit colors + targets.
  log("▶ Fixing contrast …");
  const contrast = before.violations.find((v) => v.id === "color-contrast");
  const requests: ContrastFixRequest[] = [];
  for (const node of contrast?.nodes ?? []) {
    const cc = node.checks.find((c) => c.id === "color-contrast");
    const data = cc?.data as { fgColor?: string; bgColor?: string } | undefined;
    if (data?.fgColor && data?.bgColor) {
      requests.push({ target: node.target, fg: data.fgColor, bg: data.bgColor });
    }
  }
  const reinjected = reinjectContrastFixes(structural.html, requests);
  for (const a of reinjected.applied) log(`  • ${a.selector}: ${a.fromColor} → ${a.toColor}`);

  let patchedHtml = reinjected.html;

  // 4. Alt text (the ONLY LLM step) - optional.
  const altTexts: GeneratedAltText[] = [];
  if (doAlt) {
    log("▶ Generating alt text (vision model) …");
    try {
      const result = await generateAltText({ pageUrl: auditUrl, selector: "img" });
      altTexts.push({ target: "img", altText: result.altText, model: result.model });
      // Inject the alt via the parser (ignores <img> mentioned in comments).
      const injected = injectAltText(patchedHtml, result.altText, "img");
      patchedHtml = injected.html;
      log(`  • img: "${result.altText}" (${result.model})`);
    } catch (err) {
      log(`  ! alt text skipped: ${(err as Error).message}`);
    }
  }

  // 5. Re-audit the patched output.
  const tmpOut = resolve(".a11y-fixed.html");
  writeFileSync(tmpOut, patchedHtml, "utf8");
  log("▶ Re-auditing patched output …");
  const after = await auditPage({ url: pathToFileURL(tmpOut).href });
  log(`  ${after.violationCount} violation rule(s) remaining: ${after.violations.map((v) => v.id).join(", ") || "none 🎉"}`);

  // 6. Report.
  const html = generateReport({
    url: auditUrl,
    auditBefore: before,
    simpleFixes: structural.fixes,
    contrastFixes: reinjected.applied,
    altTexts,
    auditAfter: after,
  });
  writeFileSync(reportPath, html, "utf8");
  log(`▶ Report written to ${reportPath}`);

  // 7. PR (opt-in, controlled target).
  if (doPr) {
    log("▶ Opening PR on A11Y_TARGET_REPO …");
    const pr = await openPr({
      title: "a11y: automated WCAG remediation",
      body:
        "Automated accessibility fixes by mcp-a11y.\n\n" +
        `- Violations before: ${before.violationCount}\n` +
        `- Violations after: ${after.violationCount}\n`,
      // Unique per run so the demo can be replayed without a branch conflict.
      branch: getOpt("branch") ?? `a11y/fix-${Date.now()}`,
      files: [{ path: repoPath, content: patchedHtml }],
    });
    log(`  ✔ PR #${pr.number}: ${pr.url}`);
  } else {
    log("▶ Skipping PR (pass --pr to open one on A11Y_TARGET_REPO).");
  }

  log("✓ Done.");
}

main().catch((err) => {
  console.error("Demo runner failed:", err);
  process.exit(1);
});
