# Deploying crashyard

From a Cloudflare account to a running crashyard, in about fifteen minutes. Everything here works on Cloudflare's free
plans.

## What you need

- A Cloudflare account with a domain on it (crashyard gets a subdomain, such as `crashyard.example.com`).
- Node (the version in `.nvmrc`) and pnpm (`corepack enable`).
- This repository, cloned.

## 1. Point it at your domain

In `wrangler.jsonc`, set `routes` to your subdomain:

```jsonc
"routes": [{ "pattern": "crashyard.example.com", "custom_domain": true }],
```

Cloudflare creates the DNS record and the certificate when you deploy.

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

   Put both in `wrangler.jsonc` and deploy again:

   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag>",
   },
   ```

   ```sh
   pnpm run deploy
   ```

Open your subdomain: Cloudflare's sign-in comes first, then crashyard.

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
- **The deploy can't create the custom domain:** the domain must be on the same Cloudflare account.
