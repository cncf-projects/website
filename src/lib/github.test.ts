import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fetchRepository } from './github.ts';
import { summarize } from './metrics.ts';

const repository = { owner: 'example', name: 'board' };
const category = { id: 'qa', name: 'Questions', slug: 'questions', isAnswerable: true };
const contribution = { createdAt: new Date().toISOString(), author: { login: 'participant' } };
const connection = <T>(nodes: T[], cursor: string | null = null) => ({
  nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const rawComment = (id: string, replyCursor: string | null = null) => ({
  id, ...contribution, replies: connection([contribution], replyCursor),
});
const rawDiscussion = (id: string, commentCursor: string | null = null, replyCursor: string | null = null) => ({
  id, ...contribution, category, isAnswered: false,
  comments: connection([rawComment(`${id}-comment`, replyCursor)], commentCursor),
});

interface Step {
  operation: string;
  data?: unknown;
  errors?: unknown[];
  status?: number;
  headers?: Record<string, string>;
  variables?: Record<string, unknown>;
}

function mockApi(t: TestContext, steps: Step[]) {
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const step = steps[index++];
    assert.ok(step, 'Unexpected API request');
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body as string);
    assert.ok(body.query.includes(`query ${step.operation}(`));
    if (step.variables) assert.deepEqual(body.variables, step.variables);
    return new Response(JSON.stringify({ data: step.data, errors: step.errors }), {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...step.headers },
    });
  });
  return () => assert.equal(index, steps.length, 'Not all expected pages were fetched');
}

const enabled: Step = { operation: 'Enabled', data: { repository: { hasDiscussionsEnabled: true } } };
const categories: Step = {
  operation: 'Categories', data: { repository: { discussionCategories: connection([category]) } },
};
const load = () => fetchRepository(repository, 'test-only-token', new AbortController().signal);

test('paginates categories, discussions, comments and replies independently', async (t) => {
  const verify = mockApi(t, [
    enabled,
    { operation: 'Categories', data: { repository: { discussionCategories: connection([category], 'cat-next') } } },
    { operation: 'Categories', variables: { ...repository, cursor: 'cat-next' },
      data: { repository: { discussionCategories: connection([{ ...category, id: 'g' }]) } } },
    { operation: 'Discussions', data: { repository: { discussions: connection([rawDiscussion('d1', 'comment-next', 'reply-next')], 'discussion-next') } } },
    { operation: 'Discussions', variables: { ...repository, cursor: 'discussion-next' },
      data: { repository: { discussions: connection([rawDiscussion('d2')]) } } },
    { operation: 'Comments', variables: { id: 'd1', cursor: 'comment-next' },
      data: { node: { comments: connection([rawComment('c2', 'c2-replies')], 'more-comments') } } },
    { operation: 'Comments', variables: { id: 'd1', cursor: 'more-comments' },
      data: { node: { comments: connection([rawComment('c3')]) } } },
    { operation: 'Replies', variables: { id: 'd1-comment', cursor: 'reply-next' },
      data: { node: { replies: connection([contribution], 'reply-last') } } },
    { operation: 'Replies', variables: { id: 'd1-comment', cursor: 'reply-last' },
      data: { node: { replies: connection([contribution]) } } },
    { operation: 'Replies', variables: { id: 'c2', cursor: 'c2-replies' },
      data: { node: { replies: connection([contribution]) } } },
  ]);
  const result = await load();
  verify();
  assert.deepEqual(result.errors, []);
  assert.equal(result.categories.length, 2);
  assert.equal(result.discussions.length, 2);
  assert.ok(result.discussionsComplete);
  assert.ok(result.discussions.every((discussion) => discussion.commentsComplete));
  assert.equal(result.discussions[0].comments.length, 3);
  assert.equal(result.discussions[0].comments[0].replies.length, 3);
  assert.equal(result.discussions[0].comments[1].replies.length, 2);
  assert.equal(summarize(result).comments, 11);
});

test('disabled discussions stop fetching and leave metrics unavailable', async (t) => {
  const verify = mockApi(t, [{
    operation: 'Enabled', data: { repository: { hasDiscussionsEnabled: false } },
  }]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /disabled/);
  assert.equal(summarize(result).discussions, null);
});

test('unavailable repository reports no data', async (t) => {
  const verify = mockApi(t, [{ operation: 'Enabled', data: { repository: null } }]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /not found/);
});

test('authentication failure is actionable and never exposes the token', async (t) => {
  const verify = mockApi(t, [{ operation: 'Enabled', status: 401 }]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /rejected the token/);
  assert.ok(!JSON.stringify(result).includes('test-only-token'));
});

test('rate budget exhaustion stops before another request and includes reset time', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions', data: {
      repository: { discussions: connection([rawDiscussion('d1')], 'next') },
      rateLimit: { remaining: 0, resetAt: '2026-09-17T00:00:00Z' },
    } },
  ]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /rate limit reached.*Try again after/);
  assert.equal(summarize(result).discussions, null);
});

test('HTTP secondary rate limits honor Retry-After without automatic retry loops', async (t) => {
  const verify = mockApi(t, [{ operation: 'Enabled', status: 429, headers: { 'retry-after': '60' } }]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /rate limit reached.*Try again after/);
});

test('HTTP primary rate-limit headers are handled', async (t) => {
  const verify = mockApi(t, [{
    operation: 'Enabled', status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
  }]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /rate limit reached/);
});

test('GraphQL rate-limit errors stop pagination even under HTTP 200', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions', errors: [{ type: 'RATE_LIMITED' }] },
  ]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /rate limit reached/);
});

test('failed reply pagination preserves complete discussion counts, not partial engagement counts', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions', data: { repository: { discussions: connection([rawDiscussion('d1', null, 'next')]) } } },
    { operation: 'Replies', status: 503 },
  ]);
  const result = await load();
  verify();
  assert.equal(result.discussionsComplete, true);
  assert.equal(summarize(result).discussions, 1);
  assert.equal(summarize(result).comments, null);
  assert.equal(summarize(result).participants, null);
  assert.match(result.errors[0], /HTTP 503/);
});

test('category failure does not prevent otherwise available engagement metrics', async (t) => {
  const verify = mockApi(t, [
    enabled,
    { operation: 'Categories', errors: [{ type: 'FORBIDDEN' }] },
    { operation: 'Discussions', data: { repository: { discussions: connection([]) } } },
  ]);
  const result = await load();
  verify();
  assert.equal(result.categories.length, 0);
  assert.equal(summarize(result).comments, 0);
  assert.equal(result.errors.length, 1);
});

test('repeated cursors abort instead of looping indefinitely', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions', data: { repository: { discussions: connection([rawDiscussion('d1')], 'same') } } },
    { operation: 'Discussions', data: { repository: { discussions: connection([rawDiscussion('d2')], 'same') } } },
  ]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /pagination did not advance/);
  assert.equal(summarize(result).discussions, null);
});

test('missing connection data is not interpreted as an empty discussion board', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions', data: { repository: { discussions: null } } },
  ]);
  const result = await load();
  verify();
  assert.match(result.errors[0], /incomplete data/);
  assert.equal(summarize(result).discussions, null);
});

test('partial GraphQL errors never silently become complete counts', async (t) => {
  const verify = mockApi(t, [
    enabled, categories,
    { operation: 'Discussions',
      data: { repository: { discussions: connection([]) } },
      errors: [{ type: 'FORBIDDEN', message: 'a private upstream detail' }] },
  ]);
  const result = await load();
  verify();
  assert.equal(summarize(result).discussions, null);
  assert.ok(!JSON.stringify(result).includes('private upstream detail'));
});

test('network failure keeps a usable no-data result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  const result = await load();
  assert.match(result.errors[0], /could not be reached/);
  assert.equal(summarize(result).participants, null);
});

test('cancellation stops before fetching', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  const controller = new AbortController();
  controller.abort();
  const result = await fetchRepository(repository, 'test-only-token', controller.signal);
  assert.equal(mock.mock.callCount(), 0);
  assert.match(result.errors[0], /cancelled/);
});
