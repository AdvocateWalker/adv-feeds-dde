import type { DiscoveryTermRule } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function uniqueStrings(value: unknown, maximum = 100): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizeWhitespace(item))
        .filter(Boolean)
    )
  ).slice(0, maximum);
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeExternalText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = normalizeWhitespace(
    stripLoneSurrogates(value)
      .normalize("NFKC")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
  return cleaned.slice(0, Math.max(0, maxLength));
}

function stripLoneSurrogates(value: string): string {
  return Array.from(value)
    .filter((character) => {
      if (character.length !== 1) return true;
      const code = character.charCodeAt(0);
      return code < 0xd800 || code > 0xdfff;
    })
    .join("");
}

export function normalizeSubreddit(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/^\//, "")
    .toLowerCase();
}

export function normalizeUsername(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^\/?u\//i, "")
    .replace(/^\//, "")
    .toLowerCase();
}

export function normalizeDomain(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  try {
    const parsed = new URL(text.includes("://") ? text : `https://${text}`);
    return parsed.hostname.replace(/^(www|m)\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function extractHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

export function matchesDomainRule(hostname: string, rule: string): boolean {
  const host = normalizeDomain(hostname);
  const expected = normalizeDomain(rule);
  return Boolean(expected && (host === expected || host.endsWith(`.${expected}`)));
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForMatch(value: string): string {
  return normalizeWhitespace(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[\p{P}\p{S}]+/gu, " ")
  );
}

export function phraseMatches(text: string, phrase: string, caseSensitive = false): boolean {
  const haystack = caseSensitive ? normalizeWhitespace(text) : normalizeForMatch(text);
  const needle = caseSensitive ? normalizeWhitespace(phrase) : normalizeForMatch(phrase);
  if (!needle) return false;
  const expression = new RegExp(`(?:^|\\s)${escapeRegex(needle)}(?:$|\\s)`, caseSensitive ? "u" : "iu");
  return expression.test(haystack);
}

export function termMatches(text: string, rule: DiscoveryTermRule): boolean {
  const parsed =
    typeof rule === "string"
      ? { value: rule, match: "contains" as const, caseSensitive: false }
      : {
          value: rule.value,
          match: rule.match ?? "contains",
          caseSensitive: rule.caseSensitive ?? false,
        };
  if (!parsed.value.trim()) return false;
  if (parsed.match === "regex") {
    try {
      return new RegExp(parsed.value, parsed.caseSensitive ? "u" : "iu").test(text);
    } catch {
      return false;
    }
  }
  if (parsed.match === "exact") {
    return phraseMatches(text, parsed.value, parsed.caseSensitive);
  }
  const haystack = parsed.caseSensitive ? text : text.toLocaleLowerCase("en-US");
  const needle = parsed.caseSensitive
    ? parsed.value
    : parsed.value.toLocaleLowerCase("en-US");
  return haystack.includes(needle);
}

export function safeDateMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function pathValue(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  let current: unknown = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
