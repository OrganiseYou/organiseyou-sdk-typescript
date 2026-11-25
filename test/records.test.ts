import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrganiseYou,
  OrganiseYouError,
  type RecordData,
  type RecordValues,
  type RequestInfo,
} from '../src/index.js';
import { BASE_URL, FakeServer, USER, emptyResponse, json, type RecordedCall } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeServer(): FakeServer {
  return new FakeServer();
}

function record(n: number): RecordData {
  return { id: `rec-${n}`, title: `Todo ${n}`, done: false };
}

function listAnswer(
  items: RecordData[],
  total: number,
  extra: Record<string, unknown> = {},
  links: Record<string, unknown> = {},
): Response {
  return json({
    data: items,
    pagination: {
      total,
      links: {
        first: `${BASE_URL}/rest/todos/records?page=1`,
        last: `${BASE_URL}/rest/todos/records?page=9`,
        previous: null,
        next: `${BASE_URL}/rest/todos/records?page=2`,
        ...links,
      },
      ...extra,
    },
  });
}

function pageOf(call: RecordedCall): { page: number; perPage: number | undefined } {
  const url = new URL(call.url);
  const perPage = url.searchParams.get('perPage');
  return {
    page: Number(url.searchParams.get('page') ?? '1'),
    perPage: perPage === null ? undefined : Number(perPage),
  };
}

async function signedIn(
  fake: FakeServer,
  extra: { onRequest?: (info: RequestInfo) => void } = {},
): Promise<OrganiseYou> {
  const oy = new OrganiseYou({ baseUrl: BASE_URL, fetch: fake.fetch, ...extra });
  await oy.auth.signIn({ identifier: USER.email, password: fake.password });
  return oy;
}

async function collect(iterable: AsyncIterable<RecordData>): Promise<RecordData[]> {
  const all: RecordData[] = [];
  for await (const item of iterable) all.push(item);
  return all;
}

async function failure(promise: Promise<unknown>): Promise<OrganiseYouError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OrganiseYouError);
    return error as OrganiseYouError;
  }
  throw new Error('The call was expected to fail.');
}

/** A list of `total` records that serves `perPage` of them per page, like the server, and counts the requests. */
function serveList(fake: FakeServer, total: number): { listCalls: () => RecordedCall[] } {
  fake.restOverride = (call) => {
    if (!call.path.startsWith('/rest/todos/records')) return undefined;
    const { page, perPage = 50 } = pageOf(call);
    const items = Array.from({ length: total }, (_, i) => record(i + 1)).slice(
      (page - 1) * perPage,
      page * perPage,
    );
    return listAnswer(items, total);
  };
  return {
    listCalls: () => fake.calls.filter((call) => call.path.startsWith('/rest/todos/records')),
  };
}

describe('SDK-10 paging', () => {
  it('all({ perPage: 2 }) over a total of 5 makes exactly three list requests and yields five records', async () => {
    const fake = makeServer();
    const { listCalls } = serveList(fake, 5);
    const oy = await signedIn(fake);

    const records = await collect(oy.records('todos').all({ perPage: 2 }));

    expect(listCalls()).toHaveLength(3);
    expect(listCalls().map((call) => pageOf(call))).toEqual([
      { page: 1, perPage: 2 },
      { page: 2, perPage: 2 },
      { page: 3, perPage: 2 },
    ]);
    expect(records.map((r) => r.id)).toEqual(['rec-1', 'rec-2', 'rec-3', 'rec-4', 'rec-5']);
  });

  it('all() against a server whose total stays 10 while every page is empty stops after one request', async () => {
    const fake = makeServer();
    fake.restOverride = () => listAnswer([], 10);
    const oy = await signedIn(fake);

    const records = await collect(oy.records('todos').all());

    expect(records).toEqual([]);
    expect(fake.restCalls()).toHaveLength(1);
  });

  it('all() against a server that keeps answering full pages past total stops after ceil(total / perPage) + 1 requests', async () => {
    // A server that never runs out: every page is full, and the total says 5 (perPage 2: three pages)
    const fullPages = makeServer();
    fullPages.restOverride = (call) => {
      const { page } = pageOf(call);
      return listAnswer([record(page * 2 - 1), record(page * 2)], 5);
    };
    const oy = await signedIn(fullPages);
    const records = await collect(oy.records('todos').all({ perPage: 2 }));
    expect(fullPages.restCalls().length).toBeLessThanOrEqual(Math.ceil(5 / 2) + 1);
    expect(records.length).toBeGreaterThanOrEqual(5);

    // A server whose pages are short and never empty: the walk still ends one page past the last page
    const shortPages = makeServer();
    shortPages.restOverride = (call) => listAnswer([record(pageOf(call).page)], 5);
    const other = await signedIn(shortPages);
    const some = await collect(other.records('todos').all({ perPage: 2 }));
    expect(shortPages.restCalls()).toHaveLength(Math.ceil(5 / 2) + 1);
    expect(some).toHaveLength(4);
  });

  it('all() follows a total that changes while it reads, with the latest total', async () => {
    const fake = makeServer();
    // The list grows from 4 to 6 records after the first page
    fake.restOverride = (call) => {
      const { page } = pageOf(call);
      const total = page === 1 ? 4 : 6;
      const items = [record(page * 2 - 1), record(page * 2)];
      return listAnswer(items, total);
    };
    const oy = await signedIn(fake);
    const records = await collect(oy.records('todos').all({ perPage: 2 }));
    expect(fake.restCalls()).toHaveLength(3);
    expect(records).toHaveLength(6);
  });

  it('all() without a page size sends none, and works out the last page from the first page it gets', async () => {
    const fake = makeServer();
    // A server whose default page is 3, and that reports no perPage
    fake.restOverride = (call) => {
      const { page } = pageOf(call);
      expect(call.url).not.toContain('perPage');
      const items = [1, 2, 3]
        .map((n) => record((page - 1) * 3 + n))
        .filter((r) => Number(r.id.slice(4)) <= 8);
      return listAnswer(items, 8);
    };
    const oy = await signedIn(fake);
    const records = await collect(oy.records('todos').all());
    expect(records).toHaveLength(8);
    expect(fake.restCalls()).toHaveLength(3);
  });

  it('all() reads the page size the server reports, and stops reading when the caller stops', async () => {
    const fake = makeServer();
    fake.restOverride = (call) => {
      const { page } = pageOf(call);
      return listAnswer([record(page * 2 - 1), record(page * 2)], 100, { page, perPage: 2 });
    };
    const oy = await signedIn(fake);
    for await (const item of oy.records('todos').all()) {
      if (item.id === 'rec-3') break;
    }
    expect(fake.restCalls()).toHaveLength(2);
  });

  it('all() stops with the signal, and sends no request after the abort', async () => {
    const fake = makeServer();
    serveList(fake, 10);
    const oy = await signedIn(fake);
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(async () => {
      for await (const item of oy.records('todos').all({ perPage: 2, signal: controller.signal })) {
        seen.push(item.id);
        if (seen.length === 2) controller.abort();
      }
    }).rejects.toBeInstanceOf(DOMException);
    expect(fake.restCalls()).toHaveLength(1);
    expect(seen).toEqual(['rec-1', 'rec-2']);
  });

  it('list() returns a Page with items, total, page, perPage and hasNext', async () => {
    const fake = makeServer();
    serveList(fake, 5);
    const oy = await signedIn(fake);
    const todos = oy.records('todos');

    const first = await todos.list({ page: 1, perPage: 2 });
    expect(first).toEqual({
      items: [record(1), record(2)],
      total: 5,
      page: 1,
      perPage: 2,
      hasNext: true,
    });
    const last = await todos.list({ page: 3, perPage: 2 });
    expect(last.items).toEqual([record(5)]);
    expect(last.hasNext).toBe(false);
    const byDefault = await todos.list();
    expect(byDefault).toMatchObject({ page: 1, perPage: 50, total: 5, hasNext: false });
    expect(fake.restCalls()[2]?.url).toBe(`${BASE_URL}/rest/todos/records`);
  });

  it('hasNext is false on the last page whatever links.next holds, and true before it whatever links.next holds', async () => {
    const fake = makeServer();
    // The server's next link points at the last page itself on the last page, and may be empty elsewhere
    fake.restOverride = (call) => {
      const { page } = pageOf(call);
      if (page === 2)
        return listAnswer(
          [record(3), record(4)],
          4,
          {},
          { next: `${BASE_URL}/rest/todos/records?page=2` },
        );
      return listAnswer([record(1), record(2)], 4, {}, { next: null });
    };
    const oy = await signedIn(fake);
    const todos = oy.records('todos');
    expect((await todos.list({ page: 2, perPage: 2 })).hasNext).toBe(false);
    expect((await todos.list({ page: 1, perPage: 2 })).hasNext).toBe(true);
  });

  it('hasNext uses the page and page size the server reports when it reports them', async () => {
    const fake = makeServer();
    fake.restOverride = () => listAnswer([record(1)], 10, { page: 2, perPage: 5 });
    const oy = await signedIn(fake);
    const page = await oy.records('todos').list({ page: 2, perPage: 5 });
    expect(page).toMatchObject({ page: 2, perPage: 5, hasNext: false });
  });

  it('makes no request that follows a URL from pagination.links (the fake fails on any host other than the base address)', async () => {
    const fake = makeServer();
    const hosts = new Set<string>();
    fake.restOverride = (call) => {
      hosts.add(new URL(call.url).origin);
      const { page } = pageOf(call);
      return listAnswer(
        [record(page * 2 - 1), record(page * 2)],
        6,
        {},
        {
          first: 'https://evil.example.test/first',
          last: 'https://evil.example.test/last',
          previous: 'https://evil.example.test/previous',
          next: 'https://evil.example.test/next',
        },
      );
    };
    const oy = await signedIn(fake);
    await collect(oy.records('todos').all({ perPage: 2 }));
    await oy.records('todos').list({ page: 2, perPage: 2 });

    expect(hosts).toEqual(new Set(['https://api.example.test']));
    for (const call of fake.calls) {
      expect(call.url.startsWith(`${BASE_URL}/`)).toBe(true);
      expect(call.url).not.toContain('evil.example.test');
    }
  });

  it('refuses a page or perPage that is not a whole number of 1 or more, without a request', async () => {
    const fake = makeServer();
    const oy = await signedIn(fake);
    const before = fake.calls.length;
    const todos = oy.records('todos');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(todos.list({ page: bad })).rejects.toBeInstanceOf(RangeError);
      await expect(todos.list({ perPage: bad })).rejects.toBeInstanceOf(RangeError);
    }
    expect(fake.calls).toHaveLength(before);
  });

  it('answers decoding for a list that is not in the expected shape', async () => {
    const fake = makeServer();
    const answers = [
      json({ data: 'x', pagination: { total: 1 } }),
      json({ data: [], pagination: {} }),
      json({ data: [{ title: 'no id' }], pagination: { total: 1 } }),
      json([]),
    ];
    fake.restOverride = () => answers.shift();
    const oy = await signedIn(fake);
    for (let i = 0; i < 4; i++) {
      expect((await failure(oy.records('todos').list())).kind).toBe('decoding');
    }
  });
});

describe('SDK-10 the record calls', () => {
  it('create returns the 201 body as RecordData with its id', async () => {
    const fake = makeServer();
    fake.restOverride = () => json({ id: 'rec-9', title: 'Buy milk', assignee: ['usr_1'] }, 201);
    const oy = await signedIn(fake);

    const created = await oy.records('todos').create({ title: 'Buy milk' });

    expect(created).toEqual({ id: 'rec-9', title: 'Buy milk', assignee: ['usr_1'] });
    const call = fake.restCalls()[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/rest/todos/record');
    expect(call?.body).toEqual({ title: 'Buy milk' });
    expect(call?.headers['content-type']).toBe('application/json');
  });

  it('delete resolves on a 200 with an empty body', async () => {
    const fake = makeServer();
    fake.restOverride = () => emptyResponse(200);
    const oy = await signedIn(fake);

    await expect(oy.records('todos').delete('rec-1')).resolves.toBeUndefined();

    const call = fake.restCalls()[0];
    expect(call?.method).toBe('DELETE');
    expect(call?.path).toBe('/rest/todos/record/rec-1');
    expect(call?.rawBody).toBeUndefined();
    expect(call?.headers['content-type']).toBeUndefined();
  });

  it('update(id, { done: true }) sends PUT with exactly {"done": true}', async () => {
    const fake = makeServer();
    fake.restOverride = () => json({ id: 'rec-1', title: 'Buy milk', done: true });
    const oy = await signedIn(fake);

    const updated = await oy.records('todos').update('rec-1', { done: true });

    const call = fake.restCalls()[0];
    expect(call?.method).toBe('PUT');
    expect(call?.path).toBe('/rest/todos/record/rec-1');
    expect(call?.rawBody).toBe('{"done":true}');
    expect(call?.body).toEqual({ done: true });
    expect(updated).toEqual({ id: 'rec-1', title: 'Buy milk', done: true });
  });

  it('update sends null to clear a value, and nothing for a key that is left out', async () => {
    const fake = makeServer();
    fake.restOverride = () => json({ id: 'rec-1' });
    const oy = await signedIn(fake);
    await oy.records('todos').update('rec-1', { due: null });
    expect(fake.restCalls()[0]?.rawBody).toBe('{"due":null}');
  });

  it('get returns the record, and sends the bearer token', async () => {
    const fake = makeServer();
    fake.restOverride = () => json(record(1));
    const oy = await signedIn(fake);
    expect(await oy.records('todos').get('rec-1')).toEqual(record(1));
    const call = fake.restCalls()[0];
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe('/rest/todos/record/rec-1');
    expect(call?.headers['authorization']).toBe(`Bearer ${fake.currentAccess}`);
  });

  it('sends an endpoint name such as "my todos/x" as /rest/my%20todos%2Fx/records, and a record id as one segment', async () => {
    const fake = makeServer();
    fake.restOverride = (call) =>
      call.path.endsWith('/records') ? listAnswer([], 0) : json({ id: 'a/b' });
    const oy = await signedIn(fake);
    const odd = oy.records('my todos/x');

    await odd.list();
    await odd.get('a/b?c');
    await odd.create({});
    await odd.update('a/b', {});
    await odd.delete('a/b');

    expect(
      fake.restCalls().map((call) => `${call.method} ${call.url.slice(BASE_URL.length)}`),
    ).toEqual([
      'GET /rest/my%20todos%2Fx/records',
      'GET /rest/my%20todos%2Fx/record/a%2Fb%3Fc',
      'POST /rest/my%20todos%2Fx/record',
      'PUT /rest/my%20todos%2Fx/record/a%2Fb',
      'DELETE /rest/my%20todos%2Fx/record/a%2Fb',
    ]);
  });

  it('refuses an endpoint name or id that would leave its path segment', async () => {
    const fake = makeServer();
    const oy = await signedIn(fake);
    for (const name of ['', '.', '..']) {
      expect(() => oy.records(name)).toThrow(TypeError);
    }
    await expect(oy.records('todos').get('..')).rejects.toBeInstanceOf(TypeError);
    await expect(oy.records('todos').delete('')).rejects.toBeInstanceOf(TypeError);
    await expect(
      oy.records('todos').create(null as unknown as RecordValues),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fake.restCalls()).toHaveLength(0);
  });

  it('answers decoding for a record answer with no id', async () => {
    const fake = makeServer();
    fake.restOverride = () => json({ title: 'no id' }, 201);
    const oy = await signedIn(fake);
    expect((await failure(oy.records('todos').create({ title: 'x' }))).kind).toBe('decoding');
  });

  it('turns a 422 into an error with fieldErrors per alias', async () => {
    const fake = makeServer();
    fake.restOverride = () =>
      json(
        {
          error: 'validation_failed',
          message: 'The title is required.',
          errors: { title: ['The title is required.'] },
        },
        422,
      );
    const oy = await signedIn(fake);
    const error = await failure(oy.records('todos').create({}));
    expect(error.code).toBe('validation_failed');
    expect(error.fieldErrors['title']).toEqual(['The title is required.']);
  });

  it('never repeats a write after a network failure', async () => {
    const fake = makeServer();
    fake.restOverride = () => Promise.reject(new TypeError('connection reset'));
    const oy = await signedIn(fake);
    expect((await failure(oy.records('todos').create({ title: 'x' }))).kind).toBe('network');
    expect(fake.restCalls()).toHaveLength(1);
  });

  it('fails without a session as signedOut, before any request', async () => {
    const fake = makeServer();
    const oy = new OrganiseYou({ baseUrl: BASE_URL, fetch: fake.fetch });
    expect((await failure(oy.records('todos').list())).kind).toBe('signedOut');
    expect(fake.calls).toHaveLength(0);
  });

  it('refreshes once and retries when the access token has ended, for any record call', async () => {
    const fake = makeServer();
    fake.restOverride = () => undefined;
    const oy = await signedIn(fake);
    vi.setSystemTime(Date.now() + 1801 * 1000);
    fake.restOverride = (call) =>
      call.path === '/rest/todos/records' ? listAnswer([], 0) : undefined;
    await oy.records('todos').list();
    expect(fake.refreshCalls).toHaveLength(1);
  });

  it('exposes the last rate limit through oy.lastRateLimit, and puts only page and perPage in the request log', async () => {
    const fake = makeServer();
    const infos: RequestInfo[] = [];
    fake.restOverride = () =>
      json({ data: [], pagination: { total: 0 } }, 200, {
        'RateLimit-Limit': '120',
        'RateLimit-Remaining': '117',
        'RateLimit-Reset': '42',
      });
    const oy = await signedIn(fake, { onRequest: (info) => infos.push(info) });
    await oy.records('todos').list({ page: 2, perPage: 5 });

    expect(oy.lastRateLimit).toEqual({ limit: 120, remaining: 117, resetSeconds: 42 });
    const last = infos.at(-1);
    expect(last).toMatchObject({
      method: 'GET',
      path: '/rest/todos/records?page=2&perPage=5',
      status: 200,
    });
    expect(Object.keys(last ?? {}).sort()).toEqual(['durationMs', 'method', 'path', 'status']);
  });
});
