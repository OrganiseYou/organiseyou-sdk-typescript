import type { TransportConfig } from './config.js';
import { OrganiseYouError, type RateLimit } from './error.js';

/**
 * What `onRequest` receives after every request. It holds nothing else: never a header, a body or a query value
 * other than `page` and `perPage`.
 */
export interface RequestInfo {
  method: string;
  /** The path after the API address, with the `page` and `perPage` query when the call has them. */
  path: string;
  /** The HTTP status, or `null` when no answer arrived. */
  status: number | null;
  durationMs: number;
}

export interface SendOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Starts with `/`, with every segment already percent-encoded. */
  path: string;
  query?: { page?: number | undefined; perPage?: number | undefined };
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as `Authorization: Bearer`. Only `/rest/*` calls pass one. */
  accessToken?: string | undefined;
  /** Cancels the call. The returned promise then rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
}

/** Sends the requests of one client to one API address and turns every failure into `OrganiseYouError`. */
export class Transport {
  readonly #config: TransportConfig;
  #lastRateLimit: RateLimit | undefined;

  constructor(config: TransportConfig) {
    this.#config = config;
  }

  /** The rate limit headers of the latest answer that carried them. */
  get lastRateLimit(): RateLimit | undefined {
    return this.#lastRateLimit;
  }

  /** Returns the parsed JSON body, or `undefined` for an empty one. */
  async send(options: SendOptions): Promise<unknown> {
    const { signal } = options;
    // No request is made after an abort
    signal?.throwIfAborted();

    const path = options.path + queryString(options.query);
    const started = Date.now();
    const controller = new AbortController();
    const state: { status: number | null } = { status: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    // Rejects when the deadline passes or the caller aborts. The platform's `fetch` honours the abort too, but a
    // replacement may not, so the call never waits for it.
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new OrganiseYouError({
            kind: 'timeout',
            message: `The request took longer than ${this.#config.timeoutMs} ms.`,
          }),
        );
        controller.abort();
      }, this.#config.timeoutMs);
      if (signal !== undefined) {
        onAbort = () => {
          // The caller's own reason, as `fetch` rejects with it; it is not wrapped in OrganiseYouError
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
          controller.abort(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    interrupted.catch(() => undefined);

    try {
      const work = this.#exchange(options, path, controller.signal, state);
      work.catch(() => undefined);
      return await Promise.race([work, interrupted]);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined)
        signal.removeEventListener('abort', onAbort);
      this.#report({
        method: options.method,
        path,
        status: state.status,
        durationMs: Date.now() - started,
      });
    }
  }

  async #exchange(
    options: SendOptions,
    path: string,
    signal: AbortSignal,
    state: { status: number | null },
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = {
      method: options.method,
      headers,
      // The API never redirects: a redirect is an error, so a token is never sent to another address
      redirect: 'error',
      // Credentials travel in the Authorization header only
      credentials: 'omit',
      signal,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    if (options.accessToken !== undefined)
      headers['Authorization'] = `Bearer ${options.accessToken}`;

    let response: Response;
    let text: string;
    try {
      response = await this.#config.fetch(this.#config.baseUrl + path, init);
      state.status = response.status;
      text = await response.text();
    } catch (cause) {
      if (cause instanceof OrganiseYouError) throw cause;
      // A deadline or an abort wins the race in `send`; this error is then never seen
      throw new OrganiseYouError({
        kind: 'network',
        status: state.status ?? undefined,
        message: 'The request failed before an answer arrived.',
      });
    }

    const rateLimit = parseRateLimit(response.headers);
    if (rateLimit !== undefined) this.#lastRateLimit = rateLimit;
    const status = response.status;

    if (status >= 300 && status < 400) {
      throw new OrganiseYouError({
        kind: 'http',
        status,
        message: `The server answered with a redirect (${status}). Redirects are not followed.`,
      });
    }

    const parsed = parseJson(text);
    if (status >= 400) {
      throw errorFromAnswer(status, text, parsed, response.headers, rateLimit);
    }
    if (!parsed.ok) {
      throw new OrganiseYouError({
        kind: 'decoding',
        status,
        message: `The server answered ${status} with a body that is not JSON.`,
      });
    }
    return parsed.value;
  }

  #report(info: RequestInfo): void {
    const { onRequest } = this.#config;
    if (onRequest === undefined) return;
    try {
      onRequest(info);
    } catch (error) {
      // A failing hook must not fail the call; the app's own error handler sees it
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function queryString(query: SendOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.perPage !== undefined) params.set('perPage', String(query.perPage));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): Parsed {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFromAnswer(
  status: number,
  text: string,
  parsed: Parsed,
  headers: Headers,
  rateLimit: RateLimit | undefined,
): OrganiseYouError {
  const retryAfterSeconds = parseRetryAfter(headers.get('Retry-After'));
  const extras = { status, retryAfterSeconds, rateLimit };

  // A body that is not JSON (a proxy's HTML page): the status is known, the server's shape is not
  if (!parsed.ok) {
    return new OrganiseYouError({
      kind: 'decoding',
      message: `The server answered ${status} with a body that is not JSON.`,
      ...extras,
    });
  }

  const body = parsed.value;
  const generic = `The server answered ${status}.`;
  if (!isObject(body)) {
    return new OrganiseYouError({
      kind: 'http',
      message:
        text.trim() === '' ? generic : `${generic} The body is not in the server's error shape.`,
      ...extras,
    });
  }

  // `{error: "<code>", message}`; OData-style `{error: {code, message}}` is read too
  let code: string | undefined;
  let message: string | undefined =
    typeof body['message'] === 'string' ? body['message'] : undefined;
  const error = body['error'];
  if (typeof error === 'string') {
    code = error;
  } else if (isObject(error)) {
    if (typeof error['code'] === 'string') code = error['code'];
    if (message === undefined && typeof error['message'] === 'string') message = error['message'];
  }

  return new OrganiseYouError({
    kind: 'http',
    code,
    message: message ?? generic,
    fieldErrors: parseFieldErrors(body['errors']),
    ...extras,
  });
}

function parseFieldErrors(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isObject(value)) return result;
  for (const [field, messages] of Object.entries(value)) {
    if (typeof messages === 'string') {
      result[field] = [messages];
    } else if (Array.isArray(messages)) {
      result[field] = messages.filter((m): m is string => typeof m === 'string');
    }
  }
  return result;
}

function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number.parseInt(value.trim(), 10);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = wholeNumber(value);
  if (seconds !== undefined) return seconds;
  // The HTTP-date form
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function parseRateLimit(headers: Headers): RateLimit | undefined {
  const limit = wholeNumber(headers.get('RateLimit-Limit'));
  const remaining = wholeNumber(headers.get('RateLimit-Remaining'));
  const resetSeconds = wholeNumber(headers.get('RateLimit-Reset'));
  if (limit === undefined || remaining === undefined || resetSeconds === undefined)
    return undefined;
  return { limit, remaining, resetSeconds };
}
