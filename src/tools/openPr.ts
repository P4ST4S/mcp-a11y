import { Octokit } from "octokit";
import { z } from "zod";

import { getGithubToken, getTargetRepo } from "../config.js";

/**
 * `open_pr` — open a mergeable PR with remediated files.
 *
 * STRICT GUARDRAIL: this tool only ever touches the repo named in
 * A11Y_TARGET_REPO. The target repo is NOT an input — it is read from config.
 * If a caller passes a `repo` that disagrees with A11Y_TARGET_REPO, we refuse.
 * This is a controlled demo target by design; never a PR on an arbitrary repo.
 */

export const openPrInputSchema = {
  title: z.string().describe("Pull request title."),
  body: z.string().optional().describe("Pull request body."),
  branch: z.string().describe("New branch name to create for the PR."),
  files: z
    .array(
      z.object({
        path: z.string().describe("Path of the file in the repo, e.g. demo-site/index.html"),
        content: z.string().describe("Full new file content (UTF-8)."),
      }),
    )
    .min(1)
    .describe("Files to commit on the new branch."),
  commitMessage: z.string().optional().describe("Commit message (defaults to the PR title)."),
  // Defensive only: if provided, it MUST equal A11Y_TARGET_REPO. Prefer omitting.
  repo: z
    .string()
    .optional()
    .describe("Optional safety assertion — must equal A11Y_TARGET_REPO if set."),
};

export interface OpenPrResult {
  url: string;
  number: number;
  branch: string;
  repo: string;
}

export async function openPr(input: {
  title: string;
  body?: string;
  branch: string;
  files: Array<{ path: string; content: string }>;
  commitMessage?: string;
  repo?: string;
}): Promise<OpenPrResult> {
  const target = getTargetRepo();

  // --- GUARDRAIL ---
  if (input.repo && input.repo.trim() !== target) {
    throw new Error(
      `Refusing to open a PR on "${input.repo}". open_pr only operates on A11Y_TARGET_REPO ("${target}").`,
    );
  }
  const [owner, repo] = target.split("/");
  if (!owner || !repo) {
    throw new Error(`A11Y_TARGET_REPO must be "owner/repo", got "${target}".`);
  }

  const octokit = new Octokit({ auth: getGithubToken() });

  // 1. Default branch + its head SHA.
  const repoInfo = await octokit.rest.repos.get({ owner, repo });
  const baseBranch = repoInfo.data.default_branch;
  const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data.object.sha;

  // 2. Create the new branch from base.
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${input.branch}`,
    sha: baseSha,
  });

  // 3. Commit each file on the new branch (update if it already exists).
  const commitMessage = input.commitMessage ?? input.title;
  for (const file of input.files) {
    let existingSha: string | undefined;
    try {
      const existing = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.path,
        ref: input.branch,
      });
      if (!Array.isArray(existing.data) && "sha" in existing.data) {
        existingSha = existing.data.sha;
      }
    } catch {
      // File doesn't exist yet — it will be created.
    }

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message: commitMessage,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch: input.branch,
      sha: existingSha,
    });
  }

  // 4. Open the PR.
  const pr = await octokit.rest.pulls.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.branch,
    base: baseBranch,
  });

  return {
    url: pr.data.html_url,
    number: pr.data.number,
    branch: input.branch,
    repo: target,
  };
}
