export interface Repository {
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
  author: { login: string } | null;
}

export interface Comment extends Contribution {
  id: string;
  replies: Contribution[];
}

export interface Discussion extends Contribution {
  id: string;
  category: Category;
  isAnswered: boolean;
  comments: Comment[];
  commentsComplete: boolean;
}

export interface Snapshot {
  repository: Repository;
  asOf: number;
  categories: Category[];
  discussions: Discussion[];
  discussionsComplete: boolean;
  errors: string[];
}

export function discussionUrl(repository: Repository): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/discussions`;
}
