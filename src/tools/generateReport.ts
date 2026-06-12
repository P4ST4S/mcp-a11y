import { z } from "zod";

import { generateReport as buildReport, type ReportInput } from "../lib/report.js";

/**
 * Pure tool `generate_report`: turn an audit (+ applied fixes) into a
 * self-contained before/after HTML report. No LLM, no I/O.
 *
 * Schemas validate the shape actually consumed by the report so a malformed
 * input is rejected at the tool boundary instead of crashing the renderer.
 * `.passthrough()` keeps extra fields the other tools emit.
 */
const auditResultSchema = z
  .object({
    url: z.string().optional(),
    violationCount: z.number(),
    violations: z.array(
      z
        .object({
          id: z.string(),
          impact: z.string().optional(),
          description: z.string(),
          helpUrl: z.string(),
          nodes: z.array(z.object({}).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const appliedFixSchema = z.object({ rule: z.string(), description: z.string() }).passthrough();
const contrastFixSchema = z
  .object({
    selector: z.string(),
    rule: z.string(),
    fromColor: z.string(),
    toColor: z.string(),
  })
  .passthrough();
const altTextSchema = z
  .object({
    target: z.string(),
    altText: z.string(),
    model: z.string(),
    previewDataUri: z.string().optional(),
  })
  .passthrough();

export const generateReportInputSchema = {
  url: z.string().describe("Audited URL / page label shown in the report header."),
  auditBefore: auditResultSchema.describe("AuditResult from audit_page (before fixes)."),
  auditAfter: auditResultSchema.optional().describe("AuditResult after fixes (after column)."),
  simpleFixes: z.array(appliedFixSchema).optional().describe("AppliedFix[] from simple_fixes."),
  contrastFixes: z.array(contrastFixSchema).optional().describe("ContrastReinjection[] from the contrast glue."),
  altTexts: z.array(altTextSchema).optional().describe("Generated alt texts (target/altText/model)."),
  generatedAt: z.string().optional().describe("Optional timestamp shown in the header."),
};

export function generateReport(input: ReportInput): string {
  return buildReport(input);
}
