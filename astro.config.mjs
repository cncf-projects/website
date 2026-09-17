import { defineConfig } from 'astro/config';

// Served as a GitHub Pages project site, so every asset lives under /website/.
// Without `base`, the emitted /_astro/* URLs resolve to the domain root and 404.
export default defineConfig({
  site: 'https://cncf-projects.github.io',
  base: '/website',
  output: 'static',
});
