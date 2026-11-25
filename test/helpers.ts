import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../src/config.js';

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
