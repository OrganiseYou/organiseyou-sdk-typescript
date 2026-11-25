# Conformance set for the OrganiseYou client SDKs

Recorded exchanges between a client and an OrganiseYou organization's REST API (with the organization's own sign-in
endpoints), the scenarios that use them, and sample `openapi.json` documents for the code generators. Every OrganiseYou SDK
(TypeScript, Dart, Kotlin, Swift) runs the same scenarios in its CI against a mock transport, so the SDKs agree with each other
and with the server.

An SDK repository keeps a **copy** of this folder in `conformance/`. A copy is never edited by hand: it is replaced as a whole by
a newer set, and a test checks every file against `manifest.json`.

```text
manifest.json    the set number, its date, and the SHA-256 of every other file in this folder
CHANGELOG.md     what changed per set number
README.md        this file
interactions/    recorded requests and answers, one file each (two are written by hand and marked synthetic)
scenarios/       what the SDK is asked to do and what it must report, one file each
openapi/         sample documents for the generators
```

## What is in the files, and what is not

Everything is made up and normalised, so two recordings are byte for byte the same:

- The API base is `https://api.example.test/api/acme`. An interaction's `path` is relative to it. No other host appears.
- Tokens are short placeholders: `oyo_exchange_a1` (access), `oyr_exchange_r1` (refresh). They are far shorter than a real token,
  so they never match a secret-scanning rule. A reset key is `exchange-reset-token-1`.
- Passwords are `exchange-password-1` (and `exchange-new-password-1`, `exchange-wrong-password`). E-mail addresses end in
  `@example.test`. User ids are `usr_1` to `usr_5`; record ids and the organization's id are the fixed UUIDs
  `00000000-0000-4000-8000-0000000000nn` (ids `1` to `5` are the first person's five records, `11` and `12` the second
  person's, `101` is the record a scenario creates).
- The clock stood at `2026-01-01T10:00:00Z` while recording: every time in an answer (`token.expires_at`) is that plus the
  token's 1800 seconds, and `Retry-After` and `RateLimit-Reset` are those of a clock at the start of a minute.
- Messages are the server's, in English, as sent.

## An interaction

One request and its answer. A runner's mock serves it for a request that matches on **method, path, query, `Authorization`
and the JSON body** (the body compared as JSON, keys in any order); a request that matches no interaction fails the test.

```json
{
    "id": "login-ok",
    "description": "What it shows.",
    "synthetic": false,
    "request": {
        "method": "POST",
        "path": "/auth/token",
        "query": {},
        "headers": { "Content-Type": "application/json" },
        "body": { "identifier": "ada@example.test", "password": "exchange-password-1" }
    },
    "response": {
        "status": 200,
        "headers": { "Content-Type": "application/json", "Cache-Control": "no-store, private" },
        "body": { "access_token": "oyo_exchange_a1" }
    }
}
```

- `request.headers` holds `Authorization` as `Bearer <placeholder>` when the call carries a token, and `Content-Type` when it
  has a body. A request with no body has no `body` key. `query` values are strings.
- `response.headers` holds only the headers that matter: `Content-Type`, `Cache-Control`, `WWW-Authenticate`, `Retry-After`
  and `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
- The answer's body is `body` (decoded JSON, which may be `{}`) or `bodyText` (a string, `""` for an empty body, the text of a
  body that is not JSON). `delete-ok` is `200` with `bodyText: ""` and a `text/html` content type: the SDK must accept it.
- `"synthetic": true` marks an answer written by hand that this application never gave: a proxy's 502 page and a 200 that is
  not JSON. Connection failures and timeouts are each runner's own tests.

## A scenario

```json
{
    "id": "refresh-after-401",
    "description": "What it shows.",
    "now": "2026-01-01T10:00:00Z",
    "start": { "session": "stored", "accessToken": "oyo_exchange_a4", "accessTokenEndsAt": "2026-01-01T10:30:00Z",
               "refreshToken": "oyr_exchange_s2", "scope": "rest:read rest:write", "user": { "id": "usr_1", "name": "Ada Lovelace", "email": "ada@example.test" } },
    "steps": [
        { "do": "auth.me", "calls": ["me-token-rejected", "refresh-ok-2", "me-after-refresh-2"], "expect": { "result": { }, "state": { } } }
    ],
    "serves": { "me-token-rejected": 1, "refresh-ok-2": 1, "me-after-refresh-2": 1 }
}
```

- **`now`**: the instant the runner's clock starts at (a fake clock, so no test waits). `clock.advance` moves it.
- **`start`**: `{"session": "none"}` (signed out, nothing stored) or a stored session (restored with `restore()` before the
  first step). The stored access token ends at `accessTokenEndsAt`; one that has ended, or ends within 60 seconds, is
  refreshed before the first call.
- **`serves`**: the interactions the mock serves for this scenario and **exactly how often each is requested**. A request
  count above or below it fails the test. This is what proves "one refresh" for two calls started together.
- **`steps`** run in order. Each has `do`, `args`, `calls` (the interactions that step requests, in order; for `parallel`, as a
  set) and `expect`. `serves` is the sum of the steps' `calls`; a test in the application checks that.

### The vocabulary

| `do` | `args` | What it calls |
| --- | --- | --- |
| `auth.signIn` | `identifier`, `password` | `signIn` |
| `auth.signOut` | none | `signOut` |
| `auth.register` | `name`, `identifier`, `password` | `register` |
| `auth.forgotPassword` | `identifier`, `redirectUrl` (sent as `redirect_url`) | `forgotPassword` |
| `auth.resetPassword` | `token`, `password` | `resetPassword` |
| `auth.me` | none | `me` |
| `records.list` | `endpoint`, `page`, `perPage` (each optional) | `records(endpoint).list`. Only the query parameters given are sent. |
| `records.all` | `endpoint`, `perPage` (optional) | `records(endpoint).all`. It sends `page` and `perPage` on every request, `perPage` being the one given. |
| `records.get` | `endpoint`, `id` | `get` |
| `records.create` | `endpoint`, `values` | `create` (the body is `values`) |
| `records.update` | `endpoint`, `id`, `values` | `update` (`PUT`, the body is `values`) |
| `records.delete` | `endpoint`, `id` | `delete` |
| `parallel` | `steps`: sub-steps started together, each with `do`, `args`, `expect` | all of them at once, then waits for all |
| `clock.advance` | `seconds` | moves the fake clock |

### What a step expects

`expect` may hold any of these; what it does not hold is not checked.

- **`result`**: the call's result as JSON; every key named here must be in it with an equal value (objects are compared by the
  keys named, lists exactly). A list result is `{items, total, page, perPage, hasNext}`, written here with `itemIds`, the `id`
  of each item in order, instead of `items`; `all` has `itemIds` only. A step with no `result` only expects that nothing
  was thrown. A record is its JSON. `me` is `{user, organization, roles, permissions, scopes, token}`.
- **`error`**: the call must fail with the one error type, and the named parts must match: `kind` (`http`, `network`,
  `timeout`, `decoding`, `signedOut`, `storage`), `status`, `code` (the answer's `error`), `fieldErrors` (the answer's
  `errors`), `retryAfterSeconds`. An answer whose body is not the server's JSON (a proxy's 502 HTML page, a 200 that is plain
  text) is `decoding` whatever its status: a `decoding` error keeps the HTTP `status` and has no `code`. A step with `error` expects no `result`.
- **`state`**: the session state after the step: `status` (`signedIn` or `signedOut`), `reason` for signed out (`none`,
  `signedOut`, `sessionEnded`), `user.id` for signed in.
- **`lastRateLimit`**: `{limit, remaining, reset}` as the client reports the last values it read.

### The SDK's own header

An SDK may send `X-OrganiseYou-Client`; the mock ignores request headers other than `Authorization` and `Content-Type`.

## The runner

Each SDK's runner loads every scenario, serves the interactions named in `serves` from a mock transport, drives the SDK
through the vocabulary above, and checks results, errors, state and request counts. No socket is opened and no real server or
token is used.

## The manifest

`manifest.json` holds the `set` number, its `date`, and `files`: a list of `{"path", "sha256"}` for every file in this folder
except the manifest itself, in path order. A runner (or the CI before it) hashes each file and fails when a digest differs or a
file is missing or extra: a difference is a hand edit or a partial copy.

## Sets and releases

A set number is raised whenever a recorded answer, a scenario or a sample document changes; `CHANGELOG.md` says what changed. An
SDK release names the set number it passes. A newer set means the server's behaviour changed: copy it in, and the scenarios
that now fail show what the SDK must change.

## The sample documents

`openapi/` holds four documents as the server's `GET /rest/openapi.json` answers them for a caller (hosts and names are the
made-up ones above): `todos-app-user.json` (what a person who registered in the app is given), `todos-owner.json` (what an owner
is given), `all-types.json` (one field of every column type) and `awkward-names.json` (endpoint and field names with a space, a
hyphen, a leading digit, a reserved word, and two names that make the same identifier). Each record operation and endpoint tag
carries `x-organiseyou-endpoint`, the endpoint's name. A generator's tests read them.
