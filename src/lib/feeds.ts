import type { Category, RepositoryRef } from './model.ts';

/**
 * GitHub exposes Atom feeds for a repository's discussion board and for each
 * category. Verified endpoints:
 *   https://github.com/OWNER/REPO/discussions.atom
 *   https://github.com/OWNER/REPO/discussions/categories/SLUG.atom
 *
 * An unknown slug returns HTTP 200 with an empty feed rather than 404, so
 * category feeds are only ever built from slugs the API reported.
 */

export function discussionsUrl(repository: RepositoryRef): string {
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/discussions`;
}

export function repositoryFeedUrl(repository: RepositoryRef): string {
  return `${discussionsUrl(repository)}.atom`;
}

export function categoryPageUrl(repository: RepositoryRef, category: Category): string {
  return `${discussionsUrl(repository)}/categories/${encodeURIComponent(category.slug)}`;
}

export function categoryFeedUrl(repository: RepositoryRef, category: Category): string {
  return `${categoryPageUrl(repository, category)}.atom`;
}
