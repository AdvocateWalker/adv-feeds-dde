import {
  DEFAULT_DISCOVERY_NSFW_TERMS,
  DEFAULT_DISCOVERY_STOP_WORDS,
  DISCOVERY_CONFIG_VERSION,
  DISCOVERY_MAX_TARGETS,
} from "./constants.js";
import type {
  DiscoveryConfig,
  DiscoveryCustomJsonSource,
  DiscoveryCustomXmlSource,
  DiscoveryFeedSource,
  DiscoveryHtmlSource,
  DiscoveryTarget,
  DiscoveryTargetCategory,
  DiscoveryTermRule,
  RequiredTermMode,
} from "./types.js";
import {
  asBoolean,
  asFiniteNumber,
  asString,
  clamp,
  isHttpsUrl,
  isRecord,
  normalizeDomain,
  normalizeSubreddit,
  normalizeUsername,
  normalizeWhitespace,
  uniqueStrings,
} from "./utils.js";
import {
  fetchHostname,
  isDeclaredHttpsFetchUrl,
} from "../shared/http-sources.js";

export interface DiscoveryConfigParseResult {
  config: DiscoveryConfig;
  errors: string[];
  warnings: string[];
}

export const DISCOVERY_TARGET_CATEGORIES: DiscoveryTargetCategory[] = [
  "person",
  "organization",
  "topic",
  "news",
  "breaking-news",
  "food",
  "entertainment",
  "sports",
  "politics",
  "technology",
  "science",
  "business",
  "other",
];

export const EMPTY_DISCOVERY_CONFIG: DiscoveryConfig = {
  version: DISCOVERY_CONFIG_VERSION,
  paused: false,
  nsfwTerms: [...DEFAULT_DISCOVERY_NSFW_TERMS],
  stopWords: [...DEFAULT_DISCOVERY_STOP_WORDS],
  blockedBotAccounts: [],
  targets: [],
};

export const EXAMPLE_DISCOVERY_CONFIG: DiscoveryConfig = {
  ...EMPTY_DISCOVERY_CONFIG,
  targets: [
    {
      id: "example-target",
      enabled: false,
      name: "Example Person",
      category: "person",
      aliases: [],
      destinationSubreddit: "YourSubreddit",
      reddit: {
        sourceSubreddits: [],
        usernames: [],
        scanUserComments: false,
        listingSorts: ["new"],
      },
      query: {
        additionalQueries: [],
        requiredTerms: [],
        requiredTermMode: "none",
        preferredTerms: [],
        excludedTerms: [],
      },
      domains: { preferred: [], excluded: [] },
      sources: { feeds: [], html: [], customJson: [], customXml: [] },
      discovery: {
        pollMinutes: 30,
        maxCandidateAgeHours: 72,
        maxResultsPerProvider: 25,
        minimumScore: 60,
        autoPostScore: 75,
        maxPostsPerHour: 2,
        maxPostsPerDay: 12,
      },
      moderation: { mode: "probation_then_auto", probationHours: 24 },
      redditPost: {
        titleTemplate: "{title}",
        sendReplies: false,
        spoiler: false,
        sticky: false,
        lock: false,
        distinguish: false,
        redditNativeMode: "link",
      },
    },
  ],
};

export function migrateDiscoveryConfig(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const version = asFiniteNumber(value.version, 1);
  if (version === DISCOVERY_CONFIG_VERSION) return value;
  // Version 1 is the first persisted schema. Future migrations are applied here.
  return { ...value, version: DISCOVERY_CONFIG_VERSION };
}

export function parseDiscoveryConfigJson(
  raw: string,
  now = Date.now()
): DiscoveryConfigParseResult {
  if (!raw.trim()) return { config: { ...EMPTY_DISCOVERY_CONFIG }, errors: [], warnings: [] };
  try {
    return parseDiscoveryConfig(JSON.parse(raw) as unknown, now);
  } catch (error) {
    return {
      config: { ...EMPTY_DISCOVERY_CONFIG },
      errors: [`DDE configuration is invalid JSON: ${String(error)}`],
      warnings: [],
    };
  }
}

export function parseDiscoveryConfig(
  input: unknown,
  now = Date.now()
): DiscoveryConfigParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const migrated = migrateDiscoveryConfig(input);
  if (!isRecord(migrated)) {
    return {
      config: { ...EMPTY_DISCOVERY_CONFIG },
      errors: ["DDE configuration must be an object."],
      warnings,
    };
  }
  const rawTargets = Array.isArray(migrated.targets) ? migrated.targets : [];
  if (!Array.isArray(migrated.targets)) errors.push("targets must be an array.");
  if (rawTargets.length > DISCOVERY_MAX_TARGETS) {
    errors.push(`targets supports at most ${DISCOVERY_MAX_TARGETS} entries.`);
  }
  const targets: DiscoveryTarget[] = [];
  for (let index = 0; index < rawTargets.slice(0, DISCOVERY_MAX_TARGETS).length; index += 1) {
    const target = parseTarget(rawTargets[index], index, errors, warnings, now);
    if (target) targets.push(target);
  }
  const duplicateIds = targets
    .map((target) => target.id)
    .filter((id, index, values) => values.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    errors.push(`Target IDs must be unique: ${Array.from(new Set(duplicateIds)).join(", ")}.`);
  }
  return {
    config: {
      version: DISCOVERY_CONFIG_VERSION,
      paused: asBoolean(migrated.paused, false),
      nsfwTerms: parseTermRules(migrated.nsfwTerms, "nsfwTerms", errors, DEFAULT_DISCOVERY_NSFW_TERMS),
      stopWords: uniqueStrings(migrated.stopWords, 500).length
        ? uniqueStrings(migrated.stopWords, 500)
        : [...DEFAULT_DISCOVERY_STOP_WORDS],
      blockedBotAccounts: uniqueStrings(migrated.blockedBotAccounts, 100).map(normalizeUsername),
      targets,
    },
    errors,
    warnings,
  };
}

function parseTarget(
  value: unknown,
  index: number,
  errors: string[],
  warnings: string[],
  now: number
): DiscoveryTarget | undefined {
  const label = `targets[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }
  const name = normalizeWhitespace(asString(value.name) ?? "");
  const category = parseTargetCategory(value.category, `${label}.category`, errors);
  const destinationSubreddit = normalizeSubreddit(value.destinationSubreddit);
  const rawId = normalizeWhitespace(asString(value.id) ?? "");
  const id = rawId || slugify(name);
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    errors.push(`${label}.id must use 2-64 lowercase letters, numbers, underscores, or hyphens.`);
  }
  if (!name) errors.push(`${label}.name is required.`);
  if (!destinationSubreddit || !/^[a-z0-9_]{2,21}$/i.test(destinationSubreddit)) {
    errors.push(`${label}.destinationSubreddit is invalid.`);
  }
  if ("search" in value) {
    warnings.push(`${label}.search provider switches are ignored; all operational providers run automatically.`);
  }

  const enabled = asBoolean(value.enabled, false);
  const enabledAtRaw = asFiniteNumber(value.enabledAt, 0);
  const enabledAt = enabled ? (enabledAtRaw > 0 ? enabledAtRaw : now) : undefined;
  const rawReddit = isRecord(value.reddit) ? value.reddit : {};
  const listingSorts = parseListingSorts(rawReddit.listingSorts, `${label}.reddit.listingSorts`, errors);
  const rawQuery = isRecord(value.query) ? value.query : {};
  const requiredTermMode = parseRequiredTermMode(rawQuery.requiredTermMode, `${label}.query.requiredTermMode`, errors);
  const rawDomains = isRecord(value.domains) ? value.domains : {};
  const rawSources = isRecord(value.sources) ? value.sources : {};
  const rawDiscovery = isRecord(value.discovery) ? value.discovery : {};
  const minimumScore = integerInRange(rawDiscovery.minimumScore, 60, -100, 500, `${label}.discovery.minimumScore`, errors);
  const autoPostScore = integerInRange(rawDiscovery.autoPostScore, 75, -100, 500, `${label}.discovery.autoPostScore`, errors);
  if (autoPostScore < minimumScore) {
    errors.push(`${label}.discovery.autoPostScore must be at least minimumScore.`);
  }
  const rawModeration = isRecord(value.moderation) ? value.moderation : {};
  const mode = parseApprovalMode(rawModeration.mode, `${label}.moderation.mode`, errors);
  const probationHours = integerInRange(rawModeration.probationHours, 24, 1, 24 * 30, `${label}.moderation.probationHours`, errors);
  const holdHours = integerInRange(rawModeration.holdHours, 24, 1, 24 * 30, `${label}.moderation.holdHours`, errors);
  const probationEndsAt =
    mode === "probation_then_auto" && enabledAt !== undefined
      ? asFiniteNumber(value.probationEndsAt, enabledAt + probationHours * 60 * 60 * 1000)
      : undefined;
  const rawPost = isRecord(value.redditPost) ? value.redditPost : {};
  const stickyPositionValue = integerInRange(rawPost.stickyPosition, 1, 1, 4, `${label}.redditPost.stickyPosition`, errors);
  const suggestedSort = parseSuggestedSort(rawPost.suggestedCommentSort, `${label}.redditPost.suggestedCommentSort`, errors);

  return {
    id,
    enabled,
    enabledAt,
    probationEndsAt,
    name,
    category,
    aliases: uniqueStrings(value.aliases, 50),
    destinationSubreddit,
    reddit: {
      sourceSubreddits: uniqueStrings(rawReddit.sourceSubreddits, 100).map(normalizeSubreddit).filter(Boolean),
      usernames: uniqueStrings(rawReddit.usernames, 100).map(normalizeUsername).filter(Boolean),
      scanUserComments: asBoolean(rawReddit.scanUserComments, false),
      listingSorts,
    },
    query: {
      additionalQueries: uniqueStrings(rawQuery.additionalQueries, 100),
      requiredTerms: parseTermRules(rawQuery.requiredTerms, `${label}.query.requiredTerms`, errors),
      requiredTermMode,
      preferredTerms: parseTermRules(rawQuery.preferredTerms, `${label}.query.preferredTerms`, errors),
      excludedTerms: parseTermRules(rawQuery.excludedTerms, `${label}.query.excludedTerms`, errors),
    },
    domains: {
      preferred: parseDomains(rawDomains.preferred, `${label}.domains.preferred`, errors),
      excluded: parseDomains(rawDomains.excluded, `${label}.domains.excluded`, errors),
    },
    sources: {
      feeds: parseFeedSources(rawSources.feeds, `${label}.sources.feeds`, errors),
      html: parseHtmlSources(rawSources.html, `${label}.sources.html`, errors),
      customJson: parseCustomJsonSources(rawSources.customJson, `${label}.sources.customJson`, errors),
      customXml: parseCustomXmlSources(rawSources.customXml, `${label}.sources.customXml`, errors),
    },
    discovery: {
      pollMinutes: integerInRange(rawDiscovery.pollMinutes, 30, 5, 1440, `${label}.discovery.pollMinutes`, errors),
      maxCandidateAgeHours: integerInRange(rawDiscovery.maxCandidateAgeHours, 72, 1, 24 * 365, `${label}.discovery.maxCandidateAgeHours`, errors),
      maxResultsPerProvider: integerInRange(rawDiscovery.maxResultsPerProvider, 25, 1, 50, `${label}.discovery.maxResultsPerProvider`, errors),
      minimumScore,
      autoPostScore,
      maxPostsPerHour: integerInRange(rawDiscovery.maxPostsPerHour, 2, 1, 20, `${label}.discovery.maxPostsPerHour`, errors),
      maxPostsPerDay: integerInRange(rawDiscovery.maxPostsPerDay, 12, 1, 100, `${label}.discovery.maxPostsPerDay`, errors),
    },
    moderation: {
      mode,
      probationHours: mode === "probation_then_auto" ? probationHours : undefined,
      holdHours: mode === "timed_hold" ? holdHours : undefined,
    },
    redditPost: {
      titleTemplate: asString(rawPost.titleTemplate) ?? "{title}",
      flairId: nonEmpty(asString(rawPost.flairId)),
      flairText: nonEmpty(asString(rawPost.flairText)),
      sendReplies: asBoolean(rawPost.sendReplies, false),
      spoiler: asBoolean(rawPost.spoiler, false),
      sticky: asBoolean(rawPost.sticky, false),
      stickyPosition: asBoolean(rawPost.sticky, false) ? (stickyPositionValue as 1 | 2 | 3 | 4) : undefined,
      lock: asBoolean(rawPost.lock, false),
      distinguish: asBoolean(rawPost.distinguish, false),
      suggestedCommentSort: suggestedSort,
      redditNativeMode: asString(rawPost.redditNativeMode) === "link" ? "link" : "crosspost",
    },
  };
}

export function createDiscoveryTarget(
  nameInput: string,
  category: DiscoveryTargetCategory,
  destinationSubreddit: string,
  existingIds: Iterable<string> = [],
  now = Date.now()
): DiscoveryTarget {
  const name = normalizeWhitespace(nameInput);
  const preset = discoveryCategoryPreset(category);
  const usedIds = new Set(Array.from(existingIds, (id) => id.toLowerCase()));
  const baseId = (slugify(name) || `target-${now.toString(36)}`).slice(0, 64);
  let id = baseId;
  for (let suffix = 2; usedIds.has(id.toLowerCase()); suffix += 1) {
    const ending = `-${suffix}`;
    id = `${baseId.slice(0, 64 - ending.length)}${ending}`;
  }
  return {
    id,
    enabled: true,
    enabledAt: now,
    name,
    category,
    aliases: [],
    destinationSubreddit: normalizeSubreddit(destinationSubreddit),
    reddit: {
      sourceSubreddits: [],
      usernames: [],
      scanUserComments: false,
      listingSorts: ["new"],
    },
    query: {
      additionalQueries: [],
      requiredTerms: [],
      requiredTermMode: "none",
      preferredTerms: preset.preferredTerms,
      excludedTerms: [],
    },
    domains: { preferred: [], excluded: [] },
    sources: { feeds: [], html: [], customJson: [], customXml: [] },
    discovery: {
      pollMinutes: preset.pollMinutes,
      maxCandidateAgeHours: preset.maxCandidateAgeHours,
      maxResultsPerProvider: 25,
      minimumScore: 60,
      autoPostScore: 75,
      maxPostsPerHour: 2,
      maxPostsPerDay: 12,
    },
    moderation: { mode: "manual" },
    redditPost: {
      titleTemplate: "{title}",
      sendReplies: false,
      spoiler: false,
      sticky: false,
      lock: false,
      distinguish: false,
      redditNativeMode: "link",
    },
  };
}

function discoveryCategoryPreset(category: DiscoveryTargetCategory): {
  pollMinutes: number;
  maxCandidateAgeHours: number;
  preferredTerms: string[];
} {
  switch (category) {
    case "breaking-news":
      return {
        pollMinutes: 5,
        maxCandidateAgeHours: 24,
        preferredTerms: ["breaking", "developing", "live"],
      };
    case "news":
    case "politics":
    case "business":
      return { pollMinutes: 15, maxCandidateAgeHours: 72, preferredTerms: [] };
    case "sports":
      return { pollMinutes: 15, maxCandidateAgeHours: 48, preferredTerms: [] };
    case "food":
    case "science":
      return { pollMinutes: 60, maxCandidateAgeHours: 168, preferredTerms: [] };
    default:
      return { pollMinutes: 30, maxCandidateAgeHours: 72, preferredTerms: [] };
  }
}

function parseTargetCategory(
  value: unknown,
  label: string,
  errors: string[]
): DiscoveryTargetCategory {
  if (value === undefined || value === "") return "other";
  const category = asString(value);
  if (category && DISCOVERY_TARGET_CATEGORIES.includes(category as DiscoveryTargetCategory)) {
    return category as DiscoveryTargetCategory;
  }
  errors.push(`${label} is invalid.`);
  return "other";
}

function parseTermRules(
  value: unknown,
  label: string,
  errors: string[],
  fallback: string[] = []
): DiscoveryTermRule[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  const output: DiscoveryTermRule[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item === "string" && item.trim()) {
      output.push(normalizeWhitespace(item));
      continue;
    }
    if (!isRecord(item) || !asString(item.value)?.trim()) {
      errors.push(`${label}[${index}] must be a string or term rule object.`);
      continue;
    }
    const match = asString(item.match) ?? "contains";
    if (!(["contains", "exact", "regex"] as string[]).includes(match)) {
      errors.push(`${label}[${index}].match is invalid.`);
      continue;
    }
    if (match === "regex") {
      try {
        new RegExp(asString(item.value)!, asBoolean(item.caseSensitive, false) ? "u" : "iu");
      } catch {
        errors.push(`${label}[${index}] contains an invalid regular expression.`);
        continue;
      }
    }
    output.push({
      value: normalizeWhitespace(asString(item.value)!),
      match: match as "contains" | "exact" | "regex",
      caseSensitive: asBoolean(item.caseSensitive, false),
    });
  }
  return output.slice(0, 250);
}

function parseDomains(value: unknown, label: string, errors: string[]): string[] {
  const domains = uniqueStrings(value, 250);
  const output: string[] = [];
  for (const item of domains) {
    const domain = normalizeDomain(item);
    if (!domain) errors.push(`${label} contains invalid domain '${item}'.`);
    else output.push(domain);
  }
  return Array.from(new Set(output));
}

function parseFeedSources(value: unknown, label: string, errors: string[]): DiscoveryFeedSource[] {
  if (!Array.isArray(value)) return [];
  const output: DiscoveryFeedSource[] = [];
  value.slice(0, 100).forEach((item, index) => {
    const record = typeof item === "string" ? { url: item } : item;
    if (!isRecord(record) || !isHttpsUrl(asString(record.url) ?? "")) {
      errors.push(`${label}[${index}] needs an HTTPS URL.`);
      return;
    }
    const url = asString(record.url)!;
    if (!isDeclaredHttpsFetchUrl(url)) {
      errors.push(`${label}[${index}] hostname ${fetchHostname(url) ?? "unknown"} is not declared for Devvit HTTP Fetch.`);
      return;
    }
    const sourceType = asString(record.sourceType);
    if (sourceType && !["auto", "rss", "atom"].includes(sourceType)) {
      errors.push(`${label}[${index}].sourceType is invalid.`);
      return;
    }
    output.push({ url, sourceType: sourceType as DiscoveryFeedSource["sourceType"] });
  });
  return output;
}

function parseHtmlSources(value: unknown, label: string, errors: string[]): DiscoveryHtmlSource[] {
  if (!Array.isArray(value)) return [];
  const output: DiscoveryHtmlSource[] = [];
  value.slice(0, 100).forEach((item, index) => {
    if (!isRecord(item) || !isHttpsUrl(asString(item.url) ?? "")) {
      errors.push(`${label}[${index}] needs an HTTPS URL.`);
      return;
    }
    const url = asString(item.url)!;
    if (!isDeclaredHttpsFetchUrl(url)) {
      errors.push(`${label}[${index}] hostname ${fetchHostname(url) ?? "unknown"} is not declared for Devvit HTTP Fetch.`);
      return;
    }
    for (const field of ["itemLinkPattern", "itemTitlePattern"] as const) {
      const pattern = asString(item[field]);
      if (pattern) {
        try { new RegExp(pattern, "i"); } catch { errors.push(`${label}[${index}].${field} is invalid regex.`); }
      }
    }
    output.push({
      url,
      itemLinkPattern: nonEmpty(asString(item.itemLinkPattern)),
      itemTitlePattern: nonEmpty(asString(item.itemTitlePattern)),
      minTitleLength: integerInRange(item.minTitleLength, 25, 1, 500, `${label}[${index}].minTitleLength`, errors),
      sameHostOnly: asBoolean(item.sameHostOnly, true),
      stripUrlQuery: asBoolean(item.stripUrlQuery, true),
      maxAnchorsToScan: integerInRange(item.maxAnchorsToScan, 4000, 100, 20000, `${label}[${index}].maxAnchorsToScan`, errors),
    });
  });
  return output;
}

function parseCustomJsonSources(value: unknown, label: string, errors: string[]): DiscoveryCustomJsonSource[] {
  if (!Array.isArray(value)) return [];
  const output: DiscoveryCustomJsonSource[] = [];
  value.slice(0, 50).forEach((item, index) => {
    if (!isRecord(item) || !isHttpsUrl(asString(item.url) ?? "")) {
      errors.push(`${label}[${index}] needs an HTTPS URL.`);
      return;
    }
    const url = asString(item.url)!;
    if (!isDeclaredHttpsFetchUrl(url)) {
      errors.push(`${label}[${index}] hostname ${fetchHostname(url) ?? "unknown"} is not declared for Devvit HTTP Fetch.`);
      return;
    }
    const id = asString(item.id)?.trim();
    if (!id || !/^[a-zA-Z0-9_-]{2,64}$/.test(id)) {
      errors.push(`${label}[${index}].id is invalid.`);
      return;
    }
    output.push({
      id,
      url,
      itemsPath: asString(item.itemsPath),
      titleField: asString(item.titleField) ?? "title",
      urlField: asString(item.urlField) ?? "url",
      descriptionField: asString(item.descriptionField) ?? "description",
      publishedAtField: asString(item.publishedAtField) ?? "publishedAt",
      authorField: asString(item.authorField) ?? "author",
      sourceNameField: asString(item.sourceNameField) ?? "source",
      thumbnailField: asString(item.thumbnailField) ?? "thumbnailUrl",
    });
  });
  return output;
}

function parseCustomXmlSources(value: unknown, label: string, errors: string[]): DiscoveryCustomXmlSource[] {
  if (!Array.isArray(value)) return [];
  const output: DiscoveryCustomXmlSource[] = [];
  value.slice(0, 50).forEach((item, index) => {
    if (!isRecord(item) || !isHttpsUrl(asString(item.url) ?? "")) {
      errors.push(`${label}[${index}] needs an HTTPS URL.`);
      return;
    }
    const url = asString(item.url)!;
    if (!isDeclaredHttpsFetchUrl(url)) {
      errors.push(`${label}[${index}] hostname ${fetchHostname(url) ?? "unknown"} is not declared for Devvit HTTP Fetch.`);
      return;
    }
    const id = asString(item.id)?.trim();
    if (!id || !/^[a-zA-Z0-9_-]{2,64}$/.test(id)) {
      errors.push(`${label}[${index}].id is invalid.`);
      return;
    }
    const tagFields = [
      "itemTag",
      "idTag",
      "titleTag",
      "urlTag",
      "descriptionTag",
      "publishedAtTag",
      "authorTag",
      "sourceNameTag",
      "thumbnailTag",
    ] as const;
    for (const field of tagFields) {
      const tag = asString(item[field]);
      if (tag && !/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(tag)) {
        errors.push(`${label}[${index}].${field} is not a valid XML tag name.`);
        return;
      }
    }
    output.push({
      id,
      url,
      itemTag: asString(item.itemTag) ?? "item",
      idTag: asString(item.idTag) ?? "id",
      titleTag: asString(item.titleTag) ?? "title",
      urlTag: asString(item.urlTag) ?? "url",
      descriptionTag: asString(item.descriptionTag) ?? "description",
      publishedAtTag: asString(item.publishedAtTag) ?? "publishedAt",
      authorTag: asString(item.authorTag) ?? "author",
      sourceNameTag: asString(item.sourceNameTag) ?? "source",
      thumbnailTag: asString(item.thumbnailTag) ?? "thumbnailUrl",
    });
  });
  return output;
}

function parseListingSorts(value: unknown, label: string, errors: string[]): Array<"new" | "hot" | "rising" | "top"> {
  if (value === undefined) return ["new"];
  const values = uniqueStrings(value, 4);
  const allowed = new Set(["new", "hot", "rising", "top"]);
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length) errors.push(`${label} contains invalid values: ${invalid.join(", ")}.`);
  const valid = values.filter((item): item is "new" | "hot" | "rising" | "top" => allowed.has(item));
  return valid.length ? valid : ["new"];
}

function parseRequiredTermMode(value: unknown, label: string, errors: string[]): RequiredTermMode {
  const mode = asString(value) ?? "none";
  if (["none", "any", "all"].includes(mode)) return mode as RequiredTermMode;
  errors.push(`${label} must be none, any, or all.`);
  return "none";
}

function parseApprovalMode(value: unknown, label: string, errors: string[]): DiscoveryTarget["moderation"]["mode"] {
  const mode = asString(value) ?? "manual";
  if (["manual", "probation_then_auto", "auto", "timed_hold"].includes(mode)) {
    return mode as DiscoveryTarget["moderation"]["mode"];
  }
  errors.push(`${label} is invalid.`);
  return "manual";
}

function parseSuggestedSort(value: unknown, label: string, errors: string[]): DiscoveryTarget["redditPost"]["suggestedCommentSort"] {
  if (value === undefined || value === "") return undefined;
  const normalized = asString(value)?.toUpperCase();
  const allowed = ["BLANK", "CONFIDENCE", "CONTROVERSIAL", "LIVE", "NEW", "OLD", "QA", "RANDOM", "TOP"];
  if (normalized && allowed.includes(normalized)) {
    return normalized as DiscoveryTarget["redditPost"]["suggestedCommentSort"];
  }
  errors.push(`${label} is invalid.`);
  return undefined;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, label: string, errors: string[]): number {
  const raw = asFiniteNumber(value, fallback);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Math.floor(clamp(raw, min, max));
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function nonEmpty(value?: string): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

export function serializeDiscoveryConfig(config: DiscoveryConfig): string {
  return JSON.stringify(config, null, 2);
}
