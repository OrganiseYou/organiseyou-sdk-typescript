/** Who is signed in. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface StoredSessionInit {
  accessToken: string;
  /** The instant the access token ends. */
  expiresAt: Date;
  refreshToken: string;
  scope: string;
  user: SessionUser;
}

const HIDDEN = '<hidden>';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A session as a token store keeps it. The tokens are private fields: printing a session, turning it into JSON or
 * logging it never shows them. A store that persists a session reads `accessToken` and `refreshToken` itself.
 */
export class StoredSession {
  readonly #accessToken: string;
  readonly #expiresAt: number;
  readonly #refreshToken: string;
  readonly scope: string;
  readonly user: SessionUser;

  constructor(init: StoredSessionInit) {
    this.#accessToken = init.accessToken;
    this.#expiresAt = init.expiresAt.getTime();
    this.#refreshToken = init.refreshToken;
    this.scope = init.scope;
    this.user = Object.freeze({ id: init.user.id, name: init.user.name, email: init.user.email });
  }

  get accessToken(): string {
    return this.#accessToken;
  }

  /** The instant the access token ends. */
  get expiresAt(): Date {
    return new Date(this.#expiresAt);
  }

  get refreshToken(): string {
    return this.#refreshToken;
  }

  toJSON(): Record<string, unknown> {
    return {
      accessToken: HIDDEN,
      expiresAt: new Date(this.#expiresAt).toISOString(),
      refreshToken: HIDDEN,
      scope: this.scope,
      user: this.user,
    };
  }

  toString(): string {
    return `StoredSession(${this.user.id}, tokens ${HIDDEN})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

/** Where a session lives between calls. A store may fail: the error is reported as an `OrganiseYouError`. */
export interface TokenStore {
  /** The stored session, or `null` when there is none. */
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

/** Keeps the session in memory only: a reload or a restart signs out. This is the default. */
export class MemoryTokenStore implements TokenStore {
  #session: StoredSession | null = null;

  load(): Promise<StoredSession | null> {
    return Promise.resolve(this.#session);
  }

  save(session: StoredSession): Promise<void> {
    this.#session = session;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#session = null;
    return Promise.resolve();
  }
}

/** The part of `Storage` that is used. */
export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionStorageTokenStoreOptions {
  /** Defaults to the browser's `sessionStorage`. */
  storage?: StringStorage;
  /** The storage key. Give each client of a page its own when it talks to more than one organization. */
  key?: string;
}

/**
 * Keeps the refresh token (with the scope and the user's name and address, which are not secret) in the browser's
 * `sessionStorage`, so a reload of the tab stays signed in. The access token stays in memory, so after a reload the
 * first call refreshes first. Nothing is written to `localStorage`.
 */
export class SessionStorageTokenStore implements TokenStore {
  readonly #storage: StringStorage;
  readonly #key: string;
  #memory: StoredSession | null = null;

  constructor(options: SessionStorageTokenStoreOptions = {}) {
    const storage =
      options.storage ?? (globalThis as { sessionStorage?: StringStorage }).sessionStorage;
    if (storage === undefined) {
      throw new TypeError('sessionStorage is not available here: pass a storage in the options.');
    }
    this.#storage = storage;
    this.#key = options.key ?? 'organiseyou.session';
  }

  load(): Promise<StoredSession | null> {
    return Promise.resolve().then(() => {
      if (this.#memory !== null) return this.#memory;
      const raw = this.#storage.getItem(this.#key);
      if (raw === null) return null;
      const kept = parseKept(raw);
      if (kept === undefined) return null;
      // No access token yet: it ended long ago, so the first call refreshes
      return new StoredSession({ ...kept, accessToken: '', expiresAt: new Date(0) });
    });
  }

  save(session: StoredSession): Promise<void> {
    return Promise.resolve().then(() => {
      this.#storage.setItem(
        this.#key,
        JSON.stringify({
          refreshToken: session.refreshToken,
          scope: session.scope,
          user: session.user,
        }),
      );
      this.#memory = session;
    });
  }

  clear(): Promise<void> {
    return Promise.resolve().then(() => {
      this.#memory = null;
      this.#storage.removeItem(this.#key);
    });
  }
}

function parseKept(
  raw: string,
): { refreshToken: string; scope: string; user: SessionUser } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { refreshToken, scope, user } = value as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken === '' || typeof scope !== 'string')
    return undefined;
  if (typeof user !== 'object' || user === null) return undefined;
  const { id, name, email } = user as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof email !== 'string')
    return undefined;
  return { refreshToken, scope, user: { id, name, email } };
}
