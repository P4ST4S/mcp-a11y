/**
 * Deterministic WCAG contrast math. NO LLM, NO randomness - pure functions.
 *
 * References:
 *   - Relative luminance & contrast ratio: WCAG 2.1, https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 *   - AA threshold for normal text: 4.5:1
 */

export const AA_NORMAL = 4.5;

export interface Rgb {
  r: number; // 0-255
  g: number;
  b: number;
}

/** Parse "#rgb", "#rrggbb" or "rgb(r, g, b)" into Rgb. Throws on anything else. */
export function parseColor(input: string): Rgb {
  const s = input.trim().toLowerCase();

  const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/);
  if (rgbMatch) {
    return {
      r: clampByte(Number(rgbMatch[1])),
      g: clampByte(Number(rgbMatch[2])),
      b: clampByte(Number(rgbMatch[3])),
    };
  }

  throw new Error(`Unsupported color format: "${input}" (use #rgb, #rrggbb or rgb(r,g,b))`);
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Format Rgb as lowercase "#rrggbb". */
export function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Relative luminance per WCAG (sRGB gamma expansion). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colors (>= 1, <= 21). Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastFix {
  /** Ratio of the original fg/bg pair. */
  originalRatio: number;
  /** Closest compliant foreground color as "#rrggbb". */
  compliantFg: string;
  /** Ratio achieved by compliantFg against bg. */
  newRatio: number;
  /** Whether compliantFg meets the target threshold. */
  passesAA: boolean;
  /** Whether the original fg already passed (compliantFg == original). */
  alreadyCompliant: boolean;
}

/**
 * Adjust the FOREGROUND: find the color closest to `fg` that reaches `target`
 * contrast against a fixed `bg`. Deterministic. Use this for plain text.
 */
export function fixContrast(fgInput: string, bgInput: string, target: number = AA_NORMAL): ContrastFix {
  const fg = parseColor(fgInput);
  const bg = parseColor(bgInput);
  const originalRatio = round2(contrastRatio(fg, bg));

  if (originalRatio >= target) {
    return { originalRatio, compliantFg: toHex(fg), newRatio: originalRatio, passesAA: true, alreadyCompliant: true };
  }

  const candidate = closestCompliant(fg, bg, target);
  const newRatio = round2(contrastRatio(candidate, bg));
  return {
    originalRatio,
    compliantFg: toHex(candidate),
    newRatio,
    passesAA: newRatio >= target,
    alreadyCompliant: false,
  };
}

export interface BackgroundContrastFix {
  originalRatio: number;
  /** Closest compliant background color as "#rrggbb". */
  compliantBg: string;
  newRatio: number;
  passesAA: boolean;
  alreadyCompliant: boolean;
}

/**
 * Adjust the BACKGROUND instead: find the color closest to `bg` that reaches
 * `target` contrast against a fixed `fg`. Use this to preserve a foreground
 * that carries the visual identity (e.g. white button text), darkening or
 * lightening the surface instead of recoloring the text.
 */
export function fixContrastByBackground(
  fgInput: string,
  bgInput: string,
  target: number = AA_NORMAL,
): BackgroundContrastFix {
  const fg = parseColor(fgInput);
  const bg = parseColor(bgInput);
  const originalRatio = round2(contrastRatio(fg, bg));

  if (originalRatio >= target) {
    return { originalRatio, compliantBg: toHex(bg), newRatio: originalRatio, passesAA: true, alreadyCompliant: true };
  }

  const candidate = closestCompliant(bg, fg, target);
  const newRatio = round2(contrastRatio(fg, candidate));
  return {
    originalRatio,
    compliantBg: toHex(candidate),
    newRatio,
    passesAA: newRatio >= target,
    alreadyCompliant: false,
  };
}

/**
 * Find the color closest to `adjustable` that reaches `target` contrast against
 * the fixed `other` color. Tries pushing toward black and toward white, keeps
 * the closer compliant result (or best-effort if neither direction can satisfy
 * the target because `other` itself is the constraint).
 */
function closestCompliant(adjustable: Rgb, other: Rgb, target: number): Rgb {
  const black: Rgb = { r: 0, g: 0, b: 0 };
  const white: Rgb = { r: 255, g: 255, b: 255 };
  const towardsBlack = searchToward(adjustable, black, other, target);
  const towardsWhite = searchToward(adjustable, white, other, target);
  return pickBest(adjustable, other, towardsBlack, towardsWhite, target);
}

/**
 * Binary-search the point between `fg` and `extreme` (black or white) that
 * first reaches `target` contrast against `bg`. Returns the extreme itself if
 * even that does not reach the target (caller decides what to do with it).
 */
function searchToward(fg: Rgb, extreme: Rgb, bg: Rgb, target: number): Rgb {
  const lerp = (t: number): Rgb => ({
    r: fg.r + (extreme.r - fg.r) * t,
    g: fg.g + (extreme.g - fg.g) * t,
    b: fg.b + (extreme.b - fg.b) * t,
  });

  if (contrastRatio(extreme, bg) < target) {
    return extreme; // this direction can't satisfy the target
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(lerp(mid), bg) >= target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // Quantize to 8-bit and step further toward the extreme if rounding dropped
  // us back below the target (so the final #rrggbb really meets it).
  const quantize = (t: number): Rgb => ({
    r: Math.round(fg.r + (extreme.r - fg.r) * t),
    g: Math.round(fg.g + (extreme.g - fg.g) * t),
    b: Math.round(fg.b + (extreme.b - fg.b) * t),
  });
  let t = hi;
  let color = quantize(t);
  while (contrastRatio(color, bg) < target && t < 1) {
    t = Math.min(1, t + 1 / 255);
    color = quantize(t);
  }
  return color;
}

/** Distance in RGB space (good enough to mean "closest to original"). */
function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * Among the two candidates, prefer those meeting `target` (closest to fg wins);
 * if neither meets it, return whichever has the higher contrast against bg.
 */
function pickBest(fg: Rgb, bg: Rgb, a: Rgb, b: Rgb, target: number): Rgb {
  const aRatio = contrastRatio(a, bg);
  const bRatio = contrastRatio(b, bg);
  const aOk = aRatio >= target;
  const bOk = bRatio >= target;

  if (aOk && bOk) {
    return rgbDistance(a, fg) <= rgbDistance(b, fg) ? a : b;
  }
  if (aOk) return a;
  if (bOk) return b;
  // Neither reaches the target (bg is the constraint) - best effort.
  return aRatio >= bRatio ? a : b;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
