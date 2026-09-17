import type { Metric } from './metrics.ts';

const DECIMAL = new Intl.NumberFormat('en');
const PERCENT = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });

export const decimal = DECIMAL;
export const percent = PERCENT;

const PLACEHOLDER: Record<Metric<unknown>['state'], string> = {
  ok: '',
  'no-activity': 'No activity',
  'insufficient-history': 'Insufficient history',
  unavailable: 'No data',
};

const HINT: Record<Metric<unknown>['state'], string> = {
  ok: '',
  'no-activity': 'Measured, and nothing happened in this window.',
  'insufficient-history': 'Read, but not far enough back to answer this honestly.',
  unavailable: 'The data could not be read when this page was built.',
};

export interface Presented {
  text: string;
  empty: boolean;
  title: string;
}

/**
 * `emptyLabel` overrides the wording for a measured-but-empty result, where a
 * blanket "No activity" would overclaim: a window can hold plenty of activity
 * and still contain no questions, or no answered ones.
 */
export function present<T>(
  metric: Metric<T>,
  render: (value: T) => string,
  emptyLabel?: string,
): Presented {
  if (metric.state === 'ok' && metric.value !== null) {
    return { text: render(metric.value), empty: false, title: '' };
  }
  const named = metric.state === 'no-activity' && emptyLabel !== undefined;
  return {
    text: named ? emptyLabel! : PLACEHOLDER[metric.state],
    empty: true,
    title: named ? 'Measured; there was nothing of this kind in the window.' : HINT[metric.state],
  };
}

export function duration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}
