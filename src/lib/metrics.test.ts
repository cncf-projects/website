import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnalysisConfig } from '../config/site.ts';
import type { Discussion, Snapshot } from './model.ts';
import { summarize } from './metrics.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-17T00:00:00Z');

const config: AnalysisConfig = {
  windowDays: 90,
  sparklineBuckets: 9,
  maxRequests: 60,
  rateLimitFloor: 50,
  discussionPageSize: 25,
  commentPageSize: 50,
  replyPageSize: 50,
};

const QA = { id: 'qa', name: 'Q&A', slug: 'q-a', isAnswerable: true };
const GENERAL = { id: 'gen', name: 'General', slug: 'general', isAnswerable: false };

function ago(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

/**
 * D1 is opened inside the window and answered.
 * D2 is older than the window but receives a comment inside it, which is the
 * case a truncated fetch silently undercounts.
 * D3 predates both windows.
 */
function discussions(): Discussion[] {
  return [
    {
      id: 'd1',
      number: 1,
      createdAt: ago(10),
      author: { login: 'alice' },
      category: QA,
      isAnswered: true,
      answerChosenAt: ago(9),
      commentsComplete: true,
      comments: [
        {
          id: 'c1',
          createdAt: ago(9),
          author: { login: 'bob' },
          replies: [],
          repliesComplete: true,
        },
      ],
    },
    {
      id: 'd2',
      number: 2,
      createdAt: ago(100),
      author: { login: 'bob' },
      category: GENERAL,
      isAnswered: null,
      answerChosenAt: null,
      commentsComplete: true,
      comments: [
        {
          id: 'c2',
          createdAt: ago(5),
          author: { login: 'alice' },
          replies: [],
          repliesComplete: true,
        },
      ],
    },
    {
      id: 'd3',
      number: 3,
      createdAt: ago(200),
      author: { login: 'carol' },
      category: GENERAL,
      isAnswered: null,
      answerChosenAt: null,
      commentsComplete: true,
      comments: [],
    },
  ];
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    repository: { owner: 'acme', name: 'widget' },
    asOf: NOW,
    categories: [QA, GENERAL],
    discussions: discussions(),
    historyComplete: true,
    oldestFetchedAt: NOW - 200 * DAY,
    requests: 4,
    rateLimit: { remaining: 4900, resetAt: null },
    errors: [],
    ...overrides,
  };
}

test('a complete fetch reports every metric from timestamps alone', () => {
  const summary = summarize(snapshot(), config);

  assert.deepEqual(summary.participants, { state: 'ok', value: 2 });
  assert.deepEqual(summary.discussionsOpened, { state: 'ok', value: 1 });
  assert.deepEqual(summary.comments, { state: 'ok', value: 2 });

  // One day between the discussion opening and bob's reply.
  assert.equal(summary.medianFirstResponse.state, 'ok');
  assert.equal(summary.medianFirstResponse.value, DAY);

  // alice first appears inside the window; bob opened d2 long before it.
  assert.deepEqual(summary.cohorts.value, { newcomers: 1, returning: 1 });

  // Three contributions this window against d2's opening in the previous one.
  assert.deepEqual(summary.trend.value, { current: 3, previous: 1, change: 2, ratio: 2 });

  assert.equal(summary.series.state, 'ok');
  assert.equal(summary.series.value?.buckets.reduce((a, b) => a + b, 0), 3);
});

test('categories that do not accept answers are excluded, not counted unanswered', () => {
  // d2 and d3 sit in General with isAnswered null; only d1 is a question.
  const summary = summarize(snapshot(), config);
  assert.deepEqual(summary.answered.value, { answered: 1, unanswered: 0, ratio: 1 });
});

test('a truncated fetch refuses to report contribution counts as exact', () => {
  // Pagination stopped early, so a comment on an unfetched older thread could be
  // missing. Reporting a number here would be reporting an undercount as fact.
  const summary = summarize(snapshot({ historyComplete: false }), config);

  for (const metric of [
    summary.participants,
    summary.comments,
    summary.cohorts,
    summary.topCategory,
    summary.series,
    summary.trend,
  ]) {
    assert.equal(metric.state, 'insufficient-history');
    assert.equal(metric.value, null);
  }

  // Discussions arrive newest first, so openings and answer status inside the
  // window are still known exactly.
  assert.deepEqual(summary.discussionsOpened, { state: 'ok', value: 1 });
  assert.equal(summary.answered.state, 'ok');
  assert.equal(summary.medianFirstResponse.state, 'ok');
});

test('an unread thread withholds the response time that could be hiding in it', () => {
  const partial = discussions();
  partial[0]!.commentsComplete = false;
  const summary = summarize(snapshot({ discussions: partial }), config);
  assert.equal(summary.medianFirstResponse.state, 'insufficient-history');
});

test('a failed fetch reports nothing measured, not shallow history', () => {
  const summary = summarize(
    snapshot({ discussions: [], oldestFetchedAt: null, historyComplete: false, errors: ['boom'] }),
    config,
  );

  for (const metric of [
    summary.participants,
    summary.discussionsOpened,
    summary.comments,
    summary.answered,
    summary.medianFirstResponse,
    summary.cohorts,
    summary.topCategory,
    summary.series,
    summary.trend,
  ]) {
    assert.equal(metric.state, 'unavailable');
  }
});

test('an empty window is distinguished from an unmeasured one', () => {
  const stale = discussions().map((discussion) => ({ ...discussion, createdAt: ago(400), comments: [] }));
  const summary = summarize(snapshot({ discussions: stale, oldestFetchedAt: NOW - 400 * DAY }), config);

  assert.deepEqual(summary.participants, { state: 'no-activity', value: 0 });
  assert.equal(summary.series.state, 'no-activity');
  assert.equal(summary.trend.state, 'no-activity');
  assert.deepEqual(summary.discussionsOpened, { state: 'ok', value: 0 });
});
