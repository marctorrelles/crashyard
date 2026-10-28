# Upgrading crashyard

When a newer version is available, owners see **Update available** at the bottom of the sidebar. crashyard checks
GitHub for new releases once a day. [CHANGELOG.md](../CHANGELOG.md) lists what changed. If a release's migration
changes existing data, the changelog says so at the top of that release.

Choose **Update available** to update. You can install the update from the dashboard, or deploy it yourself.

## Update from the dashboard

crashyard can install a release itself, the way `pnpm run deploy` does. It applies the release's new migrations, then
deploys the release's build, which GitHub made from the release's code. Your domain, settings, secrets and data stay
as they are. This needs the Workers Paid plan.

1. **Create an API token.** In the Cloudflare dashboard, open My Profile, then API Tokens, and create a custom token
   with two permissions on your account: **Workers Scripts: Edit** and **D1: Edit**.
2. **Connect it.** Open **Update available**, or Settings, General, then **Automatic updates**. Paste the token, check
   the Worker's name, which is `crashyard` unless you renamed it, and choose **Connect Cloudflare**.
3. **Install.** Choose **Install** and keep the page open for up to a minute. The page reloads on the new version.

Turn on **Install updates automatically** and crashyard installs each new release every day at 03:40 UTC. A new major
version always waits for you, as it can change how crashyard works. If an automatic update can't install, the
dialog says why.

Some releases can't be installed from the dashboard, and the dialog says so:

- **A release that adds a binding**, such as a new database or queue. A deploy creates it.
- **A release that changes the SymCache builder**, if you run it. The builder's image is built on deploy, so update
  with a deploy, with Docker running. Its release notes say "This release changes the SymCache builder."

## Upgrade a clone

```sh
git pull                 # or merge the release's tag into your fork
pnpm install
pnpm check               # optional, runs the tests and the build
pnpm run deploy          # builds, applies new migrations to your D1 database and deploys
```

Git ignores `wrangler.local.json`, which holds your domain and sign-in values, so pulling never changes it.

If crashyard installed a newer release from the dashboard, `pnpm run deploy` from an older checkout stops instead of
going back to the older version. Pull first, then deploy.

If you run the SymCache builder, start Docker before you deploy. Every deploy builds its image, which takes a few
seconds when nothing in it changed. To deploy a release that doesn't change the builder without Docker, run
`pnpm run deploy -- --containers-rollout=none`, which leaves the builder as it is.

## Upgrade a deployment made with the button

The button created a copy of the repository on your GitHub account and connected it to Workers Builds, which deploys
whenever the copy changes. Bring the release into your copy by merging the release's tag. Workers Builds then builds,
migrates and deploys it. You can also install releases from the dashboard, as above. Merge the tag into your copy
afterwards too, so the next build doesn't go back to the older version.

## If a deploy goes wrong

Migrations only add tables and columns, so the previous version still runs on an upgraded database. Roll the worker
back from the Cloudflare dashboard, under Workers, crashyard, Deployments, while you investigate. If a migration
can't be written that way, the changelog calls it out and explains what to do.
