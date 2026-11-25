/**
 * What went wrong:
 * - `http`: the server answered an error;
 * - `network`: no answer arrived;
 * - `timeout`: the call took longer than `timeoutMs`;
 * - `decoding`: an answer that is not the expected JSON, such as a proxy's HTML page;
 * - `signedOut`: there is no session, or the session has ended;
 * - `storage`: the token store failed.
 */
export type ErrorKind = 'http' | 'network' | 'timeout' | 'decoding' | 'signedOut' | 'storage';

/** The limit of the tightest rate limit that applied to an answer. */
export interface RateLimit {
  /** The most calls the limit allows in its window. */
  limit: number;
  /** The calls left in the window. */
  remaining: number;
  /** The seconds until the window resets. */
  resetSeconds: number;
}

export interface OrganiseYouErrorInit {
  kind: ErrorKind;
  message: string;
  status?: number | undefined;
  code?: string | undefined;
  fieldErrors?: Record<string, string[]> | undefined;
  retryAfterSeconds?: number | undefined;
  rateLimit?: RateLimit | undefined;
}

/**
 * The one error of this package. It never holds a token, a password, a request body or a header, so it is safe to
 * log.
 */
export class OrganiseYouError extends Error {
  override readonly name = 'OrganiseYouError';
  readonly kind: ErrorKind;
  /** The HTTP status, when the server answered. */
  readonly status?: number;
  /** The server's `error` code, such as `validation_failed`. Absent when the body is not in the server's shape. */
  readonly code?: string;
  /** The messages of a `422`, per field alias. Empty for every other error. */
  readonly fieldErrors: Readonly<Record<string, string[]>>;
  /** The seconds to wait, from the `Retry-After` header. */
  readonly retryAfterSeconds?: number;
  /** The rate limit headers of the answer, when it carried them. */
  readonly rateLimit?: RateLimit;

  constructor(init: OrganiseYouErrorInit) {
    super(init.message);
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    this.fieldErrors = init.fieldErrors ?? {};
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
    if (init.rateLimit !== undefined) this.rateLimit = init.rateLimit;
  }
}

/** The error of a call that needs a session when there is none, or the session has ended. */
export function signedOutError(message = 'Not signed in.'): OrganiseYouError {
  return new OrganiseYouError({ kind: 'signedOut', message });
}
