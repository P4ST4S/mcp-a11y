import { test } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { generateReport, buildPrBody, type ReportInput } from "../src/lib/report.ts";
import { generateReportInputSchema } from "../src/tools/generateReport.ts";
import type { AuditResult } from "../src/tools/auditPage.ts";

function audit(violations: AuditResult["violations"]): AuditResult {
  return { url: "file:///demo", violationCount: violations.length, violations };
}

const before = audit([
  {
    id: "color-contrast",
    impact: "serious",
    description: "Elements must have sufficient color contrast",
    helpUrl: "https://x",
    nodes: [{ html: "<h1>", target: ["h1"], checks: [] }],
  },
  {
    id: "image-alt",
    impact: "critical",
    description: "Images must have alternate text",
    helpUrl: "https://x",
    nodes: [{ html: "<img>", target: ["img"], checks: [] }],
  },
]);

test("report renders summary cards with before/fixed/after counts", () => {
  const input: ReportInput = {
    url: "file:///demo",
    auditBefore: before,
    auditAfter: audit([]),
    contrastFixes: [{ selector: "h1", rule: ".muted", fromColor: "#999999", toColor: "#767676" }],
    simpleFixes: [{ rule: "html-has-lang", description: 'Added lang="en"' }],
    altTexts: [{ target: "img", altText: "A black puppy on grass", model: "claude-haiku-4-5" }],
  };
  const html = generateReport(input);

  // Summary numbers.
  assert.match(html, /Violations before/);
  assert.match(html, /Violations after/);
  assert.match(html, />2<\/div>\s*<div class="l">Violations before/);
  assert.match(html, />0<\/div>\s*<div class="l">Violations after/);

  // Sections present.
  assert.match(html, /Contrast fixes/);
  assert.match(html, /Structural fixes/);
  assert.match(html, /Generated alt text/);

  // Color swatches use the actual colors.
  assert.match(html, /background:#999999/);
  assert.match(html, /background:#767676/);
  // Alt text content present.
  assert.match(html, /A black puppy on grass/);

  // Self-contained: a full document with inline CSS, no external assets.
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
});

test("report escapes HTML to avoid breaking the document", () => {
  const input: ReportInput = {
    url: 'file:///demo"><script>alert(1)</script>',
    auditBefore: audit([
      {
        id: "x",
        impact: "minor",
        description: "<b>bold</b> & risky",
        helpUrl: "https://x",
        nodes: [{ html: "<x>", target: ["x"], checks: [] }],
      },
    ]),
  };
  const html = generateReport(input);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; risky/);
});

test("report never emits a remote img src (stays self-contained)", () => {
  const httpTarget = generateReport({
    url: "file:///demo",
    auditBefore: before,
    altTexts: [{ target: "https://example.com/x.png", altText: "desc", model: "m" }],
  });
  // The target is shown as text, NOT as an <img src="https://…">.
  assert.doesNotMatch(httpTarget, /<img[^>]+src="https?:/);

  // A data: URI preview IS embedded (still self-contained).
  const withPreview = generateReport({
    url: "file:///demo",
    auditBefore: before,
    altTexts: [
      {
        target: "img",
        altText: "desc",
        model: "m",
        previewDataUri: "data:image/png;base64,iVBORw0KGgo=",
      },
    ],
  });
  assert.match(withPreview, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(withPreview, /src="https?:/);
});

test("report omits the after column when no second audit is provided", () => {
  const html = generateReport({ url: "file:///demo", auditBefore: before });
  assert.doesNotMatch(html, /Violations after/);
  // Fixes-applied card still shows (counts applied fixes = 0 here).
  assert.match(html, /Fixes applied/);
});

test("generate_report schema rejects a malformed auditBefore", () => {
  const schema = z.object(generateReportInputSchema);
  // Missing violationCount/violations - would crash the renderer; must be rejected.
  assert.equal(schema.safeParse({ url: "demo" }).success, false);
  assert.equal(schema.safeParse({ url: "demo", auditBefore: {} }).success, false);
  // A well-formed minimal input passes.
  assert.equal(
    schema.safeParse({ url: "demo", auditBefore: { violationCount: 0, violations: [] } }).success,
    true,
  );
});

test("buildPrBody renders the summary table, fixes, ratios and visual warning", () => {
  const body = buildPrBody({
    auditedUrl: "https://example.com/index.html",
    before: 5,
    after: 0,
    simpleFixes: [{ rule: "html-has-lang", description: 'Added lang="en" to <html>' }],
    contrastFixes: [
      {
        selector: "button",
        rule: ".cta",
        fromColor: "#6cb2eb",
        toColor: "#4b7ba3",
        property: "background-color",
        ratioBefore: 2.28,
        ratioAfter: 4.51,
        visualChange: true,
      },
    ],
    altTexts: [{ target: ".hero", altText: "A sun in a green sky", model: "claude-haiku-4-5" }],
  });

  assert.match(body, /Automated accessibility remediation/);
  assert.match(body, /\| Total \| \*\*5\*\* \| \*\*0\*\* \|/);
  assert.match(body, /2\.28:1 → 4\.51:1/);
  assert.match(body, /axe rule: `html-has-lang`/);
  assert.match(body, /`\.hero` → "A sun in a green sky"/);
  assert.match(body, /Visual change to review:/);
  assert.match(body, /<details>/);
  // No long dashes anywhere (en dash U+2013 / em dash U+2014).
  assert.doesNotMatch(body, new RegExp("[\\u2013\\u2014]"));
});
