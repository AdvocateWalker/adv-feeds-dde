import { sha256 } from "./hash.js";
import type { DiscoveryCandidate, DiscoveryFingerprints } from "./types.js";
import { normalizeForMatch } from "./utils.js";

const TRACKING_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "ref",
  "source",
]);

export function extractYouTubeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      return validYouTubeId(url.pathname.split("/").filter(Boolean)[0]);
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") return validYouTubeId(url.searchParams.get("v") ?? undefined);
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0] ?? "")) {
        return validYouTubeId(parts[1]);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function validYouTubeId(value?: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_-]{6,20}$/.test(value) ? value : undefined;
}

export function canonicalizeDiscoveryUrl(value: string): string {
  const youtubeId = extractYouTubeVideoId(value);
  if (youtubeId) return `youtube:${youtubeId}`;

  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  url.hash = "";
  url.username = "";
  url.password = "";

  const parameterKeys: string[] = [];
  url.searchParams.forEach((_value, key) => parameterKeys.push(key));
  for (const key of parameterKeys) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "");
}

export function canonicalUrlToPostUrl(canonicalUrl: string, fallback: string): string {
  if (canonicalUrl.startsWith("youtube:")) {
    return `https://www.youtube.com/watch?v=${canonicalUrl.slice("youtube:".length)}`;
  }
  return canonicalUrl.startsWith("https://") ? canonicalUrl : fallback;
}

export function buildDiscoveryFingerprints(
  candidate: Pick<
    DiscoveryCandidate,
    "provider" | "providerItemId" | "canonicalUrl" | "title"
  >
): DiscoveryFingerprints {
  const providerKey = candidate.providerItemId
    ? `${candidate.provider}:${candidate.providerItemId}`
    : undefined;
  const canonicalUrlHash = sha256(candidate.canonicalUrl);
  const normalizedTitleHash = sha256(normalizeForMatch(candidate.title));
  const contentKey = candidate.canonicalUrl.startsWith("youtube:")
    ? candidate.canonicalUrl
    : providerKey ?? `url:${canonicalUrlHash}`;
  return { providerKey, canonicalUrlHash, normalizedTitleHash, contentKey };
}
