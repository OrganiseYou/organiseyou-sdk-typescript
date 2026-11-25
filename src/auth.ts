import { OrganiseYouError } from './error.js';
import type { SessionEngine } from './session.js';
import type { Transport } from './transport.js';

/** Options every call takes. */
export interface RequestOptions {
  /** Cancels the call. The returned promise then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What `/auth/register`, `/auth/password/forgot` and `/auth/password/reset` answer. */
export interface StatusResult {
  /** `verification_sent`, `reset_sent` or `password_reset`. */
  status: string;
}

/** The answer of `GET /rest/me`, as the server sends it. */
export interface Me {
  user: { id: string; email: string; name: string };
  organization: { id: string; slug: string; name: string };
  roles: string[];
  permissions: string[];
  scopes: string[];
  token: { expires_at: string };
}

/** Sign-in, sign-out, registration and password reset, as `oy.auth`. */
export class Auth {
  readonly #engine: SessionEngine;
  readonly #transport: Transport;

  /** Made by `OrganiseYou`; not for apps. */
  constructor(engine: SessionEngine, transport: Transport) {
    this.#engine = engine;
    this.#transport = transport;
  }

  /**
   * Signs in with an e-mail address and a password and keeps the session. A refusal (`invalid_credentials`,
   * `email_not_verified`) is an `OrganiseYouError` with that `code`, and the state stays signed out.
   */
  signIn(
    credentials: { identifier: string; password: string },
    options: RequestOptions = {},
  ): Promise<void> {
    return this.#engine.signIn(credentials, options.signal);
  }

  /**
   * Ends the session on the server and here. The state is signed out afterwards, also when the server cannot be
   * reached.
   */
  signOut(options: RequestOptions = {}): Promise<void> {
    return this.#engine.signOut(options.signal);
  }

  /** Asks for an account. The answer is `verification_sent`; nobody is signed in until the e-mail link is followed. */
  register(
    details: { name: string; identifier: string; password: string },
    options: RequestOptions = {},
  ): Promise<StatusResult> {
    return this.#status(
      '/auth/register',
      {
        name: details.name,
        identifier: details.identifier,
        password: details.password,
      },
      options,
    );
  }

  /**
   * Asks for a reset link. `redirectUrl` is the page of your app that opens from the link; the organization must
   * allow it, else the error code is `invalid_redirect`.
   */
  forgotPassword(
    details: { identifier: string; redirectUrl: string },
    options: RequestOptions = {},
  ): Promise<StatusResult> {
    return this.#status(
      '/auth/password/forgot',
      {
        identifier: details.identifier,
        redirect_url: details.redirectUrl,
      },
      options,
    );
  }

  /** Sets a new password with the token of the reset link. Nobody is signed in by it. */
  resetPassword(
    details: { token: string; password: string },
    options: RequestOptions = {},
  ): Promise<StatusResult> {
    return this.#status(
      '/auth/password/reset',
      {
        token: details.token,
        password: details.password,
      },
      options,
    );
  }

  /** Who the signed-in person is, with the roles and scopes of the token. */
  async me(options: RequestOptions = {}): Promise<Me> {
    const answer = await this.#engine.authorized({
      method: 'GET',
      path: '/rest/me',
      signal: options.signal,
    });
    if (!isMe(answer)) {
      throw new OrganiseYouError({
        kind: 'decoding',
        message: 'The answer of /rest/me is not in the expected shape.',
      });
    }
    return answer;
  }

  /**
   * The token in the fragment of a reset link (`https://app.example.test/reset#token=abc` gives `abc`), or
   * `undefined` when the link has none. Take the token out of the address bar afterwards.
   */
  resetTokenFrom(url: string): string | undefined {
    const hash = url.indexOf('#');
    if (hash === -1) return undefined;
    const token = new URLSearchParams(url.slice(hash + 1)).get('token');
    return token === null || token === '' ? undefined : token;
  }

  async #status(
    path: string,
    body: Record<string, string>,
    options: RequestOptions,
  ): Promise<StatusResult> {
    const answer = await this.#transport.send({
      method: 'POST',
      path,
      body,
      signal: options.signal,
    });
    const status =
      typeof answer === 'object' && answer !== null
        ? (answer as { status?: unknown }).status
        : undefined;
    if (typeof status !== 'string') {
      throw new OrganiseYouError({
        kind: 'decoding',
        message: `The answer of ${path} is not in the expected shape.`,
      });
    }
    return { status };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMe(value: unknown): value is Me {
  return (
    isObject(value) &&
    isObject(value['user']) &&
    isObject(value['organization']) &&
    Array.isArray(value['roles']) &&
    Array.isArray(value['permissions']) &&
    Array.isArray(value['scopes']) &&
    isObject(value['token'])
  );
}
