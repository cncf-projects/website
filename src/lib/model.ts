export interface RepositoryRef {
  owner: string;
  name: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  isAnswerable: boolean;
}

export interface Contribution {
  createdAt: string;
  /** Null when the account was deleted. Such contributions cannot be attributed. */
  author: { login: string } | null;
}

export interface Comment extends Contribution {
  id: string;
  replies: Contribution[];
  repliesComplete: boolean;
}

export interface Discussion extends Contribution {
  id: string;
  number: number;
  category: Category;
  /** Null in categories that do not accept answers. Not the same as false. */
  isAnswered: boolean | null;
  answerChosenAt: string | null;
  comments: Comment[];
  commentsComplete: boolean;
}

export interface RateLimitState {
  remaining: number | null;
  resetAt: string | null;
}

export interface Snapshot {
  repository: RepositoryRef;
  /** Wall clock at the start of the fetch. All windows are measured back from here. */
  asOf: number;
  categories: Category[];
  discussions: Discussion[];
  /**
   * True when the discussion connection was paginated to exhaustion. False when
   * the request budget or rate limit stopped it early, which bounds how far back
   * history-dependent metrics can look.
   */
  historyComplete: boolean;
  /** Creation time of the oldest discussion actually fetched, in ms. */
  oldestFetchedAt: number | null;
  requests: number;
  rateLimit: RateLimitState;
  /** Human-readable failures. A non-empty list does not imply zero usable data. */
  errors: string[];
}

export function repositoryLabel(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}
