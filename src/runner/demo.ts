#!/usr/bin/env node
import "dotenv/config";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import { Octokit } from "octokit";

import { auditPage } from "../tools/auditPage.js";
import { simpleFixes } from "../tools/simpleFixes.js";
import { generateAltText } from "../tools/generateAltText.js";
import { reinjectContrastFixes, injectAltText, getImageSrc, type ContrastFixRequest } from "../lib/html.js";
import { generateReport, buildPrBody, type GeneratedAltText } from "../lib/report.js";
import { openPr } from "../tools/openPr.js";
import { getGithubToken, getTargetRepo } from "../config.js";

/**
 * Demo runner - orchestrates the full loop audit → fixes → report → (PR) by
 * reusing the pure tool functions directly (not over MCP). Logs to stderr so
 * stdout stays clean; this is a CLI, not the MCP server.
 *
 * Two source modes:
 *   - Local file (default): audit and remediate a local HTML file. The PR (if
 *     any) commits it under --repo-path.
 *   - --from-repo <path>: fetch THAT file from A11Y_TARGET_REPO, audit and
 *     remediate it, and re-PR the SAME path. This is the coherent loop: you
 *     fix the exact file that lives in the target repo, with no demo gap.
 *
 * Usage:
 *   tsx src/runner/demo.ts [<htmlFile>] [--from-repo <path>] [--url <auditUrl>] \
 *       [--alt] [--img-selector <sel>] [--pr] [--repo-path <path>] [--report out.html]
 *
 *   <htmlFile>       Local HTML source (default: demo-site/index.html). Ignored with --from-repo.
 *   --from-repo      Fetch and remediate this path from A11Y_TARGET_REPO, then re-PR the same path.
 *   --url            Override the audit URL (default: file:// of the source).
 *   --alt            Also run generate_alt_text (needs ANTHROPIC_API_KEY).
 *   --img-selector   CSS selector for the image to describe (default: first <img> without alt).
 *   --pr             Open a PR on A11Y_TARGET_REPO (needs GITHUB_TOKEN). Off by default.
 *   --repo-path      Path of the file inside the target repo (defaults to --from-repo, else demo-site/index.html).
 *   --report         Where to write the HTML report (default: a11y-report.html).
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

/** Fetch a file's content from A11Y_TARGET_REPO (default branch). */
async function fetchFromTargetRepo(path: string): Promise<string> {
  const target = getTargetRepo();
  const [owner, repo] = target.split("/");
  const octokit = new Octokit({ auth: getGithubToken() });
  const res = await octokit.rest.repos.getContent({ owner, repo, path });
  if (Array.isArray(res.data) || res.data.type !== "file") {
    throw new Error(`${path} in ${target} is not a file.`);
  }
  return Buffer.from(res.data.content, "base64").toString("utf8");
}

/**
 * Raw GitHub bases for resolving image URLs over http:
 *   - fileUrl: the raw URL of the HTML document (for relative src like "img/x").
 *   - rootUrl: the repo root base ".../owner/repo/branch/" (for root-relative
 *     src like "/img/x", which must NOT resolve against the origin).
 */
async function rawBases(path: string): Promise<{ fileUrl: string; rootUrl: string }> {
  const target = getTargetRepo();
  const [owner, repo] = target.split("/");
  const octokit = new Octokit({ auth: getGithubToken() });
  const info = await octokit.rest.repos.get({ owner, repo });
  const branch = info.data.default_branch;
  const rootUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  return { fileUrl: new URL(path, rootUrl).href, rootUrl };
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const fromRepo = getOpt("from-repo");
  const reportPath = resolve(getOpt("report") ?? "a11y-report.html");
  const doAlt = getFlag("alt");
  const doPr = getFlag("pr");
  const imgSelector = getOpt("img-selector") ?? "img";

  // Scratch directory in the OS temp location (never the project cwd). Holds the
  // fetched source and the patched copy we audit; removed in finally.
  const workDir = mkdtempSync(join(tmpdir(), "mcp-a11y-"));
  try {
    await run();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  async function run(): Promise<void> {
  // Resolve the source: either a file in the target repo (coherent loop) or a
  // local file. The PR commits to the same path we sourced from.
  let src: string;
  let auditUrl: string;
  let repoPath: string;
  // Human-readable label for the audited file (the temp file:// path is noise).
  let displayUrl: string;
  // Bases to resolve image src over http (file:// fetch is unsupported).
  let assetBaseUrl: string | undefined;
  let assetRootUrl: string | undefined;

  if (fromRepo) {
    log(`▶ Fetching ${fromRepo} from A11Y_TARGET_REPO …`);
    src = await fetchFromTargetRepo(fromRepo);
    repoPath = getOpt("repo-path") ?? fromRepo;
    // Write to a temp file so axe can audit the rendered DOM via file://.
    const tmpSource = join(workDir, "source.html");
    writeFileSync(tmpSource, src, "utf8");
    auditUrl = getOpt("url") ?? pathToFileURL(tmpSource).href;
    const bases = await rawBases(fromRepo);
    assetBaseUrl = bases.fileUrl;
    assetRootUrl = bases.rootUrl;
    displayUrl = `${getTargetRepo()}/${fromRepo}`;
  } else {
    const htmlFile = resolve(positional ?? "demo-site/index.html");
    src = readFileSync(htmlFile, "utf8");
    repoPath = getOpt("repo-path") ?? "demo-site/index.html";
    auditUrl = getOpt("url") ?? pathToFileURL(htmlFile).href;
    displayUrl = auditUrl;
  }

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

  // 4. Alt text (the ONLY LLM step) - optional. One call per image flagged by
  // axe, each addressed by its own selector so multiple images are all fixed.
  // We cache by image URL so the same image is described once, even if it
  // appears under several selectors (one model call, consistent text).
  const altTexts: GeneratedAltText[] = [];
  if (doAlt) {
    log("▶ Generating alt text (vision model) …");
    const imageAlt = before.violations.find((v) => v.id === "image-alt");
    const selectors = imageAlt
      ? imageAlt.nodes.map((n) => n.target[n.target.length - 1]).filter(Boolean)
      : [imgSelector];
    const altByImageUrl = new Map<string, string>();
    for (const sel of selectors) {
      try {
        const srcKey = getImageSrc(patchedHtml, sel);
        let altText: string;
        let model = "(cached)";
        const cached = srcKey ? altByImageUrl.get(srcKey) : undefined;
        if (cached) {
          altText = cached;
        } else {
          const result = await generateAltText({
            pageUrl: auditUrl,
            selector: sel,
            assetBaseUrl,
            assetRootUrl,
          });
          altText = result.altText;
          model = result.model;
          if (srcKey) altByImageUrl.set(srcKey, altText);
        }
        const injected = injectAltText(patchedHtml, altText, sel);
        if (injected.injected) {
          patchedHtml = injected.html;
          altTexts.push({ target: sel, altText, model });
          log(`  • ${sel}: "${altText}" (${model})`);
        }
      } catch (err) {
        log(`  ! alt text skipped for ${sel}: ${(err as Error).message}`);
      }
    }
  }

  // 5. Re-audit the patched output (written to the scratch dir, not the cwd).
  const tmpOut = join(workDir, "patched.html");
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
      body: buildPrBody({
        auditedUrl: displayUrl,
        before: before.violationCount,
        after: after.violationCount,
        simpleFixes: structural.fixes,
        contrastFixes: reinjected.applied,
        altTexts,
      }),
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
}

main().catch((err) => {
  console.error("Demo runner failed:", err);
  process.exit(1);
});
