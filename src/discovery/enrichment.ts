import { canonicalizeDiscoveryUrl } from "./canonical-url.js";
import type { DiscoveryCandidate, DiscoveryTarget } from "./types.js";
import {
  extractHostname,
  safeDateMs,
  sanitizeExternalText,
} from "./utils.js";

const MAX_ENRICHMENTS_PER_BATCH = 3;
const MAX_ENRICHMENT_BODY_LENGTH = 1_000_000;

export async function enrichDiscoveryCandidates(
  candidates: DiscoveryCandidate[],
  target: DiscoveryTarget,
  fetchFn: typeof fetch
): Promise<DiscoveryCandidate[]> {
  let attempts = 0;
  const output: DiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    const necessary = !candidate.description || candidate.publishedAt === undefined;
    if (
      necessary &&
      attempts < MAX_ENRICHMENTS_PER_BATCH &&
      isApprovedEnrichmentUrl(candidate.url, target)
    ) {
      attempts += 1;
      output.push(await enrichDiscoveryCandidate(candidate, fetchFn));
    } else {
      output.push(candidate);
    }
  }
  return output;
}

export function isApprovedEnrichmentUrl(url: string, target: DiscoveryTarget): boolean {
  const hostname = extractHostname(url);
  if (!hostname) return false;
  const configuredHosts = [
    ...target.sources.feeds.map((source) => extractHostname(source.url)),
    ...target.sources.html.map((source) => extractHostname(source.url)),
    ...target.sources.customJson.map((source) => extractHostname(source.url)),
    ...target.sources.customXml.map((source) => extractHostname(source.url)),
    ...(target.sources.existingFeeds ?? []).map((source) => extractHostname(source.url)),
  ].filter((value): value is string => Boolean(value));
  return configuredHosts.some((approved) => hostname.toLowerCase() === approved.toLowerCase());
}

export async function enrichDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  fetchFn: typeof fetch
): Promise<DiscoveryCandidate> {
  try {
    const response = await fetchFn(candidate.url, {
      headers: { Accept: "text/html, application/xhtml+xml" },
    });
    if (!response.ok) return candidate;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("html")) return candidate;
    const html = (await response.text()).slice(0, MAX_ENRICHMENT_BODY_LENGTH);
    const canonical = metaValue(html, "link", "rel", "canonical", "href");
    const canonicalUrl = safeCanonical(canonical, candidate.canonicalUrl);
    return {
      ...candidate,
      canonicalUrl,
      description:
        candidate.description ??
        optional(metaValue(html, "meta", "property", "og:description", "content"), 5000) ??
        optional(metaValue(html, "meta", "name", "description", "content"), 5000),
      sourceName:
        candidate.sourceName ??
        optional(metaValue(html, "meta", "property", "og:site_name", "content"), 300),
      author:
        candidate.author ??
        optional(metaValue(html, "meta", "name", "author", "content"), 300),
      publishedAt:
        candidate.publishedAt ??
        safeDateMs(
          metaValue(html, "meta", "property", "article:published_time", "content") ??
          metaValue(html, "meta", "name", "date", "content")
        ),
    };
  } catch {
    return candidate;
  }
}

function metaValue(
  html: string,
  tag: "meta" | "link",
  keyAttribute: string,
  keyValue: string,
  valueAttribute: string
): string | undefined {
  const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`, "gi")) ?? [];
  for (const item of tags) {
    const key = attribute(item, keyAttribute);
    if (key?.toLowerCase() !== keyValue.toLowerCase()) continue;
    const value = attribute(item, valueAttribute);
    if (value) return decodeHtml(value);
  }
  return undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
}

function optional(value: string | undefined, maximum: number): string | undefined {
  const clean = sanitizeExternalText(value, maximum);
  return clean || undefined;
}

function safeCanonical(value: string | undefined, fallback: string): string {
  if (!value?.startsWith("https://")) return fallback;
  try {
    return canonicalizeDiscoveryUrl(value);
  } catch {
    return fallback;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
