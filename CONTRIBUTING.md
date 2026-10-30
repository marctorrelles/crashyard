# Contributing to crashyard

Thanks for helping. Bug reports, SDKs that don't work with crashyard and small fixes are all welcome. For anything
larger, open an issue or a discussion first, so we can agree on the approach before you write it.

## Set up

You need Node.js at the version in `.nvmrc`, and pnpm. Running `corepack enable` installs the version in
`package.json`. Node.js 25 and later no longer include corepack, so run `npm install -g corepack` first.

```sh
pnpm install                                  # also installs the git hooks, which lint and format what you stage
pnpm wrangler d1 migrations apply DB --local  # creates the local database's tables
pnpm dev                                      # http://localhost:3000, with local D1 and R2, signed in as dev@localhost
pnpm seed                                     # optional: a month of sample crashes, logs and transactions
```

## Before you open a pull request

- `pnpm check` passes. It runs lint, formatting, types, unused code with knip, the tests and the build, just like CI.
- Tests run in seconds. They test pure functions with fixtures, not full renders or sleeps.
- The AGENTS.md file of each part you changed is still accurate. Every folder that has one describes itself in it.
- Migrations are new files. Merged migrations are never edited.
- Text that users read follows the tone described in [AGENTS.md](AGENTS.md).

## Commits and pull requests

- Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/), such as `fix: …`,
  `feat: …`, `docs: …` or `chore: …`. The title becomes the squashed commit and the changelog entry.
- Each pull request covers one subject.
- A change to what crashyard accepts from SDKs names the SDK and the version it was checked with.

## Report a vulnerability

Please don't use a public issue. See [SECURITY.md](SECURITY.md) instead.

By contributing, you agree to the [code of conduct](CODE_OF_CONDUCT.md) and to license your contributions under the
[MIT license](LICENSE).
