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
  Deploy button's height: the whole mark at rest (`data-whole`), and while it plays the app's loader's five pieces (`PIECES` in
  `src/components/shell.tsx`, the same paths in the same order, `data-ring`), outside in each turning the other way
  from the one before, moving as the app's do (up to speed within 40°, on, braking evenly over the last 90°), with
  each round's own numbers: 1 to 3 turns a piece, starting within 0.25 s, 2.2 to 3.4 s a turn and never over 400° a
  second on average; on a mouse over it and on a press (touch has no hover), not on load, one round at a
  time, through the Web Animations API, never with reduced motion. Pressed on this page, it scrolls to the top rather than
  loading it again. The footer's is the filled mark.
- Motion follows Emil Kowalski's rules (emilkowalski/skills): `ease-out` and `ease-in-out` are redefined in
  `styles.css` as his strong curves, only `transform`, `opacity`, `clip-path` and `filter` animate (the tab pills'
  `width` aside, one absolute element), nothing animates on a keyboard action, everything has a reduced-motion
  state at rest. What moves, and why:
  - Buttons press to 97% (`active:scale-97`, 160 ms).
  - The hero's added DSN line writes in once as the page opens (`animate-diff-in`, a clip from the left).
  - Both tab lists have one pill (`data-pill`) under the selected tab that slides to the next; panels swap at once.
  - Copy's icon turns into a check and back.
  - Two demos play once as they come into view (`once` in the script), and only when they start below the fold, so
    what's on screen as the page opens is at rest: the stack trace card shows the raw addresses, then reads them
    row by row, and Before the dSYM flips it back (its rows are the app's: function, file and line, "in acme-ios", "Not symbolicated", a folded run of system frames); the Telegram alert is held at 03:12 and its clock runs to 08:00
    before it arrives. Their frames and addresses are the screenshots' crash (Voice.swift:41).
- Identity: a blueprint grid and the accent's glow behind the hero (`bg-grid`), and the deploy band dark in both
  themes under hazard tape (`hazard`), the theme's namesake. Left out on purpose, as template tells: all-caps labels
  over the headings, a badge pill in the hero, effects on the feature cards and decorative motion on scroll.
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
  2560 × 1600), `analytics-*.jpg`, Analytics' Insights of acme-ios comparing app opened, song created and song exported, with `pnpm seed`'s pocketband and notes-web renamed acme-ios and acme-web in the local database first, at 1280 × 800 twice over, `status-*.jpg`, a Brightpan status page with an open incident and planned maintenance, rendered from a
  throwaway local database (the demo's own page only fills its 30 days live), `og.png`, the share image (2560 × 1280,
  `og:image`, a large Twitter card, and the repo's social preview, uploaded by hand), and `logo.svg`, a copy of
  `docs/images/logo.svg`. The Status pages tab links to the demo's page, demo-status.crashyard.dev.
- `public/fonts/`: Geist and Geist Mono 1.8.2, variable woff2, served from here so the page makes no third-party
  requests (SIL OFL, `LICENSE-geist.txt`).
- Facts on the page follow the README and docs: a change there that the page states (plans, limits, SDKs, commands)
  changes the page too.
