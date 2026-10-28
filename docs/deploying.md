# Deploying crashyard

This guide takes a Cloudflare account to a running crashyard in about fifteen minutes. Everything in it works on
Cloudflare's free plans.

Apps with native crashes, such as iOS and Android apps, or with source maps, need the Workers Paid plan. Turning their
stack traces back into code, and processing the files you upload for it, takes more processing time than the free
plan's 10 ms a request. Apps whose stack traces are readable as sent, such as Node.js and Python, work on the free
plan. Settings, Usage shows which plan crashyard found, and the pages that need Paid say so on the free plan.

## Deploy with the button

The README's **Deploy to Cloudflare** button copies this repository to your GitHub account, creates the D1 database and
the R2 bucket, and deploys to `crashyard.<your account>.workers.dev`. It redeploys whenever your copy changes.

After that, follow steps 3 to 5 below. For step 3, add the setup code as a secret in the Cloudflare dashboard: open
Workers & Pages, then `crashyard`, then Settings, then Variables and Secrets, and add a **Secret** named `SETUP_CODE`
with a code of your own, such as three groups of five letters. Put any other values in your copy's `wrangler.jsonc`,
under `routes` and `vars`, instead of in `wrangler.local.json`. Commit them and it deploys again.

## What you need

- A Cloudflare account with a domain on it. crashyard runs on a subdomain such as `crashyard.example.com`.
- Node.js at the version in `.nvmrc`, and pnpm. Running `corepack enable` installs the right pnpm.
- A clone of this repository.

## 1. Point it at your domain

`pnpm run setup` asks for the values in this step, writes the file for you and offers to run steps 2, 3 and 4. Run it again whenever you want to change a value. To do it by hand instead, read on.

Your deployment's own values live in `wrangler.local.json` at the root of the repository. Git ignores it, and the build
lays it over `wrangler.jsonc`: its `vars` are merged in, and any other key replaces the one in `wrangler.jsonc`. Create
it with your subdomain:

```json
{
  "routes": [{ "pattern": "crashyard.example.com", "custom_domain": true }],
  "workers_dev": false,
  "vars": { "PUBLIC_URL": "https://crashyard.example.com" }
}
```

Cloudflare creates the DNS record and the certificate when you deploy. `PUBLIC_URL` is the dashboard's address, used in
the links of alerts sent by scheduled checks such as monitors. Without this file, crashyard deploys to
`crashyard.<your account>.workers.dev`.

## 2. Deploy

```sh
pnpm install
pnpm wrangler login
pnpm run deploy
```

The first deploy creates the D1 database, `crashyard`, and the R2 bucket, `crashyard-files`, in your account. Their IDs
aren't in `wrangler.jsonc`, so Wrangler creates them. The deploy also applies the database migrations.

Open your subdomain. It shows **Set up crashyard**. Until the first owner exists, that page is all anyone can open.

## 3. Create the owner

crashyard signs people in with passkeys, kept by their phone, laptop or password manager. There are no passwords.

1. **Make a setup code.** It proves that whoever creates the owner also controls the deployment, and it stops working
   once the owner exists. `pnpm run setup` makes one and prints it. To make your own, run this and type a code, such
   as three groups of five letters:

   ```sh
   pnpm wrangler secret put SETUP_CODE
   ```

2. **Create your passkey.** Open `https://crashyard.example.com/setup`, enter the setup code, your name and your email,
   and choose **Create passkey**. Your device asks to save it.
3. **Save your recovery codes.** crashyard shows ten codes once. Each signs you in once, with your email, if you lose
   your passkeys. Keep them in your password manager.

Then invite your team from Settings, then People. An invite is a link that works once, for 7 days, with the role you
choose:

- **Owner**: everything, including people and sign-in.
- **Admin**: settings, projects, notifications and tokens.
- **Member**: resolve, ignore, assign and note issues, and edit dashboards.
- **Viewer**: read everything, change nothing.

Each person can add a passkey on every device they use in Settings, then Account, and sign out other devices there.

### Sign in with GitHub

This is optional. In Settings, then People, choose **Add Sign in with GitHub**, with an organization if the app should
belong to one. GitHub asks you to confirm a private GitHub App for your crashyard, which can only read who someone is,
and sends you back. From then on:

- People already in crashyard can sign in with GitHub, matched by a verified email on their GitHub account.
- An invite can be used with GitHub instead of a passkey.
- Anyone else is turned away, whatever their GitHub account.

To turn it off, choose **Remove Sign in with GitHub** there, then delete the app on GitHub.

### If someone loses every passkey

They can sign in with their email and a recovery code, from **Lost your passkey?** on the sign-in page, then add a new
passkey. If their recovery codes are gone too, anyone with access to the Cloudflare account can make them a new one:

```sh
pnpm run recovery-code them@example.com
```

Passkeys belong to the dashboard's domain. If you move crashyard to another domain, everyone signs in with a recovery
code once and adds a new passkey.

## 4. Clean up stored files

This step is optional but recommended. crashyard keeps every envelope in R2 exactly as it arrived, so it can be
reprocessed or inspected. An envelope holds what the app sent before anything was scrubbed, request headers included,
so keep it no longer than you need. These lifecycle rules delete envelopes after 30 days, envelopes that failed five
times after 30 days, and the pieces of uploads that never finished after one day:

```sh
pnpm wrangler r2 bucket lifecycle add crashyard-files envelopes envelopes/ --expire-days 30
pnpm wrangler r2 bucket lifecycle add crashyard-files failed failed/ --expire-days 30
pnpm wrangler r2 bucket lifecycle add crashyard-files chunks chunks/ --expire-days 1
```

crashyard deletes an event's attachments itself once the event is past its project's retention, so attachments need
no rule. An older setup added one of 90 days: remove it if a project keeps events longer, or their screenshots go
first.

## 5. Email notifications

This step is optional. crashyard sends email through Cloudflare Email Routing, and only to addresses you have verified
there.

1. In the Cloudflare dashboard, open your domain, then Email, then Email Routing, and turn it on. Cloudflare adds the DNS
   records it needs.
2. Under Destination addresses, add the address that should get alerts, and open the confirmation link Cloudflare sends
   to it.
3. In the `vars` of `wrangler.local.json`, set `EMAIL_FROM` to an address on your domain, such as
   `crashyard@example.com`. The address doesn't need to exist. Then deploy again.

To check it, add an email channel under Notifications with the address you verified, then choose its test button.
Telegram, Slack, Discord and webhook channels need no setup here.
A Telegram channel's Resolve, Ignore and Assign to me buttons work once `PUBLIC_URL` is set: saving the channel tells
Telegram to send their taps to `<PUBLIC_URL>/api/telegram/<bot id>`, which needs no sign-in, with a secret only crashyard and
Telegram know.

Push notifications need no setup either. Each person turns them on at the top of Notifications, or in Settings, Preferences, on each device they want
them on. That gives them a channel of their own, which an admin adds to routes like any other. On an iPhone or iPad
they work in the app added to the Home Screen, on iOS 16.4 or later: open crashyard in Safari, choose Share, then Add
to Home Screen, and turn them on from there.

## Debug files over 48 MB

This step is optional. crashyard turns debug files into lookup tables itself, up to 48 MB a file. A big app's dSYM can
be larger, and sentry-cli then refuses to upload it. To take files up to 512 MB, add the SymCache builder, a small
Cloudflare Container that does this work for the bigger files. It needs the Workers Paid plan and Docker on the
machine you deploy from.

1. Add this to `wrangler.local.json`:

   ```json
   "containers": [
     { "class_name": "SymcacheBuilder", "image": "./symcache/Dockerfile", "max_instances": 1, "instance_type": "standard-1" }
   ],
   "durable_objects": { "bindings": [{ "name": "SYMCACHE_BUILDER", "class_name": "SymcacheBuilder" }] },
   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SymcacheBuilder"] }]
   ```

2. Start Docker, then deploy with `pnpm run deploy`. The first deploy builds the container's image, which takes a few
   minutes.

The container starts when a big file arrives and stops a minute after, so it costs a few seconds of container time per
upload. Files over 16 MB go to it, and smaller ones stay with crashyard itself.

## Upload tokens

sentry-cli and the build plugins need a token to upload debug files and source maps. Create one in Settings, then
Tokens. A token can be for one project or for every project. A token for one project is refused for any other, so give
each app its own.

## Check that it works

- Open your subdomain in a private window. You should see crashyard's sign-in page.
- Sign in. You should see the crashyard dashboard.
- Run `curl -X POST https://crashyard.example.com/api/1/envelope/`. The answer should come from crashyard, not from a
  sign-in page.
- Open Settings, then General. It shows the public URL. Settings, then Health, says whether the schedule runs every
  minute.

## Troubleshooting

- **The setup page says to add a setup code.** The worker has no `SETUP_CODE` secret yet. Add it as step 3 says,
  then reload the page.
- **The browser says the passkey can't be used here.** Open crashyard at the address in `PUBLIC_URL`. Passkeys only
  work on the domain they were created for.
- **Crashes from apps don't arrive, and `curl` to `/api/` returns Cloudflare's sign-in page.** A Cloudflare Access
  application covers the subdomain. crashyard signs people in itself, so delete it in Cloudflare One.
- **Emails don't arrive.** The destination address isn't verified in Email Routing, or `EMAIL_FROM` isn't on your
  domain.
- **The deploy can't create the custom domain.** The domain has to be on the same Cloudflare account.
