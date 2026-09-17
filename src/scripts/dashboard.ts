import { analysis, repositories } from '../config/site';
import { categoryFeedUrl } from '../lib/feeds';
import { fetchSnapshot } from '../lib/github';
import type { RepositoryRef, Snapshot } from '../lib/model';
import { summarize, type Metric, type Summary } from '../lib/metrics';
import { sparkline } from '../lib/sparkline';

const form = document.querySelector<HTMLFormElement>('#access-form')!;
const tokenInput = document.querySelector<HTMLInputElement>('#github-token')!;
const remember = document.querySelector<HTMLInputElement>('#remember')!;
const loadButton = document.querySelector<HTMLButtonElement>('#load')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel')!;
const formStatus = document.querySelector<HTMLElement>('#form-status')!;

const rows = new Map<string, HTMLElement>();
for (const row of document.querySelectorAll<HTMLElement>('[data-repository]')) {
  rows.set(row.dataset.key!, row);
}
const panels = new Map<string, HTMLElement>();
for (const panel of document.querySelectorAll<HTMLElement>('[data-detail]')) {
  panels.set(panel.dataset.key!, panel);
}

const decimal = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
const STORAGE_KEY = 'github-token';

let controller: AbortController | null = null;

const PLACEHOLDER: Record<Metric<unknown>['state'], string> = {
  ok: '',
  'no-activity': 'No activity',
  'insufficient-history': 'Insufficient history',
  unavailable: 'No data',
};

const PLACEHOLDER_HINT: Record<Metric<unknown>['state'], string> = {
  ok: '',
  'no-activity': 'Measured, and nothing happened in this window.',
  'insufficient-history': 'Read, but not far enough back to answer this honestly.',
  unavailable: 'The fetch failed, so this was not measured.',
};

function duration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

/**
 * `emptyLabel` overrides the wording for a measured-but-empty result, where a
 * blanket "No activity" would overclaim: a window can hold plenty of activity
 * and still contain no questions, or no answered ones.
 */
function setMetric(
  row: HTMLElement,
  key: string,
  metric: Metric<unknown>,
  text: string | null,
  emptyLabel?: string,
) {
  const cell = row.querySelector<HTMLElement>(`[data-metric="${key}"]`)!;
  if (metric.state === 'ok' && text !== null) {
    cell.textContent = text;
    cell.className = '';
    cell.removeAttribute('title');
  } else {
    const named = metric.state === 'no-activity' && emptyLabel;
    cell.textContent = named ? emptyLabel : PLACEHOLDER[metric.state];
    cell.className = 'cell-empty';
    // A window can be busy and still hold nothing of this particular kind, so
    // the generic "nothing happened" hint would be wrong here.
    cell.title = named
      ? 'Measured; there was nothing of this kind in the window.'
      : PLACEHOLDER_HINT[metric.state];
  }
}

function renderSparkline(row: HTMLElement, summary: Summary, label: string) {
  const svg = row.querySelector<SVGElement>('[data-sparkline]')!;
  const line = row.querySelector<SVGPolylineElement>('[data-sparkline-line]')!;
  const area = row.querySelector<SVGPathElement>('[data-sparkline-area]')!;
  const fallback = row.querySelector<HTMLElement>('[data-sparkline-empty]')!;
  const metric = summary.series;

  if (metric.state !== 'ok' || !metric.value) {
    svg.setAttribute('hidden', '');
    fallback.hidden = false;
    fallback.textContent = PLACEHOLDER[metric.state];
    return;
  }

  const path = sparkline(metric.value.buckets);
  line.setAttribute('points', path.line);
  area.setAttribute('d', path.area);
  svg.removeAttribute('hidden');
  fallback.hidden = true;

  const days = Math.round(metric.value.bucketDays);
  svg.setAttribute(
    'aria-label',
    `Discussion activity for ${label}: ${metric.value.buckets.join(', ')} contributions per ${days}-day period, oldest first. Peak ${path.peak}.`,
  );
}

function renderTrend(row: HTMLElement, summary: Summary) {
  const cell = row.querySelector<HTMLElement>('[data-trend]')!;
  const metric = summary.trend;

  if (metric.state !== 'ok' || !metric.value) {
    cell.textContent = PLACEHOLDER[metric.state];
    cell.className = 'trend cell-empty';
    return;
  }

  const { change, ratio, current, previous } = metric.value;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const sign = change > 0 ? '+' : change < 0 ? '\u2212' : '';
  const magnitude = ratio === null ? decimal.format(Math.abs(change)) : percent.format(Math.abs(ratio));

  cell.className = `trend trend-${direction}`;
  cell.textContent = direction === 'flat' ? 'No change' : `${sign}${magnitude}`;
  cell.title = `${current} contributions this window against ${previous} in the previous one.`;
}

function renderCategories(panel: HTMLElement, snapshot: Snapshot) {
  const list = panel.querySelector<HTMLUListElement>('[data-categories]')!;
  const status = panel.querySelector<HTMLElement>('[data-category-status]')!;
  list.replaceChildren();

  if (snapshot.categories.length === 0) {
    status.textContent =
      'Categories could not be read. The board feed above still covers every category.';
    return;
  }

  status.textContent = 'Each category publishes its own feed.';
  for (const category of snapshot.categories) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'subscribe subscribe-category';
    link.href = categoryFeedUrl(snapshot.repository, category);
    link.textContent = category.name;
    item.append(link);
    list.append(item);
  }
}

function render(key: string, snapshot: Snapshot) {
  const row = rows.get(key)!;
  const panel = panels.get(key)!;
  const summary = summarize(snapshot, analysis);
  const label = key;

  setMetric(row, 'participants', summary.participants, decimal.format(summary.participants.value ?? 0));
  setMetric(row, 'discussions', summary.discussionsOpened, decimal.format(summary.discussionsOpened.value ?? 0));
  setMetric(row, 'comments', summary.comments, decimal.format(summary.comments.value ?? 0));

  const answered = summary.answered.value;
  setMetric(
    row,
    'answered',
    summary.answered,
    answered ? `${percent.format(answered.ratio)} of ${answered.answered + answered.unanswered}` : null,
    'No questions',
  );

  setMetric(
    row,
    'response',
    summary.medianFirstResponse,
    summary.medianFirstResponse.value === null ? null : duration(summary.medianFirstResponse.value),
    'No responses',
  );
  const responseCell = row.querySelector<HTMLElement>('[data-metric="response"]')!;
  if (summary.medianFirstResponse.state === 'ok') {
    responseCell.title = `Median across ${summary.firstResponseSample} discussion(s) that received a response.`;
  }

  const cohorts = summary.cohorts.value;
  setMetric(row, 'cohorts', summary.cohorts, cohorts ? `${cohorts.newcomers} / ${cohorts.returning}` : null);

  const category = summary.topCategory.value;
  setMetric(row, 'category', summary.topCategory, category ? category.names.join(', ') : null);
  if (category) {
    row.querySelector<HTMLElement>('[data-metric="category"]')!.title =
      `${category.events} contributions in this window.`;
  }

  renderSparkline(row, summary, label);
  renderTrend(row, summary);
  renderCategories(panel, snapshot);

  const status = row.querySelector<HTMLElement>('[data-status]')!;
  const parts: string[] = [];
  if (snapshot.errors.length > 0) {
    parts.push(...new Set(snapshot.errors));
  } else {
    parts.push(`Read ${decimal.format(snapshot.discussions.length)} discussions`);
    if (!snapshot.historyComplete) parts.push('history incomplete');
  }
  status.textContent = parts.join(' \u00b7 ');
  status.className = snapshot.errors.length > 0 ? 'row-status row-status-error' : 'row-status';

  const meta = panel.querySelector<HTMLElement>('[data-meta]')!;
  const detail = document.createElement('span');
  detail.className = 'muted';
  detail.textContent = ` Loaded ${new Date(snapshot.asOf).toLocaleTimeString()} in ${snapshot.requests} request(s).${
    snapshot.rateLimit.remaining === null ? '' : ` ${decimal.format(snapshot.rateLimit.remaining)} API points left.`
  }`;
  meta.querySelector('.muted')?.remove();
  meta.append(detail);
}

function resetRow(key: string) {
  const row = rows.get(key)!;
  for (const cell of row.querySelectorAll<HTMLElement>('[data-metric]')) {
    cell.textContent = 'Loading';
    cell.className = 'cell-empty';
  }
  row.querySelector<HTMLElement>('[data-trend]')!.textContent = 'Loading';
  row.querySelector<HTMLElement>('[data-status]')!.textContent = 'Loading';
}

/**
 * Repositories are independent, so they load concurrently. The pool is bounded
 * rather than a bare Promise.all: a few hundred simultaneous fetches would
 * exhaust the rate limit in one burst and give every row a failure to show.
 */
const CONCURRENCY = 4;

async function load(token: string) {
  controller = new AbortController();
  loadButton.disabled = true;
  tokenInput.disabled = true;
  cancelButton.hidden = false;

  const queue = [...repositories];
  let failure: unknown = null;

  const worker = async () => {
    for (;;) {
      const repository = queue.shift();
      if (!repository || controller?.signal.aborted) return;

      const ref: RepositoryRef = { owner: repository.owner, name: repository.name };
      const key = `${repository.owner}/${repository.name}`;
      resetRow(key);
      const status = rows.get(key)!.querySelector<HTMLElement>('[data-status]')!;

      try {
        const snapshot = await fetchSnapshot(ref, token, analysis, controller!.signal, (message) => {
          status.textContent = message;
        });
        render(key, snapshot);
      } catch (error) {
        // One repository must never take the others, or the page, down with it.
        // Render a failed snapshot rather than only rewriting the status line, or
        // the cells stay stuck on "Loading" and claim work that never finished.
        failure ??= error;
        render(key, {
          repository: ref,
          asOf: Date.now(),
          categories: [],
          discussions: [],
          historyComplete: false,
          oldestFetchedAt: null,
          requests: 0,
          rateLimit: { remaining: null, resetAt: null },
          errors: [error instanceof Error ? error.message : 'This repository could not be read.'],
        });
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
    );
    formStatus.textContent = controller.signal.aborted
      ? 'Cancelled.'
      : failure
        ? 'Finished with errors. Affected rows say so.'
        : 'Done.';
  } finally {
    controller = null;
    loadButton.disabled = false;
    tokenInput.disabled = false;
    cancelButton.hidden = true;
  }
}

/*
 * Rendering changes the table's width: "Insufficient history" is far wider than
 * the placeholder it replaces. Watching the viewport alone would leave the hint
 * stale after a load, so the table itself is observed.
 */
function updateScrollHint() {
  const scroll = document.querySelector<HTMLElement>('[data-table-scroll]');
  const hint = document.querySelector<HTMLElement>('[data-scroll-hint]');
  if (!scroll || !hint) return;
  hint.hidden = scroll.scrollWidth <= scroll.clientWidth;
}

const scrollContainer = document.querySelector<HTMLElement>('[data-table-scroll]');
const leaderboardTable = scrollContainer?.querySelector('table');
updateScrollHint();

if (scrollContainer && leaderboardTable) {
  const observer = new ResizeObserver(updateScrollHint);
  observer.observe(scrollContainer);
  observer.observe(leaderboardTable);
} else {
  window.addEventListener('resize', updateScrollHint);
}

cancelButton.addEventListener('click', () => controller?.abort());

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (controller) return;

  const token = tokenInput.value.trim();
  if (!token) {
    tokenInput.reportValidity();
    return;
  }

  if (remember.checked) {
    sessionStorage.setItem(STORAGE_KEY, token);
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
    tokenInput.value = '';
  }

  formStatus.textContent = 'Reading the GitHub API.';
  void load(token);
});

const saved = sessionStorage.getItem(STORAGE_KEY);
if (saved) {
  tokenInput.value = saved;
  remember.checked = true;
  formStatus.textContent = 'Token restored for this tab. Load metrics to refresh.';
}
