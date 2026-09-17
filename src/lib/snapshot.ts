import { analysis, repositories } from '../config/site.ts';
import { fetchSnapshot } from './github.ts';
import { summarize, type Summary } from './metrics.ts';
import type { RepositoryRef, Snapshot } from './model.ts';

/**
 * Discussion data is read while the page is built, using the workflow's
 * GITHUB_TOKEN. The GraphQL API refuses anonymous requests, and a static site
 * has nowhere to keep a credential that visitors could use, so fetching here is
 * what lets the published page carry real numbers without asking anyone for a
 * token. The trade is that figures are current as of the build, not the visit.
 */

export interface RepositoryView {
  key: string;
  label: string;
  repository: RepositoryRef;
  snapshot: Snapshot;
  summary: Summary;
}

const BUILD_TIMEOUT_MS = 180_000;
const CONCURRENCY = 4;

function unread(repository: RepositoryRef, reason: string): Snapshot {
  return {
    repository,
    asOf: Date.now(),
    categories: [],
    discussions: [],
    historyComplete: false,
    oldestFetchedAt: null,
    requests: 0,
    rateLimit: { remaining: null, resetAt: null },
    errors: [reason],
  };
}

export async function loadRepositoryViews(): Promise<RepositoryView[]> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const views = new Array<RepositoryView>(repositories.length);
  const queue = repositories.map((config, index) => ({ config, index }));

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;

      const repository: RepositoryRef = { owner: item.config.owner, name: item.config.name };
      let snapshot: Snapshot;

      if (!token) {
        snapshot = unread(
          repository,
          'No GITHUB_TOKEN was available when this page was built.',
        );
      } else {
        try {
          snapshot = await fetchSnapshot(
            repository,
            token,
            analysis,
            AbortSignal.timeout(BUILD_TIMEOUT_MS),
          );
        } catch (error) {
          // A build must not fail because one repository was unreadable; the
          // page states that instead.
          snapshot = unread(
            repository,
            error instanceof Error ? error.message : 'This repository could not be read.',
          );
        }
      }

      views[item.index] = {
        key: `${item.config.owner}/${item.config.name}`,
        label: item.config.label ?? `${item.config.owner}/${item.config.name}`,
        repository,
        snapshot,
        summary: summarize(snapshot, analysis),
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return views;
}
