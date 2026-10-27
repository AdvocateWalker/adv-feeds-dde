export const DEVVIT_HTTP_DOMAINS = [
  "en.wikipedia.org",
  "www.wikidata.org",
  "discord.com",
  "feeds.npr.org",
  "rss.nytimes.com",
  "www.propublica.org",
  "www.pbs.org",
] as const;

export const AUTOMATIC_PUBLIC_FEED_SOURCES = [
  {
    id: "public-npr-news",
    url: "https://feeds.npr.org/1001/rss.xml",
    sourceType: "feed" as const,
  },
  {
    id: "public-nyt-homepage",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    sourceType: "feed" as const,
  },
  {
    id: "public-propublica",
    url: "https://www.propublica.org/feeds/propublica/main",
    sourceType: "feed" as const,
  },
  {
    id: "public-pbs-headlines",
    url: "https://www.pbs.org/newshour/feeds/rss/headlines",
    sourceType: "feed" as const,
  },
] as const;

export const LEGACY_PLACEHOLDER_FEED_URLS = new Set([
  "https://example.com/dhs-feed.xml",
]);

const DECLARED_DOMAIN_SET = new Set<string>(DEVVIT_HTTP_DOMAINS);

export function isDeclaredHttpsFetchUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && DECLARED_DOMAIN_SET.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function fetchHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
