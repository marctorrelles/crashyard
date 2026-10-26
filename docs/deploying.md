# Deploying crashyard

This guide takes a Cloudflare account to a running crashyard in about fifteen minutes. Everything in it works on
Cloudflare's free plans.

Apps with native crashes, such as iOS and Android apps, or with source maps, need the Workers Paid plan. Turning their
stack traces back into code, and processing the files you upload for it, takes more processing time than the free
plan's 10 ms a request. Apps whose stack traces are readable as sent, such as Node.js and Python, work on the free
plan.

## Deploy with the button

The README's **Deploy to Cloudflare** button copies this repository to your GitHub account, creates the D1 database and
the R2 bucket, and deploys to `crashyard.<your account>.workers.dev`. It redeploys whenever your copy changes.

After that, follow steps 3 to 5 below. Put the values they mention in your copy's `wrangler.jsonc`, under `routes` and
`vars`, instead of in `wrangler.local.json`. Commit them and it deploys again.

## What you need

- A Cloudflare account with a domain on it. crashyard runs on a subdomain such as `crashyard.example.com`.
- Node.js at the version in `.nvmrc`, and pnpm. Running `corepack enable` installs the right pnpm.
- A clone of this repository.

## 1. Point it at your domain

`pnpm run setup` asks for the values in this step and in step 3, writes the file for you and offers to run steps 2 and 4. Run it again whenever you want to change a value. To do it by hand instead, read on.

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

Open your subdomain. It says "Sign in through Cloudflare Access to open crashyard". That means crashyard is refusing
every visitor because Access isn't set up yet, which is exactly what should happen at this point.

## 3. Put Cloudflare Access in front

Cloudflare Access handles sign-in, so crashyard has no accounts of its own. Open
[one.dash.cloudflare.com](https://one.dash.cloudflare.com), which Cloudflare calls Cloudflare One or Zero Trust.

1. **Choose a plan.** The first time, Cloudflare asks for a plan. Choose **Free**, which costs nothing for up to 50
   users. It may still ask for a payment method. The total stays at $0, and if it shows more, you've picked the wrong
   plan.
2. **Add the dashboard application.** Go to Access, then Applications, then **Add an application**, and choose
   **Self-hosted**.
   - Name: `crashyard`.
   - Public hostname: your subdomain, such as `crashyard` on `example.com`, with no path.
   - Policy: create one with the action **Allow**. Under Include, choose **Emails** and list the people who may sign
     in, or choose **Emails ending in** and enter `@example.com` to allow a whole domain.
   - Login methods: keep the default, which accepts every available identity provider. One-time PIN, a code sent by
     email, is on for every team. You can add Google or GitHub under Settings, then Authentication.
   - Save.
3. **Let apps through.** Apps send their crashes to `/api/…` and can't sign in, so that path has to skip Access.
   crashyard checks each project's key there itself. Choose **Add an application** and **Self-hosted** again.
   - Name: `crashyard api`.
   - Public hostname: the same subdomain, with the **path `api/`**.
   - Policy: create one with the action **Bypass**. Under Include, choose **Everyone**, with no value.
   - Save.
4. **Copy the two values crashyard checks.** crashyard verifies the Access token on every dashboard request, so a route
   accidentally left outside Access stays closed. It needs two values:
   - **The application audience.** Open the `crashyard` application, not the api one, and copy its **Application
     Audience (AUD) Tag**.
   - **Your team domain.** It has the form `<team>.cloudflareaccess.com` and appears under Settings, then Custom pages,
     as the team domain. It isn't always the same as your team's display name. The surest way to find it is to open your
     crashyard subdomain in a private window and read the address of the sign-in page.

   Add both to the `vars` in `wrangler.local.json` and deploy again:

   ```json
   "vars": {
     "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag>",
     "PUBLIC_URL": "https://crashyard.example.com"
   }
   ```

   ```sh
   pnpm run deploy
   ```

Open your subdomain again. Cloudflare's sign-in page comes first, then the crashyard dashboard.

## 4. Clean up stored files

This step is optional but recommended. crashyard keeps every envelope in R2 exactly as it arrived, so it can be
reprocessed or inspected. These lifecycle rules delete envelopes after 30 days, attachments such as screenshots after
90 days, and the pieces of uploads that never finished after one day:

```sh
pnpm wrangler r2 bucket lifecycle add crashyard-files envelopes envelopes/ --expire-days 30
pnpm wrangler r2 bucket lifecycle add crashyard-files attachments attachments/ --expire-days 90
pnpm wrangler r2 bucket lifecycle add crashyard-files chunks chunks/ --expire-days 1
```

crashyard also deletes an event's attachments itself once the event is past its project's retention.

## 5. Email notifications

This step is optional. crashyard sends email through Cloudflare Email Routing, and only to addresses you have verified
there.

1. In the Cloudflare dashboard, open your domain, then Email, then Email Routing, and turn it on. Cloudflare adds the DNS
   records it needs.
2. Under Destination addresses, add the address that should get alerts, and open the confirmation link Cloudflare sends
   to it.
3. In the `vars` of `wrangler.local.json`, set `EMAIL_FROM` to an address on your domain, such as
   `crashyard@example.com`. The address doesn't need to exist. Then deploy again.

To check it, open Settings, then Email, and choose **Send test email** with the address you verified. Then add an
email channel under Notifications in the dashboard. Telegram, Slack, Discord and webhook channels need no setup here.

## Upload tokens

sentry-cli and the build plugins need a token to upload debug files and source maps. Create one in Settings, then
Tokens. A token can be for one project or for every project. A token for one project is refused for any other, so give
each app its own.

## Check that it works

- Open your subdomain in a private window. You should see Cloudflare's sign-in page.
- Sign in. You should see the crashyard dashboard.
- Run `curl -X POST https://crashyard.example.com/api/1/envelope/`. The answer should come from crashyard, not from
  Cloudflare's sign-in page, which shows the bypass works.
- Open Settings, then General. It shows the public URL and whether Access is set up. Settings, then Health, says
  whether the schedule runs every minute.

## Troubleshooting

- **"Sign in through Cloudflare Access to open crashyard" appears after signing in.** `ACCESS_TEAM_DOMAIN` or
  `ACCESS_AUD` doesn't match. Compare the team domain with the sign-in page's address, and make sure the AUD tag is the
  `crashyard` application's, not the api one's.
- **Crashes from apps don't arrive, and `curl` to `/api/` returns Cloudflare's sign-in page.** The bypass application
  is missing, or its path isn't `api/`.
- **Emails don't arrive.** The destination address isn't verified in Email Routing, or `EMAIL_FROM` isn't on your
  domain.
- **The deploy can't create the custom domain.** The domain has to be on the same Cloudflare account.
