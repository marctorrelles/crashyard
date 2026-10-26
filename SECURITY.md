# Security

crashyard receives crash reports from the internet and stores what apps send it, so vulnerabilities matter.

## Report a vulnerability

Report it privately through GitHub. Open the repository's **Security** tab and choose **Report a vulnerability**.
Please don't open a public issue. You'll get an answer within a few days, and credit in the release notes if you'd
like it.

## Scope

The worker is in scope: the ingest and Sentry API endpoints, the Access check in front of the dashboard, the dashboard
itself and the scheduled jobs. Cloudflare's own services, such as Access, D1 and R2, are Cloudflare's responsibility.
