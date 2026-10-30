# site/

crashyard.dev, the project's landing page. Static files in `public/` served by the `crashyard-site` Worker (assets
only, no code), on crashyard.dev and www.crashyard.dev. It isn't part of a crashyard deployment and the Deploy button
doesn't deploy it.

- `public/index.html`: the whole page, hand-written HTML and CSS with one inline script (SDK and product tabs, Copy,
  the light/dark/system switch kept in localStorage). Hazard's tokens, light and dark. Prettier skips it, as its
  `<pre>` blocks are whitespace-exact.
- `public/images/`: the app's screenshots (sample apps acme-ios, acme-web, sync from `pnpm seed`, light and dark,
  2560 × 1600) and `logo.svg`, a copy of `docs/images/logo.svg`.
- `public/fonts/`: Geist and Geist Mono 1.8.2, variable woff2, served from here so the page makes no third-party
  requests (SIL OFL, `LICENSE-geist.txt`).
- Deploy: `pnpm wrangler deploy -c site/wrangler.jsonc` from the repo root. The custom domains create the DNS records.
- Facts on the page follow the README and docs: a change there that the page states (plans, limits, SDKs, commands)
  changes the page too.
