import { DEFAULT_DISCOVERY_STOP_WORDS, DISCOVERY_SIMILARITY } from "./constants.js";
import { normalizeForMatch } from "./utils.js";

export interface TitleFeatures {
  normalized: string;
  tokens: Set<string>;
  bigrams: Set<string>;
}

export function buildTitleFeatures(
  title: string,
  targetNames: string[] = [],
  extraStopWords: string[] = []
): TitleFeatures {
  let normalized = normalizeForMatch(title);
  for (const name of [...targetNames].sort((a, b) => b.length - a.length)) {
    const normalizedName = normalizeForMatch(name);
    if (normalizedName) normalized = normalized.split(normalizedName).join(" ");
  }
  const stopWords = new Set(
    [...DEFAULT_DISCOVERY_STOP_WORDS, ...extraStopWords]
      .flatMap((value) => normalizeForMatch(value).split(" "))
      .filter(Boolean)
      .map(stemToken)
  );
  const tokenList = normalized
    .split(" ")
    .map(stemToken)
    .filter((token) => token.length > 1 && !stopWords.has(token));
  const tokens = new Set(tokenList);
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < tokenList.length; index += 1) {
    bigrams.add(`${tokenList[index]} ${tokenList[index + 1]}`);
  }
  return { normalized: tokenList.join(" "), tokens, bigrams };
}

function stemToken(token: string): string {
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const union = new Set([...left, ...right]);
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return union.size === 0 ? 0 : intersection / union.size;
}

export function titleSimilarity(
  leftTitle: string,
  rightTitle: string,
  targetNames: string[] = [],
  extraStopWords: string[] = []
): number {
  const left = buildTitleFeatures(leftTitle, targetNames, extraStopWords);
  const right = buildTitleFeatures(rightTitle, targetNames, extraStopWords);
  if (!left.tokens.size || !right.tokens.size) {
    return normalizeForMatch(leftTitle) === normalizeForMatch(rightTitle) ? 1 : 0;
  }
  const tokenScore = jaccardSimilarity(left.tokens, right.tokens);
  const bigramScore = jaccardSimilarity(left.bigrams, right.bigrams);
  let common = 0;
  for (const token of left.tokens) if (right.tokens.has(token)) common += 1;
  // Catch reordered headlines and headlines with a publisher suffix or added detail.
  const shorter = Math.min(left.tokens.size, right.tokens.size);
  const longer = Math.max(left.tokens.size, right.tokens.size);
  if (shorter >= 3 && common / shorter >= 0.85 && common / longer >= 0.65) {
    return Math.max(0.85, tokenScore);
  }
  return (
    tokenScore * DISCOVERY_SIMILARITY.tokenWeight +
    bigramScore * DISCOVERY_SIMILARITY.bigramWeight
  );
}
