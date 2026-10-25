# Security

crashyard takes crash reports from the internet and holds what apps send it, so a vulnerability matters.

## Reporting one

Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Please don't open a
public issue. You'll get an answer within a few days, and credit in the release notes if you'd like it.

## What's in scope

The worker: the ingest and Sentry API endpoints, the Access check in front of the dashboard, the dashboard itself, and
the scheduled jobs. Cloudflare's own services (Access, D1, R2) are Cloudflare's to secure.
