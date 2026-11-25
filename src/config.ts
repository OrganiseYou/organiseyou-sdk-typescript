import { encodeSegment } from './path.js';
import type { RequestInfo } from './transport.js';

/** The `fetch` of the platform, or a replacement. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportConfig {
  /** `https://<host>/api/<slug>`, with no trailing slash. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  onRequest: ((info: RequestInfo) => void) | undefined;
}

export interface ClientOptions {
  /** A replacement for the platform's `fetch`. */
  fetch?: FetchLike;
  /** The longest a call may take, in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** Called after every request with its method, path, status and duration; never a header or a body. */
  onRequest?: (info: RequestInfo) => void;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Hosts that may be reached over plain `http`: this machine, and the Android emulator's address for it. */
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '10.0.2.2']);

/** Checks the address of the API and returns it without a trailing slash. */
export function resolveBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl is not a valid address. Expected https://<host>/api/<slug>.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('baseUrl must not hold a user name or a password.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('baseUrl must not hold a query or a fragment.');
  }
  const plainHttpAllowed = url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !plainHttpAllowed) {
    throw new TypeError(
      `baseUrl ${url.protocol}//${url.host} is refused: it must use https. Plain http is allowed only for ` +
        'localhost, 127.0.0.1, ::1 and 10.0.2.2.',
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** `https://<host>/api/<slug>` from a host (with or without a scheme and port) and the organization's slug. */
export function organizationBaseUrl(host: string, slug: string): string {
  const slugSegment = encodeSegment(slug, 'The organization slug');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TypeError('host is not a valid host name.');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('host must be a host name with an optional port, without a path.');
  }
  return `${url.origin}/api/${slugSegment}`;
}

export function resolveConfig(baseUrl: string, options: ClientOptions): TransportConfig {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Timers cannot wait longer than 2^31 - 1 milliseconds (about 24 days)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError(
      'timeoutMs must be a positive number of milliseconds, at most 2147483647.',
    );
  }
  let fetchFn = options.fetch;
  if (fetchFn === undefined) {
    if (typeof globalThis.fetch !== 'function') {
      throw new TypeError('This platform has no fetch: pass one in the options.');
    }
    // Looked up at call time and called on globalThis, which browsers require
    fetchFn = (input, init) => globalThis.fetch(input, init);
  }
  return {
    baseUrl: resolveBaseUrl(baseUrl),
    fetch: fetchFn,
    timeoutMs,
    onRequest: options.onRequest,
  };
}
