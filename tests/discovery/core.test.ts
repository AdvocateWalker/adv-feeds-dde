import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeDiscoveryUrl,
  extractYouTubeVideoId,
} from "../../src/discovery/canonical-url.js";
import {
  createDiscoveryTarget,
  migrateDiscoveryConfig,
  parseDiscoveryConfig,
} from "../../src/discovery/config.js";
import {
  evaluateDiscoveryCandidate,
  resolveDeliveryDisposition,
} from "../../src/discovery/evaluator.js";
import { buildQueries } from "../../src/discovery/queries.js";
import { checkDiscoverySafety } from "../../src/discovery/safety.js";
import { scoreDiscoveryCandidate } from "../../src/discovery/scoring.js";
import { titleSimilarity } from "../../src/discovery/similarity.js";
import { discoveryFilterOptions } from "../../src/discovery/runtime.js";
import { matchesDomainRule } from "../../src/discovery/utils.js";
import { candidate, config, NOW, target } from "./fixtures.js";

test("query generation quotes names and aliases and deduplicates custom queries", () => {
  const value = target({
    aliases: ["Park Yeon-mi", "Park Yeon-mi"],
    query: {
      additionalQueries: ["\"Zohran Mamdani\"", "\"Zohran Mamdani\" interview"],
      requiredTerms: [],
      requiredTermMode: "none",
      preferredTerms: [],
      excludedTerms: [],
    },
  });
  assert.deepEqual(buildQueries(value), [
    "\"Zohran Mamdani\"",
    "\"Park Yeon-mi\"",
    "\"Zohran Mamdani\" interview",
  ]);
});

test("simple target categories apply useful defaults and category queries", () => {
  const value = createDiscoveryTarget(
    "Metro Transit",
    "breaking-news",
    "ExampleSub",
    ["metro-transit"],
    NOW
  );
  assert.equal(value.id, "metro-transit-2");
  assert.equal(value.category, "breaking-news");
  assert.equal(value.discovery.pollMinutes, 5);
  assert.equal(value.discovery.maxCandidateAgeHours, 24);
  assert.equal(value.moderation.mode, "manual");
  assert.equal(value.redditPost.redditNativeMode, "link");
  assert.deepEqual(buildQueries(value), [
    '"Metro Transit"',
    '"Metro Transit" breaking news',
    '"Metro Transit" developing',
  ]);
});

test("DDE review posts stay visible while entering ModQueue", () => {
  assert.deepEqual(discoveryFilterOptions("Zohran Mamdani"), {
    reason: "DDE: Zohran Mamdani",
    keep: true,
  });
});

test("URL normalization strips tracking without removing identifying parameters", () => {
  assert.equal(
    canonicalizeDiscoveryUrl(
      "HTTPS://WWW.Example.COM/story/?id=42&utm_source=x&fbclid=y#section"
    ),
    "https://example.com/story?id=42"
  );
  assert.equal(matchesDomainRule("m.news.example.com", "example.com"), true);
  assert.equal(matchesDomainRule("notexample.com", "example.com"), false);
});

test("YouTube URL variants share one canonical identity", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(extractYouTubeVideoId(`https://youtu.be/${id}?si=x`), id);
  assert.equal(canonicalizeDiscoveryUrl(`https://m.youtube.com/watch?v=${id}&feature=youtu.be`), `youtube:${id}`);
  assert.equal(canonicalizeDiscoveryUrl(`https://youtube.com/shorts/${id}`), `youtube:${id}`);
});

test("title similarity clusters equivalent events and separates unrelated stories", () => {
  const similar = titleSimilarity(
    "Mamdani announces new housing initiative",
    "Mamdani unveils housing initiative",
    ["Mamdani"]
  );
  const different = titleSimilarity(
    "Mamdani announces new housing initiative",
    "Mamdani attends baseball game",
    ["Mamdani"]
  );
  assert.ok(similar >= 0.82, `expected duplicate similarity, got ${similar}`);
  assert.ok(different < 0.68, `expected distinct similarity, got ${different}`);
});

test("scoring handles aliases, required terms, domain preference, and age", () => {
  const value = target({
    query: {
      additionalQueries: [],
      requiredTerms: ["New York", "housing"],
      requiredTermMode: "all",
      preferredTerms: ["initiative"],
      excludedTerms: [],
    },
  });
  const result = scoreDiscoveryCandidate(candidate(), value, NOW);
  assert.equal(result.meaningfulTargetMatch, true);
  assert.equal(result.requiredTermsSatisfied, true);
  assert.ok(result.score >= 100);
  assert.ok(result.reasons.some((reason) => reason.code === "preferred-domain"));
  assert.ok(result.reasons.some((reason) => reason.code === "fresh-12h"));

  const alias = scoreDiscoveryCandidate(
    candidate({ title: "Zohran Kwame Mamdani gives an interview", description: "" }),
    value,
    NOW
  );
  assert.ok(alias.reasons.some((reason) => reason.code === "alias-title"));
});

test("required and excluded terms deterministically reject candidates", () => {
  const value = target({
    query: {
      additionalQueries: [],
      requiredTerms: ["Queens"],
      requiredTermMode: "all",
      preferredTerms: [],
      excludedTerms: [{ value: "parody", match: "exact" }],
    },
  });
  const missing = evaluateDiscoveryCandidate(candidate(), value, config([value]), { duplicate: false }, NOW);
  assert.equal(missing.rejectionReason, "required-terms-not-satisfied");
  const excluded = evaluateDiscoveryCandidate(
    candidate({ description: "A parody about Zohran Mamdani in Queens" }),
    value,
    config([value]),
    { duplicate: false },
    NOW
  );
  assert.equal(excluded.rejectionReason, "excluded-term: parody");
});

test("NSFW, Reddit NSFW, bot, and domain safety layers reject independently", () => {
  const value = target();
  const cfg = config([value]);
  assert.equal(checkDiscoverySafety(candidate({ title: "Explicit pornography featuring a name" }), value, cfg).rejectionReason, "nsfw-term");
  assert.equal(checkDiscoverySafety(candidate({ redditNsfw: true }), value, cfg).rejectionReason, "reddit-nsfw");
  assert.equal(checkDiscoverySafety(candidate({ author: "loop_bot" }), value, cfg).rejectionReason, "blocked-bot-author");
  assert.equal(checkDiscoverySafety(candidate({ author: "adv-feeds" }), value, cfg).rejectionReason, "blocked-bot-author");
  assert.equal(checkDiscoverySafety(candidate({ sourceDomain: "sub.blocked.example" }), value, cfg).rejectionReason, "blocked-domain");
});

test("candidate age and exact target matching affect evaluation", () => {
  const value = target();
  const old = evaluateDiscoveryCandidate(
    candidate({ publishedAt: NOW - 73 * 3_600_000 }),
    value,
    config([value]),
    { duplicate: false },
    NOW
  );
  assert.equal(old.rejectionReason, "candidate-too-old");
  const unrelated = evaluateDiscoveryCandidate(
    candidate({ title: "Another politician discusses housing", description: "No named target" }),
    value,
    config([value]),
    { duplicate: false },
    NOW
  );
  assert.equal(unrelated.rejectionReason, "no-meaningful-target-match");
});

test("manual, probation, auto, and timed hold modes resolve correctly", () => {
  const evaluation = evaluateDiscoveryCandidate(candidate(), target(), config(), { duplicate: false }, NOW);
  assert.equal(resolveDeliveryDisposition(target({ moderation: { mode: "manual" } }), evaluation, NOW), "filter");
  assert.equal(resolveDeliveryDisposition(target({ moderation: { mode: "timed_hold", holdHours: 24 } }), evaluation, NOW), "hold");
  assert.equal(resolveDeliveryDisposition(target({ moderation: { mode: "auto" } }), evaluation, NOW), "auto");
  assert.equal(
    resolveDeliveryDisposition(
      target({
        enabledAt: NOW,
        probationEndsAt: NOW + 24 * 3_600_000,
        moderation: { mode: "probation_then_auto", probationHours: 24 },
      }),
      evaluation,
      NOW
    ),
    "filter"
  );
  assert.equal(
    resolveDeliveryDisposition(
      target({
        enabledAt: NOW - 48 * 3_600_000,
        probationEndsAt: NOW - 24 * 3_600_000,
        moderation: { mode: "probation_then_auto", probationHours: 24 },
      }),
      evaluation,
      NOW
    ),
    "auto"
  );
});

test("configuration migration validates provider switches, regexes, URLs, and ranges", () => {
  assert.deepEqual(migrateDiscoveryConfig({ version: 0, targets: [] }), { version: 1, targets: [] });
  const raw = target() as unknown as Record<string, unknown>;
  raw.search = { redditSearch: false };
  const parsed = parseDiscoveryConfig({ version: 0, targets: [raw] }, NOW);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.warnings.some((warning) => warning.includes("provider switches are ignored")));

  const invalid = structuredClone(raw);
  (invalid.query as Record<string, unknown>).excludedTerms = [{ value: "(", match: "regex" }];
  (invalid.sources as Record<string, unknown>).feeds = [{ url: "http://unsafe.example/feed" }];
  (invalid.sources as Record<string, unknown>).customXml = [{
    id: "xml-api",
    url: "https://www.pbs.org/items.xml",
    itemTag: "invalid tag",
  }];
  (invalid.sources as Record<string, unknown>).customJson = [{
    id: "undeclared-api",
    url: "https://api.example/items.json",
  }];
  (invalid.discovery as Record<string, unknown>).pollMinutes = 0;
  const rejected = parseDiscoveryConfig({ version: 1, targets: [invalid] }, NOW);
  assert.ok(rejected.errors.some((error) => error.includes("invalid regular expression")));
  assert.ok(rejected.errors.some((error) => error.includes("HTTPS URL")));
  assert.ok(rejected.errors.some((error) => error.includes("valid XML tag name")));
  assert.ok(rejected.errors.some((error) => error.includes("not declared for Devvit HTTP Fetch")));
  assert.ok(rejected.errors.some((error) => error.includes("pollMinutes")));

  const legacy = structuredClone(raw);
  delete legacy.category;
  const migratedTarget = parseDiscoveryConfig({ version: 1, targets: [legacy] }, NOW);
  assert.equal(migratedTarget.config.targets[0]?.category, "other");

  const invalidCategory = structuredClone(raw);
  invalidCategory.category = "not-a-category";
  const rejectedCategory = parseDiscoveryConfig(
    { version: 1, targets: [invalidCategory] },
    NOW
  );
  assert.ok(rejectedCategory.errors.some((error) => error.includes("category is invalid")));
});
