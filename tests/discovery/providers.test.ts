import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_PROVIDER_ORDER,
  discoveryProviders,
} from "../../src/discovery/providers/index.js";
import {
  enrichDiscoveryCandidates,
  isApprovedEnrichmentUrl,
} from "../../src/discovery/enrichment.js";
import {
  AUTOMATIC_PUBLIC_FEED_SOURCES,
  DEVVIT_HTTP_DOMAINS,
  isDeclaredHttpsFetchUrl,
} from "../../src/shared/http-sources.js";
import type { DiscoveryProviderContext } from "../../src/discovery/types.js";
import { candidate, NOW, target } from "./fixtures.js";

function response(value: unknown, contentType = "application/json"): Response {
  return new Response(
    typeof value === "string" ? value : JSON.stringify(value),
    { status: 200, headers: { "content-type": contentType } }
  );
}

function listing<T>(items: T[]): { all: () => Promise<T[]> } {
  return { all: async () => items };
}

const redditPost = {
  id: "t3_source",
  title: "Zohran Mamdani announces housing plan",
  body: "New housing details",
  url: "https://news.example.com/mamdani-plan?utm_source=reddit",
  permalink: "/r/NYCPolitics/comments/source/story/",
  subredditName: "NYCPolitics",
  authorName: "reporter",
  createdAt: new Date(NOW - 60_000),
  nsfw: false,
};

function providerContext(fetchFn: typeof fetch): DiscoveryProviderContext {
  const reddit = {
    searchPosts: () => listing([redditPost]),
    getNewPosts: () => listing([redditPost]),
    getHotPosts: () => listing([redditPost]),
    getRisingPosts: () => listing([redditPost]),
    getTopPosts: () => listing([redditPost]),
    getPostsByUser: () => listing([redditPost]),
    getCommentsByUser: () => listing([]),
  };
  return {
    reddit: reddit as any,
    fetch: fetchFn,
    now: NOW,
    providerState: { nextPollAt: 0 },
    maxResults: 10,
    subredditName: "InstalledSub",
  };
}

test("the central registry contains every production provider", () => {
  assert.deepEqual(Object.keys(discoveryProviders), DISCOVERY_PROVIDER_ORDER);
  assert.equal(DISCOVERY_PROVIDER_ORDER.length, 11);
});

test("automatic public feeds use unique HTTPS hosts declared for Devvit HTTP Fetch", () => {
  assert.equal(new Set(DEVVIT_HTTP_DOMAINS).size, DEVVIT_HTTP_DOMAINS.length);
  assert.equal(
    new Set(AUTOMATIC_PUBLIC_FEED_SOURCES.map((source) => source.id)).size,
    AUTOMATIC_PUBLIC_FEED_SOURCES.length
  );
  for (const source of AUTOMATIC_PUBLIC_FEED_SOURCES) {
    assert.equal(isDeclaredHttpsFetchUrl(source.url), true, source.url);
  }
});

test("Wikipedia and Wikidata bootstrap identity without credentials", async () => {
  const requestedActions: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const action = url.searchParams.get("action") ?? "";
    requestedActions.push(action);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(url.searchParams.has("key"), false);
    if (url.hostname === "en.wikipedia.org") {
      return response({
        query: {
          pages: [
            {
              pageid: 2,
              title: "Mahmood Mamdani",
              fullurl: "https://en.wikipedia.org/wiki/Mahmood_Mamdani",
              pageprops: { wikibase_item: "Q723502" },
            },
            {
              pageid: 1,
              title: "Zohran Mamdani",
              fullurl: "https://en.wikipedia.org/wiki/Zohran_Mamdani",
              extract: "American politician",
              pageprops: { wikibase_item: "Q28034971" },
            },
          ],
        },
      });
    }
    if (action === "wbsearchentities") {
      return response({
        search: [
          { id: "Q723502", label: "Mahmood Mamdani" },
          {
            id: "Q28034971",
            label: "Zohran Mamdani",
            match: { type: "label", language: "en", text: "Zohran Mamdani" },
          },
        ],
      });
    }
    return response({
      entities: {
        Q28034971: {
          labels: { en: { language: "en", value: "Zohran Mamdani" } },
          aliases: { en: [
            { language: "en", value: "Zohran Kwame Mamdani" },
            { language: "en", value: "ZM" },
          ] },
          descriptions: { en: { language: "en", value: "American politician" } },
          sitelinks: { enwiki: { site: "enwiki", title: "Zohran Mamdani" } },
        },
      },
    });
  }) as typeof fetch;
  const value = target({ aliases: [], query: { ...target().query, additionalQueries: [] } });
  const wikipedia = await discoveryProviders.wikipedia.search(value, providerContext(fetchFn));
  const wikidata = await discoveryProviders.wikidata.search(value, providerContext(fetchFn));
  assert.equal(wikipedia.identity?.wikidataId, "Q28034971");
  assert.equal(wikipedia.identity?.wikipediaUrl, "https://en.wikipedia.org/wiki/Zohran_Mamdani");
  assert.deepEqual(wikidata.identity?.aliases, ["Zohran Mamdani", "Zohran Kwame Mamdani"]);
  assert.deepEqual(requestedActions, ["query", "wbsearchentities", "wbgetentities"]);
});

test("Reddit search, listing, and configured-user adapters normalize native posts", async () => {
  const fetchFn = (async () => response({})) as typeof fetch;
  const value = target({ aliases: [], query: { ...target().query, additionalQueries: [] } });
  for (const type of ["reddit-search", "reddit-listing", "reddit-user"] as const) {
    const result = await discoveryProviders[type].search(value, providerContext(fetchFn));
    assert.ok(result.candidates.length >= 1, type);
    assert.equal(result.candidates[0].redditPostId, "t3_source");
    assert.equal(result.candidates[0].provider, type);
    assert.equal(
      result.candidates[0].url,
      "https://news.example.com/mamdani-plan?utm_source=reddit"
    );
    assert.equal(result.candidates[0].canonicalUrl, "https://news.example.com/mamdani-plan");
  }
});

test("Reddit native search covers all of Reddit plus configured source subreddits", async () => {
  const scopes: Array<string | undefined> = [];
  const context = providerContext((async () => response({})) as typeof fetch);
  (context.reddit as any).searchPosts = (options: { subredditName?: string }) => {
    scopes.push(options.subredditName);
    return listing([]);
  };
  const base = target();
  const value = target({
    aliases: [],
    reddit: {
      ...base.reddit,
      sourceSubreddits: ["NYCPolitics"],
    },
    query: { ...base.query, additionalQueries: [] },
  });

  await discoveryProviders["reddit-search"].search(value, context);

  assert.ok(scopes.includes(undefined), "expected an unrestricted Reddit search");
  assert.ok(scopes.includes("nycpolitics"), "expected a configured subreddit search");
  assert.ok(!scopes.includes("InstalledSub"), "destination subreddit should not replace global search");
});

test("RSS and Atom adapters parse fixtures without live sites", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><guid>rss-1</guid><title>Zohran Mamdani RSS update</title><link>https://feed.example/rss-story</link><description>Housing</description><pubDate>${new Date(NOW).toUTCString()}</pubDate></item></channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-1</id><title>Zohran Mamdani Atom update</title><link href="https://feed.example/atom-story"/><summary>Housing</summary><updated>${new Date(NOW).toISOString()}</updated></entry></feed>`;
  const fetchFn = (async (input: string | URL | Request) =>
    response(String(input).includes("atom") ? atom : rss, "application/xml")) as typeof fetch;
  const value = target({
    sources: {
      feeds: [
        { url: "https://feed.example/rss.xml", sourceType: "rss" },
        { url: "https://feed.example/atom.xml", sourceType: "atom" },
      ],
      html: [],
      customJson: [],
      customXml: [],
    },
  });
  const rssResult = await discoveryProviders.rss.search(value, providerContext(fetchFn));
  const atomResult = await discoveryProviders.atom.search(value, providerContext(fetchFn));
  assert.equal(rssResult.candidates[0].provider, "rss");
  assert.equal(atomResult.candidates[0].provider, "atom");
});

test("HTML, custom JSON, and custom XML adapters normalize configured public sources", async () => {
  const html = `<html><body><a href="/zohran-mamdani-housing-plan">Zohran Mamdani releases a detailed housing plan today</a></body></html>`;
  const json = { data: [{ headline: "Zohran Mamdani JSON update", link: "https://api.example/mamdani", summary: "Housing", date: new Date(NOW).toISOString() }] };
  const xml = `<response><result><key>xml-1</key><headline>Zohran Mamdani XML update</headline><link>/mamdani-xml</link><summary>Housing</summary><date>${new Date(NOW).toISOString()}</date></result></response>`;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("page")) return response(html, "text/html");
    if (url.includes("items.xml")) return response(xml, "application/xml");
    return response(json);
  }) as typeof fetch;
  const value = target({
    sources: {
      feeds: [],
      html: [{ url: "https://html.example/page" }],
      customJson: [{
        id: "fixture-api",
        url: "https://api.example/items",
        itemsPath: "data",
        titleField: "headline",
        urlField: "link",
        descriptionField: "summary",
        publishedAtField: "date",
      }],
      customXml: [{
        id: "fixture-xml",
        url: "https://xml.example/items.xml",
        itemTag: "result",
        idTag: "key",
        titleTag: "headline",
        urlTag: "link",
        descriptionTag: "summary",
        publishedAtTag: "date",
      }],
    },
  });
  const htmlResult = await discoveryProviders.html.search(value, providerContext(fetchFn));
  const jsonResult = await discoveryProviders["custom-json"].search(value, providerContext(fetchFn));
  const xmlResult = await discoveryProviders["custom-xml"].search(value, providerContext(fetchFn));
  assert.equal(htmlResult.candidates.length, 1);
  assert.equal(htmlResult.candidates[0].provider, "html");
  assert.equal(jsonResult.candidates.length, 1);
  assert.equal(jsonResult.candidates[0].sourceName, "fixture-api");
  assert.equal(xmlResult.candidates.length, 1);
  assert.equal(xmlResult.candidates[0].provider, "custom-xml");
  assert.equal(xmlResult.candidates[0].url, "https://xml.example/mamdani-xml");
});

test("existing ADV Feeds sources are auto-detected and searched for every target", async () => {
  const rss = `<rss><channel><item><guid>existing-rss</guid><title>Zohran Mamdani existing RSS update</title><link>https://legacy.example/rss-story</link></item></channel></rss>`;
  const html = `<html><body><a href="/html-story">Zohran Mamdani existing HTML source update</a></body></html>`;
  const fetchFn = (async (input: string | URL | Request) =>
    response(String(input).includes("rss") ? rss : html, String(input).includes("rss") ? "application/rss+xml" : "text/html")) as typeof fetch;
  const value = target({
    sources: {
      feeds: [],
      html: [],
      customJson: [],
      customXml: [],
      existingFeeds: [
        { id: "legacy-rss", url: "https://legacy.example/rss", sourceType: "auto" },
        { id: "legacy-html", url: "https://legacy.example/page", sourceType: "auto" },
      ],
    },
  });
  const result = await discoveryProviders["adv-feed"].search(value, providerContext(fetchFn));
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((item) => item.provider === "adv-feed"));
});

test("a malformed feed fails independently from a valid configured feed", async () => {
  const valid = `<rss><channel><item><guid>ok</guid><title>Zohran Mamdani valid feed item</title><link>https://feed.example/ok</link></item></channel></rss>`;
  const fetchFn = (async (input: string | URL | Request) => {
    if (String(input).includes("broken")) return new Response("failed", { status: 503 });
    return response(valid, "application/rss+xml");
  }) as typeof fetch;
  const value = target({
    sources: {
      feeds: [
        { url: "https://feed.example/broken.xml", sourceType: "rss" },
        { url: "https://feed.example/valid.xml", sourceType: "rss" },
      ],
      html: [],
      customJson: [],
      customXml: [],
    },
  });
  const result = await discoveryProviders.rss.search(value, providerContext(fetchFn));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.errors?.length, 1);
});

test("direct-origin enrichment only fetches configured hosts and preserves metadata on failure", async () => {
  const value = target({
    sources: {
      feeds: [],
      html: [{ url: "https://approved.example/index" }],
      customJson: [],
      customXml: [],
    },
  });
  assert.equal(isApprovedEnrichmentUrl("https://approved.example/story", value), true);
  assert.equal(isApprovedEnrichmentUrl("https://news.approved.example/story", value), false);
  assert.equal(isApprovedEnrichmentUrl("https://unapproved.example/story", value), false);
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return response(
      `<html><head><meta property="og:description" content="Enriched summary"><meta property="article:published_time" content="${new Date(NOW).toISOString()}"><meta name="author" content="Example Reporter"></head></html>`,
      "text/html"
    );
  }) as typeof fetch;
  const approved = candidate({
    url: "https://approved.example/story",
    canonicalUrl: "https://approved.example/story",
    sourceDomain: "approved.example",
    description: undefined,
    publishedAt: undefined,
    author: undefined,
  });
  const unapproved = candidate({
    candidateId: "unapproved",
    url: "https://unapproved.example/story",
    canonicalUrl: "https://unapproved.example/story",
    sourceDomain: "unapproved.example",
    description: undefined,
    publishedAt: undefined,
  });
  const enriched = await enrichDiscoveryCandidates([approved, unapproved], value, fetchFn);
  assert.equal(calls, 1);
  assert.equal(enriched[0].description, "Enriched summary");
  assert.equal(enriched[0].author, "Example Reporter");
  assert.equal(enriched[0].publishedAt, NOW);
  assert.equal(enriched[1].description, undefined);
});
