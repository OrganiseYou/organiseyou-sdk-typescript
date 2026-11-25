import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganiseYou, OrganiseYouError, type RequestInfo } from '../src/index.js';
import { organizationBaseUrl, resolveConfig } from '../src/config.js';
import { encodeSegment } from '../src/path.js';
import { Transport, type SendOptions } from '../src/transport.js';
import { BASE_URL, emptyResponse, fakeFetch, json, type Handler } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

function transportWith(
  handler: Handler,
  options: { timeoutMs?: number; onRequest?: (info: RequestInfo) => void } = {},
) {
  const { fetch, calls } = fakeFetch(handler);
  const transport = new Transport(resolveConfig(BASE_URL, { fetch, ...options }));
  return { transport, calls };
}

const get = (path = '/rest/todos/records'): SendOptions => ({ method: 'GET', path });

async function failure(promise: Promise<unknown>): Promise<OrganiseYouError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OrganiseYouError);
    return error as OrganiseYouError;
  }
  throw new Error('The call was expected to fail.');
}

describe('SDK-08 the address rule', () => {
  it('refuses plain http for a host that is not this machine', () => {
    expect(() => new OrganiseYou({ baseUrl: 'http://example.test/api/acme' })).toThrow(TypeError);
  });

  it('accepts http://localhost:8080/api/acme and any https address', () => {
    expect(() => new OrganiseYou({ baseUrl: 'http://localhost:8080/api/acme' })).not.toThrow();
    expect(() => new OrganiseYou({ baseUrl: 'https://api.example.test/api/acme' })).not.toThrow();
    expect(() => new OrganiseYou({ baseUrl: 'https://example.test:8443/api/acme/' })).not.toThrow();
  });

  it('accepts http for 127.0.0.1, ::1 and 10.0.2.2, and for nothing that only looks like them', () => {
    for (const host of ['127.0.0.1:8000', '[::1]:8000', '10.0.2.2:8000']) {
      expect(() => new OrganiseYou({ baseUrl: `http://${host}/api/acme` })).not.toThrow();
    }
    for (const host of ['localhost.example.test', '127.0.0.2', '10.0.2.3', 'evil.test/localhost']) {
      expect(() => new OrganiseYou({ baseUrl: `http://${host}/api/acme` })).toThrow(TypeError);
    }
  });

  it('refuses other schemes, addresses with credentials, a query and garbage', () => {
    for (const baseUrl of [
      'ftp://api.example.test/api/acme',
      'https://user:secret@api.example.test/api/acme',
      'https://api.example.test/api/acme?x=1',
      'https://api.example.test/api/acme#top',
      'not an address',
      '',
    ]) {
      expect(() => new OrganiseYou({ baseUrl })).toThrow(TypeError);
    }
  });

  it('does not repeat a password of the address in its message', () => {
    let message = '';
    try {
      new OrganiseYou({ baseUrl: 'https://user:hunter2@api.example.test/api' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });

  it('builds the address from a host and a slug, and holds the same rule', () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const oy = OrganiseYou.forOrganization('api.example.test', 'acme', { fetch });
    expect(oy.lastRateLimit).toBeUndefined();
    expect(() => OrganiseYou.forOrganization('http://api.example.test', 'acme')).toThrow(TypeError);
    expect(() => OrganiseYou.forOrganization('localhost:8080', 'acme')).not.toThrow();
    expect(() => OrganiseYou.forOrganization('http://localhost:8080', 'acme')).not.toThrow();
    expect(() => OrganiseYou.forOrganization('api.example.test/path', 'acme')).toThrow(TypeError);
    expect(() => OrganiseYou.forOrganization('api.example.test', '')).toThrow(TypeError);
    expect(() => OrganiseYou.forOrganization('api.example.test', '..')).toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('puts a slug into the address as one path segment', () => {
    expect(organizationBaseUrl('api.example.test', 'a/b')).toBe(
      'https://api.example.test/api/a%2Fb',
    );
    expect(organizationBaseUrl('http://localhost:8080', 'acme')).toBe(
      'http://localhost:8080/api/acme',
    );
    expect(organizationBaseUrl('api.example.test:8443', 'acme')).toBe(
      'https://api.example.test:8443/api/acme',
    );
  });

  it('refuses a timeout that is not a positive number', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => new OrganiseYou({ baseUrl: BASE_URL, timeoutMs })).toThrow(RangeError);
    }
  });
});

describe('SDK-08 requests', () => {
  it('sends an endpoint name such as "my todos/x" as /rest/my%20todos%2Fx/records', async () => {
    const { transport, calls } = transportWith(() => json({ data: [] }));
    await transport.send(get(`/rest/${encodeSegment('my todos/x', 'The endpoint name')}/records`));
    expect(calls[0]?.url).toBe(`${BASE_URL}/rest/my%20todos%2Fx/records`);
  });

  it('refuses a segment that a URL parser would resolve', () => {
    for (const value of ['', '.', '..']) {
      expect(() => encodeSegment(value, 'The name')).toThrow(TypeError);
    }
    expect(encodeSegment('a?b#c%d', 'The name')).toBe('a%3Fb%23c%25d');
  });

  it('asks for JSON, sends JSON bodies, never follows a redirect and sends no cookies', async () => {
    const { transport, calls } = transportWith(() => json({ ok: true }));
    await transport.send({ method: 'POST', path: '/auth/token', body: { a: 1 } });
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers['accept']).toBe('application/json');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.rawBody).toBe('{"a":1}');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.credentials).toBe('omit');
  });

  it('sends no content type without a body, and no client header', async () => {
    const { transport, calls } = transportWith(() => json({}));
    await transport.send(get());
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(Object.keys(calls[0]?.headers ?? {})).toEqual(['accept']);
  });

  it('sends the access token as a bearer token when it is given one', async () => {
    const { transport, calls } = transportWith(() => json({}));
    await transport.send({ ...get(), accessToken: 'access-1' });
    expect(calls[0]?.headers['authorization']).toBe('Bearer access-1');
  });

  it('puts page and perPage in the query, and nothing else', async () => {
    const { transport, calls } = transportWith(() => json({}));
    await transport.send({ ...get(), query: { page: 2, perPage: 10 } });
    await transport.send({ ...get(), query: {} });
    expect(calls[0]?.path).toBe('/rest/todos/records?page=2&perPage=10');
    expect(calls[1]?.path).toBe('/rest/todos/records');
  });

  it('accepts an empty body', async () => {
    const { transport } = transportWith(() => emptyResponse(200));
    await expect(
      transport.send({ method: 'DELETE', path: '/rest/todos/record/1' }),
    ).resolves.toBeUndefined();
  });

  it('returns the parsed body of a success', async () => {
    const { transport } = transportWith(() => json({ id: '1' }, 201));
    await expect(transport.send(get())).resolves.toEqual({ id: '1' });
  });
});

describe('SDK-08 errors', () => {
  it('turns a 3xx answer into an error of kind http and makes no second request', async () => {
    const { transport, calls } = transportWith(
      () =>
        new Response(null, { status: 302, headers: { Location: 'https://other.example.test/x' } }),
    );
    const error = await failure(transport.send(get()));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('turns a 422 body {error, message, errors} into code validation_failed and fieldErrors per field', async () => {
    const { transport } = transportWith(() =>
      json(
        {
          error: 'validation_failed',
          message: 'The title field is required.',
          errors: {
            title: ['The title field is required.'],
            done: ['Must be true or false.', 'Second.'],
          },
        },
        422,
      ),
    );
    const error = await failure(
      transport.send({ method: 'POST', path: '/rest/todos/record', body: {} }),
    );
    expect(error.kind).toBe('http');
    expect(error.status).toBe(422);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('The title field is required.');
    expect(error.fieldErrors).toEqual({
      title: ['The title field is required.'],
      done: ['Must be true or false.', 'Second.'],
    });
  });

  it('gives an empty fieldErrors to every other error', async () => {
    const { transport } = transportWith(() =>
      json({ error: 'not_found', message: 'No such record.' }, 404),
    );
    const error = await failure(transport.send(get()));
    expect(error.fieldErrors).toEqual({});
    expect(error.code).toBe('not_found');
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.rateLimit).toBeUndefined();
  });

  it('turns a 429 with Retry-After: 30 into retryAfterSeconds 30, and RateLimit-* into rateLimit', async () => {
    const { transport } = transportWith(() =>
      json({ error: 'rate_limited', message: 'Slow down.' }, 429, {
        'Retry-After': '30',
        'RateLimit-Limit': '60',
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '30',
      }),
    );
    const error = await failure(transport.send(get()));
    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.rateLimit).toEqual({ limit: 60, remaining: 0, resetSeconds: 30 });
    expect(transport.lastRateLimit).toEqual({ limit: 60, remaining: 0, resetSeconds: 30 });
  });

  it('reads a Retry-After that is a date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { transport } = transportWith(() =>
      json({ error: 'rate_limited', message: 'Slow down.' }, 429, {
        'Retry-After': 'Tue, 01 Jan 2030 00:00:45 GMT',
      }),
    );
    expect((await failure(transport.send(get()))).retryAfterSeconds).toBe(45);
  });

  it('keeps the last rate limit of a successful answer, and keeps it when a later answer has none', async () => {
    const answers = [
      json({}, 200, {
        'RateLimit-Limit': '60',
        'RateLimit-Remaining': '59',
        'RateLimit-Reset': '55',
      }),
      json({}),
      json({}, 200, {
        'RateLimit-Limit': '60',
        'RateLimit-Remaining': 'many',
        'RateLimit-Reset': '55',
      }),
    ];
    const { transport } = transportWith((_call, index) => answers[index]!);
    expect(transport.lastRateLimit).toBeUndefined();
    await transport.send(get());
    expect(transport.lastRateLimit).toEqual({ limit: 60, remaining: 59, resetSeconds: 55 });
    await transport.send(get());
    await transport.send(get());
    expect(transport.lastRateLimit).toEqual({ limit: 60, remaining: 59, resetSeconds: 55 });
  });

  it('turns a 502 HTML page into kind decoding with status 502 and no code', async () => {
    const { transport } = transportWith(
      () =>
        new Response('<html><body>Bad gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const error = await failure(transport.send(get()));
    expect(error.kind).toBe('decoding');
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
  });

  it('turns a 200 answer that is not JSON into kind decoding', async () => {
    const { transport } = transportWith(
      () => new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 }),
    );
    const error = await failure(transport.send(get()));
    expect(error.kind).toBe('decoding');
    expect(error.status).toBe(200);
  });

  it('keeps kind http, with no code, for a JSON error body in another shape, or an empty one', async () => {
    const answers = [json({ detail: 'nope' }, 500), json(['nope'], 500), emptyResponse(503)];
    const { transport } = transportWith((_call, index) => answers[index]!);
    for (const status of [500, 500, 503]) {
      const error = await failure(transport.send(get()));
      expect(error.kind).toBe('http');
      expect(error.status).toBe(status);
      expect(error.code).toBeUndefined();
    }
  });

  it('reads an error object such as {error: {code, message}}', async () => {
    const { transport } = transportWith(() =>
      json({ error: { code: 'forbidden', message: 'You do not have access to this.' } }, 403),
    );
    const error = await failure(transport.send(get()));
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('You do not have access to this.');
  });

  it('turns a failing fetch into kind network, without a cause that could hold a header', async () => {
    const { transport } = transportWith(() => {
      throw new TypeError('fetch failed: Authorization: Bearer access-1');
    });
    const error = await failure(transport.send({ ...get(), accessToken: 'access-1' }));
    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.message).not.toContain('access-1');
    expect(error.cause).toBeUndefined();
  });
});

describe('SDK-08 timeout and cancellation', () => {
  it('gives kind timeout for a call past the timeout', async () => {
    vi.useFakeTimers();
    const { transport } = transportWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const outcome = failure(transport.send(get()));
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('30000');
  });

  it('uses timeoutMs from the options, and a fetch that ignores the abort cannot hold the call', async () => {
    vi.useFakeTimers();
    const { transport } = transportWith(() => new Promise<Response>(() => undefined), {
      timeoutMs: 500,
    });
    const outcome = failure(transport.send(get()));
    await vi.advanceTimersByTimeAsync(500);
    expect((await outcome).kind).toBe('timeout');
  });

  it('times out while the body is being read', async () => {
    vi.useFakeTimers();
    const { transport } = transportWith(
      () =>
        ({
          status: 200,
          headers: new Headers(),
          text: () => new Promise<string>(() => undefined),
        }) as unknown as Response,
      { timeoutMs: 100 },
    );
    const outcome = failure(transport.send(get()));
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).kind).toBe('timeout');
  });

  it('makes no request when the signal is aborted already, and rejects with its reason', async () => {
    const { transport, calls } = transportWith(() => json({}));
    const controller = new AbortController();
    controller.abort();
    await expect(transport.send({ ...get(), signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(calls).toHaveLength(0);
  });

  it('makes no request after the abort, and rejects a call in flight with the signal reason', async () => {
    vi.useFakeTimers();
    const { transport, calls } = transportWith(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const reason = new Error('user left the page');
    const inFlight = transport.send({ ...get(), signal: controller.signal });
    const outcome = expect(inFlight).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
    controller.abort(reason);
    await outcome;
    await expect(transport.send({ ...get(), signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('leaves no timer behind after a call', async () => {
    vi.useFakeTimers();
    const { transport } = transportWith(() => json({}));
    await transport.send(get());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SDK-08 onRequest', () => {
  it('receives method, path, status and duration, and no header or body (the keys are checked)', async () => {
    vi.useFakeTimers();
    const seen: RequestInfo[] = [];
    const { transport } = transportWith(
      async () => {
        await vi.advanceTimersByTimeAsync(25);
        return json({ ok: true }, 201);
      },
      { onRequest: (info) => seen.push(info) },
    );
    await transport.send({
      method: 'POST',
      path: '/rest/todos/record',
      body: { title: 'private text' },
      accessToken: 'access-1',
    });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(['durationMs', 'method', 'path', 'status']);
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/rest/todos/record',
      status: 201,
      durationMs: 25,
    });
    expect(JSON.stringify(seen)).not.toMatch(/access-1|private text/);
  });

  it('is also called for an error answer and for a request with no answer, with status null', async () => {
    const seen: RequestInfo[] = [];
    const answers = [
      () => json({ error: 'not_found', message: 'No.' }, 404),
      () => Promise.reject(new TypeError('down')),
    ];
    const { transport } = transportWith((_call, index) => answers[index]!(), {
      onRequest: (info) => seen.push(info),
    });
    await failure(transport.send(get()));
    await failure(
      transport.send({ ...get('/rest/todos/records'), query: { page: 3, perPage: 5 } }),
    );
    expect(seen.map((info) => info.status)).toEqual([404, null]);
    expect(seen[1]?.path).toBe('/rest/todos/records?page=3&perPage=5');
  });

  it('does not fail the call when the hook throws', async () => {
    const { transport } = transportWith(() => json({ ok: true }), {
      onRequest: () => {
        throw new Error('hook failed');
      },
    });
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);
    await expect(transport.send(get())).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('uncaughtException', uncaught);
  });
});
