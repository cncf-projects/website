/*
 * The page renders entirely at build time. The only thing left for the browser
 * is telling the reader that the leaderboard scrolls, which depends on measured
 * widths and so cannot be decided while building.
 *
 * Rendering is static now, but the table still changes width when fonts load or
 * the viewport changes, so the container and the table are both observed.
 */

const region = document.querySelector<HTMLElement>('[data-table-scroll]');
const hint = document.querySelector<HTMLElement>('[data-scroll-hint]');
const table = region?.querySelector('table');

function updateScrollHint() {
  if (!region || !hint) return;
  hint.hidden = region.scrollWidth <= region.clientWidth;
}

updateScrollHint();

if (region && hint && table) {
  const observer = new ResizeObserver(updateScrollHint);
  observer.observe(region);
  observer.observe(table);
} else {
  window.addEventListener('resize', updateScrollHint);
}
