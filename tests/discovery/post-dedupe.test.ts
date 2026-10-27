import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicatePost, isRedditSourceUrl, rememberPostedContent } from "../../src/shared/post-dedupe.js";
import { titleSimilarity } from "../../src/discovery/similarity.js";
import { checkDiscoverySafety } from "../../src/discovery/safety.js";
import { executeDiscoveryTask } from "../../src/discovery/runtime.js";
import { saveDiscoveryConfig, storeCandidate } from "../../src/discovery/state.js";
import { makeDiscoveryTask } from "../../src/discovery/tasks.js";
import { candidate, config, MemoryRedis, NOW, target } from "./fixtures.js";

test("Reddit URL blocking covers subdomains, shortlinks, and hostname tricks", () => {
  for (const url of ["https://reddit.com/r/news", "https://old.reddit.com/comments/123", "https://REDD.IT/123", "https://www.reddit.com./r/news", "https://i.redd.it/image.jpg", "https://news.example@reddit.com/r/news"]) {
    assert.equal(isRedditSourceUrl(url), true, url);
    assert.equal(checkDiscoverySafety(candidate({ url }), target(), config()).safe, false);
  }
  assert.equal(isRedditSourceUrl("https://reddit.com.publisher.example/story"), false);
  assert.equal(isRedditSourceUrl("https://publisher.example/story?source=reddit.com"), false);
  assert.equal(checkDiscoverySafety(candidate({ canonicalUrl: "https://redd.it/123" }), target(), config()).safe, false);
});

test("destination history catches tracking URLs, normalized titles, and added detail", async () => {
  const context = { redis: new MemoryRedis() as any };
  await rememberPostedContent(context, "ExampleSub", "Mamdani housing plan cuts rents", "https://news.example/story?utm_source=rss", NOW);
  assert.equal(await isDuplicatePost(context, "examplesub", "A rewritten headline", "https://news.example/story?utm_source=reddit", NOW), true);
  assert.equal(await isDuplicatePost(context, "ExampleSub", "MAMDANI: Housing plan cuts rents!", "https://other.example/story", NOW), true);
  assert.equal(await isDuplicatePost(context, "ExampleSub", "Housing plan cuts rents, Mamdani says - Daily News", "https://other.example/new", NOW + 6 * 86400000), true);
  assert.equal(await isDuplicatePost(context, "OtherSub", "Mamdani housing plan cuts rents", "https://news.example/story", NOW), false);
  assert.equal(await isDuplicatePost(context, "ExampleSub", "Mamdani attends baseball game", "https://news.example/baseball", NOW), false);
  assert.equal(await isDuplicatePost(context, "ExampleSub", "Housing plan cuts rents, Mamdani says - Daily News", "https://other.example/new", NOW + 8 * 86400000), false);
});

test("titles reduced to empty features do not mark unrelated stories as duplicates", () => {
  assert.equal(titleSimilarity("Mamdani", "New announcement", ["Mamdani"]), 0);
  assert.ok(titleSimilarity("Mamdani housing plan cuts rents", "Rents cuts plan housing Mamdani") >= 0.85);
});

test("queued Discovery articles use external links and reject later destination duplicates", async () => {
  const submissions: any[] = [];
  const context = {
    redis: new MemoryRedis() as any,
    subredditName: "ExampleSub",
    reddit: { submitPost: async (options: any) => {
      submissions.push(options);
      return { id: "t3_posted" };
    } } as any,
  };
  await saveDiscoveryConfig(context, config());
  const first = candidate({ redditPostId: "t3_source", evaluation: {
    accepted: true, score: 90, reasons: [], evaluatedAt: NOW,
  } });
  await storeCandidate(context, first);
  const publish = (id: string) => makeDiscoveryTask("discovery_publish", {
    targetId: first.targetId, candidateId: id,
  }, { bucket: "reddit:examplesub", maxAttempts: 3, identity: id });
  assert.equal((await executeDiscoveryTask(context, publish(first.candidateId), { dryRun: false, now: NOW })).status, "success");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].url, first.canonicalUrl);

  const second = candidate({ ...first, candidateId: "second", providerItemId: "second", url: "https://other.example/story", canonicalUrl: "https://other.example/story" });
  await storeCandidate(context, second);
  await executeDiscoveryTask(context, publish(second.candidateId), { dryRun: false, now: NOW + 1000 });
  assert.equal(submissions.length, 1);

  const redditOnly = candidate({ ...first, candidateId: "reddit-only", url: "https://redd.it/123", canonicalUrl: "https://redd.it/123", title: "Mamdani attends baseball game" });
  await storeCandidate(context, redditOnly);
  await executeDiscoveryTask(context, publish(redditOnly.candidateId), { dryRun: false, now: NOW + 2000 });
  assert.equal(submissions.length, 1);
});
