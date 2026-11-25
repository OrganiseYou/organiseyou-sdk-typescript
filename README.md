# OrganiseYou SDK for TypeScript

A small client for the REST API of one OrganiseYou organization: sign people in, keep their session, and read and write
the records of an endpoint by its name. It runs in browsers and in Node.js, uses the platform's `fetch`, and has no
runtime dependency.

> **Not released yet.** The package name `@organiseyou/sdk` is a working name and may change, the package is marked
> private, and until its first public release (versions `0.x`) the public interface may change.

## Install

Node.js 22 or later, or a browser with `fetch` and `AbortController`. The package is ESM only.

```bash
npm install @organiseyou/sdk   # once it is published; the name is a working name
```

## Quick start

An organization's API address is `https://<host>/api/<slug>`. Make one client from it, or from the host and the slug:

```ts
import { OrganiseYou, OrganiseYouError } from '@organiseyou/sdk';

const oy = new OrganiseYou({ baseUrl: 'https://api.example.test/api/acme' });
// the same: OrganiseYou.forOrganization('api.example.test', 'acme')

oy.session.onChange((state) => {
  if (state.status === 'signedOut') showLogin(state.reason);
});

await oy.auth.signIn({ identifier: 'user@example.test', password });

const todos = oy.records('todos');
const first = await todos.list({ page: 1, perPage: 50 });
for await (const todo of todos.all()) render(todo);

try {
  const created = await todos.create({ title: 'Buy milk' });
  await todos.update(created.id, { done: true });
  await todos.delete(created.id);
} catch (error) {
  if (error instanceof OrganiseYouError && error.code === 'validation_failed') {
    show(error.fieldErrors['title']);
  } else {
    throw error;
  }
}
```

The address must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1`, `::1` and `10.0.2.2` (the
Android emulator's address for the host machine), so a token never travels unencrypted. The client never follows a
redirect.

Other options of `new OrganiseYou({ ... })`:

| Option       | What it does                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `fetch`      | A replacement for the platform's `fetch`, for tests or a proxy.                                   |
| `timeoutMs`  | The longest a call may take. Defaults to 30 000.                                                  |
| `onRequest`  | Called after every request with `{ method, path, status, durationMs }`. Never a header or a body. |
| `tokenStore` | Where the session is kept. Defaults to memory.                                                    |

## Sign in, sign out, register, reset a password

```ts
await oy.auth.signIn({ identifier, password }); // keeps the session
await oy.auth.signOut(); // revokes it on the server, then forgets it here
await oy.auth.register({ name, identifier, password }); // { status: 'verification_sent' }; signs nobody in
await oy.auth.forgotPassword({ identifier, redirectUrl: 'https://app.example.test/reset' });
await oy.auth.resetPassword({ token, password }); // signs nobody in
const me = await oy.auth.me(); // user, organization, roles, permissions, scopes
```

A reset link ends in `#token=<key>`. Read the key on your reset page, then take it out of the address bar:

```ts
const token = oy.auth.resetTokenFrom(window.location.href); // undefined when the link has no token
history.replaceState(null, '', window.location.pathname);
```

## The session

`oy.session.state` is `{ status: 'signedIn', user }` or `{ status: 'signedOut', reason }`. The reason is:

- `none`: nobody has signed in yet;
- `signedOut`: the app called `signOut()`;
- `sessionEnded`: the server ended the session (the refresh token was spent, revoked or expired, the password was
  reset, or the person was removed).

`oy.session.onChange(listener)` returns the function that stops listening. Each listener hears every change once.

Every call to the records renews the access token a minute before it ends, and once more after a `401`. However many
calls need it at the same time, one refresh is sent, and the new tokens are saved before any waiting call goes on. A
refresh token whose refresh has been answered is never sent again. When the server refuses a refresh, the store is cleared, the state
becomes `signedOut` with the reason `sessionEnded`, and every waiting call fails with the error kind `signedOut`.

A refresh whose answer is lost on the network may have spent the token on the server. The next call then finds the
session ended. Two clients that share one store (two processes, a widget extension) are not supported.

## Token stores

| Store                      | Keeps                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `MemoryTokenStore`         | Everything, in memory. The default. A reload or a restart signs out.                    |
| `SessionStorageTokenStore` | The refresh token (with the scope and the user's name and address) in `sessionStorage`. |

```ts
import { OrganiseYou, SessionStorageTokenStore } from '@organiseyou/sdk';

const oy = new OrganiseYou({
  baseUrl: 'https://api.example.test/api/acme',
  tokenStore: new SessionStorageTokenStore(),
});
await oy.session.restore(); // read the store once, at start
```

With `SessionStorageTokenStore` the access token stays in memory, so after a reload the first call refreshes first. No
store writes to `localStorage`, and none is shipped: keep tokens out of it on a shared device. In Node.js, pass your
own store if the session must survive a restart.

To write your own, implement `TokenStore` (`load()`, `save(session)`, `clear()`, all async). A `StoredSession` hides
its tokens when printed or turned into JSON; read `session.accessToken`, `session.refreshToken`, `session.expiresAt`,
`session.scope` and `session.user` to persist it, and build one again with `new StoredSession({ ... })`. A store that
throws becomes an `OrganiseYouError` of kind `storage`.

## Errors

Every failure is an `OrganiseYouError`:

| Field               | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `kind`              | `http`, `network`, `timeout`, `decoding`, `signedOut` or `storage`.                             |
| `status`            | The HTTP status, when the server answered.                                                      |
| `code`              | The server's error code, such as `validation_failed`. Absent when the body is not the server's. |
| `message`           | The server's text, or the SDK's for the other kinds.                                            |
| `fieldErrors`       | The messages of a `422`, per field. Empty otherwise.                                            |
| `retryAfterSeconds` | From the `Retry-After` header.                                                                  |
| `rateLimit`         | `{ limit, remaining, resetSeconds }` from the `RateLimit-*` headers.                            |

`decoding` means the answer was not the expected JSON, such as a proxy's HTML page. A `429` is returned as an error
with `retryAfterSeconds`; the app decides whether to wait. Nothing is retried by itself, apart from the one retry after
a refresh, and a write is never repeated after a network failure, since the server may have done it.

`oy.lastRateLimit` holds the rate limit headers of the latest answer that carried them. An error and the debug output
of a session never hold a token, a password, a request body or a header.

Passing a bad value (an address that is not allowed, a page of 0) throws a `TypeError` or `RangeError` at once.

## Records and paging

```ts
const todos = oy.records('todos'); // by endpoint name; any name is encoded as one path segment

await todos.list({ page: 2, perPage: 20 }); // Page: { items, total, page, perPage, hasNext }
for await (const todo of todos.all({ perPage: 100 })) {
  // every page in turn
}
await todos.get(id);
await todos.create({ title: 'Buy milk' }); // the answer holds the id and the values sent
await todos.update(id, { done: true }); // PUT: only the keys you send change; null clears a value
await todos.delete(id);
```

A record is a `RecordData`: the fields of the answer, and its `id`. `hasNext` is `page * perPage < total`. `all()` reads
page after page until it has `total` records, a page comes back empty, or it has read one page past the last page the
latest `total` allows. A list that changes while it is read may skip or repeat a record. The links in a list answer are
never followed: pages are asked for by number.

## Cancel and time out

Every call takes an optional `signal`. An aborted call rejects with the signal's reason, as `fetch` does, and no request
is sent after the abort. A call that takes longer than `timeoutMs` fails with kind `timeout`.

```ts
const controller = new AbortController();
const page = todos.list({ signal: controller.signal });
controller.abort();
```

## Not there yet

- GraphQL.
- Filtering and sorting a list.
- Types generated from an organization's OpenAPI document: records are plain objects for now.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The changes of each version are in [CHANGELOG.md](CHANGELOG.md).
