import type { AnalysisConfig } from '../config/site.ts';
import type {
  Category,
  Comment,
  Contribution,
  Discussion,
  RepositoryRef,
  Snapshot,
} from './model.ts';

const ENDPOINT = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 30_000;

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

type RawComment = Omit<Comment, 'replies' | 'repliesComplete'> & {
  replies: Connection<Contribution>;
};

type RawDiscussion = Omit<Discussion, 'comments' | 'commentsComplete'> & {
  comments: Connection<RawComment>;
};

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const CONTRIBUTION = 'createdAt author { login }';
const RATE_LIMIT = 'rateLimit { cost remaining resetAt }';

export function buildQueries(config: AnalysisConfig) {
  const comment = `id ${CONTRIBUTION}
    replies(first: ${config.replyPageSize}) { nodes { ${CONTRIBUTION} } ${PAGE_INFO} }`;

  return {
    repository: `query Repository($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        hasDiscussionsEnabled
        discussionCategories(first: 100) { nodes { id name slug isAnswerable } }
      }
      ${RATE_LIMIT}
    }`,

    discussions: `query Discussions($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        discussions(first: ${config.discussionPageSize}, after: $cursor,
                    orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            id number ${CONTRIBUTION} isAnswered answerChosenAt
            category { id name slug isAnswerable }
            comments(first: ${config.commentPageSize}) { nodes { ${comment} } ${PAGE_INFO} }
          }
          ${PAGE_INFO}
        }
      }
      ${RATE_LIMIT}
    }`,

    comments: `query Comments($id: ID!, $cursor: String) {
      node(id: $id) { ... on Discussion {
        comments(first: ${config.commentPageSize}, after: $cursor) { nodes { ${comment} } ${PAGE_INFO} }
      } }
      ${RATE_LIMIT}
    }`,

    replies: `query Replies($id: ID!, $cursor: String) {
      node(id: $id) { ... on DiscussionComment {
        replies(first: ${config.replyPageSize}, after: $cursor) { nodes { ${CONTRIBUTION} } ${PAGE_INFO} }
      } }
      ${RATE_LIMIT}
    }`,
  };
}

/** Thrown when the budget or rate limit stops a fetch. Data gathered so far is kept. */
export class BudgetExhausted extends Error {}

function rateLimitMessage(resetAt: string | null): string {
  if (!resetAt || !Number.isFinite(Date.parse(resetAt))) {
    return 'GitHub rate limit reached. Try again later.';
  }
  return `GitHub rate limit reached. Resets at ${new Date(resetAt).toLocaleTimeString()}.`;
}

export interface Client {
  request<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  readonly requests: number;
  readonly remaining: number | null;
  readonly resetAt: string | null;
}

export function createClient(
  token: string,
  config: AnalysisConfig,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): Client {
  let requests = 0;
  let remaining: number | null = null;
  let resetAt: string | null = null;

  return {
    get requests() {
      return requests;
    },
    get remaining() {
      return remaining;
    },
    get resetAt() {
      return resetAt;
    },

    async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      if (signal.aborted) throw new BudgetExhausted('Loading cancelled.');
      if (requests >= config.maxRequests) {
        throw new BudgetExhausted(
          `Request budget of ${config.maxRequests} reached. History was not read to the end.`,
        );
      }
      if (remaining !== null && remaining <= config.rateLimitFloor) {
        throw new BudgetExhausted(rateLimitMessage(resetAt));
      }

      requests += 1;
      onProgress(`Reading discussions: request ${requests}`);

      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        throw new BudgetExhausted(
          signal.aborted
            ? 'Loading cancelled.'
            : 'GitHub could not be reached, or the request timed out.',
        );
      }

      const headerRemaining = response.headers.get('x-ratelimit-remaining');
      if (headerRemaining !== null && headerRemaining !== '') remaining = Number(headerRemaining);
      const headerReset = Number(response.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(headerReset) && headerReset > 0) {
        resetAt = new Date(headerReset * 1000).toISOString();
      }

      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429 || (response.status === 403 && (remaining === 0 || retryAfter))) {
        remaining = 0;
        if (retryAfter && /^\d+$/.test(retryAfter)) {
          resetAt = new Date(Date.now() + Number(retryAfter) * 1000).toISOString();
        }
        throw new BudgetExhausted(rateLimitMessage(resetAt));
      }
      if (response.status === 401) {
        throw new Error('GitHub rejected the token. Check that it is valid and not expired.');
      }
      if (response.status === 403) {
        throw new Error('GitHub denied access. Check the token grants read access to this repository.');
      }
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}.`);
      }

      const body = await response.json();
      if (body.data?.rateLimit) {
        remaining = body.data.rateLimit.remaining;
        resetAt = body.data.rateLimit.resetAt;
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        if (body.errors.some((error: { type?: string }) => error.type === 'RATE_LIMITED')) {
          remaining = 0;
          throw new BudgetExhausted(rateLimitMessage(resetAt));
        }
        const detail = body.errors[0]?.message ?? 'unspecified error';
        throw new Error(`GitHub rejected the query: ${detail}`);
      }
      if (!body.data) throw new Error('GitHub returned no data.');
      return body.data as T;
    },
  };
}

function assertConnection<T>(connection: Connection<T> | null | undefined): Connection<T> {
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
    throw new Error('GitHub returned an unexpected response shape.');
  }
  return connection;
}

/** Paginates a connection to exhaustion, guarding against a cursor that never advances. */
async function drain<T>(
  first: Connection<T>,
  more: (cursor: string) => Promise<Connection<T>>,
): Promise<T[]> {
  const collected: T[] = [];
  const seen = new Set<string>();
  let connection = first;

  for (;;) {
    collected.push(...connection.nodes.filter((node): node is T => node !== null));
    if (!connection.pageInfo.hasNextPage) return collected;

    const cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) {
      throw new Error('GitHub pagination did not advance.');
    }
    seen.add(cursor);
    connection = assertConnection(await more(cursor));
  }
}

export async function fetchSnapshot(
  repository: RepositoryRef,
  token: string,
  config: AnalysisConfig,
  signal: AbortSignal,
  onProgress: (message: string) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<Snapshot> {
  const queries = buildQueries(config);
  const client = createClient(token, config, signal, onProgress, fetchImpl);

  const snapshot: Snapshot = {
    repository,
    asOf: Date.now(),
    categories: [],
    discussions: [],
    historyComplete: false,
    oldestFetchedAt: null,
    requests: 0,
    rateLimit: { remaining: null, resetAt: null },
    errors: [],
  };

  const finish = () => {
    snapshot.requests = client.requests;
    snapshot.rateLimit = { remaining: client.remaining, resetAt: client.resetAt };
    const timestamps = snapshot.discussions.map((discussion) => Date.parse(discussion.createdAt));
    snapshot.oldestFetchedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
    return snapshot;
  };

  try {
    const data = await client.request<{
      repository: {
        hasDiscussionsEnabled: boolean;
        discussionCategories: { nodes: Category[] };
      } | null;
    }>(queries.repository, { ...repository });

    if (!data.repository) {
      snapshot.errors.push('Repository not found, or the token cannot see it.');
      return finish();
    }
    if (!data.repository.hasDiscussionsEnabled) {
      snapshot.errors.push('Discussions are disabled for this repository.');
      return finish();
    }
    snapshot.categories = data.repository.discussionCategories.nodes.filter(Boolean);
  } catch (error) {
    snapshot.errors.push(error instanceof Error ? error.message : 'GitHub is unavailable.');
    return finish();
  }

  // Newest first, so a truncated fetch still covers the reporting window.
  type DiscussionPage = { repository: { discussions: Connection<RawDiscussion> } | null };
  const raw: RawDiscussion[] = [];
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      const data: DiscussionPage = await client.request<DiscussionPage>(queries.discussions, {
        ...repository,
        cursor,
      });

      const connection: Connection<RawDiscussion> = assertConnection(data.repository?.discussions);
      for (const node of connection.nodes) {
        if (!node) continue;
        raw.push(node);
        const comments: RawComment[] = assertConnection(node.comments).nodes.filter(Boolean);
        snapshot.discussions.push({
          ...node,
          comments: comments.map((entry) => ({
            ...entry,
            replies: assertConnection(entry.replies).nodes.filter(Boolean),
            repliesComplete: !entry.replies.pageInfo.hasNextPage,
          })),
          commentsComplete:
            !node.comments.pageInfo.hasNextPage &&
            comments.every((entry) => !entry.replies.pageInfo.hasNextPage),
        });
      }

      if (!connection.pageInfo.hasNextPage) {
        snapshot.historyComplete = true;
        break;
      }
      cursor = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new Error('GitHub pagination did not advance.');
      seen.add(cursor);
    }
  } catch (error) {
    snapshot.errors.push(error instanceof Error ? error.message : 'GitHub is unavailable.');
  }

  // Backfill only the threads that overflowed their inline page.
  try {
    for (const [index, node] of raw.entries()) {
      const discussion = snapshot.discussions[index];
      if (!discussion || discussion.commentsComplete) continue;

      const comments = await drain(assertConnection(node.comments), async (cursor) => {
        const data = await client.request<{ node: { comments: Connection<RawComment> } | null }>(
          queries.comments,
          { id: node.id, cursor },
        );
        return assertConnection(data.node?.comments);
      });

      discussion.comments = [];
      for (const entry of comments) {
        const replies = await drain(assertConnection(entry.replies), async (cursor) => {
          const data = await client.request<{ node: { replies: Connection<Contribution> } | null }>(
            queries.replies,
            { id: entry.id, cursor },
          );
          return assertConnection(data.node?.replies);
        });
        discussion.comments.push({ ...entry, replies, repliesComplete: true });
      }
      discussion.commentsComplete = true;
    }
  } catch (error) {
    snapshot.errors.push(error instanceof Error ? error.message : 'GitHub is unavailable.');
  }

  return finish();
}
