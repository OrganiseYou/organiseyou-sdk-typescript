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
