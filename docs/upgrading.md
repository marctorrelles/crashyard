# Upgrading crashyard

When a newer version is available, the overview says so. crashyard checks GitHub for the latest release once a day.
[CHANGELOG.md](../CHANGELOG.md) lists what changed. If a release's migration changes existing data, the changelog says
so at the top of that release.

## Upgrade a clone

```sh
git pull                 # or merge the release's tag into your fork
pnpm install
pnpm check               # optional, runs the tests and the build
pnpm run deploy          # builds, applies new migrations to your D1 database and deploys
```

Git ignores `wrangler.local.json`, which holds your domain and Access values, so pulling never changes it.

## Upgrade a deployment made with the button

The button created a copy of the repository on your GitHub account and connected it to Workers Builds, which deploys
whenever the copy changes. Bring the release into your copy, either with GitHub's **Sync fork** or by merging the
release's tag. Workers Builds then builds, migrates and deploys it.

## If a deploy goes wrong

Migrations only add tables and columns, so the previous version still runs on an upgraded database. Roll the worker
back from the Cloudflare dashboard, under Workers, crashyard, Deployments, while you investigate. If a migration
can't be written that way, the changelog calls it out and explains what to do.
