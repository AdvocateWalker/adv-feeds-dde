import type { Context } from "@devvit/public-api";
import { sha256 } from "./hash.js";
import type { DiscoveryPostRecord } from "./types.js";
import {
  appendAudit,
  getPostRecordByRedditId,
  incrementDiscoveryStats,
  loadCandidate,
  updatePostRecord,
} from "./state.js";

type ModeratorContext = Pick<Context, "reddit" | "subredditName" | "userId" | "username">;

export async function isCurrentUserModerator(context: ModeratorContext): Promise<boolean> {
  const subredditName = context.subredditName;
  if (!subredditName) return false;
  let username = context.username;
  if (!username && context.userId?.startsWith("t2_")) {
    username = (await context.reddit.getUserById(context.userId as `t2_${string}`))?.username;
  }
  if (!username) return false;
  const moderators = await context.reddit.getModerators({
    subredditName,
    username,
    limit: 1,
    pageSize: 1,
  }).all();
  return moderators.some(
    (moderator) => moderator.username.toLowerCase() === username!.toLowerCase()
  );
}

export async function assertCurrentUserModerator(context: ModeratorContext): Promise<void> {
  if (!(await isCurrentUserModerator(context))) {
    throw new Error("Only a current subreddit moderator may perform this DDE action.");
  }
}

export async function reconcileDiscoveryModAction(
  context: Pick<Context, "redis" | "appSlug">,
  action: { action?: string; targetPost?: { id?: string }; moderator?: { name?: string } }
): Promise<DiscoveryPostRecord | undefined> {
  const postId = action.targetPost?.id;
  if (!postId) return undefined;
  const record = await getPostRecordByRedditId(context, postId);
  if (!record) return undefined;
  if (
    action.moderator?.name &&
    action.moderator.name.toLowerCase() === context.appSlug.toLowerCase()
  ) {
    return record;
  }
  if (action.action === "approvelink") {
    const updated = await updatePostRecord(context, record, { state: "approved" });
    await incrementDiscoveryStats(context, record.targetId, { manuallyApproved: 1 });
    await appendModerationAudit(context, record, "manually-approved");
    return updated;
  }
  if (action.action === "removelink" || action.action === "spamlink") {
    if (record.state === "queued") return record;
    const updated = await updatePostRecord(context, record, { state: "removed" });
    await incrementDiscoveryStats(context, record.targetId, { manuallyRejected: 1 });
    await appendModerationAudit(context, record, "manually-rejected");
    return updated;
  }
  return record;
}

export async function reconcileDiscoveryPostDelete(
  context: Pick<Context, "redis">,
  postId?: string
): Promise<DiscoveryPostRecord | undefined> {
  if (!postId) return undefined;
  const record = await getPostRecordByRedditId(context, postId);
  if (!record) return undefined;
  const updated = await updatePostRecord(context, record, { state: "deleted" });
  await appendModerationAudit(context, record, "deleted");
  return updated;
}

async function appendModerationAudit(
  context: Pick<Context, "redis">,
  record: DiscoveryPostRecord,
  action: "manually-approved" | "manually-rejected" | "deleted"
): Promise<void> {
  const candidate = await loadCandidate(context, record.targetId, record.candidateId);
  if (!candidate?.evaluation) return;
  const now = Date.now();
  await appendAudit(context, {
    id: sha256(`${record.targetId}:${record.candidateId}:${action}:${now}`).slice(0, 24),
    targetId: record.targetId,
    candidateId: record.candidateId,
    provider: candidate.provider,
    title: candidate.title,
    url: candidate.url,
    sourceDomain: candidate.sourceDomain,
    publishedAt: candidate.publishedAt,
    discoveredAt: candidate.discoveredAt,
    evaluatedAt: now,
    evaluation: candidate.evaluation,
    approvalMode: record.approvalMode,
    action,
    detail: `Reddit post ${record.redditPostId}.`,
  });
}
