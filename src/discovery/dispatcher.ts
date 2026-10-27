import type { Context } from "@devvit/public-api";
import {
  DISCOVERY_PROVIDER_OVERLAP_MS,
  DISCOVERY_QUEUE_MAX_ATTEMPTS,
} from "./constants.js";
import { DISCOVERY_PROVIDER_ORDER, discoveryProviders } from "./providers/index.js";
import { withExistingFeedSources } from "./sources.js";
import {
  getProviderHealth,
  getProviderState,
  getTargetState,
  setProviderHealth,
  setTargetState,
  takeWaitingCandidates,
} from "./state.js";
import { makeDiscoveryTask } from "./tasks.js";
import type {
  DiscoveryConfig,
  DiscoveryExistingFeedSource,
  DiscoveryProviderType,
  DiscoveryQueueTask,
} from "./types.js";

type DispatchContext = Pick<Context, "redis">;

export interface DiscoveryDispatchOptions {
  force?: boolean;
  preview?: boolean;
  targetId?: string;
  now?: number;
  existingFeedSources?: DiscoveryExistingFeedSource[];
}

export interface DiscoveryDispatchResult {
  tasks: DiscoveryQueueTask[];
  targetsChecked: number;
  targetsDue: number;
  providersQueued: number;
  waitingQueued: number;
}

export async function dispatchDiscovery(
  context: DispatchContext,
  config: DiscoveryConfig,
  options: DiscoveryDispatchOptions = {}
): Promise<DiscoveryDispatchResult> {
  const now = options.now ?? Date.now();
  const tasks: DiscoveryQueueTask[] = [];
  let targetsDue = 0;
  let providersQueued = 0;
  let waitingQueued = 0;
  const targets = config.targets.filter(
    (target) => target.enabled && (!options.targetId || target.id === options.targetId)
  );

  for (const target of targets) {
    const effectiveTarget = withExistingFeedSources(target, options.existingFeedSources);
    if (!options.preview) {
      const waiting = await takeWaitingCandidates(context, target.id, 10, now);
      for (const entry of waiting) {
        tasks.push(
          makeDiscoveryTask(
            "discovery_publish",
            { targetId: target.id, candidateId: entry.candidateId },
            {
              bucket: `reddit:${target.destinationSubreddit}`,
              maxAttempts: DISCOVERY_QUEUE_MAX_ATTEMPTS,
              identity: `waiting:${target.id}:${entry.candidateId}:${Math.floor(now / 300000)}`,
            }
          )
        );
        waitingQueued += 1;
      }
    }

    const state = await getTargetState(context, target.id);
    if (!options.force && state.nextPollAt > now) continue;
    targetsDue += 1;
    const runIdentity = `${target.id}:${Math.floor(now / 300000)}:${options.preview ? "preview" : "live"}`;
    for (const providerType of DISCOVERY_PROVIDER_ORDER) {
      const provider = discoveryProviders[providerType];
      if (!provider.isApplicable(effectiveTarget)) {
        await setProviderHealth(context, {
          provider: providerType,
          status: "not-applicable",
          consecutiveFailures: 0,
        });
        continue;
      }
      const health = await getProviderHealth(context, providerType);
      if (health.backoffUntil && health.backoffUntil > now) continue;
      const providerState = await getProviderState(context, target.id, providerType);
      if (!options.force && providerState.nextPollAt > now) continue;
      tasks.push(
        makeDiscoveryTask(
          "discovery_search",
          { targetId: target.id, provider: providerType, preview: options.preview },
          {
            bucket: `discovery:${providerType}`,
            maxAttempts: DISCOVERY_QUEUE_MAX_ATTEMPTS,
            identity: `${runIdentity}:${providerType}`,
          }
        )
      );
      providersQueued += 1;
    }
    if (!options.preview) {
      await setTargetState(context, target.id, {
        lastDispatchAt: now,
        nextPollAt: now + target.discovery.pollMinutes * 60 * 1000,
      });
    }
  }

  return {
    tasks,
    targetsChecked: targets.length,
    targetsDue,
    providersQueued,
    waitingQueued,
  };
}

export async function initializeDiscoveryProviderHealth(
  context: Pick<Context, "redis">
): Promise<void> {
  for (const provider of DISCOVERY_PROVIDER_ORDER) {
    const existing = await getProviderHealth(context, provider);
    if (!existing.lastFailureAt && !existing.lastSuccessAt) {
      await setProviderHealth(context, {
        provider,
        status: "not-applicable",
        consecutiveFailures: 0,
      });
    }
  }
}
