import type { Context } from "@devvit/public-api";
import {
  DISCOVERY_CANDIDATE_TTL_SECONDS,
  DISCOVERY_CONFIG_VERSION,
  DISCOVERY_EVENT_TTL_SECONDS,
  DISCOVERY_EXACT_TTL_SECONDS,
  DISCOVERY_IDENTITY_TTL_SECONDS,
  DISCOVERY_MAX_AUDIT_RECORDS,
  DISCOVERY_MAX_PREVIEW_RECORDS,
  DISCOVERY_MAX_WAITING_CANDIDATES,
  DISCOVERY_PROVIDER_BUDGETS,
  DISCOVERY_REJECTED_TTL_SECONDS,
  DISCOVERY_SIMILARITY,
  DISCOVERY_YOUTUBE_TTL_SECONDS,
  EMPTY_DISCOVERY_STATS,
} from "./constants.js";
import { buildDiscoveryFingerprints } from "./canonical-url.js";
import {
  EMPTY_DISCOVERY_CONFIG,
  parseDiscoveryConfig,
  serializeDiscoveryConfig,
} from "./config.js";
import { titleSimilarity } from "./similarity.js";
import type {
  DiscoveryAuditRecord,
  DiscoveryCandidate,
  DiscoveryConfig,
  DiscoveryDedupeResult,
  DiscoveryIdentityPatch,
  DiscoveryIdentityProfile,
  DiscoveryPostRecord,
  DiscoveryProviderHealth,
  DiscoveryProviderState,
  DiscoveryProviderType,
  DiscoveryStats,
  DiscoveryTarget,
} from "./types.js";
import { isRecord, normalizeForMatch, uniqueStrings } from "./utils.js";

type RedisContext = Pick<Context, "redis">;

const keys = {
  schema: "adv:discovery:schema",
  config: "adv:discovery:targets",
  identity: (targetId: string) => `adv:discovery:identity:${targetId}`,
  targetState: (targetId: string) => `adv:discovery:state:${targetId}`,
  providerState: (targetId: string, provider: DiscoveryProviderType) =>
    `adv:discovery:state:${targetId}:${provider}`,
  candidate: (targetId: string, candidateId: string) =>
    `adv:discovery:candidate:${targetId}:${candidateId}`,
  seenUrl: (targetId: string, hash: string) => `adv:discovery:seen:url:${targetId}:${hash}`,
  seenItem: (targetId: string, provider: DiscoveryProviderType, id: string) =>
    `adv:discovery:seen:item:${targetId}:${provider}:${id}`,
  seenTitle: (targetId: string, hash: string) => `adv:discovery:seen:title:${targetId}:${hash}`,
  rejected: (targetId: string, candidateId: string) =>
    `adv:discovery:rejected:${targetId}:${candidateId}`,
  events: (targetId: string) => `adv:discovery:event:${targetId}`,
  pending: (redditPostId: string) => `adv:discovery:pending:${redditPostId}`,
  postByCandidate: (targetId: string, candidateId: string) =>
    `adv:discovery:post:${targetId}:${candidateId}`,
  audit: (targetId: string) => `adv:discovery:audit:${targetId}`,
  preview: (targetId: string) => `adv:discovery:preview:${targetId}`,
  stats: (targetId: string) => `adv:discovery:stats:${targetId}`,
  totalStats: "adv:discovery:stats:installation",
  providerStats: (provider: DiscoveryProviderType) => `adv:discovery:stats:provider:${provider}`,
  health: (provider: DiscoveryProviderType) => `adv:discovery:provider:${provider}:health`,
  budget: (provider: DiscoveryProviderType) => `adv:discovery:provider:${provider}:budget`,
  postingRate: (targetId: string) => `adv:discovery:rate:${targetId}`,
  waiting: (targetId: string) => `adv:discovery:waiting:${targetId}`,
};

export async function initializeDiscoverySchema(context: RedisContext): Promise<void> {
  const current = Number(await context.redis.get(keys.schema));
  if (current === DISCOVERY_CONFIG_VERSION) return;
  const config = await loadDiscoveryConfig(context);
  await saveDiscoveryConfig(context, config);
  await context.redis.set(keys.schema, String(DISCOVERY_CONFIG_VERSION));
}

export async function loadDiscoveryConfig(context: RedisContext): Promise<DiscoveryConfig> {
  const raw = await context.redis.get(keys.config);
  if (!raw) return structuredClone(EMPTY_DISCOVERY_CONFIG);
  try {
    const result = parseDiscoveryConfig(JSON.parse(raw) as unknown);
    if (result.errors.length) {
      console.warn(`DDE config errors: ${result.errors.join(" | ")}`);
    }
    return result.config;
  } catch (error) {
    console.error(`DDE config load failed: ${String(error)}`);
    return structuredClone(EMPTY_DISCOVERY_CONFIG);
  }
}

export async function saveDiscoveryConfig(
  context: RedisContext,
  config: DiscoveryConfig
): Promise<void> {
  await context.redis.set(keys.config, serializeDiscoveryConfig(config));
}

export async function getDiscoveryIdentity(
  context: RedisContext,
  targetId: string
): Promise<DiscoveryIdentityProfile | undefined> {
  return getJson<DiscoveryIdentityProfile>(context, keys.identity(targetId));
}

export async function mergeDiscoveryIdentity(
  context: RedisContext,
  targetId: string,
  configuredName: string,
  source: "wikipedia" | "wikidata",
  patch: DiscoveryIdentityPatch,
  now = Date.now()
): Promise<DiscoveryIdentityProfile> {
  const stored = await getDiscoveryIdentity(context, targetId);
  const existing =
    stored && normalizeForMatch(stored.configuredName) === normalizeForMatch(configuredName)
      ? stored
      : undefined;
  const profile: DiscoveryIdentityProfile = {
    configuredName,
    canonicalName: patch.canonicalName ?? existing?.canonicalName,
    aliases: uniqueStrings([...(existing?.aliases ?? []), ...patch.aliases], 50),
    description: patch.description ?? existing?.description,
    wikipediaUrl: patch.wikipediaUrl ?? existing?.wikipediaUrl,
    wikidataId: patch.wikidataId ?? existing?.wikidataId,
    sources: Array.from(new Set([...(existing?.sources ?? []), source])),
    updatedAt: now,
  };
  await setJson(context, keys.identity(targetId), profile, DISCOVERY_IDENTITY_TTL_SECONDS);
  return profile;
}

export async function getEffectiveDiscoveryTarget(
  context: RedisContext,
  target: DiscoveryTarget
): Promise<DiscoveryTarget> {
  const identity = await getDiscoveryIdentity(context, target.id);
  if (!identity || normalizeForMatch(identity.configuredName) !== normalizeForMatch(target.name)) {
    return target;
  }
  const aliases = uniqueStrings([
    ...target.aliases,
    ...(identity.canonicalName ? [identity.canonicalName] : []),
    ...identity.aliases,
  ], 75).filter(
    (alias) => alias.toLocaleLowerCase("en-US") !== target.name.toLocaleLowerCase("en-US")
  );
  return { ...target, aliases };
}

export async function getTargetState(
  context: RedisContext,
  targetId: string
): Promise<{ nextPollAt: number; lastDispatchAt?: number }> {
  return (
    (await getJson<{ nextPollAt: number; lastDispatchAt?: number }>(context, keys.targetState(targetId))) ??
    { nextPollAt: 0 }
  );
}

export async function setTargetState(
  context: RedisContext,
  targetId: string,
  state: { nextPollAt: number; lastDispatchAt?: number }
): Promise<void> {
  await setJson(context, keys.targetState(targetId), state);
}

export async function getProviderState(
  context: RedisContext,
  targetId: string,
  provider: DiscoveryProviderType
): Promise<DiscoveryProviderState> {
  return (
    (await getJson<DiscoveryProviderState>(context, keys.providerState(targetId, provider))) ??
    { nextPollAt: 0 }
  );
}

export async function setProviderState(
  context: RedisContext,
  targetId: string,
  provider: DiscoveryProviderType,
  state: DiscoveryProviderState
): Promise<void> {
  await setJson(context, keys.providerState(targetId, provider), state);
}

export async function storeCandidate(
  context: RedisContext,
  candidate: DiscoveryCandidate
): Promise<DiscoveryCandidate> {
  const existing = await loadCandidate(context, candidate.targetId, candidate.candidateId);
  const merged: DiscoveryCandidate = existing
    ? {
        ...existing,
        ...candidate,
        discoveredBy: Array.from(new Set([...existing.discoveredBy, ...candidate.discoveredBy])),
        description: existing.description ?? candidate.description,
        publishedAt: existing.publishedAt ?? candidate.publishedAt,
      }
    : candidate;
  const key = keys.candidate(candidate.targetId, candidate.candidateId);
  await setJson(context, key, merged, DISCOVERY_CANDIDATE_TTL_SECONDS);
  return merged;
}

export async function loadCandidate(
  context: RedisContext,
  targetId: string,
  candidateId: string
): Promise<DiscoveryCandidate | undefined> {
  return getJson<DiscoveryCandidate>(context, keys.candidate(targetId, candidateId));
}

export async function checkDiscoveryDedupe(
  context: RedisContext,
  target: DiscoveryTarget,
  candidate: DiscoveryCandidate,
  stopWords: string[],
  now = Date.now()
): Promise<DiscoveryDedupeResult> {
  const rejected = await context.redis.get(keys.rejected(target.id, candidate.candidateId));
  if (rejected) return { duplicate: true, duplicateOf: rejected, kind: "rejected" };
  const fingerprints = buildDiscoveryFingerprints(candidate);
  if (fingerprints.providerKey && candidate.providerItemId) {
    const prior = await context.redis.get(
      keys.seenItem(target.id, candidate.provider, candidate.providerItemId)
    );
    if (prior) return { duplicate: true, duplicateOf: prior, kind: "provider" };
  }
  const urlPrior = await context.redis.get(keys.seenUrl(target.id, fingerprints.canonicalUrlHash));
  if (urlPrior) return { duplicate: true, duplicateOf: urlPrior, kind: "url" };
  const titlePrior = await context.redis.get(keys.seenTitle(target.id, fingerprints.normalizedTitleHash));
  if (titlePrior) return { duplicate: true, duplicateOf: titlePrior, kind: "title" };

  const events = (await getJson<DiscoveryEvent[]>(context, keys.events(target.id))) ?? [];
  const cutoff = now - DISCOVERY_EVENT_TTL_SECONDS * 1000;
  let strongest: { event: DiscoveryEvent; similarity: number } | undefined;
  for (const event of events.filter((item) => item.createdAt >= cutoff)) {
    const similarity = titleSimilarity(
      candidate.title,
      event.title,
      [target.name, ...target.aliases],
      stopWords
    );
    if (!strongest || similarity > strongest.similarity) strongest = { event, similarity };
  }
  if (strongest && strongest.similarity >= DISCOVERY_SIMILARITY.probableDuplicate) {
    return {
      duplicate: true,
      duplicateOf: strongest.event.candidateId,
      kind: "event",
      similarity: strongest.similarity,
    };
  }
  return { duplicate: false };
}

interface DiscoveryEvent {
  candidateId: string;
  title: string;
  createdAt: number;
}

export async function markDiscoveryConsumed(
  context: RedisContext,
  target: DiscoveryTarget,
  candidate: DiscoveryCandidate,
  accepted: boolean,
  now = Date.now()
): Promise<void> {
  const fingerprints = buildDiscoveryFingerprints(candidate);
  if (!accepted) {
    await Promise.all([
      context.redis.set(
        keys.rejected(target.id, candidate.candidateId),
        candidate.candidateId,
        { expiration: new Date(now + DISCOVERY_REJECTED_TTL_SECONDS * 1000) }
      ),
      setJson(
        context,
        keys.candidate(target.id, candidate.candidateId),
        candidate,
        DISCOVERY_REJECTED_TTL_SECONDS
      ),
    ]);
    return;
  }
  const ttl = DISCOVERY_EXACT_TTL_SECONDS;
  const writes: Promise<unknown>[] = [
    setJson(context, keys.candidate(target.id, candidate.candidateId), candidate, ttl),
    context.redis.set(keys.seenUrl(target.id, fingerprints.canonicalUrlHash), candidate.candidateId, {
      expiration: new Date(now + ttl * 1000),
    }),
    context.redis.set(keys.seenTitle(target.id, fingerprints.normalizedTitleHash), candidate.candidateId, {
      expiration: new Date(now + ttl * 1000),
    }),
  ];
  if (candidate.providerItemId) {
    const itemTtl = candidate.canonicalUrl.startsWith("youtube:")
      ? DISCOVERY_YOUTUBE_TTL_SECONDS
      : ttl;
    writes.push(
      context.redis.set(
        keys.seenItem(target.id, candidate.provider, candidate.providerItemId),
        candidate.candidateId,
        { expiration: new Date(now + itemTtl * 1000) }
      )
    );
  }
  await Promise.all(writes);
  if (accepted) {
    const existing = (await getJson<DiscoveryEvent[]>(context, keys.events(target.id))) ?? [];
    const recent = existing
      .filter((event) => event.createdAt >= now - DISCOVERY_EVENT_TTL_SECONDS * 1000)
      .filter((event) => event.candidateId !== candidate.candidateId);
    recent.unshift({ candidateId: candidate.candidateId, title: candidate.title, createdAt: now });
    await setJson(context, keys.events(target.id), recent.slice(0, 300), DISCOVERY_EVENT_TTL_SECONDS);
  }
}

export async function appendAudit(
  context: RedisContext,
  record: DiscoveryAuditRecord
): Promise<void> {
  const existing = (await getJson<DiscoveryAuditRecord[]>(context, keys.audit(record.targetId))) ?? [];
  existing.unshift(record);
  await setJson(context, keys.audit(record.targetId), existing.slice(0, DISCOVERY_MAX_AUDIT_RECORDS));
}

export async function getRecentAudits(
  context: RedisContext,
  targetId: string,
  limit = 20
): Promise<DiscoveryAuditRecord[]> {
  const existing = (await getJson<DiscoveryAuditRecord[]>(context, keys.audit(targetId))) ?? [];
  return existing.slice(0, Math.max(1, Math.min(100, limit)));
}

export async function savePreview(
  context: RedisContext,
  targetId: string,
  records: DiscoveryAuditRecord[]
): Promise<void> {
  await setJson(
    context,
    keys.preview(targetId),
    records
      .sort((left, right) => right.evaluation.score - left.evaluation.score)
      .slice(0, DISCOVERY_MAX_PREVIEW_RECORDS),
    60 * 60
  );
}

export async function clearPreviews(
  context: RedisContext,
  targetIds: string[]
): Promise<void> {
  if (targetIds.length > 0) {
    await context.redis.del(...targetIds.map((targetId) => keys.preview(targetId)));
  }
}

export async function appendPreview(
  context: RedisContext,
  record: DiscoveryAuditRecord
): Promise<void> {
  const existing = await getPreview(context, record.targetId);
  existing.push(record);
  await savePreview(context, record.targetId, existing);
}

export async function getPreview(
  context: RedisContext,
  targetId: string
): Promise<DiscoveryAuditRecord[]> {
  return (await getJson<DiscoveryAuditRecord[]>(context, keys.preview(targetId))) ?? [];
}

export async function incrementDiscoveryStats(
  context: RedisContext,
  targetId: string,
  patch: Partial<DiscoveryStats>,
  provider?: DiscoveryProviderType
): Promise<void> {
  const fields = Object.entries(patch).filter((entry): entry is [keyof DiscoveryStats, number] =>
    typeof entry[1] === "number" && entry[1] !== 0
  );
  const targets = [keys.stats(targetId), keys.totalStats];
  if (provider) targets.push(keys.providerStats(provider));
  for (const key of targets) {
    for (const [field, amount] of fields) {
      await context.redis.hIncrBy(key, field, amount);
    }
  }
}

export async function getDiscoveryStats(
  context: RedisContext,
  targetId?: string
): Promise<DiscoveryStats> {
  const raw = await context.redis.hGetAll(targetId ? keys.stats(targetId) : keys.totalStats);
  const stats = { ...EMPTY_DISCOVERY_STATS };
  for (const key of Object.keys(stats) as Array<keyof DiscoveryStats>) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) stats[key] = value;
  }
  return stats;
}

export async function getProviderHealth(
  context: RedisContext,
  provider: DiscoveryProviderType
): Promise<DiscoveryProviderHealth> {
  return (
    (await getJson<DiscoveryProviderHealth>(context, keys.health(provider))) ?? {
      provider,
      status: "not-applicable",
      consecutiveFailures: 0,
    }
  );
}

export async function setProviderHealth(
  context: RedisContext,
  health: DiscoveryProviderHealth
): Promise<void> {
  await setJson(context, keys.health(health.provider), health);
}

export async function recordProviderSuccess(
  context: RedisContext,
  provider: DiscoveryProviderType,
  now: number,
  partialErrors: string[] = []
): Promise<void> {
  await setProviderHealth(context, {
    provider,
    status: partialErrors.length ? "degraded" : "healthy",
    consecutiveFailures: 0,
    lastSuccessAt: now,
    lastError: partialErrors.length ? partialErrors.slice(0, 3).join(" | ") : undefined,
  });
}

export async function recordProviderFailure(
  context: RedisContext,
  provider: DiscoveryProviderType,
  error: string,
  now: number,
  statusCode?: number,
  requestedDelayMs?: number
): Promise<DiscoveryProviderHealth> {
  const prior = await getProviderHealth(context, provider);
  const failures = prior.consecutiveFailures + 1;
  const backoffMs = Math.min(
    60 * 60 * 1000,
    requestedDelayMs ?? 60_000 * 2 ** Math.min(6, failures - 1)
  );
  const health: DiscoveryProviderHealth = {
    provider,
    status: statusCode === 429 ? "rate-limited" : "backoff",
    consecutiveFailures: failures,
    lastSuccessAt: prior.lastSuccessAt,
    lastFailureAt: now,
    backoffUntil: now + backoffMs,
    lastStatusCode: statusCode,
    lastError: error.slice(0, 500),
  };
  await setProviderHealth(context, health);
  return health;
}

export async function consumeProviderBudget(
  context: RedisContext,
  provider: DiscoveryProviderType,
  requestedCalls: number,
  now: number
): Promise<{ allowed: boolean; retryAt?: number }> {
  const budget = DISCOVERY_PROVIDER_BUDGETS[provider];
  const history = (await getJson<BudgetEntry[]>(context, keys.budget(provider))) ?? [];
  const recent = history.filter((entry) => entry.at > now - 24 * 60 * 60 * 1000);
  const windows: Array<[number | undefined, number]> = [
    [budget.callsPerMinute, 60_000],
    [budget.callsPerHour, 3_600_000],
    [budget.callsPerDay, 86_400_000],
  ];
  let retryAt = 0;
  for (const [limit, windowMs] of windows) {
    if (!limit) continue;
    const inside = recent.filter((entry) => entry.at > now - windowMs);
    const used = inside.reduce((sum, entry) => sum + entry.count, 0);
    if (used + requestedCalls > limit) {
      retryAt = Math.max(retryAt, Math.min(...inside.map((entry) => entry.at)) + windowMs);
    }
  }
  if (retryAt > now) return { allowed: false, retryAt };
  recent.push({ at: now, count: Math.max(1, requestedCalls) });
  await setJson(context, keys.budget(provider), recent.slice(-5000), 24 * 60 * 60);
  return { allowed: true };
}

interface BudgetEntry { at: number; count: number }

export async function checkPostingRate(
  context: RedisContext,
  target: DiscoveryTarget,
  now: number
): Promise<{ allowed: boolean; retryAt?: number }> {
  const history = ((await getJson<number[]>(context, keys.postingRate(target.id))) ?? []).filter(
    (timestamp) => timestamp > now - 24 * 60 * 60 * 1000
  );
  const hourly = history.filter((timestamp) => timestamp > now - 60 * 60 * 1000);
  const retryAt = Math.max(
    hourly.length >= target.discovery.maxPostsPerHour ? Math.min(...hourly) + 60 * 60 * 1000 : 0,
    history.length >= target.discovery.maxPostsPerDay ? Math.min(...history) + 24 * 60 * 60 * 1000 : 0
  );
  return retryAt > now ? { allowed: false, retryAt } : { allowed: true };
}

export async function recordPosted(
  context: RedisContext,
  targetId: string,
  now: number
): Promise<void> {
  const history = ((await getJson<number[]>(context, keys.postingRate(targetId))) ?? []).filter(
    (timestamp) => timestamp > now - 24 * 60 * 60 * 1000
  );
  history.push(now);
  await setJson(context, keys.postingRate(targetId), history, 24 * 60 * 60);
}

export interface WaitingCandidate {
  targetId: string;
  candidateId: string;
  score: number;
  publishedAt: number;
  expiresAt: number;
}

export async function addWaitingCandidate(
  context: RedisContext,
  entry: WaitingCandidate
): Promise<void> {
  const waiting = ((await getJson<WaitingCandidate[]>(context, keys.waiting(entry.targetId))) ?? [])
    .filter((item) => item.expiresAt > Date.now() && item.candidateId !== entry.candidateId);
  waiting.push(entry);
  waiting.sort((left, right) => right.score - left.score || right.publishedAt - left.publishedAt);
  await setJson(context, keys.waiting(entry.targetId), waiting.slice(0, DISCOVERY_MAX_WAITING_CANDIDATES));
}

export async function takeWaitingCandidates(
  context: RedisContext,
  targetId: string,
  maximum: number,
  now: number
): Promise<WaitingCandidate[]> {
  const waiting = ((await getJson<WaitingCandidate[]>(context, keys.waiting(targetId))) ?? [])
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => right.score - left.score || right.publishedAt - left.publishedAt);
  const taken = waiting.slice(0, maximum);
  await setJson(context, keys.waiting(targetId), waiting.slice(taken.length));
  return taken;
}

export async function savePostRecord(
  context: RedisContext,
  record: DiscoveryPostRecord
): Promise<void> {
  await Promise.all([
    setJson(context, keys.pending(record.redditPostId), record, DISCOVERY_EXACT_TTL_SECONDS),
    setJson(context, keys.postByCandidate(record.targetId, record.candidateId), record, DISCOVERY_EXACT_TTL_SECONDS),
  ]);
}

export async function getPostRecordByRedditId(
  context: RedisContext,
  redditPostId: string
): Promise<DiscoveryPostRecord | undefined> {
  return getJson<DiscoveryPostRecord>(context, keys.pending(redditPostId));
}

export async function getPostRecordByCandidate(
  context: RedisContext,
  targetId: string,
  candidateId: string
): Promise<DiscoveryPostRecord | undefined> {
  return getJson<DiscoveryPostRecord>(context, keys.postByCandidate(targetId, candidateId));
}

export async function updatePostRecord(
  context: RedisContext,
  record: DiscoveryPostRecord,
  patch: Partial<DiscoveryPostRecord>
): Promise<DiscoveryPostRecord> {
  const updated = { ...record, ...patch, updatedAt: Date.now() };
  await savePostRecord(context, updated);
  return updated;
}

async function getJson<T>(context: RedisContext, key: string): Promise<T | undefined> {
  const raw = await context.redis.get(key);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value as T;
  } catch {
    return undefined;
  }
}

async function setJson(
  context: RedisContext,
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<void> {
  await context.redis.set(
    key,
    JSON.stringify(value),
    ttlSeconds ? { expiration: new Date(Date.now() + ttlSeconds * 1000) } : undefined
  );
}
