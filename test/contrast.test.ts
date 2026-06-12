import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AA_NORMAL,
  parseColor,
  toHex,
  contrastRatio,
  relativeLuminance,
  fixContrast,
} from "../src/lib/contrast.ts";

test("parseColor handles #rgb, #rrggbb and rgb()", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor("#000000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseColor("rgb(153, 153, 153)"), { r: 153, g: 153, b: 153 });
  assert.throws(() => parseColor("blue"));
});

test("toHex round-trips and normalizes to lowercase #rrggbb", () => {
  assert.equal(toHex({ r: 153, g: 153, b: 153 }), "#999999");
  assert.equal(toHex(parseColor("#FFF")), "#ffffff");
});

test("contrast ratio is correct for known pairs and order-independent", () => {
  // Black on white is the maximum, 21:1.
  assert.equal(Math.round(contrastRatio(parseColor("#000"), parseColor("#fff"))), 21);
  // Order does not matter.
  assert.equal(
    contrastRatio(parseColor("#999"), parseColor("#fff")),
    contrastRatio(parseColor("#fff"), parseColor("#999")),
  );
});

test("relative luminance: white = 1, black = 0", () => {
  assert.ok(Math.abs(relativeLuminance(parseColor("#fff")) - 1) < 1e-9);
  assert.equal(relativeLuminance(parseColor("#000")), 0);
});

test("#999 on #fff fails AA, and the fix reaches >= 4.5:1", () => {
  const fix = fixContrast("#999999", "#ffffff");
  assert.ok(fix.originalRatio < AA_NORMAL, `original ${fix.originalRatio} should fail AA`);
  assert.equal(fix.alreadyCompliant, false);
  assert.ok(fix.passesAA, "fix should pass AA");
  assert.ok(fix.newRatio >= AA_NORMAL, `new ratio ${fix.newRatio} >= ${AA_NORMAL}`);
  // Darkening on a white bg → the compliant fg is darker than #999.
  assert.ok(fix.compliantFg < "#999999");
});

test("fixContrast leaves an already-compliant pair untouched (idempotent)", () => {
  const fix = fixContrast("#000000", "#ffffff");
  assert.equal(fix.alreadyCompliant, true);
  assert.equal(fix.compliantFg, "#000000");
  assert.equal(fix.newRatio, fix.originalRatio);

  // Re-running the fix on its own output stays compliant and stable.
  const again = fixContrast(fix.compliantFg, "#ffffff");
  assert.equal(again.compliantFg, fix.compliantFg);
});

test("fixContrast is deterministic across runs", () => {
  const a = fixContrast("#6cb2eb", "#ffffff");
  const b = fixContrast("#6cb2eb", "#ffffff");
  assert.deepEqual(a, b);
});

test("white text on a mid-blue button is fixed by darkening fg to reach AA", () => {
  // fg=#fff on bg=#6cb2eb fails (~2.3:1). White cannot be lightened further, so
  // the algorithm must darken toward black to reach the target.
  const fix = fixContrast("#ffffff", "#6cb2eb");
  assert.ok(fix.passesAA, `expected AA, got ${fix.newRatio}`);
  assert.ok(fix.newRatio >= AA_NORMAL);
  assert.ok(fix.compliantFg < "#ffffff", "compliant fg should be darker than white");
});

test("fixContrast keeps the compliant fg as close to the original as possible", () => {
  // Both directions could satisfy a low target; the closer one must win.
  const fix = fixContrast("#777777", "#ffffff");
  assert.ok(fix.passesAA);
  // On white bg, the closest compliant color is darker, not pure black.
  assert.ok(fix.compliantFg > "#000000", "should not jump straight to black");
});
