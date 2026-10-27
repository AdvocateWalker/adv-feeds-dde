import type { DiscoveryProviderType, DiscoveryStats, ProviderBudget } from "./types.js";

export const DISCOVERY_CONFIG_VERSION = 1;
export const DISCOVERY_DISPATCH_JOB = "adv-discovery-dispatch";
export const DISCOVERY_DISPATCH_INTERVAL_MINUTES = 5;
export const DISCOVERY_INITIAL_DELAY_SECONDS = 20;
export const DISCOVERY_QUEUE_MAX_ATTEMPTS = 5;
export const DISCOVERY_QUEUE_BASE_BACKOFF_SECONDS = 30;
export const DISCOVERY_MAX_TARGETS = 25;
export const DISCOVERY_MAX_AUDIT_RECORDS = 500;
export const DISCOVERY_MAX_PREVIEW_RECORDS = 20;
export const DISCOVERY_MAX_WAITING_CANDIDATES = 200;
export const DISCOVERY_CANDIDATE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DISCOVERY_EXACT_TTL_SECONDS = 60 * 60 * 24 * 180;
export const DISCOVERY_YOUTUBE_TTL_SECONDS = 60 * 60 * 24 * 365;
export const DISCOVERY_EVENT_TTL_SECONDS = 60 * 60 * 24 * 7;
export const DISCOVERY_REJECTED_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DISCOVERY_IDENTITY_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DISCOVERY_PROVIDER_OVERLAP_MS = 15 * 60 * 1000;
export const DISCOVERY_MAX_TITLE_LENGTH = 300;
export const DISCOVERY_MAX_DESCRIPTION_LENGTH = 5000;

export const DISCOVERY_SCORE_WEIGHTS = {
  canonicalTitle: 60,
  aliasTitle: 55,
  canonicalDescription: 30,
  aliasDescription: 25,
  targetUrl: 15,
  requiredTerm: 15,
  preferredTerm: 8,
  preferredDomain: 8,
  age12Hours: 10,
  age24Hours: 6,
  age72Hours: 3,
  weakMention: -20,
} as const;

export const DISCOVERY_SIMILARITY = {
  probableDuplicate: 0.72,
  related: 0.68,
  tokenWeight: 0.65,
  bigramWeight: 0.35,
} as const;

export const DEFAULT_DISCOVERY_STOP_WORDS = [
  "a",
  "an",
  "and",
  "announces",
  "announced",
  "announcement",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "new",
  "of",
  "on",
  "says",
  "said",
  "the",
  "to",
  "unveils",
  "unveiled",
  "with",
];

export const DEFAULT_DISCOVERY_NSFW_TERMS = [
  "explicit pornography",
  "pornographic",
  "hardcore porn",
  "adult video",
  "sex tape",
  "onlyfans leak",
];

export const BUILT_IN_ADULT_DOMAINS = [
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "redtube.com",
  "youporn.com",
  "xhamster.com",
  "spankbang.com",
  "onlyfans.com",
];

export const BUILT_IN_BLOCKED_BOT_ACCOUNTS = [
  "adv-feeds",
  "adv_livefeed",
  "adv-livefeed",
  "adv-verify",
  "adv_verify",
  "adv-roundup",
  "adv_roundup",
  "adv-wiki",
  "adv_wiki",
];

export const DISCOVERY_PROVIDER_BUDGETS: Record<DiscoveryProviderType, ProviderBudget> = {
  wikipedia: { callsPerMinute: 10, callsPerHour: 200, callsPerDay: 2000 },
  wikidata: { callsPerMinute: 10, callsPerHour: 200, callsPerDay: 2000 },
  "reddit-search": { callsPerMinute: 30, callsPerHour: 500, callsPerDay: 5000 },
  "reddit-listing": { callsPerMinute: 30, callsPerHour: 500, callsPerDay: 5000 },
  "reddit-user": { callsPerMinute: 30, callsPerHour: 500, callsPerDay: 5000 },
  rss: { callsPerMinute: 30, callsPerHour: 500, callsPerDay: 5000 },
  atom: { callsPerMinute: 30, callsPerHour: 500, callsPerDay: 5000 },
  html: { callsPerMinute: 20, callsPerHour: 300, callsPerDay: 2500 },
  "custom-json": { callsPerMinute: 20, callsPerHour: 300, callsPerDay: 2500 },
  "custom-xml": { callsPerMinute: 20, callsPerHour: 300, callsPerDay: 2500 },
  "adv-feed": { callsPerMinute: 20, callsPerHour: 300, callsPerDay: 2500 },
};

export const EMPTY_DISCOVERY_STATS: DiscoveryStats = {
  searches: 0,
  candidatesDiscovered: 0,
  exactDuplicates: 0,
  nearDuplicates: 0,
  nsfwRejections: 0,
  relevanceRejections: 0,
  blockedDomainRejections: 0,
  accepted: 0,
  manualFiltered: 0,
  autoPosted: 0,
  manuallyApproved: 0,
  manuallyRejected: 0,
  autoApprovedAfterHold: 0,
  deliveryFailures: 0,
  providerFailures: 0,
  rateDeferred: 0,
};
