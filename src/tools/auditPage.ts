import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { z } from "zod";

/**
 * Logique pure du tool `audit_page`.
 *
 * Détection 100% DÉTERMINISTE : axe-core décide seul de ce qui est cassé.
 * AUCUN LLM ici.
 *
 * On conserve volontairement, pour chaque node en violation :
 *   - `target` : le sélecteur CSS axe (clé de remappage vers la source à l'étape 3)
 *   - `data`   : les données brutes du check (ex. fgColor/bgColor/contrastRatio
 *                pour color-contrast), nécessaires à fix_contrast.
 */

/** Only http(s):// (public target) and file:// (local mirror) are auditable. */
const AUDITABLE_PROTOCOLS = ["http:", "https:", "file:"] as const;

export const auditPageInputSchema = {
  url: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          return (AUDITABLE_PROTOCOLS as readonly string[]).includes(new URL(u).protocol);
        } catch {
          return false;
        }
      },
      { message: "URL must use http://, https:// or file:// scheme" },
    )
    .describe("URL to audit. http(s):// (public target) or file:// (local mirror)."),
};

export interface AuditCheckData {
  /** Check id (e.g. "color-contrast"). */
  id: string;
  /** Raw check data, e.g. { fgColor, bgColor, contrastRatio, expectedContrastRatio }. */
  data: unknown;
}

export interface AuditNode {
  /** Outer HTML of the offending element. */
  html: string;
  /** axe CSS selector(s) for the element — used to remap fixes onto the source. */
  target: string[];
  /** Human-readable summary of why the node failed. */
  failureSummary?: string;
  /** All check results (any/all/none), carrying data such as colors for color-contrast. */
  checks: AuditCheckData[];
}

export interface AuditViolation {
  /** Rule id, e.g. "image-alt", "color-contrast", "html-has-lang". */
  id: string;
  impact?: string;
  description: string;
  helpUrl: string;
  nodes: AuditNode[];
}

export interface AuditResult {
  url: string;
  /** Total number of distinct rule violations. */
  violationCount: number;
  violations: AuditViolation[];
}

export async function auditPage(input: { url: string }): Promise<AuditResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    // axe-core/playwright requires a page created from an explicit context.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(input.url, { waitUntil: "load" });

    const results = await new AxeBuilder({ page }).analyze();

    const violations: AuditViolation[] = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? undefined,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        html: n.html,
        target: n.target.map((t) => String(t)),
        failureSummary: n.failureSummary,
        checks: [...n.any, ...n.all, ...n.none].map((c) => ({ id: c.id, data: c.data })),
      })),
    }));

    return {
      url: input.url,
      violationCount: violations.length,
      violations,
    };
  } finally {
    await browser.close();
  }
}
