import { z } from "zod";

import { generateReport as buildReport, type ReportInput } from "../lib/report.js";

/**
 * Pure tool `generate_report`: turn an audit (+ applied fixes) into a
 * self-contained before/after HTML report. No LLM, no I/O.
 *
 * The schema is intentionally permissive (passthrough) because it consumes the
 * structured output of the other tools verbatim.
 */
export const generateReportInputSchema = {
  url: z.string().describe("Audited URL / page label shown in the report header."),
  auditBefore: z.any().describe("AuditResult from audit_page (before fixes)."),
  auditAfter: z.any().optional().describe("AuditResult after fixes (enables the after column)."),
  simpleFixes: z.array(z.any()).optional().describe("AppliedFix[] from simple_fixes."),
  contrastFixes: z.array(z.any()).optional().describe("ContrastReinjection[] from the contrast glue."),
  altTexts: z.array(z.any()).optional().describe("Generated alt texts (target/altText/model)."),
  generatedAt: z.string().optional().describe("Optional timestamp shown in the header."),
};

export function generateReport(input: ReportInput): string {
  return buildReport(input);
}
