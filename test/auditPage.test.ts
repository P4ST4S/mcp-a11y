import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { auditPage } from "../src/tools/auditPage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoUrl = pathToFileURL(join(here, "..", "demo-site", "index.html")).href;

// Real headless Chromium run — give it room.
test("auditPage detects the intended WCAG violations on the demo-site", { timeout: 60_000 }, async () => {
  const result = await auditPage({ url: demoUrl });

  const ids = result.violations.map((v) => v.id);
  // Deterministic fixture: these rules MUST fire.
  for (const expected of ["color-contrast", "document-title", "html-has-lang", "image-alt", "label"]) {
    assert.ok(ids.includes(expected), `expected violation "${expected}" — got ${JSON.stringify(ids)}`);
  }

  assert.equal(result.violationCount, result.violations.length);

  // color-contrast must carry the colors needed by fix_contrast (step 3 remap).
  const contrast = result.violations.find((v) => v.id === "color-contrast");
  assert.ok(contrast, "color-contrast violation present");
  const node = contrast!.nodes[0];
  assert.ok(node.target.length > 0, "node carries an axe target selector");
  const cc = node.checks.find((c) => c.id === "color-contrast");
  const data = cc?.data as { fgColor?: string; bgColor?: string } | undefined;
  assert.ok(data?.fgColor && data?.bgColor, "color-contrast check carries fg/bg colors");
});
