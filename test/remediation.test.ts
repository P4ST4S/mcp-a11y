import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
  // Title is derived from the <h1>, not a generic placeholder.
  assert.match(html, /<title>Acme Widgets<\/title>/);
  assert.match(html, /aria-label="Email"/);

  // Idempotent: re-running finds nothing left to fix.
  const second = simpleFixes({ html });
  assert.equal(second.fixes.length, 0);
});

test("document-title falls back to a placeholder when there is no <h1>", () => {
  const html = "<html><head></head><body><p>no heading</p></body></html>";
  const { html: out } = simpleFixes({ html });
  assert.match(out, /<title>Untitled page<\/title>/);
});

test("contrast fix preserves a colored button by adjusting its background", () => {
  // .cta: white text on a colored surface -> keep the text, darken the surface.
  const html =
    '<html><body><style>.cta{color:#ffffff;background-color:#6cb2eb}</style>' +
    '<button class="cta">Go</button></body></html>';
  const r = reinjectContrastFixes(html, [{ target: ["button"], fg: "#ffffff", bg: "#6cb2eb" }]);
  const fix = r.applied[0];
  assert.equal(fix.property, "background-color");
  assert.match(r.html, /color:#ffffff/); // text stays white
  assert.doesNotMatch(r.html, /color:#404040/); // not the old text-darkening behavior
  assert.ok(fix.ratioAfter >= 4.5);
});

test("contrast fix handles the `background:` shorthand, not just background-color", () => {
  // Regression: the shorthand was detected as a surface but never rewritten.
  const html =
    '<html><body><style>.cta{color:#ffffff;background:#6cb2eb url(x.png) no-repeat}</style>' +
    '<button class="cta">Go</button></body></html>';
  const r = reinjectContrastFixes(html, [{ target: ["button"], fg: "#ffffff", bg: "#6cb2eb" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].property, "background-color");
  assert.doesNotMatch(r.html, /#6cb2eb/); // old color gone
  assert.match(r.html, /url\(x\.png\) no-repeat/); // other layers preserved
  assert.match(r.html, /color:#ffffff/); // text stays white
});

test("contrast fix recolors text on a white/neutral background", () => {
  // .muted: gray text on a white page surface -> recolor the text, not the bg.
  const html =
    '<html><body><style>.muted{color:#999999;background-color:#ffffff}</style>' +
    '<p class="muted">hi</p></body></html>';
  const r = reinjectContrastFixes(html, [{ target: [".muted"], fg: "#999999", bg: "#ffffff" }]);
  const fix = r.applied[0];
  assert.equal(fix.property, "color");
  assert.match(r.html, /background-color:#ffffff/); // page stays white
  assert.ok(fix.ratioAfter >= 4.5);
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

test("injectAltText HTML-encodes the (untrusted) alt text", () => {
  const { html } = injectAltText("<img src=x>", 'Fish & chips <b> "q" >end');
  // & < > are encoded; the parser encodes the quote. No raw special chars leak.
  assert.match(html, /alt="Fish &amp; chips &lt;b&gt; &quot;q&quot; &gt;end"/);
  // No double-encoding of the quote entity.
  assert.doesNotMatch(html, /&amp;quot;/);
  // No raw < or > inside the attribute value.
  assert.doesNotMatch(html, /alt="[^"]*[<>][^"]*"/);
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

  // 3. Write patched source and re-audit. Clean the temp dir afterwards.
  const dir = mkdtempSync(join(tmpdir(), "mcp-a11y-"));
  try {
    const outPath = join(dir, "index.html");
    writeFileSync(outPath, reinjected.html, "utf8");

    const after = await auditPage({ url: pathToFileURL(outPath).href });
    const afterIds = new Set(after.violations.map((v) => v.id));

    for (const cleared of ["html-has-lang", "document-title", "label", "color-contrast"]) {
      assert.ok(!afterIds.has(cleared), `"${cleared}" should be cleared, still: ${[...afterIds]}`);
    }
    // image-alt is NOT handled deterministically (needs the vision model in step 4).
    assert.ok(afterIds.has("image-alt"), "image-alt remains until generate_alt_text runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
