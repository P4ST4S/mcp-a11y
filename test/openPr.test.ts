import { test } from "node:test";
import assert from "node:assert/strict";

import { openPr } from "../src/tools/openPr.ts";

// The guardrail must fire BEFORE any network call, so these run offline.

test("open_pr refuses a repo that is not A11Y_TARGET_REPO", async () => {
  process.env.A11Y_TARGET_REPO = "datakeen/demo-a11y";
  process.env.GITHUB_TOKEN = "ghp_dummy_for_test";

  await assert.rejects(
    () =>
      openPr({
        title: "x",
        branch: "fix/a11y",
        files: [{ path: "index.html", content: "<html></html>" }],
        repo: "attacker/evil-repo",
      }),
    /only operates on A11Y_TARGET_REPO/,
  );
});

test("open_pr rejects when A11Y_TARGET_REPO is unset", async () => {
  delete process.env.A11Y_TARGET_REPO;
  process.env.GITHUB_TOKEN = "ghp_dummy_for_test";

  await assert.rejects(
    () =>
      openPr({
        title: "x",
        branch: "fix/a11y",
        files: [{ path: "index.html", content: "<html></html>" }],
      }),
    /A11Y_TARGET_REPO is not set/,
  );
});

test("open_pr rejects a malformed A11Y_TARGET_REPO", async () => {
  process.env.GITHUB_TOKEN = "ghp_dummy_for_test";

  for (const bad of ["not-a-valid-slug", "owner/repo/extra", "/repo", "owner/", "a/b/c/d"]) {
    process.env.A11Y_TARGET_REPO = bad;
    await assert.rejects(
      () =>
        openPr({
          title: "x",
          branch: "fix/a11y",
          files: [{ path: "index.html", content: "<html></html>" }],
        }),
      /must be exactly "owner\/repo"/,
      `"${bad}" should be rejected before any network call`,
    );
  }
});
