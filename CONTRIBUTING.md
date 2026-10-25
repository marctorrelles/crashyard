# Contributing to crashyard

Thanks for helping. Bugs, SDKs that don't work against crashyard, and small fixes are all welcome; for anything bigger,
open an issue or a discussion first so we can agree on the shape before you write it.

## Setting up

You need Node (the version in `.nvmrc`) and pnpm (`corepack enable` gives you the one in `package.json`).

```sh
pnpm install   # also installs the git hooks (lefthook): lint and format on what you stage
cp .dev.vars.example .dev.vars   # local secrets: the push buttons' signing key, which the tests check
pnpm dev       # http://localhost:3000, with local D1 and R2; Cloudflare Access is off locally
```

## Before you open a pull request

- `pnpm check` passes: lint, format, types, unused code (knip), tests and the build. CI runs the same.
- Tests run in seconds: pure functions with fixtures, not full renders or sleeps.
- The AGENTS.md of each part you changed is still true (each folder that has one describes itself).
- Migrations are new files, never edits to merged ones.

## Commits and pull requests

- Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: …`, `feat: …`,
  `docs: …`, `chore: …`. The title becomes the squashed commit and the changelog line.
- One subject per pull request.
- Changes to what crashyard accepts from SDKs say which SDK and version they were checked with.

## Reporting a vulnerability

Not in an issue: see [SECURITY.md](SECURITY.md).

By contributing you agree to the [code of conduct](CODE_OF_CONDUCT.md), and that your contributions are licensed under
the [MIT licence](LICENSE).
