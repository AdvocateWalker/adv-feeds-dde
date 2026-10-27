import type {
  DiscoveryExistingFeedSource,
  DiscoveryTarget,
} from "./types.js";

export function withExistingFeedSources(
  target: DiscoveryTarget,
  sources: DiscoveryExistingFeedSource[] = []
): DiscoveryTarget {
  const combined = [...(target.sources.existingFeeds ?? []), ...sources];
  const unique = Array.from(
    new Map(combined.map((source) => [`${source.id}:${source.url}`, source])).values()
  );
  if (unique.length === 0 && !target.sources.existingFeeds) return target;
  return {
    ...target,
    sources: {
      ...target.sources,
      existingFeeds: unique,
    },
  };
}
