import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from './metrics.ts';
import type { Category, Contribution, Discussion, Snapshot } from './model.ts';

const asOf = Date.parse('2026-09-16T12:00:00Z');
const category: Category = { id: 'q', name: 'Questions', slug: 'questions', isAnswerable: true };
const contribution = (login: string | null, createdAt: string): Contribution => ({
  createdAt, author: login ? { login } : null,
});
const discussion = (id: string, login: string | null, createdAt: string): Discussion => ({
  id, ...contribution(login, createdAt), category, isAnswered: false, comments: [], commentsComplete: true,
});
const snapshot = (discussions: Discussion[], discussionsComplete = true): Snapshot => ({
  repository: { owner: 'example', name: 'discussions' }, asOf, categories: [category],
  discussions, discussionsComplete, errors: [],
});

test('counts recent events on old threads and classifies visible participant history', () => {
  const old = discussion('old', 'returning', '2026-01-01T00:00:00Z');
  old.comments.push({
    id: 'c1', ...contribution('RETURNING', '2026-09-01T00:00:00Z'),
    replies: [contribution('new', '2026-09-02T00:00:00Z'), contribution(null, '2026-09-03T00:00:00Z')],
  });
  const recent = discussion('new', 'new', '2026-09-04T00:00:00Z');
  recent.isAnswered = true;
  const result = summarize(snapshot([old, recent]));
  assert.equal(result.participants, 2);
  assert.equal(result.discussions, 1);
  assert.equal(result.comments, 3);
  assert.equal(result.newParticipants, 1);
  assert.equal(result.returningParticipants, 1);
  assert.deepEqual(result.questions, { answered: 1, unanswered: 0 });
  assert.deepEqual(result.mostActive, [{ name: 'Questions', count: 4 }]);
});

test('median excludes self responses, unidentifiable authors, and unresponded discussions', () => {
  const first = discussion('a', 'author', '2026-09-01T00:00:00Z');
  first.comments.push({
    id: 'c1', ...contribution('AUTHOR', '2026-09-01T00:01:00Z'),
    replies: [contribution(null, '2026-09-01T00:02:00Z'), contribution('other', '2026-09-01T02:00:00Z')],
  });
  const second = discussion('b', 'author', '2026-09-02T00:00:00Z');
  second.comments.push({
    id: 'c2', ...contribution('other', '2026-09-02T04:00:00Z'), replies: [],
  });
  const result = summarize(snapshot([first, second, discussion('c', null, '2026-09-03T00:00:00Z')]));
  assert.equal(result.medianResponse, 3 * 3_600_000);
  assert.equal(result.responseSample, 2);
});

test('incomplete comments keep discussion and Q&A counts but invalidate contribution metrics', () => {
  const partial = discussion('a', 'author', '2026-09-01T00:00:00Z');
  partial.commentsComplete = false;
  const result = summarize(snapshot([partial]));
  assert.equal(result.discussions, 1);
  assert.deepEqual(result.questions, { answered: 0, unanswered: 1 });
  for (const key of ['participants', 'comments', 'newParticipants', 'returningParticipants', 'mostActive', 'medianResponse', 'responseSample'] as const) {
    assert.equal(result[key], null);
  }
});

test('incomplete discussion pagination never presents partial counts as totals', () => {
  const result = summarize(snapshot([discussion('a', 'user', '2026-09-01T00:00:00Z')], false));
  assert.ok(Object.values(result).every((value) => value === null));
});

test('complete empty repositories return zero counts, not fabricated response times', () => {
  const result = summarize(snapshot([]));
  assert.equal(result.discussions, 0);
  assert.equal(result.participants, 0);
  assert.equal(result.comments, 0);
  assert.equal(result.newParticipants, 0);
  assert.deepEqual(result.questions, { answered: 0, unanswered: 0 });
  assert.equal(result.medianResponse, null);
  assert.equal(result.responseSample, 0);
  assert.deepEqual(result.mostActive, []);
});

test('window boundaries are inclusive and future events are excluded', () => {
  const atStart = discussion('a', 'start', new Date(asOf - 30 * 86_400_000).toISOString());
  const before = discussion('b', 'before', new Date(asOf - 30 * 86_400_000 - 1).toISOString());
  const atEnd = discussion('c', 'end', new Date(asOf).toISOString());
  const future = discussion('d', 'future', new Date(asOf + 1).toISOString());
  const result = summarize(snapshot([atStart, before, atEnd, future]));
  assert.equal(result.discussions, 2);
  assert.equal(result.participants, 2);
});

test('answerable categories use the API flag, not a hardcoded name; activity ties are retained', () => {
  const first = discussion('a', 'one', '2026-09-01T00:00:00Z');
  const second = discussion('b', 'two', '2026-09-02T00:00:00Z');
  second.category = { id: 'g', name: 'General', slug: 'general', isAnswerable: false };
  second.isAnswered = true;
  const result = summarize(snapshot([first, second]));
  assert.deepEqual(result.questions, { answered: 0, unanswered: 1 });
  assert.equal(result.mostActive?.length, 2);
});
