import { DISCOVERY_SCORE_WEIGHTS } from "./constants.js";
import type {
  DiscoveryCandidate,
  DiscoveryScoreReason,
  DiscoveryTarget,
  DiscoveryTermRule,
} from "./types.js";
import { matchesDomainRule, phraseMatches, termMatches } from "./utils.js";

export interface DiscoveryScoreResult {
  score: number;
  reasons: DiscoveryScoreReason[];
  meaningfulTargetMatch: boolean;
  requiredTermsSatisfied: boolean;
  excludedTerm?: string;
}

export function scoreDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  target: DiscoveryTarget,
  now = Date.now()
): DiscoveryScoreResult {
  const reasons: DiscoveryScoreReason[] = [];
  const title = candidate.title;
  const description = candidate.description ?? "";
  const urlText = decodeURIComponentSafe(candidate.url.replace(/[-_/%?=&.]+/g, " "));
  const combined = `${title}\n${description}\n${urlText}`;
  const canonicalInTitle = phraseMatches(title, target.name);
  const aliasInTitle = !canonicalInTitle && target.aliases.some((alias) => phraseMatches(title, alias));
  const canonicalInDescription = phraseMatches(description, target.name);
  const aliasInDescription =
    !canonicalInDescription && target.aliases.some((alias) => phraseMatches(description, alias));
  const targetInUrl = [target.name, ...target.aliases].some((name) => phraseMatches(urlText, name));

  if (canonicalInTitle) add(reasons, "canonical-title", "Exact target name in title", DISCOVERY_SCORE_WEIGHTS.canonicalTitle);
  else if (aliasInTitle) add(reasons, "alias-title", "Exact target alias in title", DISCOVERY_SCORE_WEIGHTS.aliasTitle);
  if (canonicalInDescription) add(reasons, "canonical-description", "Exact target name in description", DISCOVERY_SCORE_WEIGHTS.canonicalDescription);
  else if (aliasInDescription) add(reasons, "alias-description", "Exact target alias in description", DISCOVERY_SCORE_WEIGHTS.aliasDescription);
  if (targetInUrl) add(reasons, "target-url", "Target name or alias in URL", DISCOVERY_SCORE_WEIGHTS.targetUrl);

  const requiredMatches = target.query.requiredTerms.filter((rule) => termMatches(combined, rule));
  for (const rule of requiredMatches) {
    add(reasons, "required-term", "Required term present", DISCOVERY_SCORE_WEIGHTS.requiredTerm, termValue(rule));
  }
  const requiredTermsSatisfied =
    target.query.requiredTermMode === "none" ||
    target.query.requiredTerms.length === 0 ||
    (target.query.requiredTermMode === "any" && requiredMatches.length > 0) ||
    (target.query.requiredTermMode === "all" && requiredMatches.length === target.query.requiredTerms.length);

  for (const rule of target.query.preferredTerms.filter((item) => termMatches(combined, item)).slice(0, 3)) {
    add(reasons, "preferred-term", "Preferred term present", DISCOVERY_SCORE_WEIGHTS.preferredTerm, termValue(rule));
  }
  if (
    candidate.sourceDomain &&
    target.domains.preferred.some((domain) => matchesDomainRule(candidate.sourceDomain!, domain))
  ) {
    add(reasons, "preferred-domain", "Preferred source domain", DISCOVERY_SCORE_WEIGHTS.preferredDomain, candidate.sourceDomain);
  }

  if (candidate.publishedAt !== undefined) {
    const ageHours = Math.max(0, (now - candidate.publishedAt) / 3_600_000);
    if (ageHours <= 12) add(reasons, "fresh-12h", "Published within 12 hours", DISCOVERY_SCORE_WEIGHTS.age12Hours);
    else if (ageHours <= 24) add(reasons, "fresh-24h", "Published within 24 hours", DISCOVERY_SCORE_WEIGHTS.age24Hours);
    else if (ageHours <= 72) add(reasons, "fresh-72h", "Published within 72 hours", DISCOVERY_SCORE_WEIGHTS.age72Hours);
  }

  const meaningfulTargetMatch =
    canonicalInTitle || aliasInTitle || canonicalInDescription || aliasInDescription || targetInUrl;
  if (meaningfulTargetMatch && !canonicalInTitle && !aliasInTitle) {
    add(reasons, "weak-mention", "Target absent from title", DISCOVERY_SCORE_WEIGHTS.weakMention);
  }
  const excluded = target.query.excludedTerms.find((rule) => termMatches(combined, rule));
  return {
    score: reasons.reduce((total, reason) => total + reason.points, 0),
    reasons,
    meaningfulTargetMatch,
    requiredTermsSatisfied,
    excludedTerm: excluded ? termValue(excluded) : undefined,
  };
}

function add(
  reasons: DiscoveryScoreReason[],
  code: string,
  label: string,
  points: number,
  detail?: string
): void {
  reasons.push({ code, label, points, detail });
}

function termValue(rule: DiscoveryTermRule): string {
  return typeof rule === "string" ? rule : rule.value;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

