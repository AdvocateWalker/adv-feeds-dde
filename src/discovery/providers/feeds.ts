import {
  cleanFeedText,
  looksLikeFeedDocument,
  parseFeedDocument,
  parseHtmlDocument,
} from "../../shared/content-parsing.js";
import type {
  DiscoveryCandidate,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderSearchResult,
  DiscoveryProviderType,
  DiscoveryTarget,
} from "../types.js";
import { asString, isRecord, pathValue, safeDateMs, toErrorMessage } from "../utils.js";
import {
  createDiscoveryCandidate,
  fetchJson,
  fetchText,
  mergeCandidates,
} from "./common.js";
import { takeRotatingBatch } from "./batching.js";

const CONFIGURED_SOURCES_PER_POLL = 10;

export const rssProvider: DiscoveryProvider = {
  id: "rss",
  type: "rss",
  isApplicable: (target) => target.sources.feeds.some((source) => source.sourceType !== "atom"),
  estimateCalls: (target) => Math.min(
    CONFIGURED_SOURCES_PER_POLL,
    target.sources.feeds.filter((source) => source.sourceType !== "atom").length
  ),
  search: (target, context) => searchFeeds(target, context, "rss"),
};

export const atomProvider: DiscoveryProvider = {
  id: "atom",
  type: "atom",
  isApplicable: (target) => target.sources.feeds.some((source) => source.sourceType === "atom"),
  estimateCalls: (target) => Math.min(
    CONFIGURED_SOURCES_PER_POLL,
    target.sources.feeds.filter((source) => source.sourceType === "atom").length
  ),
  search: (target, context) => searchFeeds(target, context, "atom"),
};

export const htmlProvider: DiscoveryProvider = {
  id: "html",
  type: "html",
  isApplicable: (target) => target.sources.html.length > 0,
  estimateCalls: (target) => Math.min(CONFIGURED_SOURCES_PER_POLL, target.sources.html.length),
  search: searchHtml,
};

export const customJsonProvider: DiscoveryProvider = {
  id: "custom-json",
  type: "custom-json",
  isApplicable: (target) => target.sources.customJson.length > 0,
  estimateCalls: (target) => Math.min(CONFIGURED_SOURCES_PER_POLL, target.sources.customJson.length),
  search: searchCustomJson,
};

export const customXmlProvider: DiscoveryProvider = {
  id: "custom-xml",
  type: "custom-xml",
  isApplicable: (target) => target.sources.customXml.length > 0,
  estimateCalls: (target) => Math.min(CONFIGURED_SOURCES_PER_POLL, target.sources.customXml.length),
  search: searchCustomXml,
};

export const existingAdvFeedProvider: DiscoveryProvider = {
  id: "adv-feed",
  type: "adv-feed",
  isApplicable: (target) => (target.sources.existingFeeds?.length ?? 0) > 0,
  estimateCalls: (target) => Math.min(
    CONFIGURED_SOURCES_PER_POLL,
    target.sources.existingFeeds?.length ?? 0
  ),
  search: searchExistingAdvFeeds,
};

async function searchFeeds(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext,
  requestedType: "rss" | "atom"
): Promise<DiscoveryProviderSearchResult> {
  const batch = takeRotatingBatch(
    target.sources.feeds.filter((source) =>
      requestedType === "atom" ? source.sourceType === "atom" : source.sourceType !== "atom"
    ),
    context.providerState.lastCursor,
    CONFIGURED_SOURCES_PER_POLL
  );
  const candidates: DiscoveryCandidate[] = [];
  const errors: string[] = [];
  let callsUsed = 0;
  for (const source of batch.values) {
    try {
      const response = await fetchText(context.fetch, source.url, {
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      });
      callsUsed += 1;
      if (response.text.length > 5_000_000) throw new Error("Feed response exceeded 5 MB.");
      if (!looksLikeFeedDocument(response.text)) throw new Error("Response is not RSS or Atom.");
      const actualType: DiscoveryProviderType = /<feed\b/i.test(response.text) ? "atom" : "rss";
      for (const item of parseFeedDocument(response.text).slice(0, context.maxResults)) {
        const candidate = createDiscoveryCandidate({
          provider: actualType,
          providerItemId: item.id,
          targetId: target.id,
          title: item.title,
          url: item.link ?? source.url,
          description: item.summary,
          sourceName: new URL(source.url).hostname,
          publishedAt: item.published,
          discoveredAt: context.now,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${source.url}: ${toErrorMessage(error)}`);
    }
  }
  return finalize(candidates, callsUsed, context.maxResults, errors, batch.nextCursor);
}

async function searchHtml(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  const errors: string[] = [];
  let callsUsed = 0;
  const batch = takeRotatingBatch(
    target.sources.html,
    context.providerState.lastCursor,
    CONFIGURED_SOURCES_PER_POLL
  );
  for (const source of batch.values) {
    try {
      const response = await fetchText(context.fetch, source.url, {
        headers: { Accept: "text/html, application/xhtml+xml" },
      });
      callsUsed += 1;
      if (response.text.length > 5_000_000) throw new Error("HTML response exceeded 5 MB.");
      for (const item of parseHtmlDocument(response.text, source.url, {
        itemLinkPattern: source.itemLinkPattern,
        itemTitlePattern: source.itemTitlePattern,
        minTitleLength: source.minTitleLength ?? 25,
        sameHostOnly: source.sameHostOnly ?? true,
        stripUrlQuery: source.stripUrlQuery ?? true,
        maxAnchorsToScan: source.maxAnchorsToScan ?? 4000,
      }).slice(0, context.maxResults)) {
        const candidate = createDiscoveryCandidate({
          provider: "html",
          providerItemId: item.id,
          targetId: target.id,
          title: item.title,
          url: item.link ?? source.url,
          publishedAt: item.published,
          sourceName: new URL(source.url).hostname,
          discoveredAt: context.now,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${source.url}: ${toErrorMessage(error)}`);
    }
  }
  return finalize(candidates, callsUsed, context.maxResults, errors, batch.nextCursor);
}

async function searchCustomJson(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  const errors: string[] = [];
  let callsUsed = 0;
  const batch = takeRotatingBatch(
    target.sources.customJson,
    context.providerState.lastCursor,
    CONFIGURED_SOURCES_PER_POLL
  );
  for (const source of batch.values) {
    try {
      const response = await fetchJson(context.fetch, source.url, {
        headers: { Accept: "application/json" },
      });
      callsUsed += 1;
      const resolved = pathValue(response, source.itemsPath ?? "");
      const items = Array.isArray(resolved)
        ? resolved
        : isRecord(resolved) && Array.isArray(resolved.items)
          ? resolved.items
          : [];
      for (const item of items.slice(0, context.maxResults)) {
        if (!isRecord(item)) continue;
        const itemUrl = pathValue(item, source.urlField ?? "url");
        const candidate = createDiscoveryCandidate({
          provider: "custom-json",
          providerItemId: asString(item.id) ?? asString(itemUrl),
          targetId: target.id,
          title: pathValue(item, source.titleField ?? "title"),
          url: itemUrl,
          description: pathValue(item, source.descriptionField ?? "description"),
          publishedAt: pathValue(item, source.publishedAtField ?? "publishedAt"),
          author: pathValue(item, source.authorField ?? "author"),
          sourceName: pathValue(item, source.sourceNameField ?? "source") ?? source.id,
          thumbnailUrl: pathValue(item, source.thumbnailField ?? "thumbnailUrl"),
          discoveredAt: context.now,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${source.id}: ${toErrorMessage(error)}`);
    }
  }
  return finalize(candidates, callsUsed, context.maxResults, errors, batch.nextCursor);
}

async function searchCustomXml(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  const errors: string[] = [];
  let callsUsed = 0;
  const batch = takeRotatingBatch(
    target.sources.customXml,
    context.providerState.lastCursor,
    CONFIGURED_SOURCES_PER_POLL
  );
  for (const source of batch.values) {
    try {
      const response = await fetchText(context.fetch, source.url, {
        headers: { Accept: "application/xml, text/xml" },
      });
      callsUsed += 1;
      if (!/^\s*(?:<\?xml\b[^>]*>\s*)?</i.test(response.text)) {
        throw new Error("Response is not XML.");
      }
      const blocks = extractXmlBlocks(response.text, source.itemTag ?? "item");
      for (const block of blocks.slice(0, context.maxResults)) {
        const rawUrl = xmlTagText(block, source.urlTag ?? "url");
        const url = resolveHttpsUrl(rawUrl, source.url);
        const thumbnail = resolveHttpsUrl(
          xmlTagText(block, source.thumbnailTag ?? "thumbnailUrl"),
          source.url
        );
        const candidate = createDiscoveryCandidate({
          provider: "custom-xml",
          providerItemId: xmlTagText(block, source.idTag ?? "id") ?? url,
          targetId: target.id,
          title: xmlTagText(block, source.titleTag ?? "title"),
          url,
          description: xmlTagText(block, source.descriptionTag ?? "description"),
          publishedAt: xmlTagText(block, source.publishedAtTag ?? "publishedAt"),
          author: xmlTagText(block, source.authorTag ?? "author"),
          sourceName: xmlTagText(block, source.sourceNameTag ?? "source") ?? source.id,
          thumbnailUrl: thumbnail,
          discoveredAt: context.now,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${source.id}: ${toErrorMessage(error)}`);
    }
  }
  return finalize(candidates, callsUsed, context.maxResults, errors, batch.nextCursor);
}

async function searchExistingAdvFeeds(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const candidates: DiscoveryCandidate[] = [];
  const errors: string[] = [];
  let callsUsed = 0;
  const batch = takeRotatingBatch(
    target.sources.existingFeeds ?? [],
    context.providerState.lastCursor,
    CONFIGURED_SOURCES_PER_POLL
  );
  for (const source of batch.values) {
    try {
      const response = await fetchText(context.fetch, source.url, {
        headers: {
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html",
        },
      });
      callsUsed += 1;
      const feedDocument = looksLikeFeedDocument(response.text);
      if (source.sourceType === "feed" && !feedDocument) {
        throw new Error("Configured ADV feed source is not RSS or Atom.");
      }
      if (source.sourceType === "feed" || (source.sourceType === "auto" && feedDocument)) {
        const items = parseFeedDocument(response.text).slice(0, context.maxResults);
        if (items.length === 0) throw new Error("ADV feed source has no parseable items.");
        for (const item of items) {
          const candidate = createDiscoveryCandidate({
            provider: "adv-feed",
            providerItemId: item.id,
            targetId: target.id,
            title: item.title,
            url: item.link ?? source.url,
            description: item.summary,
            sourceName: new URL(source.url).hostname,
            publishedAt: item.published,
            discoveredAt: context.now,
          });
          if (candidate) candidates.push(candidate);
        }
        continue;
      }
      const options = source.htmlOptions;
      const items = parseHtmlDocument(response.text, source.url, {
        itemLinkPattern: options?.itemLinkPattern,
        itemTitlePattern: options?.itemTitlePattern,
        minTitleLength: options?.minTitleLength ?? 25,
        sameHostOnly: options?.sameHostOnly ?? true,
        stripUrlQuery: options?.stripUrlQuery ?? true,
        maxAnchorsToScan: options?.maxAnchorsToScan ?? 4000,
      }).slice(0, context.maxResults);
      if (items.length === 0) throw new Error("ADV HTML source has no parseable items.");
      for (const item of items) {
        const candidate = createDiscoveryCandidate({
          provider: "adv-feed",
          providerItemId: item.id,
          targetId: target.id,
          title: item.title,
          url: item.link ?? source.url,
          publishedAt: item.published,
          sourceName: new URL(source.url).hostname,
          discoveredAt: context.now,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${source.id}: ${toErrorMessage(error)}`);
    }
  }
  return finalize(candidates, callsUsed, context.maxResults, errors, batch.nextCursor);
}

function extractXmlBlocks(xml: string, tag: string): string[] {
  const escaped = escapeXmlTag(tag);
  const expression = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  return Array.from(xml.matchAll(expression), (match) => match[1] ?? "");
}

function xmlTagText(block: string, tag: string): string | undefined {
  const escaped = escapeXmlTag(tag);
  const value = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i")
    .exec(block)?.[1];
  const text = value === undefined ? "" : cleanFeedText(value);
  return text || undefined;
}

function escapeXmlTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveHttpsUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function finalize(
  candidates: DiscoveryCandidate[],
  callsUsed: number,
  maximum: number,
  errors: string[],
  lastCursor?: string
): DiscoveryProviderSearchResult {
  const merged = mergeCandidates(candidates).slice(0, maximum);
  const dates = merged.map((candidate) => candidate.publishedAt).filter((value): value is number => value !== undefined);
  return {
    candidates: merged,
    callsUsed,
    lastCursor,
    errors: errors.length ? errors : undefined,
    lastSeenPublishedAt: dates.length ? Math.max(...dates) : undefined,
  };
}
