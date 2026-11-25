import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runEndToEnd } from '../e2e/flow.js';
import { assertLocalUrl, isLoopbackAddress, type Lookup } from '../e2e/local.js';
import { confirmRegistration, findVerificationLink, Mailpit } from '../e2e/mail.js';

// What this file does not do: reach a server. `npm run e2e` is run by hand against a local OrganiseYou.

const LOCAL: Record<string, string[]> = {
  localhost: ['127.0.0.1', '::1'],
  'api.example.test': ['127.0.0.1'],
  'elsewhere.example.test': ['93.184.216.34'],
  'mixed.example.test': ['127.0.0.1', '93.184.216.34'],
};
const lookup: Lookup = (hostname) => {
  const found = LOCAL[hostname];
  return found === undefined ? Promise.reject(new Error('no such host')) : Promise.resolve(found);
};

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('the local-address rule of the end-to-end check', () => {
  it.each(['127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    (a) => {
      expect(isLoopbackAddress(a)).toBe(true);
    },
  );

  it.each(['10.0.2.2', '192.168.1.5', '93.184.216.34', '2606:4700::1', '::ffff:10.0.0.1'])(
    '%s is not loopback',
    (a) => {
      expect(isLoopbackAddress(a)).toBe(false);
    },
  );

  it('accepts a host that resolves only to this machine, and an IP literal', async () => {
    await expect(
      assertLocalUrl('https://api.example.test/api/acme', 'x', lookup),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertLocalUrl('http://localhost:8025', 'x', lookup)).resolves.toBeInstanceOf(URL);
    await expect(
      assertLocalUrl('http://127.0.0.1:8080/api/acme', 'x', lookup),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertLocalUrl('http://[::1]:8080/', 'x', lookup)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['https://elsewhere.example.test/api/acme', 'is not on this machine'],
    ['https://mixed.example.test/api/acme', 'is not on this machine'],
    ['http://10.0.2.2:8080/api/acme', 'is not on this machine'],
    ['https://unknown.example.test/api/acme', 'cannot be resolved'],
    ['ftp://localhost/', 'must start with http'],
    ['https://user:pw@localhost/', 'user name'],
    ['not an address', 'not a valid address'],
  ])('refuses %s', async (value, reason) => {
    await expect(assertLocalUrl(value, 'The address', lookup)).rejects.toThrow(reason);
  });
});

describe('reading the verification link from Mailpit', () => {
  const link = 'https://api.example.test/auth/verify/abc/def?expires=1&signature=0a1b';

  it('finds the link in plain text and in HTML with escaped ampersands', () => {
    expect(findVerificationLink(`Confirm my e-mail address: ${link}\n`)).toBe(link);
    expect(findVerificationLink(`[${link}]`)).toBe(link);
    expect(findVerificationLink('no link here https://api.example.test/other')).toBeUndefined();
  });

  it('searches by recipient and reads the message', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = urlOf(input);
      seen.push(url);
      if (url.includes('/api/v1/search')) {
        return Promise.resolve(Response.json({ messages: [{ ID: 'm1' }] }));
      }
      return Promise.resolve(
        Response.json({
          Text: 'plain',
          HTML: `<a href="https://api.example.test/auth/verify/a/b?expires=1&amp;signature=2">x</a>`,
        }),
      );
    }) as unknown as typeof fetch;

    const text = await new Mailpit('http://localhost:8025/', fetchFn).newestTextTo(
      'a@example.test',
    );
    expect(seen[0]).toBe('http://localhost:8025/api/v1/search?query=to%3Aa%40example.test&limit=1');
    expect(seen[1]).toBe('http://localhost:8025/api/v1/message/m1');
    expect(findVerificationLink(text ?? '')).toBe(
      'https://api.example.test/auth/verify/a/b?expires=1&signature=2',
    );
  });

  it('waits for a message, and gives up with a message that says what to check', async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls++;
      return Promise.resolve(Response.json({ messages: [] }));
    }) as unknown as typeof fetch;
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      new Mailpit('http://localhost:8025', fetchFn).waitForTextTo('a@example.test', {
        timeoutMs: 1000,
        intervalMs: 500,
        sleep,
      }),
    ).rejects.toThrow('queue worker');
    expect(calls).toBe(3);
  });

  it('says when Mailpit cannot be reached', async () => {
    const fetchFn = (() => Promise.reject(new Error('refused'))) as unknown as typeof fetch;
    await expect(
      new Mailpit('http://localhost:8025', fetchFn).newestTextTo('a@example.test'),
    ).rejects.toThrow('--mailpit-url');
  });
});

describe('confirming a registration', () => {
  it('refuses a link that is not local, or not a verification link, without a request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      confirmRegistration('https://elsewhere.example.test/auth/verify/a/b', fetchFn, lookup),
    ).rejects.toThrow('not on this machine');
    await expect(
      confirmRegistration('https://api.example.test/somewhere/else', fetchFn, lookup),
    ).rejects.toThrow('/auth/verify/');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/** A small stand-in for a local OrganiseYou, Mailpit and the confirmation page. */
class FakeWorld {
  readonly requests: string[] = [];
  /** When true, the second person's list shows the first person's record (a leak the check must catch). */
  leak = false;
  readonly #pending = new Map<string, { password: string; name: string; verified: boolean }>();
  readonly #mails = new Map<string, string>();
  readonly #tokens = new Map<string, string>();
  readonly #records = new Map<string, { owner: string; values: Record<string, unknown> }>();
  readonly #csrf = 'csrf-' + randomBytes(4).toString('hex');

  readonly fetch = ((input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    this.#handle(urlOf(input), init)) as typeof fetch;

  #handle(url: string, init: RequestInit): Promise<Response> {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    this.requests.push(`${method} ${pathname}`);

    if (url.startsWith('http://localhost:8025/api/v1/search')) {
      const address = decodeURIComponent(new URLSearchParams(search).get('query') ?? '').replace(
        'to:',
        '',
      );
      return Promise.resolve(
        Response.json({ messages: this.#mails.has(address) ? [{ ID: address }] : [] }),
      );
    }
    if (url.startsWith('http://localhost:8025/api/v1/message/')) {
      const address = decodeURIComponent(pathname.split('/').pop() ?? '');
      return Promise.resolve(Response.json({ Text: `Confirm: ${this.#mails.get(address)}` }));
    }
    if (pathname.startsWith('/auth/verify/')) {
      const address = decodeURIComponent(new URLSearchParams(search).get('for') ?? '');
      if (method === 'GET') {
        return Promise.resolve(
          new Response(
            `<form><input type="hidden" name="_token" value="${this.#csrf}" autocomplete="off"></form>`,
            {
              headers: { 'Set-Cookie': 'session=s1; path=/; HttpOnly' },
            },
          ),
        );
      }
      const headers = new Headers(init.headers);
      const ok = init.body === `_token=${this.#csrf}` && headers.get('Cookie') === 'session=s1';
      const pending = this.#pending.get(address);
      if (ok && pending !== undefined) pending.verified = true;
      return Promise.resolve(new Response('', { status: ok ? 200 : 419 }));
    }

    const rest = pathname.replace('/api/acme', '');
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (rest === '/auth/register') {
      this.#pending.set(body['identifier'] ?? '', {
        password: body['password'] ?? '',
        name: body['name'] ?? '',
        verified: false,
      });
      this.#mails.set(
        body['identifier'] ?? '',
        `https://api.example.test/auth/verify/r/t?for=${encodeURIComponent(body['identifier'] ?? '')}&signature=1`,
      );
      return Promise.resolve(Response.json({ status: 'verification_sent' }, { status: 202 }));
    }
    if (rest === '/auth/token') {
      const person = this.#pending.get(body['identifier'] ?? '');
      if (person === undefined || person.password !== body['password'])
        return Promise.resolve(
          Response.json({ error: 'invalid_credentials', message: 'no' }, { status: 401 }),
        );
      if (!person.verified)
        return Promise.resolve(
          Response.json({ error: 'email_not_verified', message: 'no' }, { status: 401 }),
        );
      const access = `oyo_${randomBytes(8).toString('hex')}`;
      this.#tokens.set(access, body['identifier'] ?? '');
      return Promise.resolve(
        Response.json({
          access_token: access,
          refresh_token: `oyr_${randomBytes(8).toString('hex')}`,
          expires_in: 1800,
          scope: 'rest:read',
          user: { id: `usr_${this.#tokens.size}`, name: person.name, email: body['identifier'] },
        }),
      );
    }
    if (rest === '/auth/revoke') return Promise.resolve(Response.json({}));

    const who = this.#tokens.get(
      String(new Headers(init.headers).get('Authorization')).replace('Bearer ', ''),
    );
    if (who === undefined)
      return Promise.resolve(
        Response.json({ error: 'unauthenticated', message: 'no' }, { status: 401 }),
      );
    if (rest === '/rest/me')
      return Promise.resolve(
        Response.json({
          user: { id: 'u', email: who, name: 'n' },
          organization: {},
          roles: [],
          permissions: [],
          scopes: [],
          token: {},
        }),
      );
    const records = /^\/rest\/todos\/records$/.exec(rest);
    const one = /^\/rest\/todos\/record(?:\/(.+))?$/.exec(rest);
    if (records !== null) {
      const mine = [...this.#records]
        .filter(([, r]) => r.owner === who || this.leak)
        .map(([id, r]) => ({ id, ...r.values }));
      return Promise.resolve(
        Response.json({ data: mine, pagination: { total: mine.length, page: 1, perPage: 100 } }),
      );
    }
    if (one !== null) {
      const id = one[1] ?? randomBytes(4).toString('hex');
      const stored = this.#records.get(id);
      if (method === 'POST') {
        this.#records.set(id, { owner: who, values: body });
        return Promise.resolve(Response.json({ id, ...body }, { status: 201 }));
      }
      if (stored === undefined || stored.owner !== who)
        return Promise.resolve(
          Response.json({ error: 'not_found', message: 'no' }, { status: 404 }),
        );
      if (method === 'PUT') stored.values = { ...stored.values, ...body };
      if (method === 'DELETE') {
        this.#records.delete(id);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return Promise.resolve(Response.json({ id, ...stored.values }));
    }
    return Promise.resolve(new Response('', { status: 500 }));
  }
}

describe('the end-to-end flow, against a stand-in for the server', () => {
  const options = (world: FakeWorld, lines: string[]) => ({
    baseUrl: 'https://api.example.test/api/acme',
    mailpitUrl: 'http://localhost:8025',
    fetch: world.fetch,
    lookup,
    log: (line: string) => lines.push(line),
    sleep: () => Promise.resolve(),
  });

  it('passes: two people, a record made, changed and deleted, and never seen by the other', async () => {
    const world = new FakeWorld();
    const lines: string[] = [];
    expect(await runEndToEnd(options(world, lines))).toBe(true);
    expect(lines.at(-1)).toBe('The end-to-end check passed.');
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('ok')).length).toBe(16);
  });

  it('fails, and stops, when the other person can see the record', async () => {
    const world = new FakeWorld();
    world.leak = true;
    const lines: string[] = [];
    expect(await runEndToEnd(options(world, lines))).toBe(false);
    expect(lines).toContain(
      'FAIL  user 2: does not see it in the list: The other person sees the record in the list.',
    );
    expect(lines.at(-1)).toBe('The end-to-end check FAILED.');
    expect(world.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });

  it('prints no password, token or link', async () => {
    const world = new FakeWorld();
    const lines: string[] = [];
    await runEndToEnd(options(world, lines));
    const text = lines.join('\n');
    expect(text).not.toMatch(/oy[a-z]_|signature|auth\/verify|csrf/);
  });

  it('refuses a base address that is not local before sending anything', async () => {
    const world = new FakeWorld();
    const lines: string[] = [];
    await expect(
      runEndToEnd({ ...options(world, lines), baseUrl: 'https://elsewhere.example.test/api/acme' }),
    ).rejects.toThrow('not on this machine');
    expect(world.requests).toEqual([]);
  });

  it('refuses a Mailpit address that is not local', async () => {
    const world = new FakeWorld();
    await expect(
      runEndToEnd({ ...options(world, []), mailpitUrl: 'http://elsewhere.example.test:8025' }),
    ).rejects.toThrow('not on this machine');
    expect(world.requests).toEqual([]);
  });
});
