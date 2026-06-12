import { test } from "node:test";
import assert from "node:assert/strict";

import { ping } from "../src/tools/ping.ts";

test("ping returns 'pong' with no message", () => {
  assert.equal(ping({}), "pong");
  assert.equal(ping({ message: undefined }), "pong");
});

test("ping echoes the message", () => {
  assert.equal(ping({ message: "hackathon" }), "pong: hackathon");
});

test("ping treats an empty string as no message", () => {
  // "" is falsy → no echo, stays a plain pong
  assert.equal(ping({ message: "" }), "pong");
});
