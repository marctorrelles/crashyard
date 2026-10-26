# 3. Cloudflare Access for sign-in

**Context.** The dashboard holds every app's crashes and logs, so it needs sign-in. Building accounts, passwords and
roles is a project of its own, and getting it wrong leaks data.

**Decision.** Cloudflare Access sits in front of the dashboard, and its policies decide who gets in. They can allow
specific emails, a whole domain, a GitHub organization or one-time PINs. The worker also verifies the Access token on
every request, and refuses everything when Access isn't configured. crashyard has no users, members or roles of its
own. It records the email in the token to show who did what.

**What it costs.** Everyone who can sign in sees every project. A team that needs to keep an app from some people runs
a second crashyard. Deploying requires a Cloudflare Zero Trust team, which is free for up to 50 users.
