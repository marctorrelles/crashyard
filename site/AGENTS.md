# site/

crashyard.dev, the project's landing page. Built by Vite (`vite.config.ts`, `@tailwindcss/vite`) to `dist/`, served by
the `crashyard-site` Worker (assets only, no code), on crashyard.dev and www.crashyard.dev. It isn't part of a crashyard
deployment and the Deploy button doesn't deploy it.

```sh
pnpm site:dev      # the page on a Vite dev server
pnpm site:deploy   # build to site/dist and deploy it; the custom domains create the DNS records
```

- `index.html`: the whole page, styled with Tailwind utilities inline (no component classes), one inline script.
  Prettier skips it, as its `<pre>` blocks are whitespace-exact: each line of a snippet is one `pre > span`. The hero's
  columns align to the top, so a taller snippet grows the code card downward. The nav's logo is the C mark alone, the
  Deploy button's height: its centreline, playing the app's loading animation (`.cy-draw` in `src/styles.css`, the
  same path), faster here, 2 s: taken away speeding up, a beat empty (160 ms), drawn back from fast to slow, once on load, on a mouse over it and on a press (touch has no hover), one round at a time,
  through the Web Animations API, never with reduced motion. Pressed on this page, it scrolls to the top rather than
  loading it again. The footer's is the filled mark.
- `styles.css`: only what utilities can't be: the Geist faces, Hazard's tokens light and dark (as the system is, no
  switch) mapped to Tailwind colors (`bg-card`, `text-fg-2`, `text-code-key`…), the breakpoints (xs 420, sm 640, md
  820, lg 900, xl 1000 px) and base element styles. `source('.')` keeps Tailwind to this folder.
- Accessibility, checked with axe-core (WCAG 2.2 AA and best practice, light, dark and a phone) and by Tab:
  - Skip to content first.
  - Both tab lists follow WAI-ARIA's tabs pattern: one Tab stop, the selected tab; the arrow keys, Home and End move
    and select; each tab controls its panel.
  - Snippets are focusable, as they scroll sideways.
  - Copy says Copied to screen readers through a polite live region.
  - Grey text and Yes and No in the plans table are 4.5:1 or more.
  - Icons are `<use>` of a symbol carrying its stroke, `aria-hidden`, beside text.
- `public/images/`: the app's screenshots (sample apps acme-ios, acme-web, sync from `pnpm seed`, light and dark,
  2560 × 1600), `analytics-*.jpg`, the funnel of `pnpm seed`'s pocketband (pattern recorded, export started, song exported, by release) at 1280 × 800 twice over, `status-*.jpg`, a Brightpan status page with an open incident and planned maintenance, rendered from a
  throwaway local database (the demo's own page only fills its 30 days live), `og.png`, the share image (2560 × 1280,
  `og:image`, a large Twitter card, and the repo's social preview, uploaded by hand), and `logo.svg`, a copy of
  `docs/images/logo.svg`. The Status pages tab links to the demo's page, demo-status.crashyard.dev.
- `public/fonts/`: Geist and Geist Mono 1.8.2, variable woff2, served from here so the page makes no third-party
  requests (SIL OFL, `LICENSE-geist.txt`).
- Facts on the page follow the README and docs: a change there that the page states (plans, limits, SDKs, commands)
  changes the page too.
