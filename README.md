# Discussion engagement

A static site that measures GitHub Discussions engagement and makes subscribing to a
board the primary action. The browser reads the GitHub GraphQL API directly when the
page loads; there is no server, no database, and no build-time data pipeline.

This is a single-repository prototype. It is enrolled with `cert-manager/cert-manager`.

## Running it

```sh
npm install
npm run dev
```

Open <http://localhost:4321/>.

```sh
npm run build     # static output in dist/
npm run preview   # serve dist/
npm test          # metric computation tests
npx astro check   # type check
```

## Authentication

GitHub's GraphQL API rejects unauthenticated requests, including for public
repositories. The Atom feed endpoints are anonymous; the GraphQL endpoint is not.
Because this build is browser-only, with no server and no scheduled job to hold a
credential, the page cannot load metrics without a token you supply. A backend proxy
or a build-time fetch could hold auth instead, at the cost of no longer being a purely
static, client-fetching site.

This site ships no credential and has no server to hold one. You supply a token in the
form on the page. It is kept in memory and sent only to `api.github.com`. Ticking
"Keep it for this browser tab only" stores it in `sessionStorage`, which is cleared
when the tab closes; leave it unticked and nothing is persisted.

Create a token at <https://github.com/settings/tokens>:

- A **classic** token with **no scopes selected** is sufficient for public repositories.
- A **fine-grained** token needs only `Discussions: read-only` on the repositories you
  enroll.

Do not use a token with write access. A token in a browser page is readable by anything
running in that page.

There is deliberately no `PUBLIC_GITHUB_TOKEN` environment variable. Astro inlines
`PUBLIC_`-prefixed variables into the client bundle, so configuring one would publish
the credential to every visitor of a deployed build.

## Which metrics come from a single fetch

All of them, including the sparkline and the trend. Neither needs an accumulated
snapshot history.

Every discussion, comment, and reply carries its own `createdAt` timestamp in the
GraphQL response. One fetch therefore reconstructs *when* activity happened, which is
enough to bucket it into a sparkline and to compare one period against the previous
one. Nothing needs to be remembered between page loads.

Computed live, with no stored history:

| Metric | Source |
|---|---|
| Unique participants | Distinct authors across discussions, comments, replies in the window |
| Discussions opened | `discussion.createdAt` inside the window |
| Comments and replies | `comment.createdAt` and `reply.createdAt` inside the window |
| Answered ratio | `isAnswered` on discussions in categories where `isAnswerable` is true |
| Median time to first response | Earliest non-author contribution minus `discussion.createdAt` |
| New vs returning participants | Earliest contribution per author across the whole board |
| Most active category | Contribution counts grouped by `category` |
| Activity sparkline | Contributions bucketed by timestamp across the window |
| Trend | Contributions in the window against the preceding window of equal length |

### What genuinely would need stored snapshots

Not the trend, but state that GitHub only reports as it currently stands:

- **Historical answer status.** `isAnswered` is a present-tense flag. `answerChosenAt`
  gives the moment an answer was accepted, so answer latency is recoverable, but a
  question that was unanswered for a year and answered yesterday cannot be told apart
  from one answered immediately unless that field is set.
- **Deleted content.** Removed discussions and comments are absent from the API. Any
  window containing them is undercounted, permanently.
- **Category moves.** A discussion reports its current category. Past activity is
  attributed to wherever it sits today.
- **Deleted accounts.** These return a null author and cannot be attributed to a
  person, so they are excluded from participant counts.

Measuring any of those over time needs periodic snapshots. This prototype keeps none.

## Honest failure

The fetch never blanks the page. A cell without a number states which of three things
happened, and the distinction is enforced in `summarize`:

- **No activity** — the window was read and nothing happened in it.
- **Insufficient history** — the board was read, but not far enough back to answer that
  particular question.
- **No data** — the fetch failed, so the metric was never measured.

The truncation rule is not cosmetic. Discussions are paginated newest-first, so a
short fetch still holds every discussion *opened* in the window; openings, answer
ratio, and median first response stay exact. But a comment written yesterday can sit on
a thread opened years ago, so any unread page leaves contribution counts undercounted
by an unknown amount. Participants, comments, top category, sparkline, and trend
therefore report insufficient history rather than a plausible-looking wrong number.

Rate limiting, an invalid token, a repository with Discussions disabled, and a network
failure are each surfaced on the affected row. Subscription links are static markup and
keep working in every one of those cases.

## Subscriptions

Feeds need no token and no account.

- Board: `https://github.com/OWNER/REPO/discussions.atom`
- Category: `https://github.com/OWNER/REPO/discussions/categories/SLUG.atom`

Category feeds are only rendered for slugs the API reported. An unknown slug returns
HTTP 200 with an empty feed rather than a 404, so guessed URLs cannot be validated.

## Scaling to more repositories

Enrollment lives entirely in `src/config/site.ts`:

```ts
export const repositories: RepositoryConfig[] = [
  { owner: 'cert-manager', name: 'cert-manager' },
];
```

Nothing downstream contains the string `cert-manager`. The page maps over that array,
the fetch layer takes a `RepositoryRef` argument, and the metric layer takes a
`Snapshot`. Adding repositories is a data change.

Deliberately not built yet:

- Landscape sync from <https://landscape.cncf.io> to generate the array
- Sorting, filtering, and search across rows
- Org-wide aggregate totals
- Any snapshot or caching layer

Fetch cost scales linearly: roughly one GraphQL request per 25 discussions, against a
5,000 point/hour budget. `analysis.maxRequests` caps per-repository work, and a
repository that hits the cap degrades to insufficient history rather than failing.

## Layout

```
src/config/site.ts        enrolled repositories and analysis parameters
src/lib/model.ts          domain types
src/lib/github.ts         GraphQL client, pagination, rate limits
src/lib/metrics.ts        metric computation and availability rules
src/lib/sparkline.ts      bucket counts to SVG geometry
src/lib/feeds.ts          Atom feed URLs
src/components/           leaderboard table, row, subscribe panel
src/scripts/dashboard.ts  client orchestration
```

## Verified against live data

Loaded against `cert-manager/cert-manager` on 2026-09-17, over a trailing 90-day
window, in 12 GraphQL requests reading all 259 discussions:

| Metric | Value |
|---|---|
| Unique participants | 10 |
| Discussions opened | 2 |
| Comments and replies | 13 |
| Answered | 0% of 1 |
| Median first response | 24.2 h |
| New / returning | 6 / 4 |
| Most active category | Q&A |
| Sparkline | 1, 2, 4, 2, 0, 0, 0, 2, 0, 1, 0, 2, 1 |
| Trend | No change (15 against 15) |

Every figure was cross-checked against an independent implementation reading the same
API payload.

Note that this board is quiet: 259 discussions since 2020, and roughly one or two per
month during 2026. The 90-day window in `analysis.windowDays` exists because a 30-day
window returns a single discussion for this repository.
