import type {
  DiscoveryCandidate,
  DiscoveryConfig,
  DiscoveryDedupeResult,
  DiscoveryEvaluation,
  DiscoveryTarget,
} from "./types.js";
import { checkDiscoverySafety } from "./safety.js";
import { scoreDiscoveryCandidate } from "./scoring.js";

export function evaluateDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  target: DiscoveryTarget,
  config: DiscoveryConfig,
  dedupe: DiscoveryDedupeResult = { duplicate: false },
  now = Date.now()
): DiscoveryEvaluation {
  const score = scoreDiscoveryCandidate(candidate, target, now);
  const evaluatedAt = now;
  const reject = (rejectionReason: string): DiscoveryEvaluation => ({
    accepted: false,
    score: score.score,
    reasons: score.reasons,
    rejectionReason,
    duplicateOf: dedupe.duplicateOf,
    duplicateKind: dedupe.kind,
    evaluatedAt,
  });

  const safety = checkDiscoverySafety(candidate, target, config);
  if (!safety.safe) {
    return reject(`${safety.rejectionReason}${safety.detail ? `: ${safety.detail}` : ""}`);
  }
  if (score.excludedTerm) return reject(`excluded-term: ${score.excludedTerm}`);
  if (!score.meaningfulTargetMatch) return reject("no-meaningful-target-match");
  if (!score.requiredTermsSatisfied) return reject("required-terms-not-satisfied");
  if (
    candidate.publishedAt !== undefined &&
    now - candidate.publishedAt > target.discovery.maxCandidateAgeHours * 3_600_000
  ) {
    return reject("candidate-too-old");
  }
  if (dedupe.duplicate) return reject(`duplicate-${dedupe.kind ?? "content"}`);
  if (score.score < target.discovery.minimumScore) return reject("below-minimum-score");

  return {
    accepted: true,
    score: score.score,
    reasons: score.reasons,
    evaluatedAt,
  };
}

export type DiscoveryDeliveryDisposition = "filter" | "auto" | "hold";

export function resolveDeliveryDisposition(
  target: DiscoveryTarget,
  evaluation: DiscoveryEvaluation,
  now = Date.now()
): DiscoveryDeliveryDisposition {
  if (target.moderation.mode === "manual") return "filter";
  if (target.moderation.mode === "timed_hold") return "hold";
  if (target.moderation.mode === "probation_then_auto") {
    const probationEndsAt =
      target.probationEndsAt ??
      (target.enabledAt ?? now) + (target.moderation.probationHours ?? 24) * 3_600_000;
    return now < probationEndsAt ? "filter" : "auto";
  }
  return evaluation.score >= target.discovery.autoPostScore ? "auto" : "filter";
}

