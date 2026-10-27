export interface ParsedFeedItem {
  id: string;
  title: string;
  link?: string;
  summary?: string;
  published?: string;
}

export interface HtmlParseOptions {
  itemLinkPattern?: string;
  itemTitlePattern?: string;
  minTitleLength: number;
  sameHostOnly: boolean;
  stripUrlQuery: boolean;
  maxAnchorsToScan: number;
}

export function looksLikeFeedDocument(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:rdf");
}

export function parseFeedDocument(xml: string): ParsedFeedItem[] {
  const atom = /<feed\b/i.test(xml) && /<entry\b/i.test(xml);
  const rawItems = atom ? parseAtom(xml) : parseRss(xml);
  const deduped = new Map<string, ParsedFeedItem>();
  for (const item of rawItems) {
    const key = item.id || item.link || item.title;
    if (key && !deduped.has(key)) deduped.set(key, item);
  }
  return Array.from(deduped.values());
}

export function parseHtmlDocument(
  html: string,
  pageUrl: string,
  options: HtmlParseOptions
): ParsedFeedItem[] {
  const linkRegex = options.itemLinkPattern ? safeRegex(options.itemLinkPattern, "i") : undefined;
  const titleRegex = options.itemTitlePattern ? safeRegex(options.itemTitlePattern, "i") : undefined;
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const baseUrl = new URL(pageUrl);
  const seen = new Set<string>();
  const items: ParsedFeedItem[] = [];
  let scanned = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    scanned += 1;
    if (scanned > options.maxAnchorsToScan) break;
    const href = match[1]?.trim();
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let absolute: URL;
    try { absolute = new URL(href, baseUrl); } catch { continue; }
    if (absolute.protocol !== "https:") continue;
    if (options.sameHostOnly && absolute.hostname !== baseUrl.hostname) continue;
    absolute.hash = "";
    if (options.stripUrlQuery) absolute.search = "";
    const link = absolute.toString();
    if (linkRegex && !linkRegex.test(link)) continue;
    const title = cleanFeedText(match[2] ?? "");
    if (title.length < options.minTitleLength || isLikelyNavigation(title)) continue;
    if (titleRegex && !titleRegex.test(title)) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    items.push({
      id: link,
      title,
      link,
      published: extractNearbyPublished(html, match.index),
    });
  }
  return items;
}

function parseRss(xml: string): ParsedFeedItem[] {
  return extractBlocks(xml, "item").map((block) => {
    const title = cleanFeedText(firstTag(block, ["title"]) ?? "") || "Untitled feed item";
    const link = cleanFeedText(firstTag(block, ["link"]) ?? "");
    const guid = cleanFeedText(firstTag(block, ["guid"]) ?? "");
    const summary = cleanFeedText(firstTag(block, ["description", "content:encoded"]) ?? "");
    const published = cleanFeedText(firstTag(block, ["pubDate", "dc:date"]) ?? "");
    return {
      id: guid || link || `${title}:${published || "unknown"}`,
      title,
      link: link || undefined,
      summary: summary || undefined,
      published: published || undefined,
    };
  });
}

function parseAtom(xml: string): ParsedFeedItem[] {
  return extractBlocks(xml, "entry").map((block) => {
    const title = cleanFeedText(firstTag(block, ["title"]) ?? "") || "Untitled feed item";
    const id = cleanFeedText(firstTag(block, ["id"]) ?? "");
    const link = cleanFeedText(atomLink(block) ?? "");
    const summary = cleanFeedText(firstTag(block, ["summary", "content"]) ?? "");
    const published = cleanFeedText(firstTag(block, ["updated", "published"]) ?? "");
    return {
      id: id || link || `${title}:${published || "unknown"}`,
      title,
      link: link || undefined,
      summary: summary || undefined,
      published: published || undefined,
    };
  });
}

function atomLink(block: string): string | undefined {
  return (
    /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i.exec(block)?.[1] ??
    /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i.exec(block)?.[1] ??
    firstTag(block, ["link"])
  );
}

function extractBlocks(xml: string, tag: string): string[] {
  const expression = new RegExp(`<${escapeRegex(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "gi");
  return Array.from(xml.matchAll(expression), (match) => match[1]).filter((item): item is string => Boolean(item));
}

function firstTag(block: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const expression = new RegExp(`<${escapeRegex(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "i");
    const value = expression.exec(block)?.[1];
    if (value) return value;
  }
  return undefined;
}

export function cleanFeedText(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  let output = value;
  for (const [entity, replacement] of Object.entries(named)) {
    output = output.split(entity).join(replacement);
  }
  output = output.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)));
  output = output.replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)));
  return output;
}

function safeCodePoint(value: number): string {
  try { return String.fromCodePoint(value); } catch { return ""; }
}

function isLikelyNavigation(value: string): boolean {
  return new Set([
    "apply", "close all", "open all", "read more", "learn more", "subscribe",
    "back to top", "press releases", "featured news", "all news",
  ]).has(value.toLowerCase());
}

function extractNearbyPublished(html: string, index: number): string | undefined {
  const around = cleanFeedText(html.slice(Math.max(0, index - 240), Math.min(html.length, index + 140)));
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b/i.exec(around)?.[0];
}

function safeRegex(pattern: string, flags: string): RegExp {
  try { return new RegExp(pattern, flags); } catch { return /^$/; }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

