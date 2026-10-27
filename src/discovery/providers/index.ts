import type { DiscoveryProvider, DiscoveryProviderType } from "../types.js";
import {
  atomProvider,
  customJsonProvider,
  customXmlProvider,
  existingAdvFeedProvider,
  htmlProvider,
  rssProvider,
} from "./feeds.js";
import { redditListingProvider, redditSearchProvider, redditUserProvider } from "./reddit.js";
import { wikidataProvider, wikipediaProvider } from "./wikimedia.js";

export const discoveryProviders: Record<DiscoveryProviderType, DiscoveryProvider> = {
  wikipedia: wikipediaProvider,
  wikidata: wikidataProvider,
  "reddit-search": redditSearchProvider,
  "reddit-listing": redditListingProvider,
  "reddit-user": redditUserProvider,
  rss: rssProvider,
  atom: atomProvider,
  html: htmlProvider,
  "custom-json": customJsonProvider,
  "custom-xml": customXmlProvider,
  "adv-feed": existingAdvFeedProvider,
};

export const DISCOVERY_PROVIDER_ORDER: DiscoveryProviderType[] = [
  "wikipedia",
  "wikidata",
  "reddit-search",
  "reddit-listing",
  "reddit-user",
  "rss",
  "atom",
  "html",
  "custom-json",
  "custom-xml",
  "adv-feed",
];
