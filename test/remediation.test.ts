import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { auditPage } from "../src/tools/auditPage.ts";
import { simpleFixes } from "../src/tools/simpleFixes.ts";
import { reinjectContrastFixes, injectAltText, type ContrastFixRequest } from "../src/lib/html.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoPath = join(here, "..", "demo-site", "index.html");

test("simpleFixes adds lang, title and labels deterministically", () => {
  const src = readFileSync(demoPath, "utf8");
  const { html, fixes } = simpleFixes({ html: src });
  const rules = fixes.map((f) => f.rule);
  assert.ok(rules.includes("html-has-lang"));
  assert.ok(rules.includes("document-title"));
  assert.ok(rules.includes("label"));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>/);
  assert.match(html, /aria-label="Email"/);

  // Idempotent: re-running finds nothing left to fix.
  const second = simpleFixes({ html });
  assert.equal(second.fixes.length, 0);
});

test("injectAltText targets the real <img>, not one mentioned in a comment", () => {
  // Regression: a regex on the raw string matched the <img> inside the comment
  // first, corrupting the comment and leaving the real image without alt.
  const html =
    '<html><body><!-- <img> with no alt --><img src="dog.png"></body></html>';
  const { html: out, injected } = injectAltText(html, "A black dog");
  assert.ok(injected);
  assert.match(out, /<img src="dog\.png" alt="A black dog">/);
  // The comment is untouched.
  assert.match(out, /<!-- <img> with no alt -->/);
});

test("injectAltText leaves an image that already has alt alone", () => {
  const html = '<html><body><img src="x.png" alt="already"></body></html>';
  const { injected } = injectAltText(html, "new");
  assert.equal(injected, false);
});

test("simpleFixes does not relabel controls that already have a label", () => {
  // Implicit label (input wrapped in <label>) - must be left untouched.
  const implicit = '<html><body><form><label>Work email <input name="email"></label></form></body></html>';
  const r1 = simpleFixes({ html: implicit });
  assert.ok(!r1.fixes.some((f) => f.rule === "label"), "implicit label should not trigger a fix");
  assert.doesNotMatch(r1.html, /aria-label/);

  // Explicit label via for/id - also untouched.
  const explicit =
    '<html><body><form><label for="e">Email</label><input id="e" name="email"></form></body></html>';
  const r2 = simpleFixes({ html: explicit });
  assert.ok(!r2.fixes.some((f) => f.rule === "label"));
});

test("simpleFixes handles a special-character id without throwing", () => {
  const html = '<html><body><form><input id=\'a"b\' name="weird"></form></body></html>';
  // Should not throw on the unescaped id and should still add a label (no matching <label for>).
  const r = simpleFixes({ html });
  assert.ok(r.fixes.some((f) => f.rule === "label"));
});

test("end-to-end: audit → fix → reinject → re-audit clears the violations", { timeout: 90_000 }, async () => {
  const src = readFileSync(demoPath, "utf8");
  const before = await auditPage({ url: pathToFileURL(demoPath).href });
  const beforeIds = new Set(before.violations.map((v) => v.id));
  assert.ok(beforeIds.has("color-contrast"));
  assert.ok(beforeIds.has("html-has-lang"));
  assert.ok(beforeIds.has("document-title"));
  assert.ok(beforeIds.has("label"));

  // 1. Structural fixes.
  const structural = simpleFixes({ html: src });

  // 2. Contrast reinjection, driven by the audit's reported colors AND targets.
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
  assert.ok(reinjected.applied.length > 0, "should reinject at least one color into <style>");

  // 3. Write patched source and re-audit.
  const dir = mkdtempSync(join(tmpdir(), "mcp-a11y-"));
  const outPath = join(dir, "index.html");
  writeFileSync(outPath, reinjected.html, "utf8");

  const after = await auditPage({ url: pathToFileURL(outPath).href });
  const afterIds = new Set(after.violations.map((v) => v.id));

  for (const cleared of ["html-has-lang", "document-title", "label", "color-contrast"]) {
    assert.ok(!afterIds.has(cleared), `"${cleared}" should be cleared, still: ${[...afterIds]}`);
  }
  // image-alt is NOT handled deterministically (needs the vision model in step 4).
  assert.ok(afterIds.has("image-alt"), "image-alt remains until generate_alt_text runs");
});
