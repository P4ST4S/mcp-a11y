import { z } from "zod";
import { simpleFixes as applySimpleFixes, type AppliedFix } from "../lib/html.js";

/**
 * Pure tool `simple_fixes`: apply deterministic structural a11y fixes to an HTML
 * string (missing lang, missing title, unlabeled form controls). NO LLM.
 */
export const simpleFixesInputSchema = {
  html: z.string().describe("HTML source to remediate"),
  lang: z.string().optional().describe('Language code for <html lang="…"> (default "en")'),
};

export interface SimpleFixesResult {
  html: string;
  fixes: AppliedFix[];
}

export function simpleFixes(input: { html: string; lang?: string }): SimpleFixesResult {
  return applySimpleFixes(input.html, { lang: input.lang });
}
