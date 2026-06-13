import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { z } from "zod";

import { getAnthropicApiKey, getAltTextModel } from "../config.js";

/**
 * `generate_alt_text` - the ONLY place an LLM is used in mcp-a11y.
 *
 * Given an image (by direct URL, or by a selector on a page), ask a vision
 * model for a concise, WCAG-appropriate alt text. Everything else in this
 * project is deterministic; this is the single non-deterministic tool.
 */

const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

const httpUrl = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const p = new URL(u).protocol;
        return p === "http:" || p === "https:";
      } catch {
        return false;
      }
    },
    { message: "imageUrl must be an http(s):// URL (Anthropic image URLs are remote-hosted)" },
  );

export const generateAltTextInputSchema = {
  imageUrl: httpUrl
    .optional()
    .describe("Direct http(s):// URL of the image. For local images, use selector + pageUrl."),
  pageUrl: z
    .string()
    .url()
    .optional()
    .describe("Page URL to load when using `selector` to locate the image."),
  selector: z
    .string()
    .optional()
    .describe("CSS selector of an <img> on `pageUrl` (alternative to imageUrl)."),
};

export interface AltTextResult {
  altText: string;
  model: string;
  /** How the image was sourced. */
  source: "url" | "page-selector";
}

const ALT_TEXT_PROMPT =
  "You are writing an HTML alt attribute for this image. " +
  "Describe it concisely (one short sentence, no more than ~125 characters), " +
  "conveying the information a sighted user gets. " +
  "Do not start with 'Image of' or 'Picture of'. Return ONLY the alt text, no quotes.";

export async function generateAltText(input: {
  imageUrl?: string;
  pageUrl?: string;
  selector?: string;
  /**
   * Base URL used to resolve a relative image `src` (e.g. "img/x.png") when the
   * page is loaded from a local file. Lets us audit a local copy while fetching
   * the image over http, since file:// fetch is unsupported. Should be the http
   * URL of the document itself (e.g. the raw URL of the HTML file).
   */
  assetBaseUrl?: string;
  /**
   * Base URL used to resolve a ROOT-relative image `src` (e.g. "/img/x.png").
   * On hosts like raw.githubusercontent.com the document does not live at the
   * origin root, so "/x" must resolve against this repo base
   * (".../owner/repo/branch/"), not the origin. Defaults to assetBaseUrl.
   */
  assetRootUrl?: string;
}): Promise<AltTextResult> {
  if (!input.imageUrl && !input.selector) {
    throw new Error("Provide either `imageUrl` or `selector` (with `pageUrl`).");
  }
  if (input.selector && !input.pageUrl) {
    throw new Error("`selector` requires `pageUrl` to know which page to load.");
  }
  if (input.imageUrl) {
    const protocol = safeProtocol(input.imageUrl);
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(
        "imageUrl must be an http(s):// URL. For local images, use selector + pageUrl (sent as base64).",
      );
    }
  }

  // Resolve the image first: no point requiring an API key if the image can't
  // even be located. This also lets a missing-selector error surface quickly.
  const imageBlock: Anthropic.ImageBlockParam = input.imageUrl
    ? { type: "image", source: { type: "url", url: input.imageUrl } }
    : await fetchImageAsBase64Block(input.pageUrl!, input.selector!, {
        baseUrl: input.assetBaseUrl,
        rootUrl: input.assetRootUrl ?? input.assetBaseUrl,
      });

  const client = new Anthropic({ apiKey: getAnthropicApiKey() });
  const model = getAltTextModel();

  const response = await client.messages.create({
    model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [imageBlock, { type: "text", text: ALT_TEXT_PROMPT }],
      },
    ],
  });

  const altText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();

  return {
    altText,
    model,
    source: input.imageUrl ? "url" : "page-selector",
  };
}

/** Load `pageUrl`, grab the image at `selector`, return a base64 image block. */
async function fetchImageAsBase64Block(
  pageUrl: string,
  selector: string,
  asset: { baseUrl?: string; rootUrl?: string } = {},
): Promise<Anthropic.ImageBlockParam> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "load" });

    const locator = page.locator(selector);
    // Fast existence check - avoids waiting out Playwright's 30s default timeout
    // on a selector that matches nothing.
    if ((await locator.count()) === 0) {
      throw new Error(`No element found for selector "${selector}" on ${pageUrl}.`);
    }

    const src = await locator.first().getAttribute("src");
    if (!src) {
      throw new Error(`Element "${selector}" has no src attribute.`);
    }

    // Resolve src over http when an asset base is given (Playwright's request
    // API does not support file://).
    const absolute = resolveAssetUrl(src, pageUrl, asset);
    const resp = await page.request.get(absolute);
    if (!resp.ok()) {
      throw new Error(`Failed to fetch image ${absolute}: HTTP ${resp.status()}`);
    }
    const buffer = await resp.body();
    const mediaType = normalizeMediaType(resp.headers()["content-type"], absolute);

    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
    };
  } finally {
    await browser.close();
  }
}

/**
 * Resolve an image `src` to an absolute http(s) URL.
 *   - absolute src: used as-is.
 *   - root-relative ("/x"): appended to `rootUrl` (the repo base
 *     ".../owner/repo/branch/"). `new URL("/x", base)` cannot do this because a
 *     leading slash resets to the origin root, dropping owner/repo/branch.
 *   - relative ("x/y"): resolved against `baseUrl` (the document URL).
 * Falls back to `pageUrl` when no asset bases are provided.
 */
export function resolveAssetUrl(
  src: string,
  pageUrl: string,
  asset: { baseUrl?: string; rootUrl?: string },
): string {
  if (/^https?:\/\//i.test(src)) return src;

  const isRootRelative = src.startsWith("/");
  if (isRootRelative) {
    const root = asset.rootUrl ?? asset.baseUrl;
    if (root) {
      // Join repo base + path without the leading slash (avoid URL origin reset).
      return new URL(src.replace(/^\/+/, ""), root.endsWith("/") ? root : `${root}/`).href;
    }
    return new URL(src, pageUrl).href;
  }
  return new URL(src, asset.baseUrl ?? pageUrl).href;
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function normalizeMediaType(contentType: string | undefined, url: string): SupportedMediaType {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if ((SUPPORTED_MEDIA_TYPES as readonly string[]).includes(ct)) {
    return ct as SupportedMediaType;
  }
  // Fall back to the file extension.
  const ext = url.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}
