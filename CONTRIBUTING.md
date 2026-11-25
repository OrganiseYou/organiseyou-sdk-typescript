# Contributing

These rules apply to everyone who changes this repository, people and AI tools alike.

## Set up

You need Node.js 22.18 or later (the build tool needs it) and npm.

```bash
npm ci
npm run build       # writes dist/index.js and dist/index.d.ts
npm run lint        # ESLint and a Prettier check; `npm run format` fixes the format
npm run typecheck
npm test
```

Tests use a fake `fetch` and fake timers. A test never opens a socket, reaches a real server or uses a real token.
Build a token-shaped value at run time, never write one in a file: the secret scan fails on a string that looks like a
credential, and so does a pull request that holds one.

## The shared conformance set

`conformance/` holds recorded requests and answers, the scenarios that use them and sample OpenAPI documents. Every
OrganiseYou SDK runs the same scenarios, so they agree with each other and with the server. It is a **copy**: never edit
a file in it by hand.

- `test/conformance/` runs every scenario against the SDK. A mock transport serves the interactions a scenario names,
  fails on any request it does not know, and counts every request; the global `fetch` is replaced by one that fails,
  so no socket is opened.
- `node scripts/conformance.mjs check` (the `conformance` CI job) compares every file with the SHA-256 in
  `conformance/manifest.json`. It fails on a changed, missing or extra file.
- A newer set comes in a pull request of its own: `scripts/sync-conformance <path to a checkout of the OrganiseYou
application>` copies it, checks it against its manifest and prints the set number. Review the diff, then run the tests. A pull request that only brings in a newer set may change more than 50 files.
  If the SDK and a scenario disagree, do not change the runner to hide it: the set is corrected at its source, or the
  SDK is fixed.

## The generator

`src/generator` is the `organiseyou` command and `src/cli.ts` is its entry; it uses only Node.js and the core, and the
package has no runtime dependency. Its tests (`test/generator`) generate code from each sample document of the
conformance set into a temporary project and compile it with the TypeScript compiler, `--strict`. The files that must
**not** compile are in `test/generator/fixtures/<document>/*.txt` (`.txt` so that the project's own checks skip them).
A line that must fail ends in `// expect: TS<code> <words of the message>`, and the test requires exactly those lines,
with that code and those words, and no other error in the file.

## The end-to-end check

`npm run e2e -- --base-url <address>` runs the SDK against a **local** OrganiseYou: it registers two people, takes each
confirmation link from the local Mailpit, signs in, creates, lists, updates and deletes a record, signs out, and checks
that the second person never sees the first person's record. Run it by hand; CI never does.

- Prepare a local organization with the application's `sdk:e2e-setup` command, and use its API address as `--base-url`.
- Mailpit is read at `http://localhost:8025`; pass `--mailpit-url` when yours is elsewhere.
- Both addresses must point at this machine: the host is resolved and anything that is not a loopback address is
  refused before a request is sent. A local development host with a locally trusted certificate needs Node.js to trust
  that certificate authority, for example with `NODE_EXTRA_CA_CERTS`.
- It prints one line per step, and never a token, a password or a link.

## Start from the default branch

Start every change from the latest `origin/main`:

```bash
git fetch origin main
git switch --no-track -c fix/short-title origin/main
```

## One change, one pull request, one commit

- One change gets one branch, one pull request and one commit on `main`.
- Always merge with **Squash and merge**. The commit on `main` takes the pull request's title.
- Commit as often as you like on your branch. Those commits do not reach `main`.
- If a pull request changes more than 50 files, split it.

## Pull request title

An id for the work, a colon and what the change does. Work with no id uses one of the types `fix`, `docs`, `ci` or
`chore`, with an optional scope.

```text
SDK-07: The repository, the build and CI
fix: Stop a second refresh when a retried call fails
docs(readme): Explain the token stores
```

A new feature needs agreed work first, so there is no `feat` type.

## Pull request description

Say what changed and why, how you checked it, and what a reviewer should look at. Never paste a token, a password or
a real address of an OrganiseYou server into a pull request, an issue or a test.

## Draft pull requests run no checks

Every job costs build minutes, so a draft pull request runs none. Run `npm run lint`, `npm run typecheck`,
`npm test` and `npm run build` yourself while it is a draft. Marking it **ready for review** starts the five checks:
lint, typecheck, test, conformance and gitleaks. Do not merge a pull request while one of them is red.

## What goes in the repository

- No secret: no token, key, password or private address, not even an old one. Use `api.example.test`, `acme` and
  `user@example.test` in examples and tests.
- No licence file yet: the licence has not been decided.
- No feature flags and no environment switches in the package.
