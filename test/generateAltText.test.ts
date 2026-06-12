import { test } from "node:test";
import assert from "node:assert/strict";

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { generateAltText } from "../src/tools/generateAltText.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoUrl = pathToFileURL(join(here, "..", "demo-site", "index.html")).href;

// These assert input-contract behavior that fails BEFORE any network/LLM call,
// so they run deterministically without an API key.

test("generateAltText requires imageUrl or selector", async () => {
  await assert.rejects(() => generateAltText({}), /Provide either/);
});

test("generateAltText requires pageUrl when using selector", async () => {
  await assert.rejects(() => generateAltText({ selector: "img" }), /requires `pageUrl`/);
});

test("generateAltText rejects non-http(s) imageUrl before any LLM call", async () => {
  await assert.rejects(() => generateAltText({ imageUrl: "file:///tmp/x.png" }), /http\(s\)/);
  await assert.rejects(
    () => generateAltText({ imageUrl: "data:image/png;base64,abc" }),
    /http\(s\)/,
  );
});

test("generateAltText surfaces a clear error when the API key is missing", async (t) => {
  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith("your_")) {
    t.skip("ANTHROPIC_API_KEY is set - skipping the missing-key path");
    return;
  }
  await assert.rejects(
    () => generateAltText({ imageUrl: "https://example.com/x.png" }),
    /ANTHROPIC_API_KEY is not set/,
  );
});

test("generateAltText fails fast on a missing selector (no 30s timeout)", { timeout: 20_000 }, async () => {
  // If the fast count() check regressed, this would hang ~30s and blow the timeout.
  await assert.rejects(
    () => generateAltText({ pageUrl: demoUrl, selector: "img.does-not-exist" }),
    /No element found for selector/,
  );
});
