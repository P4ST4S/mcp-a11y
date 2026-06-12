import "dotenv/config";

/**
 * Central, lazy access to environment configuration.
 *
 * We read env vars lazily (not at import time) so the server boots even when a
 * key is absent - only the tool that needs it fails, with a clear message.
 */

/** Default vision model for generate_alt_text - cheap & fast, enough for alt text. */
export const DEFAULT_ALT_TEXT_MODEL = "claude-haiku-4-5";
/** Fallback if Haiku quality is insufficient. */
export const FALLBACK_ALT_TEXT_MODEL = "claude-opus-4-8";

export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || key === "your_anthropic_api_key_here") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. generate_alt_text needs a valid Anthropic API key in .env.",
    );
  }
  return key;
}

export function getAltTextModel(): string {
  return process.env.A11Y_ALT_TEXT_MODEL?.trim() || DEFAULT_ALT_TEXT_MODEL;
}

export function getGithubToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token || token === "your_github_token_here") {
    throw new Error("GITHUB_TOKEN is not set. open_pr needs a valid GitHub token in .env.");
  }
  return token;
}

export function getTargetRepo(): string {
  const repo = process.env.A11Y_TARGET_REPO?.trim();
  if (!repo) {
    throw new Error("A11Y_TARGET_REPO is not set. open_pr only operates on this controlled repo.");
  }
  return repo;
}
