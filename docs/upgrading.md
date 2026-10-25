# Upgrading crashyard

When a newer crashyard is out, the dashboard's home page says so (it asks GitHub for the latest release once a day).
What changed is in [CHANGELOG.md](../CHANGELOG.md); a release whose migration changes data says so there, at the top.

## A clone

```sh
git pull                 # or merge the release's tag into your fork
pnpm install
pnpm check               # optional: the tests and the build
pnpm run deploy          # builds, applies the new migrations to your D1, deploys
```

`wrangler.local.json` (your domain and Access values) is git-ignored, so a pull never touches it.

## Deployed with the button

The button made you a copy of the repository on GitHub and connected it to Workers Builds, which deploys whenever
that copy changes. Bring the release into your copy (GitHub's "Sync fork", or merge the tag) and Workers Builds
builds, migrates and deploys it.

## If a deploy goes wrong

Migrations only add (new tables, new columns), so the version before still runs on an upgraded database: roll the
worker back from the Cloudflare dashboard (Workers → crashyard → Deployments) while you look. A migration that
couldn't be written that way is called out in the changelog, with what to do.
