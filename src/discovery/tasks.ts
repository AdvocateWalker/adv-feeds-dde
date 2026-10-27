import { sha256 } from "./hash.js";
import type {
  DiscoveryAutoApproveTaskPayload,
  DiscoveryEvaluateTaskPayload,
  DiscoveryPublishTaskPayload,
  DiscoveryQueueTask,
  DiscoverySearchTaskPayload,
  DiscoveryTaskKind,
  DiscoveryTaskPayload,
} from "./types.js";
import { isRecord } from "./utils.js";

export function makeDiscoveryTask(
  kind: DiscoveryTaskKind,
  payload: DiscoveryTaskPayload,
  options: {
    bucket: string;
    runAt?: number;
    maxAttempts: number;
    identity: string;
  }
): DiscoveryQueueTask {
  const now = Date.now();
  return {
    id: `${kind}:${sha256(options.identity).slice(0, 24)}`,
    kind,
    bucket: options.bucket,
    attempts: 0,
    maxAttempts: options.maxAttempts,
    createdAt: now,
    nextRunAt: options.runAt ?? now,
    payload,
  };
}

export function isDiscoveryTaskKind(value: string): value is DiscoveryTaskKind {
  return (
    value === "discovery_search" ||
    value === "discovery_evaluate" ||
    value === "discovery_publish" ||
    value === "discovery_auto_approve"
  );
}

export function parseDiscoverySearchPayload(
  value: unknown
): DiscoverySearchTaskPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.targetId !== "string" ||
    typeof value.provider !== "string"
  ) return undefined;
  return value as unknown as DiscoverySearchTaskPayload;
}

export function parseDiscoveryEvaluatePayload(
  value: unknown
): DiscoveryEvaluateTaskPayload | undefined {
  if (!isRecord(value) || typeof value.targetId !== "string" || typeof value.candidateId !== "string") {
    return undefined;
  }
  return value as unknown as DiscoveryEvaluateTaskPayload;
}

export function parseDiscoveryPublishPayload(
  value: unknown
): DiscoveryPublishTaskPayload | undefined {
  if (!isRecord(value) || typeof value.targetId !== "string" || typeof value.candidateId !== "string") {
    return undefined;
  }
  return value as unknown as DiscoveryPublishTaskPayload;
}

export function parseDiscoveryAutoApprovePayload(
  value: unknown
): DiscoveryAutoApproveTaskPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.targetId !== "string" ||
    typeof value.candidateId !== "string" ||
    typeof value.redditPostId !== "string"
  ) return undefined;
  return value as unknown as DiscoveryAutoApproveTaskPayload;
}

