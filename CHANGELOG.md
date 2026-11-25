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
