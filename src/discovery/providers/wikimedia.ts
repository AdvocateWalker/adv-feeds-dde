import type {
  DiscoveryIdentityPatch,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderSearchResult,
  DiscoveryTarget,
} from "../types.js";
import {
  asString,
  isRecord,
  normalizeForMatch,
  sanitizeExternalText,
  uniqueStrings,
} from "../utils.js";
import { fetchJson } from "./common.js";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIMEDIA_HEADERS = {
  Accept: "application/json",
  "Api-User-Agent": "ADV Feeds Devvit app",
};

export const wikipediaProvider: DiscoveryProvider = {
  id: "wikipedia",
  type: "wikipedia",
  isApplicable: () => true,
  estimateCalls: () => 1,
  search: searchWikipedia,
};

export const wikidataProvider: DiscoveryProvider = {
  id: "wikidata",
  type: "wikidata",
  isApplicable: () => true,
  estimateCalls: () => 2,
  search: searchWikidata,
};

async function searchWikipedia(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const url = new URL(WIKIPEDIA_API);
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: target.name,
    gsrnamespace: "0",
    gsrlimit: "5",
    prop: "info|extracts|pageprops",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
    redirects: "1",
    origin: "*",
  }).toString();
  const value = await fetchJson(context.fetch, url.toString(), {
    headers: WIKIMEDIA_HEADERS,
  });
  const page = selectWikipediaPage(value, target);
  return {
    candidates: [],
    callsUsed: 1,
    identity: page ? wikipediaIdentity(page) : undefined,
  };
}

async function searchWikidata(
  target: DiscoveryTarget,
  context: DiscoveryProviderContext
): Promise<DiscoveryProviderSearchResult> {
  const searchUrl = new URL(WIKIDATA_API);
  searchUrl.search = new URLSearchParams({
    action: "wbsearchentities",
    search: target.name,
    language: "en",
    uselang: "en",
    type: "item",
    limit: "10",
    format: "json",
    origin: "*",
  }).toString();
  const searchValue = await fetchJson(context.fetch, searchUrl.toString(), {
    headers: WIKIMEDIA_HEADERS,
  });
  const entityId = selectWikidataEntityId(searchValue, target);
  if (!entityId) return { candidates: [], callsUsed: 1 };

  const entityUrl = new URL(WIKIDATA_API);
  entityUrl.search = new URLSearchParams({
    action: "wbgetentities",
    ids: entityId,
    props: "labels|aliases|descriptions|sitelinks",
    languages: "en",
    sitefilter: "enwiki",
    format: "json",
    formatversion: "2",
    origin: "*",
  }).toString();
  const entityValue = await fetchJson(context.fetch, entityUrl.toString(), {
    headers: WIKIMEDIA_HEADERS,
  });
  return {
    candidates: [],
    callsUsed: 2,
    identity: wikidataIdentity(entityValue, entityId, target),
  };
}

function selectWikipediaPage(
  value: unknown,
  target: DiscoveryTarget
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.query) || !Array.isArray(value.query.pages)) {
    return undefined;
  }
  const acceptedNames = identityNames(target);
  return value.query.pages.find(
    (page): page is Record<string, unknown> =>
      isRecord(page) && acceptedNames.has(normalizeForMatch(asString(page.title) ?? ""))
  );
}

function wikipediaIdentity(page: Record<string, unknown>): DiscoveryIdentityPatch | undefined {
  const title = cleanName(page.title);
  if (!title) return undefined;
  const pageProps = isRecord(page.pageprops) ? page.pageprops : undefined;
  const wikidataId = cleanEntityId(pageProps?.wikibase_item);
  const fullUrl = asString(page.fullurl);
  return {
    canonicalName: title,
    aliases: [title],
    description: cleanDescription(page.extract),
    wikipediaUrl: fullUrl?.startsWith("https://") ? fullUrl : wikipediaPageUrl(title),
    wikidataId,
  };
}

function selectWikidataEntityId(value: unknown, target: DiscoveryTarget): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.search)) return undefined;
  const acceptedNames = identityNames(target);
  for (const result of value.search) {
    if (!isRecord(result)) continue;
    const label = cleanName(result.label);
    const match = isRecord(result.match) ? cleanName(result.match.text) : undefined;
    if (!acceptedNames.has(normalizeForMatch(label ?? match ?? ""))) continue;
    const id = cleanEntityId(result.id);
    if (id) return id;
  }
  return undefined;
}

function wikidataIdentity(
  value: unknown,
  entityId: string,
  target: DiscoveryTarget
): DiscoveryIdentityPatch | undefined {
  if (!isRecord(value) || !isRecord(value.entities)) return undefined;
  const entity = value.entities[entityId];
  if (!isRecord(entity)) return undefined;
  const labels = isRecord(entity.labels) ? entity.labels : undefined;
  const englishLabel = isRecord(labels?.en) ? cleanName(labels.en.value) : undefined;
  const aliases = isRecord(entity.aliases) && Array.isArray(entity.aliases.en)
    ? entity.aliases.en
        .map((alias) => isRecord(alias) ? cleanName(alias.value) : undefined)
        .filter((alias): alias is string => Boolean(alias))
    : [];
  const sitelinks = isRecord(entity.sitelinks) ? entity.sitelinks : undefined;
  const enwiki = isRecord(sitelinks?.enwiki) ? sitelinks.enwiki : undefined;
  const wikipediaTitle = cleanName(enwiki?.title);
  const descriptions = isRecord(entity.descriptions) ? entity.descriptions : undefined;
  const description = isRecord(descriptions?.en)
    ? cleanDescription(descriptions.en.value)
    : undefined;
  const safeAliases = aliases.filter((alias) => isSafeDerivedAlias(alias, target));
  const names = uniqueStrings(
    [englishLabel, wikipediaTitle, ...safeAliases].filter((name): name is string => Boolean(name)),
    25
  );
  if (!englishLabel || names.length === 0) return undefined;
  return {
    canonicalName: englishLabel,
    aliases: names,
    description,
    wikipediaUrl: wikipediaTitle ? wikipediaPageUrl(wikipediaTitle) : undefined,
    wikidataId: entityId,
  };
}

function isSafeDerivedAlias(alias: string, target: DiscoveryTarget): boolean {
  const normalized = normalizeForMatch(alias);
  if (normalized.length < 3 || /^\d+$/.test(normalized)) return false;
  if (identityNames(target).has(normalized)) return true;
  const targetWordCount = normalizeForMatch(target.name).split(" ").filter(Boolean).length;
  return targetWordCount <= 1 || normalized.split(" ").filter(Boolean).length >= 2;
}

function identityNames(target: DiscoveryTarget): Set<string> {
  return new Set(
    [target.name, ...target.aliases]
      .map(normalizeForMatch)
      .filter(Boolean)
  );
}

function cleanName(value: unknown): string | undefined {
  const text = sanitizeExternalText(value, 200);
  return text || undefined;
}

function cleanDescription(value: unknown): string | undefined {
  const text = sanitizeExternalText(value, 1000);
  return text || undefined;
}

function cleanEntityId(value: unknown): string | undefined {
  const text = asString(value)?.trim().toUpperCase();
  return text && /^Q[1-9][0-9]*$/.test(text) ? text : undefined;
}

function wikipediaPageUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
