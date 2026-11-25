import { expect, vi } from 'vitest';
import { MemoryTokenStore, OrganiseYou, OrganiseYouError, StoredSession } from '../../src/index.js';
import type { SessionState } from '../../src/index.js';
import { BASE_URL, MockTransport } from './mock-transport.js';
import type { Expectation, Interaction, Scenario, Step } from './set.js';

/** What one step came to: a value, or the error it threw. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Runs one scenario of the set against the SDK, and fails the test on any difference. */
export async function runScenario(
  scenario: Scenario,
  interactions: Map<string, Interaction>,
): Promise<void> {
  const served = Object.keys(scenario.serves).map((id) => {
    const interaction = interactions.get(id);
    if (interaction === undefined) {
      throw new Error(`${scenario.id} serves ${id}, which is not in the set.`);
    }
    return interaction;
  });
  const mock = new MockTransport(served);
  const store = new MemoryTokenStore();
  const client = new OrganiseYou({ baseUrl: BASE_URL, fetch: mock.fetch, tokenStore: store });

  vi.useFakeTimers({ now: new Date(scenario.now) });
  try {
    if (scenario.start.session === 'stored') {
      const { accessToken, accessTokenEndsAt, refreshToken, scope, user } = scenario.start;
      if (
        accessToken === undefined ||
        accessTokenEndsAt === undefined ||
        refreshToken === undefined ||
        user === undefined
      ) {
        throw new Error(
          `${scenario.id}: a stored session needs its tokens, an end time and a user.`,
        );
      }
      await store.save(
        new StoredSession({
          accessToken,
          expiresAt: new Date(accessTokenEndsAt),
          refreshToken,
          scope: scope ?? '',
          user,
        }),
      );
      await client.session.restore();
    }

    for (const [index, step] of scenario.steps.entries()) {
      const where = `${scenario.id}, step ${index + 1} (${step.do})`;
      const before = mock.order.length;
      if (step.do === 'parallel') await runParallel(client, step, where);
      else check(await settle(() => execute(client, step)), step.expect, where);

      const requested = mock.order.slice(before);
      if (step.do === 'parallel') {
        // Started together, so the order the requests arrive in is not part of the scenario
        expect([...requested].sort(), `${where}: the interactions requested`).toEqual(
          [...(step.calls ?? [])].sort(),
        );
      } else {
        expect(requested, `${where}: the interactions requested, in order`).toEqual(
          step.calls ?? [],
        );
      }
      checkState(client.session.state, step.expect?.state, where);
      await checkStore(store, client.session.state, where);
      checkRateLimit(client.lastRateLimit, step.expect?.lastRateLimit, where);
    }

    expect(mock.unmatched, `${scenario.id}: requests that matched no interaction`).toEqual([]);
    expect(mock.counts, `${scenario.id}: how often each interaction was requested`).toEqual(
      sortedKeys(scenario.serves),
    );
  } finally {
    vi.useRealTimers();
  }
}

async function runParallel(client: OrganiseYou, step: Step, where: string): Promise<void> {
  const sub = step.steps ?? [];
  expect(sub.length, `${where}: a parallel step needs steps`).toBeGreaterThan(0);
  // All of them are started before any is waited for
  const started = sub.map((one) => settle(() => execute(client, one)));
  const outcomes = await Promise.all(started);
  for (const [index, one] of sub.entries()) {
    check(outcomes[index] as Outcome, one.expect, `${where}, part ${index + 1} (${one.do})`);
  }
}

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Calls the SDK for one step of the vocabulary. The result is turned into the form `expect.result` is written in. */
async function execute(client: OrganiseYou, step: Step): Promise<unknown> {
  const args = step.args ?? {};
  const text = (name: string): string => {
    const value = args[name];
    if (typeof value !== 'string') throw new Error(`${step.do} needs the text argument "${name}".`);
    return value;
  };
  const number = (name: string): number | undefined => {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'number') throw new Error(`${step.do}: "${name}" must be a number.`);
    return value;
  };
  const values = (): Record<string, unknown> => {
    const value = args['values'];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${step.do} needs "values" as an object.`);
    }
    return value as Record<string, unknown>;
  };
  // Only the options a step names are passed, so the call sends only the query it names
  const paging = (): { page?: number; perPage?: number } => {
    const page = number('page');
    const perPage = number('perPage');
    return {
      ...(page === undefined ? {} : { page }),
      ...(perPage === undefined ? {} : { perPage }),
    };
  };

  switch (step.do) {
    case 'auth.signIn':
      return client.auth.signIn({ identifier: text('identifier'), password: text('password') });
    case 'auth.signOut':
      return client.auth.signOut();
    case 'auth.register':
      return client.auth.register({
        name: text('name'),
        identifier: text('identifier'),
        password: text('password'),
      });
    case 'auth.forgotPassword':
      return client.auth.forgotPassword({
        identifier: text('identifier'),
        redirectUrl: text('redirectUrl'),
      });
    case 'auth.resetPassword':
      return client.auth.resetPassword({ token: text('token'), password: text('password') });
    case 'auth.me':
      return client.auth.me();
    case 'records.list': {
      const page = await client.records(text('endpoint')).list(paging());
      const { items, ...rest } = page;
      return { ...rest, itemIds: items.map((item) => item.id) };
    }
    case 'records.all': {
      const perPage = number('perPage');
      const itemIds: string[] = [];
      for await (const item of client
        .records(text('endpoint'))
        .all(perPage === undefined ? {} : { perPage })) {
        itemIds.push(item.id);
      }
      return { itemIds };
    }
    case 'records.get':
      return client.records(text('endpoint')).get(text('id'));
    case 'records.create':
      return client.records(text('endpoint')).create(values());
    case 'records.update':
      return client.records(text('endpoint')).update(text('id'), values());
    case 'records.delete':
      return client.records(text('endpoint')).delete(text('id'));
    case 'clock.advance': {
      const seconds = number('seconds');
      if (seconds === undefined) throw new Error('clock.advance needs "seconds".');
      // Moves the clock without running timers: nothing waits for time to pass
      vi.setSystemTime(new Date(Date.now() + seconds * 1000));
      return undefined;
    }
    default:
      throw new Error(`The step "${step.do}" is not in the vocabulary of the set.`);
  }
}

function check(outcome: Outcome, expectation: Expectation | undefined, where: string): void {
  if (expectation?.error !== undefined) {
    expect(outcome.ok, `${where}: expected an error, the call succeeded`).toBe(false);
    if (outcome.ok) return;
    checkError(outcome.error, expectation.error, where);
    return;
  }
  if (!outcome.ok) {
    // An unexpected error fails the test with the error itself, which never holds a token
    throw new Error(`${where}: the call failed: ${describeError(outcome.error)}`);
  }
  if (expectation?.result !== undefined) {
    const actual = JSON.parse(JSON.stringify(outcome.value ?? null)) as unknown;
    expect(pick(actual, expectation.result), `${where}: the result`).toEqual(expectation.result);
  }
}

function checkError(
  error: unknown,
  expected: NonNullable<Expectation['error']>,
  where: string,
): void {
  expect(error, `${where}: the error is the one error type`).toBeInstanceOf(OrganiseYouError);
  if (!(error instanceof OrganiseYouError)) return;
  const actual = {
    kind: error.kind,
    status: error.status,
    code: error.code,
    fieldErrors: error.fieldErrors,
    retryAfterSeconds: error.retryAfterSeconds,
  };
  const named = Object.fromEntries(
    Object.keys(expected).map((key) => [key, actual[key as keyof typeof actual]]),
  );
  expect(named, `${where}: the error`).toEqual(expected);
  // An answer that is not the server's JSON has the HTTP status and no code (conformance/README.md)
  if (error.kind === 'decoding')
    expect(error.code, `${where}: a decoding error has no code`).toBeUndefined();
}

function describeError(error: unknown): string {
  if (error instanceof OrganiseYouError) {
    return `${error.kind}${error.status === undefined ? '' : ` ${error.status}`}${error.code === undefined ? '' : ` ${error.code}`}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function checkState(state: SessionState, expected: Expectation['state'], where: string): void {
  if (expected === undefined) return;
  const actual: Record<string, unknown> = { status: state.status };
  if (state.status === 'signedOut') actual['reason'] = state.reason;
  if (state.status === 'signedIn') actual['user'] = { id: state.user.id };
  expect(pick(actual, expected), `${where}: the session state`).toEqual(expected);
}

/** The store holds a session exactly when the state is signed in, and it is that person's. */
async function checkStore(
  store: MemoryTokenStore,
  state: SessionState,
  where: string,
): Promise<void> {
  const stored = await store.load();
  if (state.status === 'signedOut') {
    expect(stored, `${where}: a signed-out client keeps nothing in its store`).toBeNull();
  } else {
    expect(stored?.user.id, `${where}: the store holds the signed-in person's session`).toBe(
      state.user.id,
    );
  }
}

function checkRateLimit(
  actual: { limit: number; remaining: number; resetSeconds: number } | undefined,
  expected: Expectation['lastRateLimit'],
  where: string,
): void {
  if (expected === undefined) return;
  const shaped =
    actual === undefined
      ? undefined
      : { limit: actual.limit, remaining: actual.remaining, reset: actual.resetSeconds };
  expect(pick(shaped, expected), `${where}: the last rate limit`).toEqual(expected);
}

/**
 * The part of `actual` that `expected` names: every key of an object in `expected`, recursively. A list is taken
 * whole, since the set compares lists exactly.
 */
export function pick(actual: unknown, expected: unknown): unknown {
  if (
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected) &&
    typeof actual === 'object' &&
    actual !== null &&
    !Array.isArray(actual)
  ) {
    const from = actual as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key in from) picked[key] = pick(from[key], (expected as Record<string, unknown>)[key]);
    }
    return picked;
  }
  return actual;
}

function sortedKeys(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}
