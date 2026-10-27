import type {
  DiscoveryCandidate,
  DiscoveryConfig,
  DiscoveryTarget,
} from "../../src/discovery/types.js";

export const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

export function target(overrides: Partial<DiscoveryTarget> = {}): DiscoveryTarget {
  return {
    id: "zohran-mamdani",
    enabled: true,
    enabledAt: NOW - 48 * 3_600_000,
    probationEndsAt: NOW - 24 * 3_600_000,
    name: "Zohran Mamdani",
    category: "person",
    aliases: ["Zohran Kwame Mamdani"],
    destinationSubreddit: "ExampleSub",
    reddit: {
      sourceSubreddits: ["NYCPolitics"],
      usernames: ["example_account"],
      scanUserComments: false,
      listingSorts: ["new"],
    },
    query: {
      additionalQueries: ["\"Zohran Mamdani\" interview"],
      requiredTerms: [],
      requiredTermMode: "none",
      preferredTerms: ["housing"],
      excludedTerms: [],
    },
    domains: { preferred: ["news.example.com"], excluded: ["blocked.example"] },
    sources: { feeds: [], html: [], customJson: [], customXml: [] },
    discovery: {
      pollMinutes: 30,
      maxCandidateAgeHours: 72,
      maxResultsPerProvider: 25,
      minimumScore: 60,
      autoPostScore: 75,
      maxPostsPerHour: 2,
      maxPostsPerDay: 12,
    },
    moderation: { mode: "auto" },
    redditPost: {
      titleTemplate: "{title}",
      sendReplies: false,
      spoiler: false,
      sticky: false,
      lock: false,
      distinguish: false,
      redditNativeMode: "crosspost",
    },
    ...overrides,
  };
}

export function config(targets: DiscoveryTarget[] = [target()]): DiscoveryConfig {
  return {
    version: 1,
    paused: false,
    nsfwTerms: ["explicit pornography", { value: "nsfw-[0-9]+", match: "regex" }],
    stopWords: ["the", "a", "new", "announces", "unveils"],
    blockedBotAccounts: ["loop_bot"],
    targets,
  };
}

export function candidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    candidateId: "candidate-1",
    provider: "rss",
    discoveredBy: ["rss"],
    providerItemId: "provider-item-1",
    targetId: "zohran-mamdani",
    title: "Zohran Mamdani announces a housing initiative",
    description: "Zohran Mamdani discussed housing in New York.",
    url: "https://news.example.com/politics/mamdani-housing",
    canonicalUrl: "https://news.example.com/politics/mamdani-housing",
    sourceName: "Example News",
    sourceDomain: "news.example.com",
    author: "Reporter",
    publishedAt: NOW - 2 * 3_600_000,
    discoveredAt: NOW,
    providerSafe: true,
    ...overrides,
  };
}

export class MemoryRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Record<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean }
  ): Promise<string | undefined> {
    if (options?.nx && this.strings.has(key)) return undefined;
    this.strings.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (this.strings.delete(key)) count += 1;
    return count;
  }

  async hIncrBy(key: string, field: string, amount: number): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    hash[field] = (hash[field] ?? 0) + amount;
    this.hashes.set(key, hash);
    return hash[field];
  }

  async hGetAll(key: string): Promise<Record<string, number>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }
}
