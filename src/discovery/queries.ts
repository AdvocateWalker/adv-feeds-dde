import type { DiscoveryTarget, DiscoveryTargetCategory } from "./types.js";
import { normalizeWhitespace } from "./utils.js";

export function buildQueries(target: DiscoveryTarget): string[] {
  const base = [target.name, ...target.aliases]
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean)
    .map((value) => `"${value.replace(/"/g, "\\\"")}"`);
  const categoryQueries = categoryQueryTerms(target.category).map(
    (term) => `"${normalizeWhitespace(target.name).replace(/"/g, "\\\"")}" ${term}`
  );
  return Array.from(
    new Set(
      [...base, ...categoryQueries, ...target.query.additionalQueries]
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean)
    )
  );
}

function categoryQueryTerms(category: DiscoveryTargetCategory): string[] {
  switch (category) {
    case "news":
      return ["news"];
    case "breaking-news":
      return ["breaking news", "developing"];
    case "food":
      return ["food"];
    case "entertainment":
      return ["entertainment"];
    case "sports":
      return ["sports"];
    case "politics":
      return ["politics"];
    case "technology":
      return ["technology"];
    case "science":
      return ["science"];
    case "business":
      return ["business"];
    default:
      return [];
  }
}
