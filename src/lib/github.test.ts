import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnalysisConfig } from '../config/site.ts';
import { fetchSnapshot } from './github.ts';

const config: AnalysisConfig = {
  windowDays: 90,
  sparklineBuckets: 13,
  maxRequests: 10,
  rateLimitFloor: 50,
  discussionPageSize: 2,
  commentPageSize: 2,
  replyPageSize: 2,
};

const REPO = { owner: 'acme', name: 'widget' };

interface Reply {
  createdAt: string;
  author: { login: string } | null;
}

interface StubConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface StubComment {
  id: string;
  createdAt: string;
  author: { login: string } | null;
  replies: StubConnection<Reply>;
}

function connection<T>(
  nodes: T[],
  hasNextPage = false,
  endCursor: string | null = null,
): StubConnection<T> {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function comment(
  id: string,
  replies: Reply[],
  repliesNext = false,
  cursor: string | null = null,
): StubComment {
  return {
    id,
    createdAt: '2026-09-10T00:00:00Z',
    author: { login: 'bob' },
    replies: connection(replies, repliesNext, cursor),
  };
}

function discussion(id: string, comments: StubComment[], commentsNext = false) {
  return {
    id,
    number: Number(id.slice(1)),
    createdAt: '2026-09-01T00:00:00Z',
    author: { login: 'alice' },
    isAnswered: null,
    answerChosenAt: null,
    category: { id: 'gen', name: 'General', slug: 'general', isAnswerable: false },
    comments: connection(comments, commentsNext, commentsNext ? 'c-cursor' : null),
  };
}

/** Builds a fetch stub that answers by GraphQL operation name. */
function stub(
  handlers: Record<string, (vars: Record<string, unknown>, call: number) => unknown>,
  headers: Record<string, string> = {},
) {
  const calls: string[] = [];
  const counts: Record<string, number> = {};

  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const name = /query (\w+)/.exec(body.query)?.[1] ?? 'unknown';
    calls.push(name);
    counts[name] = (counts[name] ?? 0) + 1;

    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected operation ${name}`);
    const payload = handler(body.variables, counts[name]!);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const RATE = { rateLimit: { cost: 1, remaining: 4999, resetAt: null } };
const ENABLED = {
  data: {
    repository: {
      hasDiscussionsEnabled: true,
      discussionCategories: {
        nodes: [{ id: 'gen', name: 'General', slug: 'general', isAnswerable: false }],
      },
    },
    ...RATE,
  },
};

test('discussion pages are followed to exhaustion and marked complete', async () => {
  const { impl, calls } = stub({
    Repository: () => ENABLED,
    Discussions: (_vars, call) =>
      call === 1
        ? {
            data: {
              repository: { discussions: connection([discussion('d1', []), discussion('d2', [])], true, 'page2') },
              ...RATE,
            },
          }
        : {
            data: {
              repository: { discussions: connection([discussion('d3', [])]) },
              ...RATE,
            },
          },
  });

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);

  assert.equal(snapshot.discussions.length, 3);
  assert.equal(snapshot.historyComplete, true);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(calls.filter((name) => name === 'Discussions').length, 2);
});

test('an overflowing thread is backfilled across comment and reply pages', async () => {
  // d1 arrives with one comment page and one reply page outstanding.
  const { impl } = stub({
    Repository: () => ENABLED,
    Discussions: () => ({
      data: {
        repository: {
          discussions: connection([
            discussion('d1', [comment('k1', [{ createdAt: '2026-09-11T00:00:00Z', author: { login: 'carol' } }], true, 'r2')], true),
          ]),
        },
        ...RATE,
      },
    }),
    Comments: () => ({
      data: {
        node: { comments: connection([comment('k2', [])]) },
        ...RATE,
      },
    }),
    Replies: () => ({
      data: {
        node: { replies: connection([{ createdAt: '2026-09-12T00:00:00Z', author: { login: 'dave' } }]) },
        ...RATE,
      },
    }),
  });

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);
  const [first] = snapshot.discussions;

  assert.equal(first!.commentsComplete, true);
  assert.equal(first!.comments.length, 2);
  assert.equal(first!.comments[0]!.replies.length, 2, 'inline reply plus the backfilled page');
  assert.ok(first!.comments.every((entry) => entry.repliesComplete));
});

test('nested pagination cut short by the budget leaves the thread marked incomplete', async () => {
  // The budget allows the repository probe and one discussion page only, so the
  // outstanding comment page is never read. historyComplete must not imply that
  // contributions were fully read.
  const tight = { ...config, maxRequests: 2 };
  const { impl } = stub({
    Repository: () => ENABLED,
    Discussions: () => ({
      data: {
        repository: { discussions: connection([discussion('d1', [comment('k1', [])], true)]) },
        ...RATE,
      },
    }),
    Comments: () => {
      throw new Error('budget should have stopped this');
    },
  });

  const snapshot = await fetchSnapshot(REPO, 'token', tight, new AbortController().signal, () => {}, impl);

  assert.equal(snapshot.historyComplete, true, 'the discussion connection did finish');
  assert.equal(snapshot.discussions[0]!.commentsComplete, false, 'but its comments did not');
  assert.equal(snapshot.errors.length, 1);
  assert.match(snapshot.errors[0]!, /budget/i);
});

test('a rate-limited response stops the fetch and reports the reset time', async () => {
  const { impl } = stub({
    Repository: () => ENABLED,
    Discussions: () => ({
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
      data: { rateLimit: { cost: 1, remaining: 0, resetAt: '2026-09-17T13:00:00Z' } },
    }),
  });

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);

  assert.equal(snapshot.historyComplete, false);
  assert.equal(snapshot.discussions.length, 0);
  assert.match(snapshot.errors[0]!, /rate limit/i);
});

test('a cursor that does not advance is refused instead of looping forever', async () => {
  const { impl, calls } = stub({
    Repository: () => ENABLED,
    Discussions: () => ({
      data: {
        repository: { discussions: connection([discussion('d1', [])], true, 'same-cursor') },
        ...RATE,
      },
    }),
  });

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);

  assert.equal(snapshot.historyComplete, false);
  assert.match(snapshot.errors[0]!, /did not advance/i);
  assert.ok(calls.filter((name) => name === 'Discussions').length < config.maxRequests);
});

test('discussions being disabled is reported without touching the rest of the page', async () => {
  const { impl, calls } = stub({
    Repository: () => ({
      data: {
        repository: { hasDiscussionsEnabled: false, discussionCategories: { nodes: [] } },
        ...RATE,
      },
    }),
  });

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);

  assert.match(snapshot.errors[0]!, /disabled/i);
  assert.deepEqual(calls, ['Repository'], 'no further requests are spent');
});

test('an unauthorised token is reported as a token problem', async () => {
  const impl = (async () =>
    new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  const snapshot = await fetchSnapshot(REPO, 'token', config, new AbortController().signal, () => {}, impl);
  assert.match(snapshot.errors[0]!, /token/i);
});
