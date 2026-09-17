import type { AnalysisConfig } from '../config/site.ts';
import type { Contribution, Discussion, Snapshot } from './model.ts';

const DAY_MS = 86_400_000;

/**
 * Why a metric has no number.
 *   ok                    a real value was computed
 *   no-activity           measured successfully; the window was genuinely empty
 *   insufficient-history  read, but not far enough back to answer honestly
 *   unavailable           the fetch failed, so nothing was measured at all
 */
export type MetricState = 'ok' | 'no-activity' | 'insufficient-history' | 'unavailable';

export interface Metric<T> {
  state: MetricState;
  value: T | null;
}

export interface AnsweredRatio {
  answered: number;
  unanswered: number;
  ratio: number;
}

export interface Cohorts {
  newcomers: number;
  returning: number;
}

export interface TopCategory {
  names: string[];
  events: number;
}

export interface Trend {
  current: number;
  previous: number;
  /** Absolute change in events between the two windows. */
  change: number;
  /** Fractional change. Null when the previous window had no activity. */
  ratio: number | null;
}

export interface Series {
  /** One event count per bucket, oldest first. */
  buckets: number[];
  bucketDays: number;
}

export interface Summary {
  windowStart: number;
  windowEnd: number;
  participants: Metric<number>;
  discussionsOpened: Metric<number>;
  comments: Metric<number>;
  answered: Metric<AnsweredRatio>;
  medianFirstResponse: Metric<number>;
  firstResponseSample: number;
  cohorts: Metric<Cohorts>;
  topCategory: Metric<TopCategory>;
  series: Metric<Series>;
  trend: Metric<Trend>;
}

interface Event {
  at: number;
  login: string | null;
  isDiscussion: boolean;
  categoryId: string;
  categoryName: string;
}

function flatten(discussions: Discussion[], asOf: number): Event[] {
  const events: Event[] = [];

  for (const discussion of discussions) {
    const { id: categoryId, name: categoryName } = discussion.category;
    const push = (contribution: Contribution, isDiscussion: boolean) => {
      const at = Date.parse(contribution.createdAt);
      if (!Number.isFinite(at) || at > asOf) return;
      events.push({
        at,
        login: contribution.author?.login.toLowerCase() ?? null,
        isDiscussion,
        categoryId,
        categoryName,
      });
    };

    push(discussion, true);
    for (const comment of discussion.comments) {
      push(comment, false);
      for (const reply of comment.replies) push(reply, false);
    }
  }

  return events;
}

/**
 * First response to a discussion by somebody other than its author. Unattributed
 * contributions count, since a deleted account was still a different person than
 * an identified author.
 */
function firstResponseDelay(discussion: Discussion, asOf: number): number | null {
  const openedAt = Date.parse(discussion.createdAt);
  if (!Number.isFinite(openedAt)) return null;
  const author = discussion.author?.login.toLowerCase() ?? null;

  let earliest: number | null = null;
  const consider = (contribution: Contribution) => {
    const login = contribution.author?.login.toLowerCase() ?? null;
    if (author !== null && login === author) return;
    const at = Date.parse(contribution.createdAt);
    if (!Number.isFinite(at) || at < openedAt || at > asOf) return;
    if (earliest === null || at < earliest) earliest = at;
  };

  for (const comment of discussion.comments) {
    consider(comment);
    for (const reply of comment.replies) consider(reply);
  }

  return earliest === null ? null : earliest - openedAt;
}

export function summarize(snapshot: Snapshot, config: AnalysisConfig): Summary {
  const windowEnd = snapshot.asOf;
  const windowMs = config.windowDays * DAY_MS;
  const windowStart = windowEnd - windowMs;
  const previousStart = windowStart - windowMs;

  // A fetch that returned nothing while reporting errors was not measured at all.
  // That is a different claim from "read, but not deep enough", and must not be
  // dressed up as one.
  if (snapshot.discussions.length === 0 && snapshot.errors.length > 0) {
    const unavailable = { state: 'unavailable', value: null } as const;
    return {
      windowStart,
      windowEnd,
      participants: unavailable,
      discussionsOpened: unavailable,
      comments: unavailable,
      answered: unavailable,
      medianFirstResponse: unavailable,
      firstResponseSample: 0,
      cohorts: unavailable,
      topCategory: unavailable,
      series: unavailable,
      trend: unavailable,
    };
  }

  const events = flatten(snapshot.discussions, windowEnd);
  const inWindow = events.filter((event) => event.at >= windowStart);
  const inPrevious = events.filter((event) => event.at >= previousStart && event.at < windowStart);

  // Discussions arrive newest first, so once the oldest fetched one predates the
  // window we hold every discussion *opened* in it. That is enough to count
  // openings and answer status, and nothing else.
  const reachesWindow = snapshot.historyComplete || (snapshot.oldestFetchedAt ?? Infinity) <= windowStart;

  // Contributions are a different matter. A comment written yesterday can sit on
  // a thread opened years ago, so any unread discussion, comment page, or reply
  // page leaves an undercount of unknown size. Metrics derived from individual
  // contributions are only honest once every connection has been drained.
  const contributionsComplete =
    snapshot.historyComplete &&
    snapshot.discussions.every(
      (discussion) =>
        discussion.commentsComplete &&
        discussion.comments.every((comment) => comment.repliesComplete),
    );

  const participants = new Set<string>();
  const categories = new Map<string, { name: string; events: number }>();
  for (const event of inWindow) {
    if (event.login) participants.add(event.login);
    const entry = categories.get(event.categoryId) ?? { name: event.categoryName, events: 0 };
    entry.events += 1;
    categories.set(event.categoryId, entry);
  }

  const openedInWindow = snapshot.discussions.filter((discussion) => {
    const at = Date.parse(discussion.createdAt);
    return at >= windowStart && at <= windowEnd;
  });

  const questions = openedInWindow.filter((discussion) => discussion.category.isAnswerable);
  const answered = questions.filter((discussion) => discussion.isAnswered === true).length;

  // The earliest response is reachable whenever a thread's comment pages were
  // fully read; comments arrive oldest first, so a drained thread cannot hide one.
  const responsesReadable = openedInWindow.every((discussion) => discussion.commentsComplete);
  const delays = openedInWindow
    .map((discussion) => firstResponseDelay(discussion, windowEnd))
    .filter((delay): delay is number => delay !== null)
    .sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  const median =
    delays.length === 0
      ? null
      : delays.length % 2 === 1
        ? delays[middle]!
        : (delays[middle - 1]! + delays[middle]!) / 2;

  // New versus returning needs every prior contribution, so it is only honest
  // when pagination reached the beginning of the board.
  const firstSeen = new Map<string, number>();
  for (const event of events) {
    if (!event.login) continue;
    const previous = firstSeen.get(event.login);
    if (previous === undefined || event.at < previous) firstSeen.set(event.login, event.at);
  }
  let newcomers = 0;
  for (const login of participants) {
    if ((firstSeen.get(login) ?? windowStart) >= windowStart) newcomers += 1;
  }

  const ranked = [...categories.values()].sort((a, b) => b.events - a.events);
  const topEvents = ranked[0]?.events ?? 0;

  const bucketMs = windowMs / config.sparklineBuckets;
  const buckets = new Array<number>(config.sparklineBuckets).fill(0);
  for (const event of inWindow) {
    const index = Math.min(
      config.sparklineBuckets - 1,
      Math.max(0, Math.floor((event.at - windowStart) / bucketMs)),
    );
    buckets[index] += 1;
  }

  return {
    windowStart,
    windowEnd,

    participants: contributionsComplete
      ? { state: participants.size > 0 ? 'ok' : 'no-activity', value: participants.size }
      : { state: 'insufficient-history', value: null },

    discussionsOpened: reachesWindow
      ? { state: 'ok', value: openedInWindow.length }
      : { state: 'insufficient-history', value: null },

    comments: contributionsComplete
      ? { state: 'ok', value: inWindow.filter((event) => !event.isDiscussion).length }
      : { state: 'insufficient-history', value: null },

    answered:
      !reachesWindow
        ? { state: 'insufficient-history', value: null }
        : questions.length === 0
          ? { state: 'no-activity', value: null }
          : {
              state: 'ok',
              value: {
                answered,
                unanswered: questions.length - answered,
                ratio: answered / questions.length,
              },
            },

    medianFirstResponse:
      !reachesWindow || !responsesReadable
        ? { state: 'insufficient-history', value: null }
        : median === null
          ? { state: 'no-activity', value: null }
          : { state: 'ok', value: median },

    firstResponseSample: delays.length,

    cohorts: contributionsComplete
      ? {
          state: participants.size > 0 ? 'ok' : 'no-activity',
          value: { newcomers, returning: participants.size - newcomers },
        }
      : { state: 'insufficient-history', value: null },

    topCategory:
      !contributionsComplete
        ? { state: 'insufficient-history', value: null }
        : topEvents === 0
          ? { state: 'no-activity', value: null }
          : {
              state: 'ok',
              value: {
                names: ranked.filter((entry) => entry.events === topEvents).map((entry) => entry.name),
                events: topEvents,
              },
            },

    series: contributionsComplete
      ? {
          state: inWindow.length > 0 ? 'ok' : 'no-activity',
          value: { buckets, bucketDays: config.windowDays / config.sparklineBuckets },
        }
      : { state: 'insufficient-history', value: null },

    trend: contributionsComplete
      ? {
          state: inWindow.length === 0 && inPrevious.length === 0 ? 'no-activity' : 'ok',
          value: {
            current: inWindow.length,
            previous: inPrevious.length,
            change: inWindow.length - inPrevious.length,
            ratio:
              inPrevious.length === 0
                ? null
                : (inWindow.length - inPrevious.length) / inPrevious.length,
          },
        }
      : { state: 'insufficient-history', value: null },
  };
}
