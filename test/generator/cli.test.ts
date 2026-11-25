import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELP, runCli } from '../../src/generator/cli.js';
import { MANIFEST_NAME } from '../../src/generator/emit.js';
import type { Io } from '../../src/generator/source.js';
import { makeToken } from '../helpers.js';

const META = { version: '1.2.3', sdkPackage: '@organiseyou/sdk' };
const SAMPLE = fileURLToPath(
  new URL('../../conformance/openapi/todos-app-user.json', import.meta.url),
);

interface Run {
  code: number;
  out: string;
  err: string;
}

describe('the generate command', () => {
  let dir: string;
  let document: Record<string, unknown>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oy-cli-'));
    document = JSON.parse(await readFile(SAMPLE, 'utf8')) as Record<string, unknown>;
    await writeInput();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function writeInput(): Promise<void> {
    await writeFile(join(dir, 'openapi.json'), JSON.stringify(document));
  }

  function makeIo(overrides: Partial<Io> = {}): { io: Io; texts: { out: string; err: string } } {
    const texts = { out: '', err: '' };
    const io: Io = {
      stdout: (text) => void (texts.out += text),
      stderr: (text) => void (texts.err += text),
      ask: () => Promise.reject(new Error('no terminal')),
      askSecret: () => Promise.reject(new Error('no terminal')),
      env: {},
      cwd: dir,
      fetch: () => Promise.reject(new Error('no network')),
      ...overrides,
    };
    return { io, texts };
  }

  async function run(args: string[], overrides: Partial<Io> = {}): Promise<Run> {
    const { io, texts } = makeIo(overrides);
    const code = await runCli(args, io, META);
    return { code, ...texts };
  }

  const generate = (...extra: string[]): Promise<Run> =>
    run(['generate', '--input', 'openapi.json', '--out', 'gen', ...extra]);

  async function mtimes(folder: string): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const name of await readdir(join(dir, folder)))
      result[name] = (await stat(join(dir, folder, name))).mtimeMs;
    return result;
  }

  describe('the options', () => {
    it('has no --token or --password option, in the help text or in the parser', async () => {
      expect(HELP).not.toMatch(/--token(?!-env)/);
      expect(HELP).not.toMatch(/--password/);
      for (const flag of ['--token', '--password']) {
        const result = await run([
          'generate',
          '--url',
          'https://api.example.test/api/acme',
          flag,
          'secret',
          '--out',
          'gen',
        ]);
        expect(result.code).toBe(2);
        expect(result.err).toContain(`Unknown option '${flag}'`);
      }
      const help = await run(['--help']);
      expect(help.code).toBe(0);
      expect(help.out).not.toMatch(/--token(?!-env)|--password/);
    });

    it.each([
      [['generate', '--out', 'gen'], 'exactly one of --input and --url'],
      [
        [
          'generate',
          '--input',
          'a.json',
          '--url',
          'https://api.example.test/api/acme',
          '--out',
          'gen',
        ],
        'exactly one of --input and --url',
      ],
      [['generate', '--input', 'a.json'], '--out is required'],
      [['generate', '--input', 'a.json', '--out', 'gen', '--login'], 'go with --url'],
      [['generate', '--input', 'a.json', '--out', 'gen', '--save', 'x.json'], 'go with --url'],
      [
        [
          'generate',
          '--url',
          'https://api.example.test/api/acme',
          '--out',
          'gen',
          '--login',
          '--token-env',
          'X',
        ],
        'not both',
      ],
      [
        [
          'generate',
          '--url',
          'https://api.example.test/api/acme',
          '--out',
          'gen',
          '--check',
          '--save',
          'x.json',
        ],
        'cannot be used with --save',
      ],
      [
        [
          'generate',
          '--url',
          'https://api.example.test/api/acme',
          '--out',
          'gen',
          '--token-env',
          'not a name',
        ],
        'name of an environment variable',
      ],
      [['build'], 'Unknown command'],
      [[], 'Say what to do'],
    ])('refuses %j', async (args, message) => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.err).toContain(message);
    });

    it('shows its version', async () => {
      expect((await run(['--version'])).out).toBe('1.2.3\n');
    });
  });

  describe('writing', () => {
    it('writes the files, each starting with the generated line, and a manifest', async () => {
      const result = await generate();
      expect(result.code).toBe(0);
      const names = await readdir(join(dir, 'gen'));
      expect(names.sort()).toEqual([MANIFEST_NAME, 'endpoints.ts', 'index.ts', 'models.ts']);
      for (const name of ['endpoints.ts', 'index.ts', 'models.ts']) {
        const first = (await readFile(join(dir, 'gen', name), 'utf8')).split('\n')[0];
        expect(first).toBe('// Generated by organiseyou 1.2.3, do not edit.');
      }
      const manifest = JSON.parse(
        await readFile(join(dir, 'gen', MANIFEST_NAME), 'utf8'),
      ) as Record<string, unknown>;
      expect(manifest).toEqual({
        generator: { name: 'organiseyou', version: '1.2.3' },
        document: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string },
        files: ['endpoints.ts', 'index.ts', 'models.ts'],
      });
    });

    it('keeps the revision of the document in the manifest, when it has one', async () => {
      (document['info'] as Record<string, unknown>)['x-organiseyou-revision'] = 42;
      await writeInput();
      await generate();
      const manifest = JSON.parse(await readFile(join(dir, 'gen', MANIFEST_NAME), 'utf8')) as {
        document: { revision?: number };
      };
      expect(manifest.document.revision).toBe(42);
    });

    it('changes no file on a second run, and --check then exits 0', async () => {
      await generate();
      const before = await mtimes('gen');
      const texts = await Promise.all(
        (await readdir(join(dir, 'gen'))).map((n) => readFile(join(dir, 'gen', n), 'utf8')),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await generate();
      expect(second.code).toBe(0);
      expect(second.out).toContain('Nothing changed');
      expect(await mtimes('gen')).toEqual(before);
      expect(
        await Promise.all(
          (await readdir(join(dir, 'gen'))).map((n) => readFile(join(dir, 'gen', n), 'utf8')),
        ),
      ).toEqual(texts);

      const check = await generate('--check');
      expect(check.code).toBe(0);
      expect(check.out).toContain('up to date');
    });

    it('does not change the output when the document is only formatted or its keys are reordered', async () => {
      await generate();
      const before = await readFile(join(dir, 'gen', MANIFEST_NAME), 'utf8');
      await writeFile(
        join(dir, 'openapi.json'),
        JSON.stringify(Object.fromEntries(Object.entries(document).reverse()), null, 4),
      );
      expect((await generate('--check')).code).toBe(0);
      expect(await readFile(join(dir, 'gen', MANIFEST_NAME), 'utf8')).toBe(before);
    });

    it('--check writes nothing, and exits non-zero after the input changes', async () => {
      await generate();
      const before = await mtimes('gen');

      const schemas = (
        document['components'] as {
          schemas: Record<string, { properties: Record<string, unknown> }>;
        }
      ).schemas;
      schemas['Todos']!.properties['priority'] = { type: 'integer', nullable: true };
      await writeInput();

      const check = await generate('--check');
      expect(check.code).toBe(1);
      expect(check.err).toContain('out of date');
      expect(check.err).toContain('change models.ts');
      expect(await mtimes('gen')).toEqual(before);

      // A run brings it up to date again
      expect((await generate()).code).toBe(0);
      expect((await generate('--check')).code).toBe(0);
      expect(await readFile(join(dir, 'gen', 'models.ts'), 'utf8')).toContain(
        'priority?: number | null;',
      );
    });

    it('--check on a folder that does not exist yet exits non-zero and creates nothing', async () => {
      const check = await generate('--check');
      expect(check.code).toBe(1);
      await expect(stat(join(dir, 'gen'))).rejects.toThrow();
    });

    it('deletes what an endpoint that is gone left behind: its types and class, and any listed generated file', async () => {
      await generate();
      // A file an earlier version wrote: generated line, listed in the manifest
      await writeFile(
        join(dir, 'gen', 'reports.ts'),
        '// Generated by organiseyou 1.0.0, do not edit.\nexport {};\n',
      );
      const manifestPath = join(dir, 'gen', MANIFEST_NAME);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: string[] };
      manifest.files.push('reports.ts');
      await writeFile(manifestPath, JSON.stringify(manifest));

      // The reports endpoint leaves the document
      const paths = document['paths'] as Record<string, unknown>;
      for (const path of Object.keys(paths))
        if (path.startsWith('/rest/reports/')) delete paths[path];
      await writeInput();

      const result = await generate();
      expect(result.code).toBe(0);
      expect((await readdir(join(dir, 'gen'))).sort()).toEqual([
        MANIFEST_NAME,
        'endpoints.ts',
        'index.ts',
        'models.ts',
      ]);
      for (const name of ['endpoints.ts', 'index.ts', 'models.ts']) {
        expect(await readFile(join(dir, 'gen', name), 'utf8')).not.toMatch(/Reports/);
      }
    });

    it('refuses a folder with a file that has no generated line, and changes nothing in it', async () => {
      await mkdir(join(dir, 'gen'));
      await writeFile(join(dir, 'gen', 'mine.ts'), 'export const mine = 1;\n');
      await writeFile(join(dir, 'gen', 'models.ts'), 'export const handWritten = true;\n');

      for (const extra of [[], ['--check']]) {
        const result = await generate(...extra);
        expect(result.code).toBe(1);
        expect(result.err).toContain('mine.ts');
        expect(result.err).toContain('models.ts');
      }
      expect((await readdir(join(dir, 'gen'))).sort()).toEqual(['mine.ts', 'models.ts']);
      expect(await readFile(join(dir, 'gen', 'models.ts'), 'utf8')).toBe(
        'export const handWritten = true;\n',
      );
    });

    it('refuses a folder with a sub-folder, a manifest that is not its own, and a path that is a file', async () => {
      await mkdir(join(dir, 'gen', 'nested'), { recursive: true });
      expect((await generate()).code).toBe(1);
      await rm(join(dir, 'gen'), { recursive: true });

      await mkdir(join(dir, 'gen'));
      await writeFile(join(dir, 'gen', MANIFEST_NAME), '{"files":["models.ts"]}');
      expect((await generate()).code).toBe(1);
      await rm(join(dir, 'gen'), { recursive: true });

      await writeFile(join(dir, 'gen'), 'a file');
      const result = await generate();
      expect(result.code).toBe(1);
      expect(result.err).toContain('not a folder');
    });

    it('does not delete a file the manifest lists when it is hand-written', async () => {
      await generate();
      await writeFile(join(dir, 'gen', 'hand.ts'), 'export const hand = 1;\n');
      const manifestPath = join(dir, 'gen', MANIFEST_NAME);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: string[] };
      manifest.files.push('hand.ts');
      await writeFile(manifestPath, JSON.stringify(manifest));

      expect((await generate()).code).toBe(1);
      expect(await readFile(join(dir, 'gen', 'hand.ts'), 'utf8')).toBe('export const hand = 1;\n');
    });

    it('clears the leftover of a run that was cut short', async () => {
      await generate();
      await mkdir(join(dir, 'gen', '.organiseyou-tmp-abc'));
      await writeFile(join(dir, 'gen', '.organiseyou-tmp-abc', 'models.ts'), 'half');
      expect((await generate()).code).toBe(0);
      expect((await readdir(join(dir, 'gen'))).sort()).toEqual([
        MANIFEST_NAME,
        'endpoints.ts',
        'index.ts',
        'models.ts',
      ]);
    });

    it.each([
      ['the extension, from the tag', ['x-organiseyou-endpoint']],
      ['the extension and the tags, from the path', ['x-organiseyou-endpoint', 'tags']],
    ])('reads a document that lacks %s, and gives the same code', async (_what, drop) => {
      await generate();
      const models = await readFile(join(dir, 'gen', 'models.ts'), 'utf8');
      const endpoints = await readFile(join(dir, 'gen', 'endpoints.ts'), 'utf8');

      // A server that predates the extension
      const older = JSON.parse(JSON.stringify(document)) as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      for (const [path, item] of Object.entries(older.paths)) {
        if (!path.startsWith('/rest/')) continue;
        for (const operation of Object.values(item)) for (const key of drop) delete operation[key];
      }
      await writeFile(join(dir, 'older.json'), JSON.stringify(older));
      const result = await run(['generate', '--input', 'older.json', '--out', 'gen2']);
      expect(result.code).toBe(0);
      expect(await readFile(join(dir, 'gen2', 'models.ts'), 'utf8')).toBe(models);
      expect(await readFile(join(dir, 'gen2', 'endpoints.ts'), 'utf8')).toBe(endpoints);
    });

    it('skips an operation whose endpoint name does not match its path, with a warning', async () => {
      const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
      paths['/rest/todos/records']!['get']!['x-organiseyou-endpoint'] = 'other';
      await writeInput();
      const result = await generate();
      expect(result.code).toBe(0);
      expect(result.err).toContain('Skipped GET /rest/todos/records');
      expect(await readFile(join(dir, 'gen', 'endpoints.ts'), 'utf8')).not.toContain(
        'list(options?: oy.ListOptions): Promise<oy.Page<m.Todos>>',
      );
    });

    it('says why a document cannot be used', async () => {
      await writeFile(join(dir, 'openapi.json'), '{ nope');
      expect((await generate()).err).toContain('not valid JSON');
      await writeFile(join(dir, 'openapi.json'), JSON.stringify({ openapi: '3.1.0', paths: {} }));
      expect((await generate()).err).toContain('not OpenAPI 3.0');
      await writeFile(
        join(dir, 'openapi.json'),
        JSON.stringify({ openapi: '3.0.3', paths: { '/rest/me': {} } }),
      );
      expect((await generate()).err).toContain('no record endpoints');
      const missing = await run(['generate', '--input', 'nothing.json', '--out', 'gen']);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain('cannot be read');
    });

    it('turns a field it does not know into JsonValue, with a warning, and goes on', async () => {
      const schemas = (
        document['components'] as {
          schemas: Record<string, { properties: Record<string, unknown> }>;
        }
      ).schemas;
      schemas['Todos']!.properties['mystery'] = {
        oneOf: [{ type: 'string' }, { type: 'integer' }],
      };
      schemas['Todos']!.properties['blob'] = { type: 'object' };
      schemas['Todos']!.properties['anything'] = {};
      await writeInput();
      const result = await generate();
      expect(result.code).toBe(0);
      expect(result.err).toContain('warning: Todos.mystery');
      expect(result.err).toContain('warning: Todos.blob');
      expect(result.err).not.toContain('Todos.anything');
      const models = await readFile(join(dir, 'gen', 'models.ts'), 'utf8');
      expect(models).toContain('mystery?: JsonValue;');
      expect(models).toContain('anything?: JsonValue;');
    });
  });

  describe('fetching the document (--url), against a mock only', () => {
    const URL_BASE = 'https://api.example.test/api/acme';
    const text = (): string => JSON.stringify(document);

    interface Seen {
      method: string;
      url: string;
      authorization: string | undefined;
      redirect: RequestInit['redirect'];
      body: string | undefined;
    }

    function server(handler: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
      const seen: Seen[] = [];
      const mock = ((input: string | URL | Request, init: RequestInit = {}) => {
        const entry: Seen = {
          method: init.method ?? 'GET',
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init.headers).get('Authorization') ?? undefined,
          redirect: init.redirect,
          body: typeof init.body === 'string' ? init.body : undefined,
        };
        seen.push(entry);
        return Promise.resolve(handler(entry));
      }) as typeof fetch;
      return { fetch: mock, seen };
    }

    it('fetches with the token of the environment variable, never following a redirect, and saves the document', async () => {
      const token = makeToken('oyo');
      const { fetch: mock, seen } = server(() => new Response(text()));
      const result = await run(
        [
          'generate',
          '--url',
          URL_BASE,
          '--token-env',
          'MY_TOKEN',
          '--save',
          'saved.json',
          '--out',
          'gen',
        ],
        { fetch: mock, env: { MY_TOKEN: token } },
      );
      expect(result.code).toBe(0);
      expect(seen).toEqual([
        {
          method: 'GET',
          url: `${URL_BASE}/rest/openapi.json`,
          authorization: `Bearer ${token}`,
          redirect: 'error',
          body: undefined,
        },
      ]);
      expect(JSON.parse(await readFile(join(dir, 'saved.json'), 'utf8'))).toEqual(document);
      // Not in what it says, and not in anything it wrote
      expect(result.out + result.err).not.toContain(token);
      expect(await everythingUnder(dir)).not.toContain(token);
    });

    it('reads the default variable when --token-env is not given', async () => {
      const { fetch: mock, seen } = server(() => new Response(text()));
      const result = await run(['generate', '--url', URL_BASE, '--out', 'gen'], {
        fetch: mock,
        env: { ORGANISEYOU_TOKEN: 'x' },
      });
      expect(result.code).toBe(0);
      expect(seen[0]?.authorization).toBe('Bearer x');
    });

    it('says which variable is missing, and sends nothing', async () => {
      const { fetch: mock, seen } = server(() => new Response(text()));
      const result = await run(['generate', '--url', URL_BASE, '--out', 'gen'], { fetch: mock });
      expect(result.code).toBe(1);
      expect(result.err).toContain('ORGANISEYOU_TOKEN is not set');
      expect(seen).toEqual([]);
    });

    it('refuses an address that would send the token unencrypted', async () => {
      const { fetch: mock, seen } = server(() => new Response(text()));
      const result = await run(
        ['generate', '--url', 'http://api.example.test/api/acme', '--out', 'gen'],
        { fetch: mock, env: { ORGANISEYOU_TOKEN: 'x' } },
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain('must use https');
      expect(seen).toEqual([]);
    });

    it('reports the server error code and message, and writes nothing', async () => {
      const { fetch: mock } = server(() =>
        Response.json(
          { error: 'unauthenticated', message: 'The token is not valid.' },
          { status: 401 },
        ),
      );
      const result = await run(['generate', '--url', URL_BASE, '--out', 'gen'], {
        fetch: mock,
        env: { ORGANISEYOU_TOKEN: 'x' },
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain('401');
      expect(result.err).toContain('unauthenticated: The token is not valid.');
      await expect(stat(join(dir, 'gen'))).rejects.toThrow();
    });

    it('--check with --url fetches and compares, and writes nothing', async () => {
      const { fetch: mock } = server(() => new Response(text()));
      const overrides = { fetch: mock, env: { ORGANISEYOU_TOKEN: 'x' } };
      expect((await run(['generate', '--url', URL_BASE, '--out', 'gen'], overrides)).code).toBe(0);
      expect(
        (await run(['generate', '--url', URL_BASE, '--out', 'gen', '--check'], overrides)).code,
      ).toBe(0);
    });

    describe('with --login', () => {
      const email = `login-${randomBytes(3).toString('hex')}@example.test`;
      const password = `pw-${randomBytes(9).toString('base64url')}`;
      const access = makeToken('oyo');
      const refresh = makeToken('oyr');

      function loginServer(): ReturnType<typeof server> {
        return server((seen) => {
          if (seen.url === `${URL_BASE}/auth/token`) {
            const body = JSON.parse(seen.body ?? '{}') as {
              identifier?: string;
              password?: string;
            };
            if (body.identifier !== email || body.password !== password) {
              return Response.json(
                { error: 'invalid_credentials', message: 'These credentials are not valid.' },
                { status: 401 },
              );
            }
            return Response.json({
              access_token: access,
              token_type: 'Bearer',
              expires_in: 1800,
              refresh_token: refresh,
              scope: 'rest:read',
              user: { id: 'usr_1', name: 'Mira Member', email },
            });
          }
          if (
            seen.url === `${URL_BASE}/rest/openapi.json` &&
            seen.authorization === `Bearer ${access}`
          ) {
            return new Response(text());
          }
          if (seen.url === `${URL_BASE}/auth/revoke`) return Response.json({});
          return new Response('', { status: 500 });
        });
      }

      const asked: string[] = [];
      const prompts: Partial<Io> = {
        ask: (question) => {
          asked.push(question);
          return Promise.resolve(email);
        },
        askSecret: (question) => {
          asked.push(question);
          return Promise.resolve(password);
        },
      };

      it('signs in with the core, reads the document, signs out, and leaves no token, password or address anywhere', async () => {
        const { fetch: mock, seen } = loginServer();
        const result = await run(
          ['generate', '--url', URL_BASE, '--login', '--save', 'saved.json', '--out', 'gen'],
          { ...prompts, fetch: mock },
        );
        expect(result.code).toBe(0);
        expect(asked).toEqual(['E-mail address: ', 'Password: ']);
        expect(seen.map((s) => `${s.method} ${s.url.slice(URL_BASE.length)}`)).toEqual([
          'POST /auth/token',
          'GET /rest/openapi.json',
          'POST /auth/revoke',
        ]);

        // The output folder, the working folder (which holds it, the input and the saved document), and what was printed
        const everything = await everythingUnder(dir);
        for (const secret of [access, refresh, password, email]) {
          expect(everything, 'the files').not.toContain(secret);
          expect(result.out + result.err, 'the output').not.toContain(secret);
        }
        expect((await readdir(join(dir, 'gen'))).length).toBe(4);
      });

      it('fails clearly on a wrong password, and writes nothing', async () => {
        const { fetch: mock, seen } = loginServer();
        const result = await run(['generate', '--url', URL_BASE, '--login', '--out', 'gen'], {
          ask: () => Promise.resolve(email),
          askSecret: () => Promise.resolve('not-the-password'),
          fetch: mock,
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain('invalid_credentials');
        expect(result.err).not.toContain('not-the-password');
        expect(seen.some((s) => s.url.endsWith('/rest/openapi.json'))).toBe(false);
        await expect(stat(join(dir, 'gen'))).rejects.toThrow();
      });

      it('says so when there is no terminal to ask on, and sends nothing', async () => {
        const { fetch: mock, seen } = loginServer();
        const result = await run(['generate', '--url', URL_BASE, '--login', '--out', 'gen'], {
          fetch: mock,
        });
        expect(result.code).toBe(1);
        expect(result.err).toContain('no terminal');
        expect(seen).toEqual([]);
      });

      it('signs out even when the document cannot be read', async () => {
        const { fetch: mock, seen } = server((s) => {
          if (s.url.endsWith('/auth/token')) {
            return Response.json({
              access_token: access,
              token_type: 'Bearer',
              expires_in: 1800,
              refresh_token: refresh,
              scope: 'rest:read',
              user: { id: 'usr_1', name: 'M', email },
            });
          }
          if (s.url.endsWith('/auth/revoke')) return Response.json({});
          return Response.json({ error: 'forbidden', message: 'Not for you.' }, { status: 403 });
        });
        const result = await run(['generate', '--url', URL_BASE, '--login', '--out', 'gen'], {
          ...prompts,
          fetch: mock,
        });
        expect(result.code).toBe(1);
        expect(seen.at(-1)?.url).toBe(`${URL_BASE}/auth/revoke`);
      });
    });
  });
});

/** The text of every file under a folder, to look for what must never be written there. */
async function everythingUnder(folder: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else parts.push(entry.name, await readFile(full, 'utf8'));
    }
  };
  await walk(folder);
  return parts.join('\n');
}
