# ADV Feeds Deterministic Discovery Engine

This is a snapshot of ADV Feeds' Deterministic Discovery Engine, extracted from the working tree. The TypeScript source and existing tests are copied unchanged. The app entry point, moderator UI, deployment configuration, credentials, and unrelated repository files are excluded. This is source for integration into a Devvit app, not a deployable app on its own.

## Start with the Reddit search function

Read `src/discovery/providers/reddit.ts`, especially `searchReddit`. Its exported entry point is `redditSearchProvider.search(target, context)`.

The key API call is:

```ts
const posts = await context.reddit.searchPosts({
  query: item.query,
  ...(item.subredditName ? { subredditName: item.subredditName } : {}),
  sort: "new",
  timeframe: ageTimeframe(target.discovery.maxCandidateAgeHours),
  limit: context.maxResults,
  pageSize: Math.min(100, context.maxResults),
}).all();
```

Omitting `subredditName` is how this code performs Reddit-wide post search. Each query also runs against any configured source subreddits. Queries come from the target name, aliases, category terms, and optional additional queries (`src/discovery/queries.ts`).

The provider rotates through at most 15 query/scope combinations per invocation. This counter tracks listing operations, not necessarily individual network requests: `.all()` may paginate. The result includes `lastCursor`; the caller persists it as `providerState.lastCursor` for the next invocation. Results are converted to HTTPS external-link candidates, canonicalized, merged by URL, and capped at `maxResults`. NSFW signals are recorded for downstream rejection. The provider alone does not apply the full scoring, exact-age checks, or persistent duplicate checks.

## How this relates to your bots

This implements polling for matching **posts**, not a stream of every new comment on r/all. `sort: "new"` sorts search results; it does not turn search into a complete event stream. Search can miss content, and the rolling batch/result caps are deliberate limits.

The separate user provider can scan comments from explicitly configured usernames. It does not discover every Reddit comment.

The full engine evaluates candidates and submits their external website URLs as link posts to its configured destination subreddit. It does not reproduce a delayed native crosspost bot. This extract also does not establish permission to reply or crosspost in subreddits that have never installed an app, or answer what happens to registered Data API apps in March 2027.

## Included code

- `src/discovery/providers/reddit.ts`: post search, subreddit listings, and configured-user scanning.
- `src/discovery/queries.ts`: deterministic query generation.
- `src/discovery/providers/common.ts`, `canonical-url.ts`: candidate normalization and URL identity.
- `src/discovery/scoring.ts`, `safety.ts`, `evaluator.ts`: relevance and safety decisions.
- `src/discovery/state.ts`, `dispatcher.ts`, `tasks.ts`, `retry.ts`: Redis state, scheduling plans, and task definitions.
- `src/discovery/runtime.ts`: task execution, evaluation, and link-post submission.
- Other discovery providers and shared helpers required by those modules.
- `tests/discovery/`: the existing engine tests, including mocked Reddit/Redis behavior. The base-feed app integration test is excluded because it imports the omitted app entry point.

## Try the search inside a Devvit handler

```ts
import type { Context } from "@devvit/public-api";
import { parseDiscoveryConfig } from "./src/discovery/config.js";
import { redditSearchProvider } from "./src/discovery/providers/reddit.js";

export async function previewSearch(context: Context) {
  const subredditName = context.subredditName;
  if (!subredditName) throw new Error("Run from an installed subreddit.");
  const now = Date.now();
  const { config, errors } = parseDiscoveryConfig({
    targets: [{
      id: "example-topic",
      enabled: true,
      name: "Example Topic",
      category: "topic",
      destinationSubreddit: subredditName,
      reddit: { sourceSubreddits: [] },
    }],
  }, now);
  if (errors.length) throw new Error(errors.join("; "));
  const target = config.targets[0];
  if (!target) throw new Error("No valid target.");
  return redditSearchProvider.search(target, {
    reddit: context.reddit,
    fetch,
    now,
    providerState: { nextPollAt: 0 },
    maxResults: target.discovery.maxResultsPerProvider,
    subredditName,
  });
}
```

This preview returns candidates without posting. For repeated polling, persist the returned cursor. For the full pipeline, supply your own Devvit entry point, scheduler registration, queue runner, settings/UI, Reddit/Redis permissions, and the HTTP domain declarations required by whichever external providers you enable. `dispatcher.ts` plans work; the host app must enqueue it and invoke `executeDiscoveryTask` from `runtime.ts`, respecting retry delays and newly returned tasks. Keep duplicate checks, posting limits, and moderation handling when integrating live publishing.

## Local verification

Requires Node.js and npm. From this folder:

```sh
npm install
npm run type-check
npm test
```

The manifest pins the original versions of the dependencies needed for verification. Tests use mocks; passing them does not verify live Reddit access or installation permissions.
