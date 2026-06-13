import type { AuditResult } from "../tools/auditPage.js";
import type { AppliedFix, ContrastReinjection } from "./html.js";

/**
 * Generate a self-contained before/after HTML report. Pure function, no I/O,
 * no LLM. Inline CSS so the output is a single openable file - this is the
 * visible surface for a stdio MCP server (UX scoring) and the demo video.
 */

export interface GeneratedAltText {
  /** Image URL or selector the alt text was produced for. */
  target: string;
  altText: string;
  model: string;
  /**
   * Optional inline image preview as a `data:` URI. Only embedded if it is a
   * `data:` URI - the report stays self-contained, so no remote `src` is ever
   * emitted.
   */
  previewDataUri?: string;
}

export interface ReportInput {
  /** Audited URL / page label. */
  url: string;
  auditBefore: AuditResult;
  /** Structural fixes applied (lang/title/labels). */
  simpleFixes?: AppliedFix[];
  /** Contrast color swaps reinjected into the source. */
  contrastFixes?: ContrastReinjection[];
  /** Alt texts produced by the vision model. */
  altTexts?: GeneratedAltText[];
  /** Optional second audit after fixes - enables the "after" column. */
  auditAfter?: AuditResult;
  /** Optional timestamp string (caller stamps it; the lib stays pure). */
  generatedAt?: string;
}

const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"] as const;

export function generateReport(input: ReportInput): string {
  const before = input.auditBefore.violationCount;
  const after = input.auditAfter?.violationCount;
  const fixedCount =
    after !== undefined ? Math.max(0, before - after) : countAppliedFixes(input);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-a11y report - ${escapeHtml(input.url)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f6f8fa; color: #1f2328; }
  .wrap { max-width: 60rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  header h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
  header .sub { color: #57606a; font-size: .9rem; word-break: break-all; }
  .cards { display: flex; gap: 1rem; margin: 1.5rem 0; flex-wrap: wrap; }
  .card { flex: 1 1 9rem; background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 1rem 1.25rem; }
  .card .n { font-size: 2rem; font-weight: 700; line-height: 1; }
  .card .l { color: #57606a; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  .card.before .n { color: #cf222e; }
  .card.fixed .n { color: #1a7f37; }
  .card.after .n { color: ${after === 0 ? "#1a7f37" : "#9a6700"}; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; border-bottom: 1px solid #d0d7de; padding-bottom: .4rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid #eaeef2; font-size: .9rem; vertical-align: top; }
  th { background: #f6f8fa; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; color: #57606a; }
  tr:last-child td { border-bottom: none; }
  code { background: #eff1f3; padding: .1rem .35rem; border-radius: 4px; font-size: .85em; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .72rem; font-weight: 600; text-transform: uppercase; }
  .badge.critical { background: #ffebe9; color: #cf222e; }
  .badge.serious { background: #fff1e5; color: #bc4c00; }
  .badge.moderate { background: #fff8c5; color: #7d4e00; }
  .badge.minor, .badge.unknown { background: #eaeef2; color: #57606a; }
  .swatch { display: inline-block; width: 1rem; height: 1rem; border-radius: 3px; border: 1px solid #00000022; vertical-align: middle; margin-right: .35rem; }
  .arrow { color: #57606a; margin: 0 .4rem; }
  .empty { color: #57606a; font-style: italic; padding: .75rem; }
  figure { margin: 0; }
  figure img { max-width: 8rem; border-radius: 6px; border: 1px solid #d0d7de; display: block; }
  .alt { color: #1f2328; }
  footer { margin-top: 2.5rem; color: #57606a; font-size: .8rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Accessibility remediation report</h1>
    <div class="sub">${escapeHtml(input.url)}${input.generatedAt ? ` · ${escapeHtml(input.generatedAt)}` : ""}</div>
  </header>

  <div class="cards">
    <div class="card before"><div class="n">${before}</div><div class="l">Violations before</div></div>
    <div class="card fixed"><div class="n">${fixedCount}</div><div class="l">Fixes applied</div></div>
    ${after !== undefined ? `<div class="card after"><div class="n">${after}</div><div class="l">Violations after</div></div>` : ""}
  </div>

  ${renderViolations("Violations detected (before)", input.auditBefore.violations)}
  ${renderContrastFixes(input.contrastFixes)}
  ${renderSimpleFixes(input.simpleFixes)}
  ${renderAltTexts(input.altTexts)}
  ${input.auditAfter ? renderViolations("Remaining violations (after)", input.auditAfter.violations) : ""}

  <footer>Generated by <strong>mcp-a11y</strong> - the USB-C port of accessibility. Detection by axe-core (deterministic); alt text by a vision model.</footer>
</div>
</body>
</html>`;
}

function countAppliedFixes(input: ReportInput): number {
  return (
    (input.simpleFixes?.length ?? 0) +
    (input.contrastFixes?.length ?? 0) +
    (input.altTexts?.length ?? 0)
  );
}

function renderViolations(title: string, violations: AuditResult["violations"]): string {
  if (violations.length === 0) {
    return `<h2>${escapeHtml(title)}</h2><div class="empty">No violations 🎉</div>`;
  }
  const sorted = [...violations].sort(
    (a, b) => impactRank(a.impact) - impactRank(b.impact),
  );
  const rows = sorted
    .map(
      (v) => `<tr>
      <td><span class="badge ${impactClass(v.impact)}">${escapeHtml(v.impact ?? "unknown")}</span></td>
      <td><code>${escapeHtml(v.id)}</code><br>${escapeHtml(v.description)}</td>
      <td>${v.nodes.length} node${v.nodes.length > 1 ? "s" : ""}</td>
    </tr>`,
    )
    .join("\n");
  return `<h2>${escapeHtml(title)}</h2>
  <table><thead><tr><th>Impact</th><th>Rule</th><th>Count</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function renderContrastFixes(fixes: ContrastReinjection[] | undefined): string {
  if (!fixes || fixes.length === 0) return "";
  const rows = fixes
    .map(
      (f) => `<tr>
      <td><code>${escapeHtml(f.selector)}</code> <small>(rule <code>${escapeHtml(f.rule)}</code>)</small></td>
      <td><span class="swatch" style="background:${escapeAttr(f.fromColor)}"></span><code>${escapeHtml(f.fromColor)}</code>
      <span class="arrow">→</span>
      <span class="swatch" style="background:${escapeAttr(f.toColor)}"></span><code>${escapeHtml(f.toColor)}</code></td>
    </tr>`,
    )
    .join("\n");
  return `<h2>Contrast fixes</h2>
  <table><thead><tr><th>Element</th><th>Color change</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function renderSimpleFixes(fixes: AppliedFix[] | undefined): string {
  if (!fixes || fixes.length === 0) return "";
  const rows = fixes
    .map(
      (f) => `<tr><td><code>${escapeHtml(f.rule)}</code></td><td>${escapeHtml(f.description)}</td></tr>`,
    )
    .join("\n");
  return `<h2>Structural fixes</h2>
  <table><thead><tr><th>Rule</th><th>Change</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function renderAltTexts(alts: GeneratedAltText[] | undefined): string {
  if (!alts || alts.length === 0) return "";
  const rows = alts
    .map((a) => {
      // Only embed a preview when it's a self-contained data: URI. Never emit a
      // remote src - the report must stay a single openable file.
      const preview =
        a.previewDataUri && a.previewDataUri.startsWith("data:")
          ? `<figure><img src="${escapeAttr(a.previewDataUri)}" alt=""></figure><code>${escapeHtml(a.target)}</code>`
          : `<code>${escapeHtml(a.target)}</code>`;
      return `<tr><td>${preview}</td><td class="alt">${escapeHtml(a.altText)}<br><small>${escapeHtml(a.model)}</small></td></tr>`;
    })
    .join("\n");
  return `<h2>Generated alt text</h2>
  <table><thead><tr><th>Image</th><th>Alt text</th></tr></thead>
  <tbody>${rows}</tbody></table>`;
}

function impactRank(impact: string | undefined): number {
  const i = IMPACT_ORDER.indexOf((impact ?? "minor") as (typeof IMPACT_ORDER)[number]);
  return i === -1 ? IMPACT_ORDER.length : i;
}

function impactClass(impact: string | undefined): string {
  return (IMPACT_ORDER as readonly string[]).includes(impact ?? "")
    ? (impact as string)
    : "unknown";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** For attribute values inside double quotes (e.g. style/src). */
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export interface PrBodyInput {
  auditedUrl: string;
  before: number;
  after: number;
  simpleFixes?: AppliedFix[];
  contrastFixes?: ContrastReinjection[];
  altTexts?: GeneratedAltText[];
}

/**
 * Build a rich Markdown body for the remediation PR. Pure, no I/O. Mirrors the
 * report: a summary table, per-category changes with WCAG references and
 * contrast ratios, a visual-change warning when a visible color shifted, and a
 * collapsible note on how the fixes were produced.
 */
export function buildPrBody(input: PrBodyInput): string {
  const lines: string[] = [];
  lines.push("## ♿ Automated accessibility remediation");
  lines.push("");
  lines.push(
    `\`mcp-a11y\` audited **${input.auditedUrl}** against WCAG 2.1 AA and applied`,
  );
  lines.push(
    "deterministic fixes. Detection runs on axe-core; only alt text uses a vision model.",
  );
  lines.push("");
  lines.push("| WCAG violations | Before | After |");
  lines.push("|---|:--:|:--:|");
  lines.push(`| Total | **${input.before}** | **${input.after}** |`);
  lines.push("");
  lines.push("### What changed");
  lines.push("");

  const contrast = input.contrastFixes ?? [];
  if (contrast.length > 0) {
    lines.push("**Contrast - WCAG 1.4.3** · closest compliant color, minimal visual change");
    for (const c of contrast) {
      lines.push(
        `- \`${c.selector}\` \`${c.fromColor}\` → \`${c.toColor}\`  (${c.ratioBefore}:1 → ${c.ratioAfter}:1)`,
      );
    }
    lines.push("");
  }

  const structural = input.simpleFixes ?? [];
  if (structural.length > 0) {
    lines.push("**Structure**");
    for (const f of structural) {
      lines.push(`- ${f.description}  (axe rule: \`${f.rule}\`)`);
    }
    lines.push("");
  }

  const alts = input.altTexts ?? [];
  if (alts.length > 0) {
    lines.push("**Alt text** · vision-generated");
    for (const a of alts) {
      lines.push(`- \`${a.target}\` → "${a.altText}"`);
    }
    lines.push("");
  }

  for (const c of contrast.filter((f) => f.visualChange)) {
    lines.push(
      `> ⚠️ **Visual change to review:** \`${c.selector}\` ${c.property} shifted from`,
    );
    lines.push(
      `> \`${c.fromColor}\` to \`${c.toColor}\` - verify it still matches your design intent.`,
    );
    lines.push("");
  }

  lines.push("<details>");
  lines.push("<summary>How these fixes were produced</summary>");
  lines.push("");
  lines.push(
    "Everything except alt text is **deterministic and reproducible**: axe-core",
  );
  lines.push(
    "decides what is broken, and contrast/structure fixes are computed, not guessed.",
  );
  lines.push(
    "Fixes are reinjected into the source **by CSS selector** (not by raw color",
  );
  lines.push("value), so the patched file is exactly what gets committed.");
  lines.push("</details>");
  lines.push("");
  lines.push("---");
  lines.push(
    '<sub>Opened by <a href="https://github.com/P4ST4S/mcp-a11y">mcp-a11y</a> -',
  );
  lines.push(
    "the USB-C port of accessibility. These are automated changes; review before merging.</sub>",
  );

  return lines.join("\n");
}
