import type { Category, Comment, Contribution, Discussion, Repository, Snapshot } from './model.ts';

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

type RawComment = Omit<Comment, 'replies'> & { replies: Connection<Contribution> };
type RawDiscussion = Omit<Discussion, 'comments' | 'commentsComplete'> & {
  comments: Connection<RawComment>;
};

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const contributionFields = 'createdAt author { login }';
const commentFields = `id ${contributionFields}
  replies(first: 20) { nodes { ${contributionFields} } ${pageInfo} }`;
const rateFields = 'rateLimit { remaining resetAt }';

export const queries = {
  enabled: `query Enabled($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { hasDiscussionsEnabled }
    ${rateFields}
  }`,
  categories: `query Categories($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussionCategories(first: 100, after: $cursor) {
        nodes { id name slug isAnswerable } ${pageInfo}
      }
    }
    ${rateFields}
  }`,
  discussions: `query Discussions($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 20, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          id ${contributionFields} isAnswered
          category { id name slug isAnswerable }
          comments(first: 20) { nodes { ${commentFields} } ${pageInfo} }
        }
        ${pageInfo}
      }
    }
    ${rateFields}
  }`,
  comments: `query Comments($id: ID!, $cursor: String) {
    node(id: $id) { ... on Discussion {
      comments(first: 20, after: $cursor) { nodes { ${commentFields} } ${pageInfo} }
    } }
    ${rateFields}
  }`,
  replies: `query Replies($id: ID!, $cursor: String) {
    node(id: $id) { ... on DiscussionComment {
      replies(first: 100, after: $cursor) { nodes { ${contributionFields} } ${pageInfo} }
    } }
    ${rateFields}
  }`,
};

function rateMessage(resetAt?: string): string {
  const reset = resetAt && Number.isFinite(Date.parse(resetAt)) ?
    ` Try again after ${new Date(resetAt).toLocaleString()}.` : ' Try again later.';
  return `GitHub rate limit reached.${reset}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub data is unavailable.';
}

function createClient(token: string, signal: AbortSignal, progress: (message: string) => void) {
  let remaining: number | undefined;
  let resetAt: string | undefined;
  let requests = 0;

  return async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (signal.aborted) throw new Error('Loading cancelled.');
    if (remaining === 0) throw new Error(rateMessage(resetAt));
    progress(`Reading GitHub data · request ${++requests}`);
    let response: Response;
    try {
      response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Error(signal.aborted ? 'Loading cancelled.' :
        'GitHub could not be reached or the request timed out. Retry when your connection is available.');
    }
    const headerRemaining = response.headers.get('x-ratelimit-remaining');
    if (headerRemaining !== null) remaining = Number(headerRemaining);
    const headerReset = Number(response.headers.get('x-ratelimit-reset'));
    if (headerReset > 0) resetAt = new Date(headerReset * 1000).toISOString();
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || (response.status === 403 && (remaining === 0 || retryAfter))) {
      remaining = 0;
      if (retryAfter) {
        resetAt = /^\d+$/.test(retryAfter) ?
          new Date(Date.now() + Number(retryAfter) * 1000).toISOString() : retryAfter;
      }
      throw new Error(rateMessage(resetAt));
    }
    if (response.status === 401) throw new Error('GitHub rejected the token. Check its validity and try again.');
    if (response.status === 403) throw new Error('GitHub denied access or applied a secondary rate limit. Check token access and retry later.');
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Retry later.`);

    const result = await response.json();
    if (result.data?.rateLimit) {
      remaining = result.data.rateLimit.remaining;
      resetAt = result.data.rateLimit.resetAt;
    }
    if (result.errors?.length) {
      if (result.errors.some((error: { type?: string }) => error.type === 'RATE_LIMITED')) {
        remaining = 0;
        throw new Error(rateMessage(resetAt));
      }
      throw new Error('GitHub could not return all requested fields. Check repository access and retry.');
    }
    if (!result.data) throw new Error('GitHub returned no data.');
    return result.data as T;
  };
}

function nodes<T>(connection: Connection<T>): T[] {
  if (!connection || !Array.isArray(connection.nodes) ||
    connection.nodes.some((node) => node === null) || !connection.pageInfo) {
    throw new Error('GitHub returned incomplete data. Affected metrics are unavailable.');
  }
  return connection.nodes;
}

function nextCursor<T>(connection: Connection<T>, seen: Set<string>): string | null {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) {
    throw new Error('GitHub pagination did not advance. Retry the fetch.');
  }
  seen.add(cursor);
  return cursor;
}

async function collect<T>(
  first: Connection<T>,
  more: (cursor: string) => Promise<Connection<T>>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let connection = first;
  while (true) {
    result.push(...nodes(connection));
    const cursor = nextCursor(connection, seen);
    if (!cursor) return result;
    connection = await more(cursor);
  }
}

function initialDiscussion(raw: RawDiscussion): Discussion {
  const comments = nodes(raw.comments);
  return {
    ...raw,
    comments: comments.map((comment) => ({ ...comment, replies: nodes(comment.replies) })),
    commentsComplete: !raw.comments.pageInfo.hasNextPage &&
      comments.every((comment) => !comment.replies.pageInfo.hasNextPage),
  };
}

export async function fetchRepository(
  repository: Repository,
  token: string,
  signal: AbortSignal,
  progress: (message: string) => void = () => {},
): Promise<Snapshot> {
  const snapshot: Snapshot = {
    repository, asOf: Date.now(), categories: [], discussions: [],
    discussionsComplete: false, errors: [],
  };
  const request = createClient(token, signal, progress);
  try {
    const data = await request<{ repository: { hasDiscussionsEnabled: boolean } | null }>(
      queries.enabled, { ...repository },
    );
    if (!data.repository) throw new Error('Repository not found or not accessible with this token.');
    if (!data.repository.hasDiscussionsEnabled) throw new Error('Discussions are disabled for this repository.');
  } catch (error) {
    snapshot.errors.push(errorMessage(error));
    return snapshot;
  }

  try {
    const categoryPage = async (cursor: string | null) => {
      const data = await request<{ repository: { discussionCategories: Connection<Category> } }>(
        queries.categories, { ...repository, cursor },
      );
      return data.repository?.discussionCategories;
    };
    snapshot.categories = await collect(await categoryPage(null), categoryPage);
  } catch (error) {
    snapshot.errors.push(errorMessage(error));
  }

  const rawDiscussions: RawDiscussion[] = [];
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const data = await request<{ repository: { discussions: Connection<RawDiscussion> } }>(
        queries.discussions, { ...repository, cursor },
      );
      const connection = data.repository?.discussions;
      for (const raw of nodes(connection)) {
        rawDiscussions.push(raw);
        snapshot.discussions.push(initialDiscussion(raw));
      }
      cursor = nextCursor(connection, seen);
    } while (cursor);
    snapshot.discussionsComplete = true;
  } catch (error) {
    snapshot.errors.push(errorMessage(error));
    return snapshot;
  }

  try {
    for (const [index, raw] of rawDiscussions.entries()) {
      const discussion = snapshot.discussions[index];
      if (discussion.commentsComplete) continue;
      const comments = await collect(raw.comments, async (cursor) => {
        const data = await request<{ node: { comments: Connection<RawComment> } }>(
          queries.comments, { id: raw.id, cursor },
        );
        return data.node?.comments;
      });
      discussion.comments = [];
      for (const comment of comments) {
        const replies = await collect(comment.replies, async (cursor) => {
          const data = await request<{ node: { replies: Connection<Contribution> } }>(
            queries.replies, { id: comment.id, cursor },
          );
          return data.node?.replies;
        });
        discussion.comments.push({ ...comment, replies });
      }
      discussion.commentsComplete = true;
    }
  } catch (error) {
    snapshot.errors.push(errorMessage(error));
  }
  return snapshot;
}
