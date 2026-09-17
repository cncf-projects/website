/**
 * The enrollment seam.
 *
 * Every repository rendered by this site comes from `repositories`. Nothing
 * downstream of this file knows the name "cert-manager". Scaling to the full
 * CNCF Landscape means replacing the contents of this array with generated
 * data; no component, metric, or fetch code changes.
 */

export interface RepositoryConfig {
  owner: string;
  name: string;
  /** Optional display label. Defaults to `owner/name`. */
  label?: string;
}

export const repositories: RepositoryConfig[] = [
  { owner: 'bootc-dev', name: 'bootc' },
  { owner: 'cert-manager', name: 'cert-manager' },
  { owner: 'cloud-custodian', name: 'cloud-custodian' },
  { owner: 'Project-HAMi', name: 'HAMi' },
  { owner: 'kubestellar', name: 'kubestellar' },
  { owner: 'perses', name: 'perses' },
];

export interface AnalysisConfig {
  /** Length of the reporting window, in days. */
  windowDays: number;
  /** Number of buckets in the activity sparkline. */
  sparklineBuckets: number;
  /** Hard ceiling on GraphQL requests per repository, per load. */
  maxRequests: number;
  /** Stop paginating when the remaining GraphQL point budget drops below this. */
  rateLimitFloor: number;
  /**
   * Page sizes. GitHub rejects queries whose theoretical node count exceeds
   * 500,000: discussions * comments * replies must stay well under it.
   * 25 * 50 * 50 requests at most 62,525 nodes.
   */
  discussionPageSize: number;
  commentPageSize: number;
  replyPageSize: number;
}

export const analysis: AnalysisConfig = {
  windowDays: 90,
  sparklineBuckets: 13,
  maxRequests: 60,
  rateLimitFloor: 50,
  discussionPageSize: 25,
  commentPageSize: 50,
  replyPageSize: 50,
};
