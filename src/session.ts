import { OrganiseYouError, signedOutError } from './error.js';
import { type SessionUser, StoredSession, type TokenStore } from './store.js';
import type { SendOptions, Transport } from './transport.js';

/** Why there is no session: never signed in, `signOut()` was called, or the server ended the session. */
export type SignedOutReason = 'none' | 'signedOut' | 'sessionEnded';

export type SessionState =
  | { readonly status: 'signedIn'; readonly user: SessionUser }
  | { readonly status: 'signedOut'; readonly reason: SignedOutReason };

export type SessionListener = (state: SessionState) => void;

/** The access token is renewed when it ends within this time. */
const REFRESH_MARGIN_MS = 60_000;

/** What a call to a `/rest/*` path needs. The access token is added here. */
export type AuthorizedRequest = Omit<SendOptions, 'accessToken'>;

/** The session of one client, as `oy.session` shows it. */
export class Session {
  readonly #engine: SessionEngine;

  /** Made by `OrganiseYou`; not for apps. */
  constructor(engine: SessionEngine) {
    this.#engine = engine;
  }

  get state(): SessionState {
    return this.#engine.state;
  }

  /** Calls `listener` whenever the state changes. Returns the function that stops it. */
  onChange(listener: SessionListener): () => void {
    return this.#engine.onChange(listener);
  }

  /**
   * Reads the token store once. A stored session then reports signed in; an access token that has ended is
   * renewed at the first call. Call it at start when the app uses a store that keeps a session.
   */
  restore(): Promise<void> {
    return this.#engine.restore();
  }

  toJSON(): { state: SessionState } {
    return { state: this.#engine.state };
  }

  toString(): string {
    return `Session(${this.#engine.state.status})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/**
 * Owns the session: the stored tokens, the one refresh in progress and the state. The tokens never leave it except
 * in the `Authorization` header of a call and in the body of the refresh and revoke calls.
 */
export class SessionEngine {
  readonly #transport: Transport;
  readonly #store: TokenStore;
  readonly #listeners = new Set<SessionListener>();
  #state: SessionState = Object.freeze({ status: 'signedOut', reason: 'none' });
  #session: StoredSession | undefined;
  #refreshing: Promise<void> | undefined;
  /** Counts the changes of who is signed in, so an old refresh cannot bring a session back. */
  #generation = 0;

  constructor(transport: Transport, store: TokenStore) {
    this.#transport = transport;
    this.#store = store;
  }

  get state(): SessionState {
    return this.#state;
  }

  onChange(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async restore(): Promise<void> {
    if (this.#session !== undefined) return;
    let stored: StoredSession | null;
    try {
      stored = await this.#store.load();
    } catch {
      throw storageError('load');
    }
    if (stored === null) return;
    if (!(stored instanceof StoredSession)) throw storageError('load');
    // A sign-in that finished while the store was read wins
    if (this.#session !== undefined) return;
    this.#generation++;
    this.#session = stored;
    this.#setState({ status: 'signedIn', user: stored.user });
  }

  /** Signs in with a password. A refused sign-in leaves the state as it was. */
  async signIn(
    credentials: { identifier: string; password: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    const answer = await this.#transport.send({
      method: 'POST',
      path: '/auth/token',
      body: { identifier: credentials.identifier, password: credentials.password },
      signal,
    });
    const session = sessionFromAnswer(answer, startedAt);
    try {
      await this.#store.save(session);
    } catch {
      throw storageError('save');
    }
    this.#generation++;
    this.#session = session;
    this.#setState({ status: 'signedIn', user: session.user });
  }

  /**
   * Revokes the session on the server, then forgets it here. The state is signed out afterwards even when the
   * revoke call fails.
   */
  async signOut(signal?: AbortSignal): Promise<void> {
    if (this.#refreshing !== undefined) {
      // The refresh token in flight is spent when it lands: revoke the one that follows
      await this.#refreshing.catch(() => undefined);
    }
    const session = this.#session;
    if (session !== undefined) {
      try {
        await this.#transport.send({
          method: 'POST',
          path: '/auth/revoke',
          body: { token: session.refreshToken },
          signal,
        });
      } catch {
        // The app must never stay signed in because the network failed
      }
    }
    this.#generation++;
    this.#session = undefined;
    let cleared = true;
    try {
      await this.#store.clear();
    } catch {
      cleared = false;
    }
    this.#setState({ status: 'signedOut', reason: 'signedOut' });
    if (!cleared) throw storageError('clear');
  }

  /**
   * Sends a call that needs the session: renews the access token first when it ends within a minute, and once more
   * after a `401 unauthenticated`. At most one refresh runs, however many calls need it.
   */
  async authorized(request: AuthorizedRequest): Promise<unknown> {
    const session = await this.#fresh();
    const sent = session.accessToken;
    try {
      return await this.#transport.send({ ...request, accessToken: sent });
    } catch (error) {
      if (!isUnauthenticated(error)) throw error;
    }

    // A newer token may already be here, from a refresh another call started
    if (this.#session === undefined) throw signedOutError();
    if (this.#session.accessToken === sent) await this.#joinRefresh();
    const latest = this.#session;
    if (latest === undefined) throw signedOutError();
    // The one retry. Another 401 is the answer: it never starts a second refresh
    return this.#transport.send({ ...request, accessToken: latest.accessToken });
  }

  async #fresh(): Promise<StoredSession> {
    if (this.#refreshing === undefined) {
      const session = this.#session;
      if (session === undefined) throw signedOutError();
      if (session.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return session;
    }
    await this.#joinRefresh();
    if (this.#session === undefined) throw signedOutError();
    return this.#session;
  }

  /** Joins the refresh in progress, or starts it. Check and start happen in one step, so there is only one. */
  #joinRefresh(): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    const session = this.#session;
    if (session === undefined) return Promise.reject(signedOutError());
    const refreshing = this.#refresh(session, this.#generation).finally(() => {
      this.#refreshing = undefined;
    });
    this.#refreshing = refreshing;
    return refreshing;
  }

  async #refresh(current: StoredSession, generation: number): Promise<void> {
    const startedAt = Date.now();
    let answer: unknown;
    try {
      // The refresh token is sent here and nowhere else, once
      answer = await this.#transport.send({
        method: 'POST',
        path: '/auth/token',
        body: { grant_type: 'refresh_token', refresh_token: current.refreshToken },
      });
    } catch (error) {
      if (isRefusedRefresh(error)) {
        // A refusal of an old session says nothing about the one that was signed in since
        if (generation !== this.#generation) return;
        await this.#end();
        throw signedOutError('The session has ended. Sign in again.');
      }
      // The token may not be spent (the network failed, or the server was busy): the session stays as it is
      throw error;
    }

    const next = sessionFromAnswer(answer, startedAt, current.user);
    // Signed in again while the refresh was on its way: the answer belongs to the old session and is dropped. The
    // calls that waited go on with the session that is there now, or fail signed out when there is none.
    if (generation !== this.#generation) return;
    // Memory first, so the spent token is never sent again whatever the store does
    this.#session = next;
    try {
      // Saved before any waiting call is released
      await this.#store.save(next);
    } catch {
      throw storageError('save');
    }
    this.#setState({ status: 'signedIn', user: next.user });
  }

  /** The server ended the session. */
  async #end(): Promise<void> {
    this.#generation++;
    this.#session = undefined;
    try {
      await this.#store.clear();
    } catch {
      // The stored token is spent: the worst it does is end the next restore the same way
    }
    this.#setState({ status: 'signedOut', reason: 'sessionEnded' });
  }

  #setState(next: SessionState): void {
    const current = this.#state;
    if (sameState(current, next)) return;
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch (error) {
        // One failing listener must not stop the others; the app's own error handler sees it
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}

function sameState(a: SessionState, b: SessionState): boolean {
  if (a.status === 'signedIn' && b.status === 'signedIn') {
    return a.user.id === b.user.id && a.user.name === b.user.name && a.user.email === b.user.email;
  }
  if (a.status === 'signedOut' && b.status === 'signedOut') return a.reason === b.reason;
  return false;
}

function isUnauthenticated(error: unknown): boolean {
  return (
    error instanceof OrganiseYouError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.code === 'unauthenticated'
  );
}

function isRefusedRefresh(error: unknown): boolean {
  return (
    error instanceof OrganiseYouError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.code === 'invalid_credentials'
  );
}

function storageError(action: 'load' | 'save' | 'clear'): OrganiseYouError {
  return new OrganiseYouError({
    kind: 'storage',
    message: `The token store failed to ${action} the session.`,
  });
}

function notShaped(): OrganiseYouError {
  return new OrganiseYouError({
    kind: 'decoding',
    message: 'The sign-in answer is not in the expected shape.',
  });
}

function sessionFromAnswer(
  answer: unknown,
  startedAt: number,
  fallbackUser?: SessionUser,
): StoredSession {
  if (typeof answer !== 'object' || answer === null) throw notShaped();
  const { access_token, refresh_token, expires_in, scope, user } = answer as Record<
    string,
    unknown
  >;
  if (typeof access_token !== 'string' || access_token === '') throw notShaped();
  if (typeof refresh_token !== 'string' || refresh_token === '') throw notShaped();
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in < 0)
    throw notShaped();
  let sessionUser = fallbackUser;
  if (typeof user === 'object' && user !== null) {
    const { id, name, email } = user as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof email !== 'string')
      throw notShaped();
    sessionUser = { id, name, email };
  }
  if (sessionUser === undefined) throw notShaped();
  return new StoredSession({
    accessToken: access_token,
    expiresAt: new Date(startedAt + expires_in * 1000),
    refreshToken: refresh_token,
    scope: typeof scope === 'string' ? scope : '',
    user: sessionUser,
  });
}
