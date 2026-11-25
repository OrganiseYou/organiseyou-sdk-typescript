# Changelog

All notable changes to this package are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package has not been released yet, and its version
stays at `0.x` until its first public release: until then the public interface may change.

## Unreleased

### Added

- The repository, the ESM build with type declarations, and the checks that run on a pull request that is ready for
  review: lint, type check, tests and a secret scan.
- `OrganiseYou` with `baseUrl`, `OrganiseYou.forOrganization(host, slug)`, `fetch`, `timeoutMs` (30 000 by default) and
  `onRequest`. The address must be `https`; plain `http` is accepted only for `localhost`, `127.0.0.1`, `::1` and
  `10.0.2.2`. Redirects are never followed.
- `OrganiseYouError`, the one error of the package, with `kind`, `status`, `code`, `message`, `fieldErrors`,
  `retryAfterSeconds` and `rateLimit`; `oy.lastRateLimit`.
- The session: `oy.session` with `state`, `onChange(listener)` and `restore()`, and the sign-out reasons `none`,
  `signedOut` and `sessionEnded`.
- `oy.auth`: `signIn`, `signOut`, `register`, `forgotPassword`, `resetPassword`, `me` and `resetTokenFrom(url)`.
- Token stores: `TokenStore`, `StoredSession`, `MemoryTokenStore` (the default) and `SessionStorageTokenStore`, which
  keeps only the refresh token, the scope and the user's name and address in `sessionStorage`. Nothing is written to
  `localStorage`.
- One refresh, however many calls need it: the access token is renewed a minute before it ends, and once after a `401`.
  The new tokens are saved before any waiting call goes on, and a refresh token is never sent twice.
- Every call takes an optional `signal` to cancel it.
- `oy.records(name)` with `list`, `all`, `get`, `create`, `update` and `delete`, and the types `RecordData` and
  `Page`. `all()` reads page after page and stops by `total`, at an empty page, or one page past the last page the
  latest `total` allows. Links in a list answer are never followed.
- A README with the quick start, the stores, the errors and paging.
- The shared conformance set (set 1) in `conformance/`, `scripts/sync-conformance` to copy a newer one, and a CI job
  that checks every copied file against its manifest.
- A runner that plays every scenario of the set against the SDK with a mock transport: it fails on an unknown
  request, counts every request exactly, and runs with the global `fetch` replaced by one that fails.
- `npm run e2e -- --base-url <address>`, a check by hand against a local OrganiseYou: two people, a confirmation link
  from the local Mailpit, and a record created, listed, updated and deleted. It refuses an address that is not on this
  machine.
- The generator: `organiseyou generate` (a `bin`, with no runtime dependency) turns an organization's `openapi.json`
  into `models.ts`, `endpoints.ts`, `index.ts` and a manifest. From `--input`, or `--url` with `--token-env` or
  `--login`; `--save` keeps the fetched document; `--check` writes nothing and exits with 1 when the code is out of
  date. There is no option for a token or a password. A wrong field name, a missing required field, a call an endpoint
  does not have and a read-only field in an update fail to compile.
- Safe regeneration: every file starts with a generated line, the folder is refused when it holds a file that is not
  generated, unchanged files are not rewritten, and the generated files of an endpoint that is gone are deleted. No
  token, password or e-mail address is ever written.
