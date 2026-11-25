import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../src/config.js';
import { MemoryTokenStore, type StringStorage, type TokenStore } from '../src/store.js';

export const BASE_URL = 'https://api.example.test/api/acme';

export interface RecordedCall {
  url: string;
  /** The URL after the base address. */
  path: string;
  method: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** The body as sent, or `undefined`. */
  rawBody: string | undefined;
  /** The body parsed, or `undefined`. */
  body: unknown;
  init: RequestInit;
}

export type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A fake `fetch` that records every call and answers with `handler`. No socket is ever opened. */
export function fakeFetch(handler: Handler): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const rawBody = typeof init.body === 'string' ? init.body : undefined;
    const call: RecordedCall = {
      url: input,
      path: input.startsWith(BASE_URL) ? input.slice(BASE_URL.length) : input,
      method: init.method ?? 'GET',
      headers,
      rawBody,
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
      init,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function emptyResponse(status = 200): Response {
  return new Response('', { status });
}

/** A token-shaped value built at run time, so no file holds a string that looks like a real credential. */
export function makeToken(prefix: 'oyo' | 'oyr'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export interface FakeUser {
  id: string;
  name: string;
  email: string;
}

export const USER: FakeUser = { id: 'usr_1', name: 'Mira Member', email: 'user@example.test' };

/**
 * A fake OrganiseYou server for the session tests: it issues token pairs, spends a refresh token once, and checks
 * the bearer token of every `/rest/*` call. It remembers every body it was sent.
 */
export class FakeServer {
  readonly calls: RecordedCall[] = [];
  readonly fetch: FetchLike;
  readonly password = `pw-${randomBytes(6).toString('hex')}`;
  /** The refresh tokens of every refresh call, in order. */
  readonly refreshTokensSeen: string[] = [];
  currentAccess = '';
  currentRefresh = '';
  expiresIn = 1800;
  /** Every `/rest/*` call is answered 401 unauthenticated, whatever the token. */
  rejectAllRest = false;
  /** Answers `/auth/token` with this instead of working, when set. */
  tokenOverride: (() => Response | Promise<Response>) | undefined;
  /** Answers `/auth/revoke` with this instead of working, when set. */
  revokeOverride: (() => Response | Promise<Response>) | undefined;
  /** A refresh token may be sent again (a refresh whose answer was lost to the network). */
  allowRepeatedRefresh = false;
  /** Answers a `/rest/*` call instead of working, when it returns a response. */
  restOverride: ((call: RecordedCall) => Response | Promise<Response> | undefined) | undefined;
  /** Every call is logged here as `fetch <path>`, in the order it arrives. */
  log: string[] | undefined;
  /** Delay of the refresh answer, so calls really overlap. */
  refreshGate: Promise<void> = Promise.resolve();
  #issued = 0;
  readonly #spent = new Set<string>();

  constructor() {
    const faked = fakeFetch((call) => this.#answer(call));
    this.fetch = faked.fetch;
    this.calls = faked.calls;
  }

  /** The bodies of every call to `/auth/token` that were a refresh. */
  get refreshCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.path === '/auth/token' && isRefresh(call));
  }

  restCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.path.startsWith('/rest/'));
  }

  /** The server stops accepting the current access token, as when it ended. */
  invalidateAccess(): void {
    this.currentAccess = '';
  }

  /** Issues a new token pair without a call, as a store would hold from an earlier run. */
  issuePair(): { accessToken: string; refreshToken: string } {
    return this.#issue();
  }

  #issue(): { accessToken: string; refreshToken: string } {
    this.#issued++;
    if (this.currentRefresh !== '') this.#spent.add(this.currentRefresh);
    this.currentAccess = makeToken('oyo');
    this.currentRefresh = makeToken('oyr');
    return { accessToken: this.currentAccess, refreshToken: this.currentRefresh };
  }

  #tokenAnswer(pair: { accessToken: string; refreshToken: string }): Response {
    return json({
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      refresh_token: pair.refreshToken,
      scope: 'rest:read rest:write',
      user: USER,
    });
  }

  async #answer(call: RecordedCall): Promise<Response> {
    this.log?.push(`fetch ${call.path}`);
    if (call.path === '/auth/token') {
      if (this.tokenOverride !== undefined && !isRefresh(call)) return this.tokenOverride();
      const body = call.body as Record<string, string>;
      if (isRefresh(call)) {
        this.refreshTokensSeen.push(body['refresh_token'] ?? '');
        await this.refreshGate;
        if (this.tokenOverride !== undefined) return this.tokenOverride();
        if (body['refresh_token'] !== this.currentRefresh) {
          return json(
            { error: 'invalid_credentials', message: 'The refresh token is not valid.' },
            401,
          );
        }
        return this.#tokenAnswer(this.#issue());
      }
      if (body['identifier'] !== USER.email || body['password'] !== this.password) {
        return json(
          { error: 'invalid_credentials', message: 'These credentials are not valid.' },
          401,
        );
      }
      return this.#tokenAnswer(this.#issue());
    }
    if (call.path === '/auth/revoke') {
      if (this.revokeOverride !== undefined) return this.revokeOverride();
      return json({});
    }
    if (call.path.startsWith('/rest/')) {
      const overridden = this.restOverride?.(call);
      if (overridden !== undefined) return overridden;
      const bearer = call.headers['authorization'];
      if (
        this.rejectAllRest ||
        this.currentAccess === '' ||
        bearer !== `Bearer ${this.currentAccess}`
      ) {
        return json({ error: 'unauthenticated', message: 'Authentication is required.' }, 401);
      }
      if (call.path === '/rest/me') {
        return json({
          user: USER,
          organization: { id: 'org-1', slug: 'acme', name: 'Acme' },
          roles: ['app_user'],
          permissions: [],
          scopes: ['rest:read'],
          token: { expires_at: '2030-01-01T10:30:00Z' },
        });
      }
      return json({ ok: true });
    }
    return json({ error: 'not_found', message: 'No such route.' }, 404);
  }

  get issuedCount(): number {
    return this.#issued;
  }
}

function isRefresh(call: RecordedCall): boolean {
  return (call.body as { grant_type?: string } | undefined)?.grant_type === 'refresh_token';
}

/** A store that records what is done to it, in one log shared with the fake server's calls. */
export function loggingStore(
  log: string[],
  inner: TokenStore = new MemoryTokenStore(),
): TokenStore {
  return {
    async load() {
      log.push('store.load');
      return inner.load();
    },
    async save(session) {
      log.push('store.save');
      await Promise.resolve();
      return inner.save(session);
    },
    async clear() {
      log.push('store.clear');
      return inner.clear();
    },
  };
}

/** An in-memory stand-in for `Storage`. */
export class FakeStorage implements StringStorage {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}
