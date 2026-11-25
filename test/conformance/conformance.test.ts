import { readFileSync } from 'node:fs';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganiseYou } from '../../src/index.js';
import { verifyFolder } from '../../scripts/conformance.mjs';
import { BASE_URL, MockTransport } from './mock-transport.js';
import { runScenario } from './runner.js';
import {
  type Interaction,
  loadInteractions,
  loadScenario,
  SET_FOLDER,
  scenarioFiles,
} from './set.js';

// The runner opens no socket: the global `fetch` is replaced by one that fails and is counted, and a TCP connection
// fails too. The SDK is given the mock transport through its `fetch` option.
const globalFetchCalls: string[] = [];

beforeAll(() => {
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('The conformance runner opens no socket.');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  globalFetchCalls.length = 0;
});

function refuseGlobalFetch(): void {
  vi.stubGlobal('fetch', (input: unknown) => {
    globalFetchCalls.push(String(input));
    return Promise.reject(
      new Error('The conformance runner opens no socket: global fetch was used.'),
    );
  });
}

describe('the copy of the conformance set', () => {
  it('matches its manifest, file for file', async () => {
    const { problems } = await verifyFolder(new URL(SET_FOLDER).pathname);
    expect(problems).toEqual([]);
  });
});

describe('the conformance set (shared REST scenarios)', () => {
  const interactions = loadInteractions();

  it.each(scenarioFiles())('%s', async (file) => {
    refuseGlobalFetch();
    const scenario = loadScenario(file);
    await runScenario(scenario, interactions);
    expect(globalFetchCalls, 'no call reached the global fetch').toEqual([]);
  });

  it('has a scenario file named after its id, and the scenarios of the shared list', () => {
    for (const file of scenarioFiles()) {
      expect(loadScenario(file).id).toBe(file.replace(/\.json$/, ''));
    }
    expect(scenarioFiles()).toHaveLength(35);
  });

  it('names only interactions that exist, and serves what its steps call', () => {
    for (const file of scenarioFiles()) {
      const scenario = loadScenario(file);
      const called: Record<string, number> = {};
      const walk = (steps: typeof scenario.steps): void => {
        for (const step of steps) {
          for (const id of step.calls ?? []) called[id] = (called[id] ?? 0) + 1;
          walk(step.steps ?? []);
        }
      };
      walk(scenario.steps);
      for (const id of Object.keys(scenario.serves)) {
        expect(interactions.has(id), `${scenario.id} names ${id}`).toBe(true);
      }
      expect(called, `${scenario.id}: serves is the sum of the calls of its steps`).toEqual(
        scenario.serves,
      );
    }
  });
});

describe('the mock transport and the no-socket guard', () => {
  const interaction: Interaction = {
    id: 'one',
    description: 'one',
    synthetic: false,
    request: {
      method: 'POST',
      path: '/rest/todos/record',
      query: {},
      headers: { Authorization: 'Bearer oyo_exchange_a1', 'Content-Type': 'application/json' },
      body: { title: 'x', done: false },
    },
    response: { status: 201, headers: { 'Content-Type': 'application/json' }, body: { id: '1' } },
  };
  const send = (mock: MockTransport, path: string, init: RequestInit): Promise<Response> =>
    mock.fetch(`${BASE_URL}${path}`, init);
  const good: RequestInit = {
    method: 'POST',
    headers: { Authorization: 'Bearer oyo_exchange_a1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: false, title: 'x' }),
  };

  it('serves a matching request, with the body keys in any order, and counts it', async () => {
    const mock = new MockTransport([interaction]);
    await send(mock, '/rest/todos/record', good);
    await send(mock, '/rest/todos/record', good);
    expect(mock.counts).toEqual({ one: 2 });
    expect(mock.unmatched).toEqual([]);
  });

  it.each([
    ['another method', '/rest/todos/record', { ...good, method: 'PUT' }],
    ['another path', '/rest/todos/records', good],
    ['a query it does not have', '/rest/todos/record?page=1', good],
    [
      'another token',
      '/rest/todos/record',
      {
        ...good,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer oyo_exchange_a2' },
      },
    ],
    [
      'no token',
      '/rest/todos/record',
      { ...good, headers: { 'Content-Type': 'application/json' } },
    ],
    [
      'another body',
      '/rest/todos/record',
      { ...good, body: JSON.stringify({ title: 'y', done: false }) },
    ],
    [
      'no body',
      '/rest/todos/record',
      { method: 'POST', headers: { ...(good.headers as Record<string, string>) } },
    ],
  ])('fails on %s and records it', async (_name, path, init) => {
    const mock = new MockTransport([interaction]);
    await expect(send(mock, path, init)).rejects.toThrow('no interaction');
    expect(mock.unmatched).toHaveLength(1);
    expect(mock.counts).toEqual({});
  });

  it('fails a request outside the API base address', async () => {
    const mock = new MockTransport([interaction]);
    await expect(mock.fetch('https://elsewhere.example.test/x', {})).rejects.toThrow();
    expect(mock.unmatched).toHaveLength(1);
  });

  it('replaces the global fetch, so a client with no fetch option cannot reach a server', async () => {
    refuseGlobalFetch();
    const oy = new OrganiseYou({ baseUrl: BASE_URL });
    await expect(
      oy.auth.signIn({ identifier: 'ada@example.test', password: 'x' }),
    ).rejects.toMatchObject({
      kind: 'network',
    });
    expect(globalFetchCalls).toHaveLength(1);
  });

  it('refuses a TCP connection', () => {
    expect(() => net.connect({ host: '127.0.0.1', port: 9 })).toThrow('opens no socket');
  });
});

describe('the conformance set files', () => {
  it('hold nothing that looks like a real token', () => {
    const files = ['manifest.json', ...loadFileList()];
    for (const file of files) {
      const text = readFileSync(new URL(file, SET_FOLDER), 'utf8');
      expect(text, file).not.toMatch(/\boy[a-z]_[A-Za-z0-9_-]{43}\b/);
    }
  });
});

function loadFileList(): string[] {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', SET_FOLDER), 'utf8')) as {
    files: { path: string }[];
  };
  return manifest.files.map((file) => file.path);
}
