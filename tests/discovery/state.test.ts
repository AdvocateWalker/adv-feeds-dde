import assert from "node:assert/strict";
import test from "node:test";
import { planQueueRetry } from "../../src/discovery/retry.js";
import { dispatchDiscovery } from "../../src/discovery/dispatcher.js";
import {
  checkDiscoveryDedupe,
  checkPostingRate,
  consumeProviderBudget,
  getDiscoveryIdentity,
  getEffectiveDiscoveryTarget,
  markDiscoveryConsumed,
  mergeDiscoveryIdentity,
  recordPosted,
  recordProviderFailure,
} from "../../src/discovery/state.js";
import { candidate, config, MemoryRedis, NOW, target } from "./fixtures.js";

function context(redis = new MemoryRedis()): { redis: any } {
  return { redis };
}

test("exact and cross-provider URL dedupe survives provider changes", async () => {
  const redis = new MemoryRedis();
  const ctx = context(redis);
  const value = target();
  const first = candidate();
  await markDiscoveryConsumed(ctx, value, first, true, NOW);

  const exact = await checkDiscoveryDedupe(ctx, value, first, [], NOW + 1000);
  assert.equal(exact.duplicate, true);

  const crossProvider = candidate({
    candidateId: "candidate-2",
    provider: "rss",
    discoveredBy: ["rss"],
    providerItemId: "different-provider-item",
  });
  const cross = await checkDiscoveryDedupe(ctx, value, crossProvider, [], NOW + 1000);
  assert.equal(cross.duplicate, true);
  assert.equal(cross.kind, "url");
});

test("near-duplicate title event detection uses the bounded event history", async () => {
  const ctx = context();
  const value = target();
  await markDiscoveryConsumed(ctx, value, candidate(), true, NOW);
  const result = await checkDiscoveryDedupe(
    ctx,
    value,
    candidate({
      candidateId: "candidate-3",
      providerItemId: "other",
      url: "https://other.example/story",
      canonicalUrl: "https://other.example/story",
      title: "Zohran Mamdani unveils housing initiative",
    }),
    ["announces", "new", "unveils"],
    NOW + 1000
  );
  assert.equal(result.duplicate, true);
  assert.equal(result.kind, "event");
  assert.ok((result.similarity ?? 0) >= 0.82);
});

test("rejected candidates are remembered without poisoning accepted URL and title history", async () => {
  const ctx = context();
  const value = target();
  const rejected = candidate();
  await markDiscoveryConsumed(ctx, value, rejected, false, NOW);
  const repeated = await checkDiscoveryDedupe(ctx, value, rejected, [], NOW + 1000);
  assert.equal(repeated.kind, "rejected");

  const sameTitleDifferentContent = candidate({
    candidateId: "different-content",
    providerItemId: "different-content",
    url: "https://different.example/story",
    canonicalUrl: "https://different.example/story",
  });
  const independent = await checkDiscoveryDedupe(
    ctx,
    value,
    sameTitleDifferentContent,
    [],
    NOW + 1000
  );
  assert.equal(independent.duplicate, false);
});

test("posting rate enforces hourly and daily target limits", async () => {
  const ctx = context();
  const value = target({
    discovery: {
      ...target().discovery,
      maxPostsPerHour: 2,
      maxPostsPerDay: 3,
    },
  });
  assert.equal((await checkPostingRate(ctx, value, NOW)).allowed, true);
  await recordPosted(ctx, value.id, NOW - 1000);
  await recordPosted(ctx, value.id, NOW - 2000);
  const hourly = await checkPostingRate(ctx, value, NOW);
  assert.equal(hourly.allowed, false);
  assert.ok((hourly.retryAt ?? 0) > NOW);
});

test("provider failures use exponential backoff and preserve the last success fields", async () => {
  const ctx = context();
  const first = await recordProviderFailure(ctx, "wikipedia", "temporary", NOW, 503);
  const second = await recordProviderFailure(ctx, "wikipedia", "again", NOW + 1000, 503);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(second.consecutiveFailures, 2);
  assert.ok((second.backoffUntil ?? 0) - (NOW + 1000) > (first.backoffUntil ?? 0) - NOW);

  const limited = await recordProviderFailure(ctx, "reddit-search", "quota", NOW, 429, 90_000);
  assert.equal(limited.status, "rate-limited");
  assert.equal(limited.backoffUntil, NOW + 90_000);
});

test("provider request budgets block calls that exceed a fixed window", async () => {
  const ctx = context();
  assert.equal((await consumeProviderBudget(ctx, "wikipedia", 10, NOW)).allowed, true);
  const denied = await consumeProviderBudget(ctx, "wikipedia", 1, NOW + 1000);
  assert.equal(denied.allowed, false);
  assert.ok((denied.retryAt ?? 0) > NOW);
});

test("queue retry plans increment attempts, delay retries, and stop at the maximum", () => {
  assert.deepEqual(planQueueRetry(0, 3, 5000, NOW), {
    exhausted: false,
    attempts: 1,
    nextRunAt: NOW + 5000,
  });
  assert.deepEqual(planQueueRetry(2, 3, 5000, NOW), {
    exhausted: true,
    attempts: 3,
  });
});

test("derived Wikimedia aliases are cached separately from moderator configuration", async () => {
  const ctx = context();
  const configured = target({ aliases: [] });
  await mergeDiscoveryIdentity(ctx, configured.id, configured.name, "wikipedia", {
    canonicalName: "Zohran Mamdani",
    aliases: ["Zohran Mamdani"],
    wikidataId: "Q28034971",
  }, NOW);
  await mergeDiscoveryIdentity(ctx, configured.id, configured.name, "wikidata", {
    canonicalName: "Zohran Mamdani",
    aliases: ["Zohran Kwame Mamdani"],
    wikipediaUrl: "https://en.wikipedia.org/wiki/Zohran_Mamdani",
    wikidataId: "Q28034971",
  }, NOW + 1);
  const effective = await getEffectiveDiscoveryTarget(ctx, configured);
  const stored = await getDiscoveryIdentity(ctx, configured.id);
  assert.deepEqual(configured.aliases, []);
  assert.deepEqual(effective.aliases, ["Zohran Kwame Mamdani"]);
  assert.deepEqual(stored?.sources, ["wikipedia", "wikidata"]);
  const renamed = await getEffectiveDiscoveryTarget(ctx, target({ name: "Different Target", aliases: [] }));
  assert.deepEqual(renamed.aliases, []);
});

test("dispatcher automatically queues every operational provider without target switches", async () => {
  const redis = new MemoryRedis();
  const value = target({
    aliases: [],
    query: { ...target().query, additionalQueries: [] },
    sources: {
      feeds: [
        { url: "https://feed.example/rss.xml", sourceType: "rss" },
        { url: "https://feed.example/atom.xml", sourceType: "atom" },
      ],
      html: [{ url: "https://html.example/news" }],
      customJson: [{ id: "api", url: "https://api.example/items" }],
      customXml: [{ id: "xml-api", url: "https://xml.example/items.xml" }],
    },
  });
  const result = await dispatchDiscovery(
    { redis: redis as any },
    config([value]),
    {
      force: true,
      preview: true,
      now: NOW,
      existingFeedSources: [
        { id: "legacy", url: "https://legacy.example/feed", sourceType: "auto" },
      ],
    }
  );
  assert.equal(result.providersQueued, 11);
  assert.deepEqual(
    result.tasks.map((task) => task.kind),
    Array(11).fill("discovery_search")
  );
});
