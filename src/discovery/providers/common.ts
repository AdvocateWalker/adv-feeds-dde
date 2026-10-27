import {
  DISCOVERY_MAX_DESCRIPTION_LENGTH,
  DISCOVERY_MAX_TITLE_LENGTH,
} from "../constants.js";
import { canonicalizeDiscoveryUrl } from "../canonical-url.js";
import { sha256 } from "../hash.js";
import { isRedditSourceUrl } from "../../shared/post-dedupe.js";
import type { DiscoveryCandidate, DiscoveryProviderType } from "../types.js";
import {
  extractHostname,
  isHttpsUrl,
  safeDateMs,
  sanitizeExternalText,
} from "../utils.js";

const MAX_PROVIDER_RESPONSE_BYTES = 5_000_000;

export class DiscoveryProviderError extends Error {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, statusCode?: number, retryAfterMs?: number) {
    super(message);
    this.name = "DiscoveryProviderError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CandidateInput {
  provider: DiscoveryProviderType;
  providerItemId?: string;
  targetId: string;
  title: unknown;
  url: unknown;
  description?: unknown;
  sourceName?: unknown;
  author?: unknown;
  publishedAt?: unknown;
  discoveredAt: number;
  thumbnailUrl?: unknown;
  providerSafe?: boolean;
  redditPostId?: string;
  redditNsfw?: boolean;
}

export function createDiscoveryCandidate(input: CandidateInput): DiscoveryCandidate | undefined {
  const title = sanitizeExternalText(input.title, DISCOVERY_MAX_TITLE_LENGTH);
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!title || !isHttpsUrl(url) || isRedditSourceUrl(url)) return undefined;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeDiscoveryUrl(url);
  } catch {
    return undefined;
  }
  const canonicalIdentity = canonicalUrl || url;
  return {
    candidateId: sha256(`${input.targetId}:${canonicalIdentity}`).slice(0, 32),
    provider: input.provider,
    discoveredBy: [input.provider],
    providerItemId: input.providerItemId,
    targetId: input.targetId,
    title,
    url,
    canonicalUrl,
    description: optionalText(input.description, DISCOVERY_MAX_DESCRIPTION_LENGTH),
    sourceName: optionalText(input.sourceName, 300),
    sourceDomain: extractHostname(url)?.replace(/^(www|m)\./, ""),
    author: optionalText(input.author, 300),
    publishedAt: safeDateMs(input.publishedAt),
    discoveredAt: input.discoveredAt,
    thumbnailUrl:
      typeof input.thumbnailUrl === "string" && isHttpsUrl(input.thumbnailUrl)
        ? input.thumbnailUrl
        : undefined,
    providerSafe: input.providerSafe,
    redditPostId: input.redditPostId,
    redditNsfw: input.redditNsfw,
  };
}

export async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    throw new DiscoveryProviderError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("json")) {
    throw new DiscoveryProviderError(`Expected JSON but received ${contentType}.`, response.status);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new DiscoveryProviderError("JSON response exceeded 5 MB.", response.status);
  }
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new DiscoveryProviderError("JSON response exceeded 5 MB.", response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DiscoveryProviderError(`Invalid JSON response: ${String(error)}`, response.status);
  }
}

export async function fetchText(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<{ text: string; contentType: string }> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    throw new DiscoveryProviderError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new DiscoveryProviderError("Text response exceeded 5 MB.", response.status);
  }
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new DiscoveryProviderError("Text response exceeded 5 MB.", response.status);
  }
  return {
    text,
    contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
  };
}

export function mergeCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const byIdentity = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const key = candidate.canonicalUrl;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, candidate);
      continue;
    }
    existing.discoveredBy = Array.from(
      new Set([...existing.discoveredBy, ...candidate.discoveredBy])
    );
    if (!existing.description && candidate.description) existing.description = candidate.description;
    if (!existing.publishedAt && candidate.publishedAt) existing.publishedAt = candidate.publishedAt;
    if (!existing.thumbnailUrl && candidate.thumbnailUrl) existing.thumbnailUrl = candidate.thumbnailUrl;
    if (!existing.author && candidate.author) existing.author = candidate.author;
  }
  return Array.from(byIdentity.values());
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  const text = sanitizeExternalText(value, maxLength);
  return text || undefined;
}
