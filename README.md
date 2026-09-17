# Discussion engagement

A static site that measures GitHub Discussions engagement and makes subscribing to a
board the primary action.

Live: <https://cncf-projects.github.io/website/>

Discussion data is read from the GitHub GraphQL API **while the site is built**, using
the deploy workflow's own `GITHUB_TOKEN`. Visitors are never asked for a credential and
none is shipped to the browser. The published page is plain HTML with the numbers
already in it.

This is a single-repository prototype. It is enrolled with `cert-manager/cert-manager`.

## Running it

```sh
npm install
GITHUB_TOKEN=$(gh auth token) npm run dev
```

Open <http://localhost:4321/website/>. The `/website/` path is not a typo: the site is
served from a project subpath on GitHub Pages, so `base` is set in `astro.config.mjs`
and the dev server mirrors it.

```sh
GITHUB_TOKEN=$(gh auth token) npm run build   # static output in dist/
npm run preview                               # serve dist/ at /website/
npm test                                      # metric and fetch-layer tests
npx astro check                               # type check
actionlint .github/workflows/*.yml            # workflow lint
```

Building without a token still succeeds and still produces a working page; every metric
reads "No data" and the subscription links work as normal. CI treats that as a failure
(see below), but locally it is a quick way to see the degraded state.

## Authentication

GitHub's GraphQL API rejects unauthenticated requests, including for public
repositories. Atom feed endpoints are anonymous; the GraphQL endpoint is not.

Because the data is fetched at build time, the token never leaves CI:

- In GitHub Actions, the workflow maps `GITHUB_TOKEN: ${{ github.token }}` onto the
  build step. Actions does not place the token in a step's environment automatically, so
  that mapping is required.
- Locally, export `GITHUB_TOKEN` yourself. `gh auth token` is the easy source.

The repository-scoped `GITHUB_TOKEN` can read public discussions in other
organisations, which is what makes this work for repositories the site does not live in.
It also gets a 10,000 point/hour GraphQL budget in Actions, against 5,000 for a personal
token.

There is deliberately no `PUBLIC_GITHUB_TOKEN` and no in-page token prompt. Astro inlines
`PUBLIC_`-prefixed variables into the client bundle, and a credential typed into a public
page is readable by anything else running in it.

## Freshness

Metrics are as of the last build. The site rebuilds when `main` is pushed.

There is no scheduled rebuild, so if nothing is pushed the numbers age. Adding one is a
`schedule:` trigger on the deploy workflow, deliberately left out of this prototype.

The Atom feeds do not have this limitation. They come straight from GitHub and update the
moment somebody posts, which is the main reason subscription is the primary action here
rather than a footnote.

## Which metrics come from a single read

All of them, including the sparkline and the trend. Neither needs accumulated snapshot
history.

Every discussion, comment, and reply carries its own `createdAt` timestamp in the
GraphQL response. One read therefore reconstructs *when* activity happened, which is
enough to bucket it into a sparkline and compare one period against the previous one.

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

- **Historical answer status.** `isAnswered` is present-tense. `answerChosenAt` recovers
  when an answer was accepted, but nothing recovers one that was accepted and later
  unaccepted.
- **Deleted content.** Removed discussions and comments are absent from the API, so any
  window containing them is permanently undercounted.
- **Category moves.** A discussion reports its current category; past activity is
  attributed to wherever it sits today.
- **Deleted accounts.** These return a null author and are excluded from participant
  counts.

## Honest failure

A cell without a number states which of three things happened, and the distinction is
enforced in `summarize`:

- **No activity** — the window was read and nothing happened in it.
- **Insufficient history** — the board was read, but not far enough back to answer that
  particular question.
- **No data** — the read failed, so the metric was never measured.

The truncation rule is not cosmetic. Discussions are paginated newest-first, so a short
read still holds every discussion *opened* in the window; openings, answered ratio, and
median first response stay exact. But a comment written today can sit on a thread opened
years ago, so any unread page leaves contribution counts undercounted by an unknown
amount. Participants, comments, top category, sparkline, and trend therefore report
insufficient history rather than a plausible-looking wrong number.

A repository that cannot be read at all does not fail the build or blank the page; its
row says so and the rest of the site is unaffected.

CI does fail if *no* repository yielded data, because a green deploy that quietly
published "No data" everywhere is worse than a red one. The build emits
`data-has-metrics` on `<body>` and the workflow checks it before publishing.

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
the fetch layer takes a `RepositoryRef`, and the metric layer takes a `Snapshot`. Adding
repositories is a data change.

Deliberately not built yet:

- Landscape sync from <https://landscape.cncf.io> to generate the array
- Sorting, filtering, and search across rows
- Org-wide aggregate totals
- Snapshot storage, caching, or scheduled refresh

Build cost scales linearly: roughly one GraphQL request per 25 discussions, against the
10,000 point/hour Actions budget. Repositories are read four at a time.
`analysis.maxRequests` caps per-repository work, and a repository that hits the cap
degrades to insufficient history rather than failing.

## Layout

```
src/config/site.ts        enrolled repositories and analysis parameters
src/lib/model.ts          domain types
src/lib/github.ts         GraphQL client, pagination, rate limits
src/lib/metrics.ts        metric computation and availability rules
src/lib/snapshot.ts       build-time loader; reads GITHUB_TOKEN
src/lib/format.ts         number and empty-state presentation
src/lib/sparkline.ts      bucket counts to SVG geometry
src/lib/feeds.ts          Atom feed URLs
src/components/           leaderboard table, row, subscribe panel
src/scripts/dashboard.ts  the one client-side behaviour: the scroll hint
.github/workflows/        build, verify, publish to Pages
```

## Verified against live data

Built against `cert-manager/cert-manager` over a trailing 90-day window, reading all 259
discussions in 12 GraphQL requests:

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

This board is quiet: 259 discussions since 2020, roughly one or two per month during
2026. The 90-day window in `analysis.windowDays` exists because a 30-day window returns
a single discussion, leaving the answered ratio and median response with a sample size
of one.
