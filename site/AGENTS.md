# site/

crashyard.dev, the project's landing page. Static files in `public/` served by the `crashyard-site` Worker (assets
only, no code), on crashyard.dev and www.crashyard.dev. It isn't part of a crashyard deployment and the Deploy button
doesn't deploy it.

- `public/index.html`: the whole page, hand-written HTML and CSS with one inline script (the SDK tabs, one per
  official SDK the hero shows; the product tabs; Copy). Hazard's tokens, light or dark as the system is, with no
  switch. Prettier skips it, as its `<pre>` blocks are whitespace-exact.
- `public/images/`: the app's screenshots (sample apps acme-ios, acme-web, sync from `pnpm seed`, light and dark,
  2560 × 1600), `status-*.jpg`, a Brightpan status page with an open incident and planned maintenance, rendered from a
  throwaway local database (the demo's own page only fills its 30 days live), and `logo.svg`, a copy of
  `docs/images/logo.svg`. The Status pages tab links to the demo's page, demo-status.crashyard.dev.
- `public/fonts/`: Geist and Geist Mono 1.8.2, variable woff2, served from here so the page makes no third-party
  requests (SIL OFL, `LICENSE-geist.txt`).
- Deploy: `pnpm wrangler deploy -c site/wrangler.jsonc` from the repo root. The custom domains create the DNS records.
- Facts on the page follow the README and docs: a change there that the page states (plans, limits, SDKs, commands)
  changes the page too.
