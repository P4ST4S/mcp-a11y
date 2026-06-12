import { z } from "zod";
import { AA_NORMAL, fixContrast as computeFix, type ContrastFix } from "../lib/contrast.js";

/**
 * Pure tool `fix_contrast`: given a foreground/background pair, compute the
 * closest WCAG-compliant foreground color (AA 4.5:1 for normal text).
 *
 * Deterministic - no LLM. This tool ONLY computes the color; reinjecting it into
 * a source document is handled by the html reinjection glue (see lib/html.ts).
 */
export const fixContrastInputSchema = {
  fg: z.string().describe("Foreground color: #rgb, #rrggbb or rgb(r,g,b)"),
  bg: z.string().describe("Background color: #rgb, #rrggbb or rgb(r,g,b)"),
  target: z
    .number()
    .positive()
    .optional()
    .describe(`Target contrast ratio (default ${AA_NORMAL}, AA normal text)`),
};

export function fixContrast(input: { fg: string; bg: string; target?: number }): ContrastFix {
  return computeFix(input.fg, input.bg, input.target ?? AA_NORMAL);
}
