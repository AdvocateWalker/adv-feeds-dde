import {
  BUILT_IN_ADULT_DOMAINS,
  BUILT_IN_BLOCKED_BOT_ACCOUNTS,
} from "./constants.js";
import type { DiscoveryCandidate, DiscoveryConfig, DiscoveryTarget } from "./types.js";
import { matchesDomainRule, termMatches } from "./utils.js";
import { isRedditSourceUrl } from "../shared/post-dedupe.js";

export interface DiscoverySafetyResult {
  safe: boolean;
  rejectionReason?: "reddit-source-url" | "non-https-url" | "provider-unsafe" | "reddit-nsfw" | "blocked-domain" | "nsfw-term" | "blocked-bot-author";
  detail?: string;
}

export function checkDiscoverySafety(
  candidate: DiscoveryCandidate,
  target: DiscoveryTarget,
  config: DiscoveryConfig
): DiscoverySafetyResult {
  if (isRedditSourceUrl(candidate.url) || isRedditSourceUrl(candidate.canonicalUrl)) {
    return { safe: false, rejectionReason: "reddit-source-url" };
  }
  if (!candidate.url.startsWith("https://")) {
    return { safe: false, rejectionReason: "non-https-url", detail: candidate.url };
  }
  if (candidate.providerSafe === false) {
    return { safe: false, rejectionReason: "provider-unsafe" };
  }
  if (candidate.redditNsfw === true) {
    return { safe: false, rejectionReason: "reddit-nsfw" };
  }
  if (
    candidate.author &&
    [...BUILT_IN_BLOCKED_BOT_ACCOUNTS, ...config.blockedBotAccounts].some(
      (username) => username.toLowerCase() === candidate.author!.toLowerCase()
    )
  ) {
    return { safe: false, rejectionReason: "blocked-bot-author", detail: candidate.author };
  }
  const domain = candidate.sourceDomain ?? "";
  const blockedDomain = [...BUILT_IN_ADULT_DOMAINS, ...target.domains.excluded].find((rule) =>
    matchesDomainRule(domain, rule)
  );
  if (blockedDomain) {
    return { safe: false, rejectionReason: "blocked-domain", detail: blockedDomain };
  }
  const searchable = [candidate.title, candidate.description, candidate.sourceName, candidate.url]
    .filter(Boolean)
    .join("\n");
  const matchedNsfwTerm = config.nsfwTerms.find((rule) => termMatches(searchable, rule));
  if (matchedNsfwTerm) {
    return {
      safe: false,
      rejectionReason: "nsfw-term",
      detail: typeof matchedNsfwTerm === "string" ? matchedNsfwTerm : matchedNsfwTerm.value,
    };
  }
  return { safe: true };
}
