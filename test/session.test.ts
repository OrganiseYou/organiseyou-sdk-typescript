import { randomBytes } from 'node:crypto';
import { format, inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryTokenStore,
  OrganiseYou,
  OrganiseYouError,
  SessionStorageTokenStore,
  StoredSession,
  type RequestInfo,
  type SessionState,
  type TokenStore,
} from '../src/index.js';
import { BASE_URL, FakeServer, FakeStorage, USER, json, loggingStore } from './helpers.js';

let servers: FakeServer[] = [];

function newServer(): FakeServer {
  const server = new FakeServer();
  servers.push(server);
  return server;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
  servers = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The rule of the whole file: a refresh token is never sent twice (the one test of a lost refresh opts out)
  for (const server of servers) {
    if (server.allowRepeatedRefresh) continue;
    expect(new Set(server.refreshTokensSeen).size).toBe(server.refreshTokensSeen.length);
  }
});

function client(
  server: FakeServer,
  tokenStore?: TokenStore,
  onRequest?: (info: RequestInfo) => void,
): OrganiseYou {
  return new OrganiseYou({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    ...(tokenStore === undefined ? {} : { tokenStore }),
    ...(onRequest === undefined ? {} : { onRequest }),
  });
}

async function signedIn(server: FakeServer, tokenStore?: TokenStore): Promise<OrganiseYou> {
  const oy = client(server, tokenStore);
  await oy.auth.signIn({ identifier: USER.email, password: server.password });
  return oy;
}

/** Moves the clock past the end of the access token. */
function endAccessToken(seconds = 1801): void {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

async function failure(promise: Promise<unknown>): Promise<OrganiseYouError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OrganiseYouError);
    return error as OrganiseYouError;
  }
  throw new Error('The call was expected to fail.');
}

function me(oy: OrganiseYou): Promise<unknown> {
  return oy.auth.me();
}

describe('SDK-09 one refresh', () => {
  it('causes exactly one request to /auth/token for five calls started together with an ended access token, and all five succeed with the new token', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    const oldAccess = server.currentAccess;
    endAccessToken();

    let release!: () => void;
    server.refreshGate = new Promise<void>((resolve) => (release = resolve));
    const calls = Promise.allSettled([1, 2, 3, 4, 5].map(() => me(oy)));
    await vi.advanceTimersByTimeAsync(0);
    release();
    const results = await calls;

    expect(server.refreshCalls).toHaveLength(1);
    expect(results.map((result) => result.status)).toEqual(Array(5).fill('fulfilled'));
    const rest = server.restCalls();
    expect(rest).toHaveLength(5);
    for (const call of rest) {
      expect(call.headers['authorization']).toBe(`Bearer ${server.currentAccess}`);
      expect(call.headers['authorization']).not.toBe(`Bearer ${oldAccess}`);
    }
    expect(oy.session.state).toEqual({ status: 'signedIn', user: USER });
  });

  it('refreshes before the end when the token ends within 60 seconds, and not before', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    endAccessToken(1800 - 61);
    await me(oy);
    expect(server.refreshCalls).toHaveLength(0);
    endAccessToken(2);
    await me(oy);
    expect(server.refreshCalls).toHaveLength(1);
  });

  it('starts one refresh for five calls that are answered 401, and retries each once with the new token', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    // The server forgets the token while the client still thinks it is good
    server.invalidateAccess();
    // After the refresh the server accepts the new pair
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => me(oy)));
    expect(results).toHaveLength(5);
    expect(server.refreshCalls).toHaveLength(1);
    expect(server.restCalls()).toHaveLength(10);
  });

  it('retries with a newer token, without a refresh of its own, when a refresh landed while the call was in flight', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    const oldAccess = server.currentAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    // The first data call is answered 401 only after another call has refreshed
    server.restOverride = () => {
      if (held) return undefined;
      held = true;
      return gate.then(() =>
        json({ error: 'unauthenticated', message: 'Authentication is required.' }, 401),
      );
    };
    const slow = me(oy);
    await vi.advanceTimersByTimeAsync(0);
    endAccessToken();
    await me(oy);
    expect(server.refreshCalls).toHaveLength(1);

    release();
    await slow;

    expect(server.refreshCalls).toHaveLength(1);
    const rest = server.restCalls();
    expect(rest).toHaveLength(3);
    expect(rest[0]?.headers['authorization']).toBe(`Bearer ${oldAccess}`);
    expect(rest[2]?.headers['authorization']).toBe(`Bearer ${server.currentAccess}`);
  });

  it('does not refresh for a 401 with another code', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    server.restOverride = () => json({ error: 'forbidden', message: 'No.' }, 401);
    const error = await failure(me(oy));
    expect(error.code).toBe('forbidden');
    expect(server.refreshCalls).toHaveLength(0);
    expect(server.restCalls()).toHaveLength(1);
  });

  it('fails a call without a session with kind signedOut, and sends nothing', async () => {
    const server = newServer();
    const oy = client(server);
    const error = await failure(me(oy));
    expect(error.kind).toBe('signedOut');
    expect(server.calls).toHaveLength(0);
  });
});

describe('SDK-09 a refused refresh', () => {
  it('clears the store, sets signedOut with reason sessionEnded, calls each listener once, and fails every waiting call with kind signedOut', async () => {
    const server = newServer();
    const log: string[] = [];
    const oy = await signedIn(server, loggingStore(log));
    const states: SessionState[] = [];
    const listener = vi.fn((state: SessionState) => states.push(state));
    const second = vi.fn();
    oy.session.onChange(listener);
    oy.session.onChange(second);
    log.length = 0;

    // The refresh token is spent on the server
    server.currentRefresh = 'another-refresh-token';
    endAccessToken();
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => me(oy)));

    expect(server.refreshCalls).toHaveLength(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(OrganiseYouError);
      expect(((outcome as PromiseRejectedResult).reason as OrganiseYouError).kind).toBe(
        'signedOut',
      );
    }
    expect(log).toEqual(['store.clear']);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'sessionEnded' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ status: 'signedOut', reason: 'sessionEnded' }]);
    // Nothing was sent to the data routes
    expect(server.restCalls()).toHaveLength(0);
    // A later call needs a new sign-in and sends nothing
    expect((await failure(me(oy))).kind).toBe('signedOut');
    expect(
      server.calls.filter((c) => c.path === '/auth/token' && c.body !== undefined),
    ).toHaveLength(2);
  });

  it('keeps the session when the refresh is lost to the network, and the next call tries again', async () => {
    const server = newServer();
    server.allowRepeatedRefresh = true;
    const oy = await signedIn(server);
    endAccessToken();
    server.tokenOverride = () => Promise.reject(new TypeError('network down'));
    const error = await failure(me(oy));
    expect(error.kind).toBe('network');
    expect(oy.session.state.status).toBe('signedIn');
    server.tokenOverride = undefined;
    await me(oy);
    expect(server.refreshCalls).toHaveLength(2);
  });

  it('keeps the session when the refresh is rate limited', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    endAccessToken();
    server.tokenOverride = () =>
      json({ error: 'rate_limited', message: 'Slow down.' }, 429, { 'Retry-After': '30' });
    const error = await failure(me(oy));
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(oy.session.state.status).toBe('signedIn');
  });
});

describe('SDK-09 saving before release', () => {
  it('holds the new pair in the store before any waiting call resolves (a store whose save records the order)', async () => {
    const server = newServer();
    const log: string[] = [];
    server.log = log;
    const oy = await signedIn(server, loggingStore(log));
    log.length = 0;
    endAccessToken();

    await Promise.all([me(oy), me(oy), me(oy)]);

    expect(log).toEqual([
      'fetch /auth/token',
      'store.save',
      'fetch /rest/me',
      'fetch /rest/me',
      'fetch /rest/me',
    ]);
    for (const call of server.restCalls()) {
      expect(call.headers['authorization']).toBe(`Bearer ${server.currentAccess}`);
    }
  });

  it('never sends a spent refresh token again when saving fails, and reports kind storage', async () => {
    const server = newServer();
    let failing = false;
    const inner = new MemoryTokenStore();
    const store: TokenStore = {
      load: () => inner.load(),
      save: (session) => (failing ? Promise.reject(new Error('disk full')) : inner.save(session)),
      clear: () => inner.clear(),
    };
    const oy = await signedIn(server, store);
    endAccessToken();
    failing = true;
    const error = await failure(me(oy));
    expect(error.kind).toBe('storage');
    expect(error.message).not.toContain('disk full');
    // The new pair is held in memory: the next call needs no refresh and uses the new token
    endAccessToken(0);
    await me(oy);
    expect(server.refreshCalls).toHaveLength(1);
  });

  it('revokes the new refresh token when a sign-out waits for a refresh in flight', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    endAccessToken();
    let release!: () => void;
    server.refreshGate = new Promise<void>((resolve) => (release = resolve));
    const call = me(oy).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const out = oy.auth.signOut();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await out;
    await call;
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'signedOut' });
    const revoke = server.calls.find((c) => c.path === '/auth/revoke');
    expect((revoke?.body as { token: string }).token).toBe(server.currentRefresh);
    expect((await failure(me(oy))).kind).toBe('signedOut');
  });

  it('drops the answer of a refresh that lands after a new sign-in, and the waiting call uses the new session', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    endAccessToken();
    let release!: () => void;
    server.refreshGate = new Promise<void>((resolve) => (release = resolve));
    const call = me(oy);
    await vi.advanceTimersByTimeAsync(0);
    // Signed in again while the refresh is on its way
    await oy.auth.signIn({ identifier: USER.email, password: server.password });
    const second = server.currentAccess;
    release();
    await call;
    expect(oy.session.state.status).toBe('signedIn');
    expect(server.restCalls().at(-1)?.headers['authorization']).toBe(`Bearer ${second}`);
  });
});

describe('SDK-09 no refresh token is ever sent twice', () => {
  it('sends each refresh token once over many refreshes, parallel and sequential, and after a 401', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    for (let round = 0; round < 3; round++) {
      endAccessToken();
      await Promise.all([me(oy), me(oy), me(oy)]);
    }
    server.invalidateAccess();
    await Promise.all([me(oy), me(oy)]);
    endAccessToken();
    await me(oy);

    expect(server.refreshTokensSeen).toHaveLength(5);
    expect(new Set(server.refreshTokensSeen).size).toBe(5);
    // And the sign-in's own refresh token was the first one sent
    const bodies = server.calls.map((call) => call.rawBody ?? '');
    for (const token of server.refreshTokensSeen) {
      expect(bodies.filter((body) => body.includes(token)).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('SDK-09 a retried call', () => {
  it('answered 401 again fails without a second refresh', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    server.rejectAllRest = true;
    const error = await failure(me(oy));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
    expect(server.refreshCalls).toHaveLength(1);
    expect(server.restCalls()).toHaveLength(2);
    expect(oy.session.state.status).toBe('signedIn');
  });
});

describe('SDK-09 signing out', () => {
  it('posts the refresh token to /auth/revoke, clears the store and reports signedOut', async () => {
    const server = newServer();
    const log: string[] = [];
    const oy = await signedIn(server, loggingStore(log));
    const refreshToken = server.currentRefresh;
    const listener = vi.fn();
    oy.session.onChange(listener);
    log.length = 0;

    await oy.auth.signOut();

    const revoke = server.calls.filter((call) => call.path === '/auth/revoke');
    expect(revoke).toHaveLength(1);
    expect(revoke[0]?.method).toBe('POST');
    expect(revoke[0]?.body).toEqual({ token: refreshToken });
    expect(revoke[0]?.headers['authorization']).toBeUndefined();
    expect(log).toEqual(['store.clear']);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'signedOut' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await failure(me(oy))).kind).toBe('signedOut');
  });

  it('clears the store and reports signedOut also when the revoke request fails with a network error', async () => {
    const server = newServer();
    const log: string[] = [];
    const oy = await signedIn(server, loggingStore(log));
    server.revokeOverride = () => Promise.reject(new TypeError('network down'));
    log.length = 0;

    await expect(oy.auth.signOut()).resolves.toBeUndefined();

    expect(log).toEqual(['store.clear']);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'signedOut' });
  });

  it('reports signedOut also when the server answers an error, and when there is no session', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    server.revokeOverride = () => json({ error: 'server_error', message: 'Oops.' }, 500);
    await oy.auth.signOut();
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'signedOut' });
    const callsBefore = server.calls.length;
    await oy.auth.signOut();
    expect(server.calls).toHaveLength(callsBefore);
  });

  it('reports kind storage when the store cannot clear, after the state is signed out', async () => {
    const server = newServer();
    const inner = new MemoryTokenStore();
    const store: TokenStore = {
      load: () => inner.load(),
      save: (session) => inner.save(session),
      clear: () => Promise.reject(new Error('locked')),
    };
    const oy = await signedIn(server, store);
    expect((await failure(oy.auth.signOut())).kind).toBe('storage');
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'signedOut' });
  });
});

describe('SDK-09 signing in', () => {
  it('throws with the code email_not_verified and leaves the state signed out', async () => {
    const server = newServer();
    const log: string[] = [];
    const oy = client(server, loggingStore(log));
    const listener = vi.fn();
    oy.session.onChange(listener);
    server.tokenOverride = () =>
      json(
        { error: 'email_not_verified', message: 'The e-mail address has not been verified yet.' },
        401,
      );

    const error = await failure(
      oy.auth.signIn({ identifier: USER.email, password: server.password }),
    );

    expect(error.code).toBe('email_not_verified');
    expect(error.status).toBe(401);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'none' });
    expect(listener).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('throws invalid_credentials and keeps an existing session as it was', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    const error = await failure(
      oy.auth.signIn({ identifier: USER.email, password: 'wrong password' }),
    );
    expect(error.code).toBe('invalid_credentials');
    expect(oy.session.state).toEqual({ status: 'signedIn', user: USER });
  });

  it('keeps the answer, reports signedIn once, sends the right body and no Authorization header', async () => {
    const server = newServer();
    const oy = client(server);
    const listener = vi.fn();
    const stop = oy.session.onChange(listener);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'none' });

    await oy.auth.signIn({ identifier: USER.email, password: server.password });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: 'signedIn', user: USER });
    const call = server.calls[0];
    expect(call?.path).toBe('/auth/token');
    expect(call?.body).toEqual({ identifier: USER.email, password: server.password });
    expect(call?.headers['authorization']).toBeUndefined();
    // The token goes to the data routes only
    await me(oy);
    for (const other of server.calls.filter((c) => c.path.startsWith('/auth/'))) {
      expect(other.headers['authorization']).toBeUndefined();
    }
    expect(server.restCalls()[0]?.headers['authorization']).toBe(`Bearer ${server.currentAccess}`);

    stop();
    await oy.auth.signOut();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('answers decoding for a sign-in answer that is not a session', async () => {
    const server = newServer();
    const oy = client(server);
    server.tokenOverride = () => json({ access_token: 'only-this' });
    expect((await failure(oy.auth.signIn({ identifier: USER.email, password: 'x' }))).kind).toBe(
      'decoding',
    );
    expect(oy.session.state.status).toBe('signedOut');
  });

  it('does not sign in when the store cannot save, and reports kind storage', async () => {
    const server = newServer();
    const store: TokenStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error('full')),
      clear: () => Promise.resolve(),
    };
    const oy = client(server, store);
    expect(
      (await failure(oy.auth.signIn({ identifier: USER.email, password: server.password }))).kind,
    ).toBe('storage');
    expect(oy.session.state.status).toBe('signedOut');
  });
});

describe('SDK-09 the other auth calls', () => {
  it('sends register, forgotPassword and resetPassword without a session and without a website field', async () => {
    const answers = [
      json({ status: 'verification_sent' }, 202),
      json({ status: 'reset_sent' }, 202),
      json({ status: 'password_reset' }),
    ];
    const calls: { path: string; body: unknown; authorization: string | undefined }[] = [];
    const oy = new OrganiseYou({
      baseUrl: BASE_URL,
      fetch: (input, init) => {
        const headers = init.headers as Record<string, string>;
        calls.push({
          path: input.slice(BASE_URL.length),
          body: JSON.parse(init.body as string),
          authorization: headers['Authorization'],
        });
        return Promise.resolve(answers[calls.length - 1]!);
      },
    });

    const registered = await oy.auth.register({
      name: 'Rita',
      identifier: USER.email,
      password: 'a-password',
    });
    const forgot = await oy.auth.forgotPassword({
      identifier: USER.email,
      redirectUrl: 'https://app.example.test/reset',
    });
    const reset = await oy.auth.resetPassword({ token: 'reset-1', password: 'a-new-password' });

    expect(registered).toEqual({ status: 'verification_sent' });
    expect(forgot).toEqual({ status: 'reset_sent' });
    expect(reset).toEqual({ status: 'password_reset' });
    expect(calls).toEqual([
      {
        path: '/auth/register',
        body: { name: 'Rita', identifier: USER.email, password: 'a-password' },
        authorization: undefined,
      },
      {
        path: '/auth/password/forgot',
        body: { identifier: USER.email, redirect_url: 'https://app.example.test/reset' },
        authorization: undefined,
      },
      {
        path: '/auth/password/reset',
        body: { token: 'reset-1', password: 'a-new-password' },
        authorization: undefined,
      },
    ]);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'none' });
  });

  it('turns the refusals of these calls into errors with their code', async () => {
    const answers: Record<string, Response> = {
      '/auth/register': json({ error: 'registration_closed', message: 'Closed.' }, 403),
      '/auth/password/forgot': json({ error: 'invalid_redirect', message: 'Not allowed.' }, 400),
      '/auth/password/reset': json(
        { error: 'validation_failed', message: 'Too short.', errors: { password: ['Too short.'] } },
        422,
      ),
    };
    const oy = new OrganiseYou({
      baseUrl: BASE_URL,
      fetch: (input) => Promise.resolve(answers[input.slice(BASE_URL.length)]!.clone()),
    });
    expect(
      (await failure(oy.auth.register({ name: 'a', identifier: USER.email, password: 'x' }))).code,
    ).toBe('registration_closed');
    expect(
      (
        await failure(
          oy.auth.forgotPassword({
            identifier: USER.email,
            redirectUrl: 'https://x.example.test/',
          }),
        )
      ).code,
    ).toBe('invalid_redirect');
    const reset = await failure(oy.auth.resetPassword({ token: 't', password: 'x' }));
    expect(reset.code).toBe('validation_failed');
    expect(reset.fieldErrors).toEqual({ password: ['Too short.'] });
  });

  it('answers decoding for a status answer that has no status', async () => {
    const oy = new OrganiseYou({
      baseUrl: BASE_URL,
      fetch: () => Promise.resolve(json({ other: 1 }, 202)),
    });
    expect(
      (await failure(oy.auth.register({ name: 'a', identifier: USER.email, password: 'x' }))).kind,
    ).toBe('decoding');
  });

  it('returns who is signed in from me()', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    server.tokenOverride = undefined;
    const body = {
      user: USER,
      organization: { id: 'org-1', slug: 'acme', name: 'Acme' },
      roles: ['app_user'],
      permissions: [],
      scopes: ['rest:read'],
      token: { expires_at: '2030-01-01T10:30:00Z' },
    };
    const authorizedFetch = server.fetch;
    const withMe = new OrganiseYou({
      baseUrl: BASE_URL,
      fetch: (input, init) =>
        input.endsWith('/rest/me') ? Promise.resolve(json(body)) : authorizedFetch(input, init),
    });
    await withMe.auth.signIn({ identifier: USER.email, password: server.password });
    expect(await withMe.auth.me()).toEqual(body);
    expect(oy.session.state.status).toBe('signedIn');
  });

  it('answers decoding when /rest/me is not in the expected shape', async () => {
    const server = newServer();
    const authorizedFetch = server.fetch;
    const oy = new OrganiseYou({
      baseUrl: BASE_URL,
      fetch: (input, init) =>
        input.endsWith('/rest/me')
          ? Promise.resolve(json({ user: 1 }))
          : authorizedFetch(input, init),
    });
    await oy.auth.signIn({ identifier: USER.email, password: server.password });
    expect((await failure(oy.auth.me())).kind).toBe('decoding');
  });
});

describe('SDK-09 resetTokenFrom', () => {
  const oy = new OrganiseYou({ baseUrl: BASE_URL });

  it("returns 'abc' for 'https://app.example.test/reset#token=abc'", () => {
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset#token=abc')).toBe('abc');
  });

  it('returns nothing for a link without the fragment', () => {
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset')).toBeUndefined();
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset?token=abc')).toBeUndefined();
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset#other=abc')).toBeUndefined();
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset#token=')).toBeUndefined();
    expect(oy.auth.resetTokenFrom('https://app.example.test/reset#')).toBeUndefined();
  });

  it('reads a token in a link of an app, a relative link, and a fragment with other parts', () => {
    expect(oy.auth.resetTokenFrom('myapp://reset#lang=nl&token=a%2Bb')).toBe('a+b');
    expect(oy.auth.resetTokenFrom('/reset#token=abc')).toBe('abc');
  });
});

describe('SDK-09 restore and the stores', () => {
  it('reports signedIn for a stored session, and refreshes at the first call when its token has ended', async () => {
    const server = newServer();
    const first = await signedIn(server);
    expect(first.session.state.status).toBe('signedIn');
    const store = new MemoryTokenStore();
    const pair = server.issuePair();
    await store.save(
      new StoredSession({
        accessToken: pair.accessToken,
        expiresAt: new Date(Date.now() - 1000),
        refreshToken: pair.refreshToken,
        scope: 'rest:read',
        user: USER,
      }),
    );

    const oy = client(server, store);
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'none' });
    const listener = vi.fn();
    oy.session.onChange(listener);
    await oy.session.restore();

    expect(oy.session.state).toEqual({ status: 'signedIn', user: USER });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(server.refreshCalls).toHaveLength(0);
    await me(oy);
    expect(server.refreshCalls).toHaveLength(1);
  });

  it('stays signed out when the store is empty, and reports kind storage when it cannot load', async () => {
    const server = newServer();
    const oy = client(server);
    await oy.session.restore();
    expect(oy.session.state).toEqual({ status: 'signedOut', reason: 'none' });

    const broken = client(server, {
      load: () => Promise.reject(new Error('locked')),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    });
    expect((await failure(broken.session.restore())).kind).toBe('storage');
  });

  it('keeps only the refresh token in sessionStorage, and a new page restores from it with one refresh', async () => {
    const server = newServer();
    const storage = new FakeStorage();
    const oy = await signedIn(server, new SessionStorageTokenStore({ storage }));

    const kept = [...storage.data.values()].join('|');
    expect(kept).toContain(server.currentRefresh);
    expect(kept).not.toContain(server.currentAccess);
    const refreshTokenBefore = server.currentRefresh;

    // A reload: a new client over the same storage
    const reloaded = client(server, new SessionStorageTokenStore({ storage }));
    await reloaded.session.restore();
    expect(reloaded.session.state).toEqual({ status: 'signedIn', user: USER });
    await Promise.all([me(reloaded), me(reloaded)]);
    expect(server.refreshCalls).toHaveLength(1);
    expect(server.refreshCalls[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenBefore,
    });
    expect(oy.session.state.status).toBe('signedIn');

    await reloaded.auth.signOut();
    expect(storage.data.size).toBe(0);
  });

  it('ignores a sessionStorage entry that is not a session', async () => {
    const storage = new FakeStorage();
    storage.setItem('organiseyou.session', '{"refreshToken": 5}');
    const store = new SessionStorageTokenStore({ storage });
    await expect(store.load()).resolves.toBeNull();
    storage.setItem('organiseyou.session', 'not json');
    await expect(store.load()).resolves.toBeNull();
  });

  it('refuses to be made without a sessionStorage', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => new SessionStorageTokenStore()).toThrow(TypeError);
  });

  it('writes to no localStorage, with either store, through sign-in, refresh and sign-out', async () => {
    const localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    vi.stubGlobal('localStorage', localStorage);
    for (const store of [
      new MemoryTokenStore(),
      new SessionStorageTokenStore({ storage: new FakeStorage() }),
    ]) {
      const server = newServer();
      const oy = await signedIn(server, store);
      endAccessToken();
      await me(oy);
      await oy.auth.signOut();
    }
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe('SDK-09 nothing secret is printed', () => {
  it('holds neither a token nor the password in the JSON, String() and console.log output of the session, of an error after a failed login, and of an onRequest record', async () => {
    const server = newServer();
    const infos: RequestInfo[] = [];
    const store = new MemoryTokenStore();
    const oy = client(server, store, (info) => infos.push(info));

    // A failed login with a password that is checked afterwards
    const password = `pw-${randomBytes(8).toString('hex')}`;
    const failed = await failure(oy.auth.signIn({ identifier: USER.email, password }));
    expect(failed.code).toBe('invalid_credentials');

    await oy.auth.signIn({ identifier: USER.email, password: server.password });
    endAccessToken();
    await me(oy);
    const stored = await store.load();
    expect(stored).toBeInstanceOf(StoredSession);

    const secrets = [
      password,
      server.password,
      server.currentAccess,
      server.currentRefresh,
      ...server.refreshTokensSeen,
    ];
    expect(secrets.every((secret) => secret.length > 8)).toBe(true);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const things = [oy.session, failed, infos, infos[0], stored, oy, oy.session.state];
    for (const thing of things) console.log(thing);
    console.log('%s', oy.session);
    console.log('%j', oy.session);
    const printed = [
      ...log.mock.calls.map((args) => format(...args)),
      ...things.map((thing) => JSON.stringify(thing)),
      // String() of an object with no toString of its own is allowed here: the point is what it shows
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      ...things.map((thing) => String(thing)),
      ...things.map((thing) => inspect(thing, { depth: null, showHidden: true })),
      inspect(failed.stack ?? '', { depth: null }),
      String(failed.cause),
    ].join('\n');

    for (const secret of secrets) expect(printed).not.toContain(secret);
    expect(printed).toContain('<hidden>');
    // The error text is the server's, and holds no request
    expect(failed.message).toBe('These credentials are not valid.');
    // The request log has the keys it promises and the call that held the password
    expect(infos.some((info) => info.path === '/auth/token' && info.method === 'POST')).toBe(true);
    for (const info of infos)
      expect(Object.keys(info).sort()).toEqual(['durationMs', 'method', 'path', 'status']);
  });

  it('shows the session state but not the tokens when the session is turned into JSON', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    expect(JSON.parse(JSON.stringify(oy.session))).toEqual({
      state: { status: 'signedIn', user: USER },
    });
    expect(String(oy.session)).toBe('Session(signedIn)');
  });

  it('gives the tokens only to a store that asks for them', async () => {
    const server = newServer();
    const store = new MemoryTokenStore();
    await signedIn(server, store);
    const stored = (await store.load())!;
    expect(stored.accessToken).toBe(server.currentAccess);
    expect(stored.refreshToken).toBe(server.currentRefresh);
    expect(stored.expiresAt.getTime()).toBe(Date.now() + 1800 * 1000);
    expect(Object.keys(stored)).toEqual(['scope', 'user']);
  });
});

describe('SDK-09 listeners', () => {
  it('does not stop the others when one listener throws, and reports it to the app', async () => {
    const server = newServer();
    const oy = client(server);
    const survivor = vi.fn();
    oy.session.onChange(() => {
      throw new Error('listener failed');
    });
    oy.session.onChange(survivor);
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);
    await oy.auth.signIn({ identifier: USER.email, password: server.password });
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('uncaughtException', uncaught);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(uncaught).toHaveBeenCalledTimes(1);
  });

  it('does not tell a listener when nothing changed', async () => {
    const server = newServer();
    const oy = await signedIn(server);
    const listener = vi.fn();
    oy.session.onChange(listener);
    endAccessToken();
    await me(oy);
    expect(listener).not.toHaveBeenCalled();
  });
});
