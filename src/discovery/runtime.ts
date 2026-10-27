import type { Context, Post } from "@devvit/public-api";
import {
  DISCOVERY_QUEUE_BASE_BACKOFF_SECONDS,
  DISCOVERY_QUEUE_MAX_ATTEMPTS,
} from "./constants.js";
import { canonicalUrlToPostUrl } from "./canonical-url.js";
import { evaluateDiscoveryCandidate, resolveDeliveryDisposition } from "./evaluator.js";
import { enrichDiscoveryCandidates } from "./enrichment.js";
import { sha256 } from "./hash.js";
import { discoveryProviders } from "./providers/index.js";
import { DiscoveryProviderError } from "./providers/common.js";
import { withExistingFeedSources } from "./sources.js";
import {
  addWaitingCandidate,
  appendAudit,
  appendPreview,
  checkDiscoveryDedupe,
  checkPostingRate,
  consumeProviderBudget,
  getEffectiveDiscoveryTarget,
  getPostRecordByCandidate,
  getPostRecordByRedditId,
  getProviderState,
  incrementDiscoveryStats,
  loadCandidate,
  loadDiscoveryConfig,
  markDiscoveryConsumed,
  mergeDiscoveryIdentity,
  recordPosted,
  recordProviderFailure,
  recordProviderSuccess,
  savePostRecord,
  setProviderHealth,
  setProviderState,
  storeCandidate,
  updatePostRecord,
} from "./state.js";
import {
  makeDiscoveryTask,
  parseDiscoveryAutoApprovePayload,
  parseDiscoveryEvaluatePayload,
  parseDiscoveryPublishPayload,
  parseDiscoverySearchPayload,
} from "./tasks.js";
import type {
  DiscoveryAuditRecord,
  DiscoveryCandidate,
  DiscoveryEvaluation,
  DiscoveryExistingFeedSource,
  DiscoveryPostRecord,
  DiscoveryQueueTask,
  DiscoveryTaskKind,
  DiscoveryTaskPayload,
  DiscoveryTarget,
} from "./types.js";
import { normalizeWhitespace, toErrorMessage } from "./utils.js";
import { checkDiscoverySafety } from "./safety.js";
import { isDuplicatePost, rememberPostedContent } from "../shared/post-dedupe.js";

type RuntimeContext = Pick<
  Context,
  "redis" | "reddit" | "subredditName"
>;

export interface DiscoveryRuntimeOptions {
  dryRun: boolean;
  maxAttempts?: number;
  now?: number;
  existingFeedSources?: DiscoveryExistingFeedSource[];
}

export type DiscoveryTaskExecutionResult =
  | { status: "success"; tasks?: DiscoveryQueueTask[]; bucketIntervalMs: number }
  | { status: "retry"; reason: string; delayMs: number }
  | { status: "drop"; reason: string };

export async function executeDiscoveryTask(
  context: RuntimeContext,
  task: {
    kind: DiscoveryTaskKind;
    attempts: number;
    payload: DiscoveryTaskPayload;
  },
  options: DiscoveryRuntimeOptions
): Promise<DiscoveryTaskExecutionResult> {
  const now = options.now ?? Date.now();
  const config = await loadDiscoveryConfig(context);
  if (task.kind === "discovery_search") {
    const payload = parseDiscoverySearchPayload(task.payload);
    if (!payload) return { status: "drop", reason: "Invalid Discovery search payload." };
    const configuredTarget = config.targets.find((item) => item.id === payload.targetId && item.enabled);
    if (!configuredTarget) return { status: "drop", reason: "Discovery target is unavailable." };
    const target = await getEffectiveDiscoveryTarget(
      context,
      withExistingFeedSources(configuredTarget, options.existingFeedSources)
    );
    const provider = discoveryProviders[payload.provider];
    if (!provider || !provider.isApplicable(target)) {
      return { status: "success", bucketIntervalMs: 0 };
    }
    const estimatedCalls = Math.max(1, provider.estimateCalls(target));
    const budget = await consumeProviderBudget(context, provider.type, estimatedCalls, now);
    if (!budget.allowed) {
      await setProviderHealth(context, {
        provider: provider.type,
        status: "rate-limited",
        consecutiveFailures: 0,
        backoffUntil: budget.retryAt,
      });
      return {
        status: "retry",
        reason: `${provider.type} provider budget exhausted.`,
        delayMs: Math.max(60_000, (budget.retryAt ?? now + 60_000) - now),
      };
    }
    const providerState = await getProviderState(context, target.id, provider.type);
    try {
      const result = await provider.search(target, {
        reddit: context.reddit,
        fetch,
        now,
        providerState,
        maxResults: target.discovery.maxResultsPerProvider,
        subredditName: context.subredditName ?? target.destinationSubreddit,
      });
      if (result.identity && (provider.type === "wikipedia" || provider.type === "wikidata")) {
        await mergeDiscoveryIdentity(
          context,
          target.id,
          configuredTarget.name,
          provider.type,
          result.identity,
          now
        );
      }
      const spawned: DiscoveryQueueTask[] = [];
      const candidates = await enrichDiscoveryCandidates(result.candidates, target, fetch);
      for (const candidate of candidates) {
        const stored = await storeCandidate(context, candidate);
        spawned.push(
          makeDiscoveryTask(
            "discovery_evaluate",
            { targetId: target.id, candidateId: stored.candidateId, preview: payload.preview },
            {
              bucket: `discovery:evaluate:${target.id}`,
              maxAttempts: options.maxAttempts ?? DISCOVERY_QUEUE_MAX_ATTEMPTS,
              identity: `${target.id}:${stored.candidateId}:${payload.preview ? "preview" : "live"}:${Math.floor(now / 300000)}`,
            }
          )
        );
      }
      console.info(
        `DDE provider: target=${target.id}, provider=${provider.type}, candidates=${result.candidates.length}, evaluations=${spawned.length}, sourceErrors=${result.errors?.length ?? 0}`
      );
      if (!payload.preview && !options.dryRun) {
        await setProviderState(context, target.id, provider.type, {
          lastSuccessfulPollAt: now,
          lastSeenPublishedAt: result.lastSeenPublishedAt ?? providerState.lastSeenPublishedAt,
          lastCursor: result.lastCursor ?? providerState.lastCursor,
          nextPollAt: now + providerPollDelayMs(provider.type, target.discovery.pollMinutes),
        });
      }
      await recordProviderSuccess(context, provider.type, now, result.errors);
      if (!payload.preview && !options.dryRun) {
        await incrementDiscoveryStats(
          context,
          target.id,
          { searches: 1, candidatesDiscovered: result.candidates.length },
          provider.type
        );
      }
      return { status: "success", tasks: spawned, bucketIntervalMs: 0 };
    } catch (error) {
      const message = toErrorMessage(error);
      const providerError = error instanceof DiscoveryProviderError ? error : undefined;
      const health = await recordProviderFailure(
        context,
        provider.type,
        message,
        now,
        providerError?.statusCode,
        providerError?.retryAfterMs
      );
      await incrementDiscoveryStats(context, target.id, { providerFailures: 1 }, provider.type);
      return {
        status: "retry",
        reason: message,
        delayMs: Math.max(
          DISCOVERY_QUEUE_BASE_BACKOFF_SECONDS * 1000,
          (health.backoffUntil ?? now + 60_000) - now
        ),
      };
    }
  }

  if (task.kind === "discovery_evaluate") {
    const payload = parseDiscoveryEvaluatePayload(task.payload);
    if (!payload) return { status: "drop", reason: "Invalid Discovery evaluation payload." };
    const configuredTarget = config.targets.find((item) => item.id === payload.targetId && item.enabled);
    const target = configuredTarget
      ? await getEffectiveDiscoveryTarget(
          context,
          withExistingFeedSources(configuredTarget, options.existingFeedSources)
        )
      : undefined;
    const candidate = await loadCandidate(context, payload.targetId, payload.candidateId);
    if (!target || !candidate) return { status: "drop", reason: "Discovery target or candidate is missing." };
    const dedupe = await checkDiscoveryDedupe(context, target, candidate, config.stopWords, now);
    const evaluation = evaluateDiscoveryCandidate(candidate, target, config, dedupe, now);
    candidate.evaluation = evaluation;
    await storeCandidate(context, candidate);
    const disposition = resolveDeliveryDisposition(target, evaluation, now);
    const baseAudit = buildAudit(target, candidate, evaluation, now);
    if (payload.preview) {
      await appendPreview(context, {
        ...baseAudit,
        action: evaluation.accepted ? (disposition === "auto" ? "dry-run-auto-post" : "dry-run-filter") : "reject",
        detail: "Preview only; no dedupe or delivery state was changed.",
      });
      return { status: "success", bucketIntervalMs: 0 };
    }
    if (!evaluation.accepted) {
      console.info(
        `DDE rejected: target=${target.id}, provider=${candidate.provider}, candidate=${candidate.candidateId}, score=${evaluation.score}, reason=${evaluation.rejectionReason ?? "unknown"}`
      );
      if (!options.dryRun) {
        await markDiscoveryConsumed(context, target, candidate, false, now);
      }
      await appendAudit(context, { ...baseAudit, action: "reject" });
      if (!options.dryRun) {
        await incrementDiscoveryStats(context, target.id, rejectionStats(evaluation), candidate.provider);
      }
      return { status: "success", bucketIntervalMs: 0 };
    }
    const rate = await checkPostingRate(context, target, now);
    console.info(
      `DDE accepted: target=${target.id}, provider=${candidate.provider}, candidate=${candidate.candidateId}, score=${evaluation.score}, disposition=${disposition}, dryRun=${options.dryRun}`
    );
    if (options.dryRun) {
      await appendAudit(context, {
        ...baseAudit,
        action: rate.allowed
          ? disposition === "auto"
            ? "dry-run-auto-post"
            : "dry-run-filter"
          : "defer",
        detail: rate.allowed
          ? undefined
          : `DRY RUN: posting limit reached; retry after ${new Date(rate.retryAt ?? now).toISOString()}.`,
      });
      return { status: "success", bucketIntervalMs: 0 };
    }
    await markDiscoveryConsumed(context, target, candidate, true, now);
    await incrementDiscoveryStats(context, target.id, { accepted: 1 }, candidate.provider);
    if (!rate.allowed) {
      await addWaitingCandidate(context, {
        targetId: target.id,
        candidateId: candidate.candidateId,
        score: evaluation.score,
        publishedAt: candidate.publishedAt ?? candidate.discoveredAt,
        expiresAt: Math.min(
          now + 24 * 60 * 60 * 1000,
          (candidate.publishedAt ?? now) + target.discovery.maxCandidateAgeHours * 3_600_000
        ),
      });
      await appendAudit(context, {
        ...baseAudit,
        action: "defer",
        detail: `Posting limit reached; retry after ${new Date(rate.retryAt ?? now).toISOString()}.`,
      });
      await incrementDiscoveryStats(context, target.id, { rateDeferred: 1 }, candidate.provider);
      return { status: "success", bucketIntervalMs: 0 };
    }
    const publishTask = makeDiscoveryTask(
      "discovery_publish",
      { targetId: target.id, candidateId: candidate.candidateId },
      {
        bucket: `reddit:${target.destinationSubreddit}`,
        maxAttempts: options.maxAttempts ?? DISCOVERY_QUEUE_MAX_ATTEMPTS,
        identity: `${target.id}:${candidate.candidateId}:publish`,
      }
    );
    await appendAudit(context, { ...baseAudit, action: "queue-publish" });
    return { status: "success", tasks: [publishTask], bucketIntervalMs: 0 };
  }

  if (task.kind === "discovery_publish") {
    const payload = parseDiscoveryPublishPayload(task.payload);
    if (!payload) return { status: "drop", reason: "Invalid Discovery publish payload." };
    const target = config.targets.find((item) => item.id === payload.targetId && item.enabled);
    const candidate = await loadCandidate(context, payload.targetId, payload.candidateId);
    const evaluation = candidate?.evaluation;
    if (!target || !candidate || !evaluation?.accepted) {
      return { status: "drop", reason: "Accepted DDE candidate is unavailable." };
    }
    if (options.dryRun) return { status: "success", bucketIntervalMs: 0 };
    try {
      let record = await getPostRecordByCandidate(context, target.id, candidate.candidateId);
      if (record && record.state !== "queued") {
        return { status: "success", bucketIntervalMs: 2500 };
      }
      let post: Post;
      if (record) {
        post = await context.reddit.getPostById(toT3(record.redditPostId));
      } else {
        // Recheck queued candidates: another target or feed may have posted since evaluation.
        const safety = checkDiscoverySafety(candidate, target, config);
        const duplicate = await isDuplicatePost(
          context, target.destinationSubreddit, candidate.title,
          canonicalUrlToPostUrl(candidate.canonicalUrl, candidate.url), now
        );
        if (!safety.safe || duplicate) {
          await appendAudit(context, {
            ...buildAudit(target, candidate, evaluation, now), action: "reject",
            detail: duplicate ? "duplicate-destination-content" : safety.rejectionReason,
          });
          return { status: "success", bucketIntervalMs: 0 };
        }
        const rate = await checkPostingRate(context, target, now);
        if (!rate.allowed) {
          await addWaitingCandidate(context, {
            targetId: target.id,
            candidateId: candidate.candidateId,
            score: evaluation.score,
            publishedAt: candidate.publishedAt ?? candidate.discoveredAt,
            expiresAt: Math.min(
              now + 24 * 60 * 60 * 1000,
              (candidate.publishedAt ?? now) + target.discovery.maxCandidateAgeHours * 3_600_000
            ),
          });
          await appendAudit(context, {
            ...buildAudit(target, candidate, evaluation, now),
            action: "defer",
            detail: `Posting limit reached; retry after ${new Date(rate.retryAt ?? now).toISOString()}.`,
          });
          await incrementDiscoveryStats(context, target.id, { rateDeferred: 1 }, candidate.provider);
          return { status: "success", bucketIntervalMs: 0 };
        }
        post = await submitDiscoveryPost(context, target, candidate);
        record = {
          targetId: target.id,
          candidateId: candidate.candidateId,
          redditPostId: post.id,
          createdAt: now,
          updatedAt: now,
          state: "queued",
          approvalMode: target.moderation.mode,
          sourceUrl: candidate.url,
          sourceDomain: candidate.sourceDomain,
          score: evaluation.score,
          reasons: evaluation.reasons,
        };
        await savePostRecord(context, record);
        await rememberPostedContent(
          context, target.destinationSubreddit, candidate.title,
          canonicalUrlToPostUrl(candidate.canonicalUrl, candidate.url), now
        );
        await recordPosted(context, target.id, now);
      }
      const disposition = resolveDeliveryDisposition(target, evaluation, now);
      let state: DiscoveryPostRecord["state"] = "submitted";
      let scheduledAutoApprovalAt: number | undefined;
      if (disposition === "filter" || disposition === "hold") {
        await post.filter(discoveryFilterOptions(target.name));
        state = "filtered";
        if (disposition === "hold") {
          scheduledAutoApprovalAt = now + (target.moderation.holdHours ?? 24) * 3_600_000;
        }
      }
      await applyDiscoveryPostActions(post, target);
      record = await updatePostRecord(context, record, {
        state,
        approvalMode: target.moderation.mode,
        scheduledAutoApprovalAt,
        score: evaluation.score,
        reasons: evaluation.reasons,
      });
      const patch = state === "filtered" ? { manualFiltered: 1 } : { autoPosted: 1 };
      await incrementDiscoveryStats(context, target.id, patch, candidate.provider);
      await appendAudit(context, {
        ...buildAudit(target, candidate, evaluation, now),
        action: state === "filtered" ? "filtered" : "submitted",
        detail: `Reddit post ${post.id}.`,
      });
      const spawned = scheduledAutoApprovalAt
        ? [
            makeDiscoveryTask(
              "discovery_auto_approve",
              { targetId: target.id, candidateId: candidate.candidateId, redditPostId: post.id },
              {
                bucket: `reddit:${target.destinationSubreddit}`,
                runAt: scheduledAutoApprovalAt,
                maxAttempts: options.maxAttempts ?? DISCOVERY_QUEUE_MAX_ATTEMPTS,
                identity: `${target.id}:${post.id}:auto-approve:${scheduledAutoApprovalAt}`,
              }
            ),
          ]
        : undefined;
      return { status: "success", tasks: spawned, bucketIntervalMs: 2500 };
    } catch (error) {
      await incrementDiscoveryStats(context, target.id, { deliveryFailures: 1 }, candidate.provider);
      if (task.attempts + 1 >= (options.maxAttempts ?? DISCOVERY_QUEUE_MAX_ATTEMPTS)) {
        const record = await getPostRecordByCandidate(context, target.id, candidate.candidateId);
        if (record) await updatePostRecord(context, record, { state: "failed" });
        await appendAudit(context, {
          ...buildAudit(target, candidate, evaluation, now),
          action: "failed",
          detail: `Delivery exhausted retries: ${toErrorMessage(error)}`,
        });
      }
      return {
        status: "retry",
        reason: toErrorMessage(error),
        delayMs: exponentialBackoff(task.attempts),
      };
    }
  }

  const payload = parseDiscoveryAutoApprovePayload(task.payload);
  if (!payload) return { status: "drop", reason: "Invalid Discovery approval payload." };
  const target = config.targets.find((item) => item.id === payload.targetId);
  const record = await getPostRecordByRedditId(context, payload.redditPostId);
  if (!target || !record || record.state !== "filtered") {
    return { status: "success", bucketIntervalMs: 0 };
  }
  try {
    const post = await context.reddit.getPostById(toT3(payload.redditPostId));
    if (post.approved) {
      await updatePostRecord(context, record, { state: "approved" });
      return { status: "success", bucketIntervalMs: 0 };
    }
    const subreddit = await context.reddit.getSubredditByName(target.destinationSubreddit);
    const pending = await subreddit.getModQueue({ type: "post", limit: 100 }).all();
    if (!pending.some((item) => item.id === post.id)) {
      await updatePostRecord(context, record, {
        state: post.removedByCategory === "deleted" ? "deleted" : "removed",
      });
      return { status: "success", bucketIntervalMs: 0 };
    }
    await post.approve();
    await updatePostRecord(context, record, { state: "auto-approved" });
    await incrementDiscoveryStats(context, target.id, { autoApprovedAfterHold: 1 });
    const candidate = await loadCandidate(context, target.id, record.candidateId);
    if (candidate?.evaluation) {
      await appendAudit(context, {
        ...buildAudit(target, candidate, candidate.evaluation, now),
        action: "auto-approved",
        detail: `Timed hold expired for ${post.id}.`,
      });
    }
    return { status: "success", bucketIntervalMs: 2500 };
  } catch (error) {
    return { status: "retry", reason: toErrorMessage(error), delayMs: exponentialBackoff(task.attempts) };
  }
}

export function discoveryFilterOptions(targetName: string): {
  reason: string;
  keep: true;
} {
  return { reason: `DDE: ${targetName}`, keep: true };
}

async function submitDiscoveryPost(
  context: Pick<Context, "reddit">,
  target: DiscoveryTarget,
  candidate: DiscoveryCandidate
): Promise<Post> {
  const title = renderTitle(target.redditPost.titleTemplate, target.name, candidate.title, candidate.sourceName);
  const common = {
    subredditName: target.destinationSubreddit,
    title,
    flairId: target.redditPost.flairId,
    flairText: target.redditPost.flairText,
    sendreplies: target.redditPost.sendReplies,
    spoiler: target.redditPost.spoiler,
    nsfw: false,
  };
  return context.reddit.submitPost({
    ...common,
    url: canonicalUrlToPostUrl(candidate.canonicalUrl, candidate.url),
  });
}

async function applyDiscoveryPostActions(post: Post, target: DiscoveryTarget): Promise<void> {
  const actions: Array<() => Promise<unknown>> = [];
  if (target.redditPost.suggestedCommentSort) {
    actions.push(() => post.setSuggestedCommentSort(target.redditPost.suggestedCommentSort!));
  }
  if (target.redditPost.distinguish) actions.push(() => post.distinguish());
  if (target.redditPost.sticky) {
    actions.push(() => post.sticky(target.redditPost.stickyPosition ?? 1));
  }
  if (target.redditPost.lock) actions.push(() => post.lock());
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      console.warn(`DDE post action failed for ${post.id}: ${toErrorMessage(error)}`);
    }
  }
}

function renderTitle(
  template: string | undefined,
  target: string,
  title: string,
  source?: string
): string {
  const rendered = (template ?? "{title}")
    .replace(/\{title\}/g, title)
    .replace(/\{target\}/g, target)
    .replace(/\{source\}/g, source ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeWhitespace(rendered || title).slice(0, 300);
}

function buildAudit(
  target: DiscoveryTarget,
  candidate: NonNullable<Awaited<ReturnType<typeof loadCandidate>>>,
  evaluation: DiscoveryEvaluation,
  now: number
): Omit<DiscoveryAuditRecord, "action"> {
  return {
    id: sha256(`${target.id}:${candidate.candidateId}:${now}`).slice(0, 24),
    targetId: target.id,
    candidateId: candidate.candidateId,
    provider: candidate.provider,
    title: candidate.title,
    url: candidate.url,
    sourceDomain: candidate.sourceDomain,
    publishedAt: candidate.publishedAt,
    discoveredAt: candidate.discoveredAt,
    evaluatedAt: evaluation.evaluatedAt,
    evaluation,
    approvalMode: target.moderation.mode,
  };
}

function rejectionStats(evaluation: DiscoveryEvaluation): Partial<import("./types.js").DiscoveryStats> {
  const reason = evaluation.rejectionReason ?? "";
  if (reason.startsWith("duplicate")) {
    return reason === "duplicate-event" ? { nearDuplicates: 1 } : { exactDuplicates: 1 };
  }
  if (reason.includes("nsfw") || reason === "provider-unsafe") return { nsfwRejections: 1 };
  if (reason.startsWith("blocked-domain")) return { blockedDomainRejections: 1 };
  return { relevanceRejections: 1 };
}

function providerPollDelayMs(
  provider: import("./types.js").DiscoveryProviderType,
  targetPollMinutes: number
): number {
  const configuredDelay = targetPollMinutes * 60 * 1000;
  return provider === "wikipedia" || provider === "wikidata"
    ? Math.max(configuredDelay, 24 * 60 * 60 * 1000)
    : configuredDelay;
}

function exponentialBackoff(attempts: number): number {
  return Math.min(60 * 60 * 1000, DISCOVERY_QUEUE_BASE_BACKOFF_SECONDS * 1000 * 2 ** attempts);
}

function toT3(id: string): `t3_${string}` {
  return (id.startsWith("t3_") ? id : `t3_${id}`) as `t3_${string}`;
}
