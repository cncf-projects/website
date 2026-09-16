import { fetchRepository } from '../lib/github';
import { discussionUrl, type Repository, type Snapshot } from '../lib/model';
import { summarize } from '../lib/metrics';

const cards = [...document.querySelectorAll<HTMLElement>('[data-repository]')];
const form = document.querySelector<HTMLFormElement>('#access-form')!;
const input = document.querySelector<HTMLInputElement>('#github-token')!;
const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const number = new Intl.NumberFormat();
let controller: AbortController | undefined;

function repositoryFor(card: HTMLElement): Repository {
  return { owner: card.dataset.owner!, name: card.dataset.name! };
}

function status(card: HTMLElement, text: string) {
  card.querySelector<HTMLElement>('[data-status]')!.textContent = text;
}

function duration(milliseconds: number): string {
  const minutes = milliseconds / 60_000;
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${number.format(Math.round(minutes))} min`;
  if (minutes < 1440) return `${number.format(Math.round(minutes / 60 * 10) / 10)} h`;
  return `${number.format(Math.round(minutes / 1440 * 10) / 10)} days`;
}

function render(card: HTMLElement, snapshot: Snapshot) {
  const metrics = summarize(snapshot);
  const set = (key: string, value: string | number | null) => {
    card.querySelector<HTMLElement>(`[data-metric="${key}"]`)!.textContent =
      value === null ? 'No data' : typeof value === 'number' ? number.format(value) : value;
  };
  set('participants', metrics.participants);
  set('discussions', metrics.discussions);
  set('comments', metrics.comments);
  set('questions', metrics.questions ?
    `${number.format(metrics.questions.answered)} / ${number.format(metrics.questions.unanswered)}` : null);
  if (metrics.questions) {
    const total = metrics.questions.answered + metrics.questions.unanswered;
    card.querySelector<HTMLElement>('[data-detail="questions"]')!.textContent = total ?
      `${Math.round(metrics.questions.answered / total * 100)}% answered · Q&A opened in this window` :
      'No Q&A discussions opened in this window';
  }
  set('response', metrics.medianResponse === null ?
    (metrics.responseSample === 0 ? 'No responses' : null) : duration(metrics.medianResponse));
  card.querySelector<HTMLElement>('[data-detail="response"]')!.textContent =
    metrics.responseSample === null ? 'First response by someone other than the author' :
      `${number.format(metrics.responseSample)} discussions with an identifiable outside response`;
  set('cohorts', metrics.newParticipants === null ? null :
    `${number.format(metrics.newParticipants)} / ${number.format(metrics.returningParticipants!)}`);
  set('category', metrics.mostActive === null ? null :
    metrics.mostActive.length ? metrics.mostActive.map((category) => category.name).join(' / ') : 'No activity');

  const categories = card.querySelector<HTMLUListElement>('[data-categories]')!;
  categories.replaceChildren();
  for (const category of snapshot.categories) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `${discussionUrl(snapshot.repository)}/categories/${encodeURIComponent(category.slug)}`;
    link.textContent = category.name;
    item.append(link);
    categories.append(item);
  }
  card.querySelector<HTMLElement>('[data-category-status]')!.textContent = snapshot.categories.length ?
    'Category pages on GitHub. Subscribe to the repository feed above.' :
    'Category data unavailable. The repository RSS feed is still available.';
  const errors = [...new Set(snapshot.errors)];
  status(card, errors.length ?
    `${errors.join(' ')} Affected metrics show no data.` :
    `Live data · ${new Date(snapshot.asOf).toLocaleString()} · ${number.format(snapshot.discussions.length)} discussions inspected`);
}

cancel.addEventListener('click', () => controller?.abort());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (controller) return;
  let token = input.value.trim();
  if (!token) {
    input.value = '';
    input.reportValidity();
    return;
  }
  input.value = '';
  input.disabled = true;
  submit.disabled = true;
  cancel.hidden = false;
  controller = new AbortController();
  try {
    for (const card of cards) {
      card.querySelectorAll<HTMLElement>('[data-metric]').forEach((metric) => {
        metric.textContent = 'No data';
      });
      const snapshot = await fetchRepository(
        repositoryFor(card), token, controller.signal, (message) => status(card, message),
      );
      render(card, snapshot);
    }
  } catch {
    cards.forEach((card) => status(card, 'Unable to load data. Retry with a valid token. RSS remains available.'));
  } finally {
    token = '';
    controller = undefined;
    input.disabled = false;
    submit.disabled = false;
    cancel.hidden = true;
  }
});
