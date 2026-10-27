import type { Context } from "@devvit/public-api";
import { canonicalizeDiscoveryUrl } from "../discovery/canonical-url.js";
import { sha256 } from "../discovery/hash.js";
import { titleSimilarity } from "../discovery/similarity.js";
import { normalizeForMatch } from "../discovery/utils.js";

const TITLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const EXACT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
type RedisContext = Pick<Context, "redis">;
type Entry = { title: string; createdAt: number };

export function isRedditSourceUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return ["reddit.com", "redd.it", "redditmedia.com", "redditstatic.com"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function scope(subreddit: string): string {
  return `adv:posts:${subreddit.replace(/^\/?r\//i, "").toLowerCase()}`;
}

function exactKeys(subreddit: string, title: string, url?: string): string[] {
  const prefix = scope(subreddit);
  return [
    `${prefix}:title:${sha256(normalizeForMatch(title))}`,
    ...(url ? [`${prefix}:url:${sha256(canonicalizeDiscoveryUrl(url))}`] : []),
  ];
}

export async function isDuplicatePost(
  context: RedisContext, subreddit: string, title: string, url?: string, now = Date.now()
): Promise<boolean> {
  const seen = await Promise.all(exactKeys(subreddit, title, url).map((key) => context.redis.get(key)));
  if (seen.some(Boolean)) return true;
  const raw = await context.redis.get(`${scope(subreddit)}:recent`);
  const entries: Entry[] = raw ? JSON.parse(raw) : [];
  return entries.some((entry) => entry.createdAt >= now - TITLE_WINDOW_MS &&
    titleSimilarity(title, entry.title) >= 0.72);
}

export async function rememberPostedContent(
  context: RedisContext, subreddit: string, title: string, url?: string, now = Date.now()
): Promise<void> {
  await Promise.all(exactKeys(subreddit, title, url).map((key) => context.redis.set(
    key, "1", { expiration: new Date(now + EXACT_WINDOW_MS) }
  )));
  const key = `${scope(subreddit)}:recent`;
  const raw = await context.redis.get(key);
  const entries: Entry[] = raw ? JSON.parse(raw) : [];
  const recent = entries.filter((entry) => entry.createdAt >= now - TITLE_WINDOW_MS);
  recent.unshift({ title, createdAt: now });
  await context.redis.set(key, JSON.stringify(recent.slice(0, 1000)), {
    expiration: new Date(now + TITLE_WINDOW_MS),
  });
}
