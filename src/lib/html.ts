import { parse, HTMLElement } from "node-html-parser";

import { fixContrast as computeContrastFix } from "./contrast.js";

/**
 * Deterministic HTML remediation + the "reinjection glue" that puts computed
 * fixes back into the SOURCE document. NO LLM here.
 *
 * Parsing uses node-html-parser with { comment: true }, which round-trips the
 * demo-site byte-for-byte - so the patched output is safe to commit.
 */

export interface AppliedFix {
  /** Rule this fix addresses, e.g. "html-has-lang", "document-title", "label". */
  rule: string;
  /** Human-readable description of what was changed. */
  description: string;
}

function parseDoc(html: string): HTMLElement {
  return parse(html, { comment: true });
}

/**
 * Apply deterministic structural fixes:
 *   - html-has-lang  : add lang="en" on <html> if missing
 *   - document-title : add a <title> in <head> if missing
 *   - label          : give unlabeled form controls an aria-label derived from
 *                      their name/id (deterministic, no LLM)
 *
 * Returns the patched HTML plus the list of fixes that were applied.
 */
export function simpleFixes(html: string, options: { lang?: string } = {}): {
  html: string;
  fixes: AppliedFix[];
} {
  const root = parseDoc(html);
  const fixes: AppliedFix[] = [];
  const lang = options.lang ?? "en";

  // --- html-has-lang ---
  const htmlEl = root.querySelector("html");
  if (htmlEl && !htmlEl.getAttribute("lang")) {
    htmlEl.setAttribute("lang", lang);
    fixes.push({ rule: "html-has-lang", description: `Added lang="${lang}" to <html>` });
  }

  // --- document-title ---
  const head = root.querySelector("head");
  const existingTitle = root.querySelector("title");
  if (head && (!existingTitle || existingTitle.text.trim() === "")) {
    if (existingTitle) {
      existingTitle.set_content("Untitled page");
      fixes.push({ rule: "document-title", description: "Filled empty <title>" });
    } else {
      head.insertAdjacentHTML("afterbegin", "\n    <title>Untitled page</title>");
      fixes.push({ rule: "document-title", description: "Added a <title> to <head>" });
    }
  }

  // --- label: form controls without an accessible name ---
  const controls = root.querySelectorAll("input, select, textarea");
  for (const control of controls) {
    const type = (control.getAttribute("type") ?? "").toLowerCase();
    // Hidden/submit/button inputs don't need a label.
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;

    const hasName =
      control.getAttribute("aria-label") ||
      control.getAttribute("aria-labelledby") ||
      control.getAttribute("title");
    const id = control.getAttribute("id");
    // Explicit label: <label for="id">. Implicit label: <label>…<input></label>.
    const hasExplicitFor = id ? root.querySelector(`label[for="${cssEscape(id)}"]`) : null;
    const hasImplicitLabel = control.closest("label") != null;

    if (!hasName && !hasExplicitFor && !hasImplicitLabel) {
      const label = humanizeName(control.getAttribute("name") ?? id ?? "field");
      control.setAttribute("aria-label", label);
      fixes.push({ rule: "label", description: `Added aria-label="${label}" to a form control` });
    }
  }

  return { html: root.toString(), fixes };
}

/**
 * Escape a string for safe use inside a double-quoted attribute selector value
 * (`[for="…"]`). We only need to neutralize the quote and backslash so the
 * selector parser doesn't choke on ids like `a"b`. (CSS.escape is unavailable
 * outside a DOM runtime.)
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** "email" -> "Email", "first_name" -> "First name". */
function humanizeName(raw: string): string {
  const spaced = raw.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Field";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface ContrastFixRequest {
  /** axe `target` selector(s) for the failing node, e.g. ["button"] or [".muted"]. */
  target: string[];
  /** Original foreground color as reported by axe. */
  fg: string;
  /** Original background color as reported by axe. */
  bg: string;
}

export interface ContrastReinjection {
  selector: string;
  fromColor: string;
  toColor: string;
  /** The CSS rule (class or element) whose `color` was updated. */
  rule: string;
}

/**
 * Reinjection glue for color-contrast - keyed by the offending ELEMENT, not by
 * raw color value. Swapping a color value globally is wrong when a color is
 * shared between a foreground and a background (e.g. white text vs white page);
 * instead we:
 *   1. resolve each axe `target` to a DOM element,
 *   2. find which CSS rule in the single <style> sets that element's `color`
 *      (matching by class or tag name), and
 *   3. rewrite the `color:` declaration of THAT rule only.
 *
 * Deterministic - relies on the demo-site invariant: one <style>, simple
 * class/tag rules, no cascade ambiguity.
 */
export function reinjectContrastFixes(
  html: string,
  requests: ContrastFixRequest[],
): { html: string; applied: ContrastReinjection[] } {
  const root = parseDoc(html);
  const styleEl = root.querySelector("style");
  const applied: ContrastReinjection[] = [];

  if (!styleEl) {
    return { html, applied };
  }

  let css = styleEl.text;

  for (const req of requests) {
    const fix = computeContrastFix(req.fg, req.bg);
    if (fix.alreadyCompliant) continue;

    const selector = req.target[req.target.length - 1] ?? "";
    const el = selector ? root.querySelector(selector) : null;
    if (!el) continue;

    // Candidate CSS rule keys for this element: its classes, then its tag name.
    const classNames = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const ruleKeys = [...classNames.map((c) => `.${c}`), el.rawTagName ?? ""].filter(Boolean);

    for (const key of ruleKeys) {
      const updated = replaceColorInRule(css, key, fix.compliantFg);
      if (updated !== css) {
        css = updated;
        applied.push({
          selector,
          fromColor: req.fg,
          toColor: fix.compliantFg,
          rule: key,
        });
        break; // one rule updated per failing element
      }
    }
  }

  styleEl.set_content(css);
  return { html: root.toString(), applied };
}

/**
 * Replace the `color:` declaration inside the rule whose selector list contains
 * `ruleKey` (a `.class` or a `tag`). Returns css unchanged if not found.
 */
function replaceColorInRule(css: string, ruleKey: string, toColor: string): string {
  // Match: <selectors containing ruleKey> { ... }
  const ruleRe = new RegExp(
    `([^{}]*${escapeRegExp(ruleKey)}[^{}]*)\\{([^}]*)\\}`,
    "g",
  );
  return css.replace(ruleRe, (whole, selectors: string, body: string) => {
    if (!selectorListMatches(selectors, ruleKey)) return whole;
    if (!/(^|[;{\s])color\s*:/.test(body)) return whole;
    const newBody = body.replace(/(^|[;{\s])color\s*:\s*[^;}]+/, `$1color: ${toColor}`);
    return `${selectors}{${newBody}}`;
  });
}

/** Ensure ruleKey is a whole selector token (avoid `.cta` matching `.cta-large`). */
function selectorListMatches(selectors: string, ruleKey: string): boolean {
  const tokens = selectors.split(",").map((s) => s.trim());
  return tokens.some((t) => t === ruleKey || t.split(/[\s>+~]/).includes(ruleKey));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encode a string for an HTML attribute value. We encode `&`, `<`, `>` here;
 * node-html-parser already escapes `"` to `&quot;` on serialization, so we do
 * NOT touch quotes (encoding them too would double-encode the `&` of `&quot;`).
 */
function encodeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inject an `alt` attribute on `<img>` elements that lack one, via the parser
 * (so it never touches `<img>` mentioned inside HTML comments, unlike a raw
 * regex on the string). By default fills the first unlabeled image; pass a
 * selector to target a specific one.
 */
export function injectAltText(
  html: string,
  altText: string,
  selector = "img",
): { html: string; injected: boolean } {
  const root = parseDoc(html);
  const candidates = root.querySelectorAll(selector);
  for (const img of candidates) {
    if (img.rawTagName?.toLowerCase() !== "img") continue;
    const alt = img.getAttribute("alt");
    if (alt === undefined || alt.trim() === "") {
      // The alt text comes from the vision model (untrusted). node-html-parser
      // escapes quotes but not & or <>, so encode for the attribute context.
      img.setAttribute("alt", encodeHtmlAttribute(altText));
      return { html: root.toString(), injected: true };
    }
  }
  return { html, injected: false };
}
