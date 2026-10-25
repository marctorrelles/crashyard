# 3. Cloudflare Access for sign-in

**Context.** The dashboard holds every app's crashes and logs, so it needs sign-in. Building accounts, passwords and
roles is a project in itself, and getting it wrong leaks data.

**Decision.** Cloudflare Access sits in front of the dashboard; its policies decide who gets in (emails, a domain, a
GitHub organisation, one-time PINs). The worker also checks Access's token on every request, and refuses everything
when Access isn't configured. There are no users, members or roles in crashyard; the token's email is recorded for who
did what.

**What it costs.** Everyone let in sees every project. A team that needs one app kept from some people runs a second
crashyard. Deploying needs a Cloudflare Zero Trust team (free up to 50 users).
