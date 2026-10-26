# Deploying crashyard

From a Cloudflare account to a running crashyard, in about fifteen minutes. Everything here works on Cloudflare's free
plans.

## With the button

The README's **Deploy to Cloudflare** button copies this repository to your GitHub, makes the D1 database and the R2
bucket in your account, and deploys to `crashyard.<your account>.workers.dev`, redeploying whenever your copy changes.
Then follow steps 3 to 5 below, putting the values they mention in your copy's `wrangler.jsonc` (its `routes` and
`vars`) rather than in `wrangler.local.json`: commit them, and it deploys again.

## What you need

- A Cloudflare account with a domain on it (crashyard gets a subdomain, such as `crashyard.example.com`).
- Node (the version in `.nvmrc`) and pnpm (`corepack enable`).
- This repository, cloned.

## 1. Point it at your domain (from a clone)

`pnpm run setup` asks for this step's and step 3's values, writes the file, and offers steps 2 and 4 for you; run
it again to change a value. By hand:

Your deployment's own values go in `wrangler.local.json` at the repo root, which git ignores and the build lays over
`wrangler.jsonc` (its `vars` merged in, anything else replacing `wrangler.jsonc`'s). Make it with your subdomain:

```json
{
  "routes": [{ "pattern": "crashyard.example.com", "custom_domain": true }],
  "workers_dev": false,
  "vars": { "PUBLIC_URL": "https://crashyard.example.com" }
}
```

Cloudflare creates the DNS record and the certificate when you deploy. `PUBLIC_URL` is where the dashboard is, for the
links in notifications that the cron sends (monitors). Without the file, crashyard deploys to
`crashyard.<your account>.workers.dev`.

## 2. Deploy

```sh
pnpm install
pnpm wrangler login
pnpm run deploy
```

The first deploy creates the D1 database (`crashyard`) and the R2 bucket (`crashyard-files`) in your account: their
ids aren't in `wrangler.jsonc`, so Wrangler makes them. It also applies the migrations.

Open your subdomain: it says "Sign in through Cloudflare Access to open crashyard". That's crashyard refusing everyone
because Access isn't set up yet, which is what you want.

## 3. Put Cloudflare Access in front

Access does the signing in; crashyard has no accounts of its own. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com)
(Cloudflare One, also called Zero Trust).

1. **The plan.** The first time, Cloudflare asks you to choose a plan: pick **Free** ($0, up to 50 users). It may ask for
   a payment method even so; the total stays $0. If it shows more, you've picked the wrong plan.
2. **The dashboard's application.** Access → Applications → **Add an application** → **Self-hosted**.
   - Name: `crashyard`.
   - Public hostname: your subdomain (`crashyard` on `example.com`), no path.
   - Policy: create one, action **Allow**, Include → **Emails** → the emails of the people who may sign in (or
     **Emails ending in** `@example.com` for a whole domain).
   - Login methods: leave the default ("accept all available identity providers"). One-time PIN, a code sent by email,
     is on for every team; add Google or GitHub under Settings → Authentication if you like.
   - Save.
3. **The apps' way in.** Apps send crashes to `/api/…` and can't sign in, so that path skips Access (crashyard checks
   each project's key there itself). **Add an application** → **Self-hosted** again.
   - Name: `crashyard api`.
   - Public hostname: the same subdomain, **path `api/`**.
   - Policy: create one, action **Bypass**, Include → **Everyone** (no value).
   - Save.
4. **The two values crashyard checks.** crashyard verifies Access's token on every dashboard request, so a route left
   out of Access by mistake stays closed. It needs:
   - **The application's audience:** open the `crashyard` application (not the api one) and copy its **Application
     Audience (AUD) Tag**.
   - **Your team domain:** `<team>.cloudflareaccess.com`. It's under Settings → Custom pages (Team domain). It isn't
     always your team's display name: the surest way is to open your crashyard subdomain in a private window and look
     at the address Cloudflare's sign-in page is on.

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

Open your subdomain: Cloudflare's sign-in comes first, then crashyard.

## 4. Keep raw envelopes a month, and clean up uploads (optional)

Every envelope is also kept as it arrived in R2, to reprocess or debug. A lifecycle rule deletes them after 30 days:

```sh
pnpm wrangler r2 bucket lifecycle add crashyard-files envelopes envelopes/ --expire-days 30
pnpm wrangler r2 bucket lifecycle add crashyard-files chunks chunks/ --expire-days 1
```

The second drops upload chunks left behind by an upload that never finished.

## 5. Email notifications (optional)

crashyard sends email through Cloudflare Email Routing, to addresses you've verified there.

1. In the Cloudflare dashboard, your domain → Email → Email Routing → enable it (it adds the DNS records).
2. Destination addresses → add the address that gets notifications, and click the link Cloudflare emails it.
3. In `wrangler.local.json`'s `vars`, set `EMAIL_FROM` to an address on your domain, such as `crashyard@example.com` (it needn't
   exist), and deploy again.

Then add an email channel in the dashboard's notification settings. Telegram and webhook channels need nothing here.

## Checking it

- Your subdomain in a private window → Cloudflare's sign-in page.
- After signing in → crashyard's dashboard.
- `curl -X POST https://crashyard.example.com/api/1/envelope/` → an answer from crashyard (not Cloudflare's sign-in
  page): the bypass works.

## When something's wrong

- **"Sign in through Cloudflare Access to open crashyard" after signing in:** `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` don't
  match. Check the team domain against the sign-in page's address, and that the AUD is the `crashyard` application's,
  not the api one's.
- **Apps' crashes don't arrive, and `curl` to `/api/` returns Cloudflare's sign-in page:** the bypass application is
  missing, or its path isn't `api/`.
- **Emails don't arrive:** the destination isn't verified in Email Routing, or `EMAIL_FROM` isn't on the domain.
- **The deploy can't create the custom domain:** the domain must be on the same Cloudflare account.
