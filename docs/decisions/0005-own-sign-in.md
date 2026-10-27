# 5. crashyard's own sign-in, with passkeys

Supersedes [0003](0003-cloudflare-access-for-sign-in.md).

**Context.** Cloudflare Access worked, but it made crashyard harder to start and to use. Deploying meant creating a
Zero Trust team, two Access applications and copying two values back. Signing in meant a one-time PIN by email on
every new device, and Access sessions ran out often. Agents needed an Access service token and a policy for it. Nobody
had a role, so everyone who could sign in could change everything.

**Decision.** crashyard signs people in by itself, with passkeys. The first owner is created at `/setup` with a setup
code from the deployment, and everyone else joins with an invite link. Sessions last 90 days from the last visit.
People have a role: owner, admin, member or viewer. Agents use tokens each person creates, which act as that person.
Recovery codes, and a command for whoever holds the Cloudflare account, cover lost devices. Sign in with GitHub is
optional and set up in one click, as a private GitHub App only that deployment uses. Cloudflare Access was kept as a
mode for a while, so a deployment could move over without a gap, and then removed: one way in is less to keep safe.

**What it costs.** crashyard now holds sessions, passkeys, invites and tokens, so a mistake in it can let someone in.
It keeps only digests of every secret, checks WebAuthn with `@simplewebauthn/server` rather than by hand, and fails
closed: signed out, only the sign-in pages open. There are no passwords and no email links, so someone who loses every
passkey and recovery code needs a person with the Cloudflare account. Changing the dashboard's domain means creating
passkeys again. Everyone who can sign in still sees every project.
