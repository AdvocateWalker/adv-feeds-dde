import type { Context, PostSuggestedCommentSort } from "@devvit/public-api";

export type DiscoveryProviderType =
  | "wikipedia"
  | "wikidata"
  | "reddit-search"
  | "reddit-listing"
  | "reddit-user"
  | "rss"
  | "atom"
  | "html"
  | "custom-json"
  | "custom-xml"
  | "adv-feed";

export type DiscoveryApprovalMode =
  | "manual"
  | "probation_then_auto"
  | "auto"
  | "timed_hold";

export type DiscoveryTargetCategory =
  | "person"
  | "organization"
  | "topic"
  | "news"
  | "breaking-news"
  | "food"
  | "entertainment"
  | "sports"
  | "politics"
  | "technology"
  | "science"
  | "business"
  | "other";

export type DiscoveryPostState =
  | "queued"
  | "submitted"
  | "filtered"
  | "approved"
  | "auto-approved"
  | "removed"
  | "deleted"
  | "failed";

export type RequiredTermMode = "none" | "any" | "all";
export type DiscoveryTermMatch = "contains" | "exact" | "regex";

export type DiscoveryTermRule =
  | string
  | {
      value: string;
      match?: DiscoveryTermMatch;
      caseSensitive?: boolean;
    };

export interface DiscoveryFeedSource {
  url: string;
  sourceType?: "auto" | "rss" | "atom";
}

export interface DiscoveryHtmlSource {
  url: string;
  itemLinkPattern?: string;
  itemTitlePattern?: string;
  minTitleLength?: number;
  sameHostOnly?: boolean;
  stripUrlQuery?: boolean;
  maxAnchorsToScan?: number;
}

export interface DiscoveryCustomJsonSource {
  id: string;
  url: string;
  itemsPath?: string;
  titleField?: string;
  urlField?: string;
  descriptionField?: string;
  publishedAtField?: string;
  authorField?: string;
  sourceNameField?: string;
  thumbnailField?: string;
}

export interface DiscoveryCustomXmlSource {
  id: string;
  url: string;
  itemTag?: string;
  idTag?: string;
  titleTag?: string;
  urlTag?: string;
  descriptionTag?: string;
  publishedAtTag?: string;
  authorTag?: string;
  sourceNameTag?: string;
  thumbnailTag?: string;
}

export interface DiscoveryExistingFeedSource {
  id: string;
  url: string;
  sourceType: "auto" | "feed" | "html";
  htmlOptions?: Omit<DiscoveryHtmlSource, "url">;
}

export interface DiscoveryModerationPolicy {
  mode: DiscoveryApprovalMode;
  probationHours?: number;
  holdHours?: number;
}

export interface DiscoveryRedditPostOptions {
  titleTemplate?: string;
  flairId?: string;
  flairText?: string;
  sendReplies: boolean;
  spoiler: boolean;
  sticky: boolean;
  stickyPosition?: 1 | 2 | 3 | 4;
  lock: boolean;
  distinguish: boolean;
  suggestedCommentSort?: PostSuggestedCommentSort;
  redditNativeMode?: "crosspost" | "link";
}

export interface DiscoveryTarget {
  id: string;
  enabled: boolean;
  enabledAt?: number;
  probationEndsAt?: number;
  name: string;
  category: DiscoveryTargetCategory;
  aliases: string[];
  destinationSubreddit: string;
  reddit: {
    sourceSubreddits: string[];
    usernames: string[];
    scanUserComments: boolean;
    listingSorts: Array<"new" | "hot" | "rising" | "top">;
  };
  query: {
    additionalQueries: string[];
    requiredTerms: DiscoveryTermRule[];
    requiredTermMode: RequiredTermMode;
    preferredTerms: DiscoveryTermRule[];
    excludedTerms: DiscoveryTermRule[];
  };
  domains: {
    preferred: string[];
    excluded: string[];
  };
  sources: {
    feeds: DiscoveryFeedSource[];
    html: DiscoveryHtmlSource[];
    customJson: DiscoveryCustomJsonSource[];
    customXml: DiscoveryCustomXmlSource[];
    existingFeeds?: DiscoveryExistingFeedSource[];
  };
  discovery: {
    pollMinutes: number;
    maxCandidateAgeHours: number;
    maxResultsPerProvider: number;
    minimumScore: number;
    autoPostScore: number;
    maxPostsPerHour: number;
    maxPostsPerDay: number;
  };
  moderation: DiscoveryModerationPolicy;
  redditPost: DiscoveryRedditPostOptions;
}

export interface DiscoveryConfig {
  version: number;
  paused: boolean;
  nsfwTerms: DiscoveryTermRule[];
  stopWords: string[];
  blockedBotAccounts: string[];
  targets: DiscoveryTarget[];
}

export interface DiscoveryCandidate {
  candidateId: string;
  provider: DiscoveryProviderType;
  discoveredBy: DiscoveryProviderType[];
  providerItemId?: string;
  targetId: string;
  title: string;
  url: string;
  canonicalUrl: string;
  description?: string;
  sourceName?: string;
  sourceDomain?: string;
  author?: string;
  publishedAt?: number;
  discoveredAt: number;
  thumbnailUrl?: string;
  providerSafe?: boolean;
  redditPostId?: string;
  redditNsfw?: boolean;
  raw?: unknown;
  evaluation?: DiscoveryEvaluation;
}

export interface DiscoveryScoreReason {
  code: string;
  label: string;
  points: number;
  detail?: string;
}

export interface DiscoveryEvaluation {
  accepted: boolean;
  score: number;
  reasons: DiscoveryScoreReason[];
  rejectionReason?: string;
  duplicateOf?: string;
  duplicateKind?: "provider" | "url" | "title" | "event" | "rejected";
  evaluatedAt: number;
}

export interface DiscoveryFingerprints {
  providerKey?: string;
  canonicalUrlHash: string;
  normalizedTitleHash: string;
  contentKey: string;
}

export interface DiscoveryProviderState {
  lastSuccessfulPollAt?: number;
  lastSeenPublishedAt?: number;
  lastCursor?: string;
  nextPollAt: number;
}

export interface DiscoveryProviderHealth {
  provider: DiscoveryProviderType;
  status:
    | "healthy"
    | "degraded"
    | "backoff"
    | "rate-limited"
    | "not-applicable";
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  backoffUntil?: number;
  lastStatusCode?: number;
  lastError?: string;
}

export interface ProviderBudget {
  callsPerMinute?: number;
  callsPerHour?: number;
  callsPerDay?: number;
}

export interface DiscoveryProviderContext {
  reddit: Context["reddit"];
  fetch: typeof fetch;
  now: number;
  providerState: DiscoveryProviderState;
  maxResults: number;
  subredditName: string;
}

export interface DiscoveryIdentityPatch {
  canonicalName?: string;
  aliases: string[];
  description?: string;
  wikipediaUrl?: string;
  wikidataId?: string;
}

export interface DiscoveryIdentityProfile extends DiscoveryIdentityPatch {
  configuredName: string;
  sources: Array<"wikipedia" | "wikidata">;
  updatedAt: number;
}

export interface DiscoveryProviderSearchResult {
  candidates: DiscoveryCandidate[];
  callsUsed: number;
  identity?: DiscoveryIdentityPatch;
  errors?: string[];
  lastCursor?: string;
  lastSeenPublishedAt?: number;
}

export interface DiscoveryProvider {
  id: string;
  type: DiscoveryProviderType;
  isApplicable(target: DiscoveryTarget): boolean;
  estimateCalls(target: DiscoveryTarget): number;
  search(
    target: DiscoveryTarget,
    context: DiscoveryProviderContext
  ): Promise<DiscoveryProviderSearchResult>;
}

export interface DiscoveryAuditRecord {
  id: string;
  targetId: string;
  candidateId: string;
  provider: DiscoveryProviderType;
  title: string;
  url: string;
  sourceDomain?: string;
  publishedAt?: number;
  discoveredAt: number;
  evaluatedAt: number;
  evaluation: DiscoveryEvaluation;
  action:
    | "reject"
    | "defer"
    | "dry-run-auto-post"
    | "dry-run-filter"
    | "queue-publish"
    | "submitted"
    | "filtered"
    | "manually-approved"
    | "manually-rejected"
    | "auto-approved"
    | "deleted"
    | "failed";
  approvalMode: DiscoveryApprovalMode;
  detail?: string;
}

export interface DiscoveryPostRecord {
  targetId: string;
  candidateId: string;
  redditPostId: string;
  createdAt: number;
  updatedAt: number;
  state: DiscoveryPostState;
  approvalMode: DiscoveryApprovalMode;
  scheduledAutoApprovalAt?: number;
  sourceUrl: string;
  sourceDomain?: string;
  score: number;
  reasons: DiscoveryScoreReason[];
}

export interface DiscoveryStats {
  searches: number;
  candidatesDiscovered: number;
  exactDuplicates: number;
  nearDuplicates: number;
  nsfwRejections: number;
  relevanceRejections: number;
  blockedDomainRejections: number;
  accepted: number;
  manualFiltered: number;
  autoPosted: number;
  manuallyApproved: number;
  manuallyRejected: number;
  autoApprovedAfterHold: number;
  deliveryFailures: number;
  providerFailures: number;
  rateDeferred: number;
}

export type DiscoveryTaskKind =
  | "discovery_search"
  | "discovery_evaluate"
  | "discovery_publish"
  | "discovery_auto_approve";

export interface DiscoverySearchTaskPayload {
  targetId: string;
  provider: DiscoveryProviderType;
  preview?: boolean;
}

export interface DiscoveryEvaluateTaskPayload {
  targetId: string;
  candidateId: string;
  preview?: boolean;
}

export interface DiscoveryPublishTaskPayload {
  targetId: string;
  candidateId: string;
}

export interface DiscoveryAutoApproveTaskPayload {
  targetId: string;
  candidateId: string;
  redditPostId: string;
}

export type DiscoveryTaskPayload =
  | DiscoverySearchTaskPayload
  | DiscoveryEvaluateTaskPayload
  | DiscoveryPublishTaskPayload
  | DiscoveryAutoApproveTaskPayload;

export interface DiscoveryQueueTask {
  id: string;
  kind: DiscoveryTaskKind;
  bucket: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  nextRunAt: number;
  payload: DiscoveryTaskPayload;
  dedupeKey?: string;
  dedupeWindowMs?: number;
  lastError?: string;
}

export interface DiscoveryDedupeResult {
  duplicate: boolean;
  duplicateOf?: string;
  kind?: "provider" | "url" | "title" | "event" | "rejected";
  similarity?: number;
}
