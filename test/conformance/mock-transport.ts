import type { FetchLike } from '../../src/config.js';
import type { Interaction } from './set.js';

export const BASE_URL = 'https://api.example.test/api/acme';

/** What a request looked like, in the form the set's interactions are written in. */
export interface SeenRequest {
  method: string;
  /** After the base address, as sent. */
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  contentType: string | undefined;
  /** The body parsed as JSON, or `undefined` when there was none. */
  body: unknown;
}

/**
 * Serves the interactions a scenario names, and nothing else. A request matches an interaction on method, path, query,
 * `Authorization`, `Content-Type` and the JSON body (keys in any order). A request that matches none is recorded and
 * rejected, so it fails the scenario; every served interaction is counted, so the scenario can check how often.
 * No socket is opened: the transport is a function.
 */
export class MockTransport {
  readonly #interactions: Interaction[];
  readonly #served = new Map<string, number>();
  readonly #order: string[] = [];
  readonly #unmatched: string[] = [];

  constructor(interactions: Interaction[]) {
    this.#interactions = interactions;
  }

  readonly fetch: FetchLike = (input, init) => {
    const seen = describeRequest(input, init);
    const found = this.#interactions.find((interaction) => matches(interaction, seen));
    if (found === undefined) {
      this.#unmatched.push(describeUnmatched(seen));
      return Promise.reject(new Error('The mock transport has no interaction for this request.'));
    }
    this.#served.set(found.id, (this.#served.get(found.id) ?? 0) + 1);
    this.#order.push(found.id);
    return Promise.resolve(toResponse(found));
  };

  /** How often each interaction was requested. */
  get counts(): Record<string, number> {
    return Object.fromEntries([...this.#served].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** The ids of the interactions served so far, in the order they were requested. */
  get order(): readonly string[] {
    return this.#order;
  }

  /** The requests that matched no interaction. */
  get unmatched(): readonly string[] {
    return this.#unmatched;
  }
}

export function describeRequest(input: string, init: RequestInit): SeenRequest {
  if (!input.startsWith(`${BASE_URL}/`)) {
    return {
      method: init.method ?? 'GET',
      path: input,
      query: {},
      authorization: undefined,
      contentType: undefined,
      body: undefined,
    };
  }
  const rest = input.slice(BASE_URL.length);
  const mark = rest.indexOf('?');
  const path = mark === -1 ? rest : rest.slice(0, mark);
  const query: Record<string, string> = {};
  if (mark !== -1) {
    for (const [name, value] of new URLSearchParams(rest.slice(mark + 1))) query[name] = value;
  }
  const headers = new Headers(init.headers);
  let body: unknown;
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  }
  return {
    method: init.method ?? 'GET',
    path,
    query,
    authorization: headers.get('Authorization') ?? undefined,
    contentType: headers.get('Content-Type') ?? undefined,
    body,
  };
}

function matches(interaction: Interaction, seen: SeenRequest): boolean {
  const { request } = interaction;
  return (
    request.method === seen.method &&
    request.path === seen.path &&
    sameJson(request.query, seen.query) &&
    request.headers['Authorization'] === seen.authorization &&
    request.headers['Content-Type'] === seen.contentType &&
    sameJson(request.body, seen.body)
  );
}

/** Whether two JSON values are equal, with the keys of an object in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && sameJson(left[key], right[key]))
    );
  }
  return false;
}

function describeUnmatched(seen: SeenRequest): string {
  const query = new URLSearchParams(seen.query).toString();
  const auth = seen.authorization === undefined ? 'no Authorization' : seen.authorization;
  const body = seen.body === undefined ? 'no body' : `body ${JSON.stringify(seen.body)}`;
  return `${seen.method} ${seen.path}${query === '' ? '' : `?${query}`} (${auth}; ${body})`;
}

function toResponse(interaction: Interaction): Response {
  const { status, headers, body, bodyText } = interaction.response;
  const text = bodyText ?? (body === undefined ? '' : JSON.stringify(body));
  return new Response(text, { status, headers });
}
