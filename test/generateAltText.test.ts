import { test } from "node:test";
import assert from "node:assert/strict";

import { generateAltText } from "../src/tools/generateAltText.ts";

// These assert input-contract behavior that fails BEFORE any network/LLM call,
// so they run deterministically without an API key.

test("generateAltText requires imageUrl or selector", async () => {
  await assert.rejects(() => generateAltText({}), /Provide either/);
});

test("generateAltText requires pageUrl when using selector", async () => {
  await assert.rejects(() => generateAltText({ selector: "img" }), /requires `pageUrl`/);
});

test("generateAltText surfaces a clear error when the API key is missing", async (t) => {
  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith("your_")) {
    t.skip("ANTHROPIC_API_KEY is set — skipping the missing-key path");
    return;
  }
  await assert.rejects(
    () => generateAltText({ imageUrl: "https://example.com/x.png" }),
    /ANTHROPIC_API_KEY is not set/,
  );
});
