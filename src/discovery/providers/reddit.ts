import { buildQueries } from "../queries.js";
import type {
  DiscoveryCandidate,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderSearchResult,
  DiscoveryTarget,
} from "../types.js";
import { normalizeSubreddit } from "../utils.js";
import { createDiscoveryCandidate, mergeCandidates } from "./common.js";
import { takeRotatingBatch } from "./batching.js";

const REDDIT_CALLS_PER_POLL = 15;

export const redditSearchProvider: DiscoveryProvider = {
  id: "reddit-search",
  type: "reddit-search",
  isApplicable: () => true,
  estimateCalls: (target) =>
    Math.min(
      REDDIT_CALLS_PER_POLL,
      buildQueries(target).length * Math.max(1, target.reddit.sourceSubreddits.length + 1)
    ),
  search: searchReddit,
};

export const redditListingProvider: DiscoveryProvider = {
  id: "reddit-listing",
  type: "reddit-listing",
  isApplicable: (target) => target.reddit.sourceSubreddits.length > 0,
  estimateCalls: (target) => Math.min(
    REDDIT_CALLS_PER_POLL,
    target.reddit.sourceSubreddits.length * target.reddit.listingSorts.length
  ),
  search: scanRedditListings,
};

export const redditUserProvider: DiscoveryProvider = {
  id: "reddit-user",
  type: "reddit-user",
  isApplicable: (target) => target.reddit.usernames.length > 0,
  estimateCalls: (target) => Math.min(
    REDDIT_CALLS_PER_POLL,
    target.reddit.usernames.length * (target.reddit.scanUserComments ? 2 : 1)
  ),
  search: scanRedditUsers,
};

async function searchReddit(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const configuredSubreddits = Array.from(
    new Set(target.reddit.sourceSubreddits.map(normalizeSubreddit).filter(Boolean))
  );
  const searchScopes: Array<string | undefined> = [undefined, ...configuredSubreddits];
  const batch = takeRotatingBatch(
    buildQueries(target).flatMap((query) =>
      searchScopes.map((subredditName) => ({ subredditName, query }))
    ),
    context.providerState.lastCursor,
    REDDIT_CALLS_PER_POLL
  );
  const candidates: DiscoveryCandidate[] = [];
  let callsUsed = 0;
  for (const item of batch.values) {
    const posts = await context.reddit.searchPosts({
      query: item.query,
      ...(item.subredditName ? { subredditName: item.subredditName } : {}),
      sort: "new",
      timeframe: ageTimeframe(target.discovery.maxCandidateAgeHours),
      limit: context.maxResults,
      pageSize: Math.min(100, context.maxResults),
    }).all();
    callsUsed += 1;
    for (const post of posts) {
      const candidate = candidateFromPost(post, "reddit-search", target.id, context.now);
      if (candidate) candidates.push(candidate);
    }
  }
  return result(candidates, callsUsed, context.maxResults, batch.nextCursor);
}

async function scanRedditListings(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  let callsUsed = 0;
  const batch = takeRotatingBatch(
    target.reddit.sourceSubreddits.flatMap((subredditName) =>
      target.reddit.listingSorts.map((sort) => ({ subredditName, sort }))
    ),
    context.providerState.lastCursor,
    REDDIT_CALLS_PER_POLL
  );
  for (const { subredditName, sort } of batch.values) {
      const options = {
        subredditName,
        limit: context.maxResults,
        pageSize: Math.min(100, context.maxResults),
      };
      const listing =
        sort === "hot"
          ? context.reddit.getHotPosts(options)
          : sort === "rising"
            ? context.reddit.getRisingPosts(options)
            : sort === "top"
              ? context.reddit.getTopPosts({ ...options, timeframe: "week" })
              : context.reddit.getNewPosts(options);
      const posts = await listing.all();
      callsUsed += 1;
      for (const post of posts) {
        const candidate = candidateFromPost(post, "reddit-listing", target.id, context.now);
        if (candidate) candidates.push(candidate);
      }
  }
  return result(candidates, callsUsed, context.maxResults, batch.nextCursor);
}

async function scanRedditUsers(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  let callsUsed = 0;
  const callsPerUser = target.reddit.scanUserComments ? 2 : 1;
  const batch = takeRotatingBatch(
    target.reddit.usernames,
    context.providerState.lastCursor,
    Math.max(1, Math.floor(REDDIT_CALLS_PER_POLL / callsPerUser))
  );
  for (const username of batch.values) {
    const posts = await context.reddit.getPostsByUser({
      username,
      sort: "new",
      timeframe: ageTimeframe(target.discovery.maxCandidateAgeHours),
      limit: context.maxResults,
      pageSize: Math.min(100, context.maxResults),
    }).all();
    callsUsed += 1;
    for (const post of posts) {
      const candidate = candidateFromPost(post, "reddit-user", target.id, context.now);
      if (candidate) candidates.push(candidate);
    }
    if (target.reddit.scanUserComments) {
      const comments = await context.reddit.getCommentsByUser({
        username,
        sort: "new",
        timeframe: ageTimeframe(target.discovery.maxCandidateAgeHours),
        limit: context.maxResults,
        pageSize: Math.min(100, context.maxResults),
      }).all();
      callsUsed += 1;
      for (const comment of comments) {
        for (const url of extractHttpsUrls(comment.body)) {
          const candidate = createDiscoveryCandidate({
            provider: "reddit-user",
            providerItemId: `${comment.id}:${url}`,
            targetId: target.id,
            title: comment.body.slice(0, 300),
            url,
            description: comment.body,
            sourceName: `u/${comment.authorName}`,
            author: comment.authorName,
            publishedAt: comment.createdAt.getTime(),
            discoveredAt: context.now,
            providerSafe: true,
          });
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  return result(candidates, callsUsed, context.maxResults, batch.nextCursor);
}

function candidateFromPost(
  post: {
    id: string;
    title: string;
    body?: string;
    url: string;
    permalink: string;
    subredditName: string;
    authorName: string;
    createdAt: Date;
    thumbnail?: { url: string };
    nsfw: boolean;
  },
  provider: "reddit-search" | "reddit-listing" | "reddit-user",
  targetId: string,
  now: number
): DiscoveryCandidate | undefined {
  if (!post.url.startsWith("https://")) return undefined;
  const externalUrl = post.url;
  return createDiscoveryCandidate({
    provider,
    providerItemId: post.id,
    targetId,
    title: post.title,
    url: externalUrl,
    description: post.body,
    sourceName: `r/${post.subredditName}`,
    author: post.authorName,
    publishedAt: post.createdAt.getTime(),
    discoveredAt: now,
    thumbnailUrl: post.thumbnail?.url,
    providerSafe: !post.nsfw,
    redditPostId: post.id,
    redditNsfw: post.nsfw,
  });
}

function result(
  candidates: DiscoveryCandidate[],
  callsUsed: number,
  maximum: number,
  lastCursor?: string
): DiscoveryProviderSearchResult {
  const merged = mergeCandidates(candidates).slice(0, maximum);
  const published = merged.map((item) => item.publishedAt).filter((value): value is number => value !== undefined);
  return {
    candidates: merged,
    callsUsed,
    lastCursor,
    lastSeenPublishedAt: published.length ? Math.max(...published) : undefined,
  };
}

function ageTimeframe(hours: number): "hour" | "day" | "week" | "month" | "year" | "all" {
  if (hours <= 1) return "hour";
  if (hours <= 24) return "day";
  if (hours <= 24 * 7) return "week";
  if (hours <= 24 * 31) return "month";
  if (hours <= 24 * 365) return "year";
  return "all";
}

function extractHttpsUrls(value: string): string[] {
  return Array.from(new Set(value.match(/https:\/\/[^\s<>"'\])}]+/gi) ?? []));
}
