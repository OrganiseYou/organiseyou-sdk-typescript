import { randomBytes } from 'node:crypto';
import { OrganiseYou, OrganiseYouError } from '../src/index.js';
import { assertLocalUrl, type Lookup } from './local.js';
import { confirmRegistration, findVerificationLink, Mailpit } from './mail.js';

export interface FlowOptions {
  /** The API address of a local organization prepared for this check: `https://<host>/api/<slug>`. */
  baseUrl: string;
  /** The address of the local Mailpit. */
  mailpitUrl: string;
  /** Where each line of the report goes. */
  log: (line: string) => void;
  fetch?: typeof fetch;
  lookup?: Lookup;
  /** How long to wait for each e-mail. */
  mailTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface TestUser {
  oy: OrganiseYou;
  email: string;
  name: string;
  password: string;
}

/**
 * The end-to-end check: two people register and confirm their address from the e-mail, sign in, and one of them
 * creates, lists, updates and deletes a record while the other never sees it; then both sign out. It prints what
 * happened and never a token, a password or a link. Returns whether every step passed.
 */
export async function runEndToEnd(options: FlowOptions): Promise<boolean> {
  const { log } = options;
  const fetchFn = options.fetch ?? fetch;
  const base = await assertLocalUrl(
    options.baseUrl,
    'The base address (--base-url)',
    options.lookup,
  );
  await assertLocalUrl(options.mailpitUrl, 'The Mailpit address (--mailpit-url)', options.lookup);
  const mailpit = new Mailpit(options.mailpitUrl, fetchFn);

  const run = randomBytes(4).toString('hex');
  const makeUser = (n: number): TestUser => ({
    oy: new OrganiseYou({ baseUrl: base.href, fetch: fetchFn }),
    email: `sdk-e2e-${run}-${n}@example.test`,
    name: `SDK End To End ${n}`,
    password: randomBytes(18).toString('base64url'),
  });
  const [one, two] = [makeUser(1), makeUser(2)] as [TestUser, TestUser];
  log(`Run ${run}: ${base.origin}${base.pathname}, users ${one.email} and ${two.email}`);

  let failed = false;
  const step = async (name: string, action: () => Promise<void>): Promise<boolean> => {
    if (failed) return false;
    try {
      await action();
      log(`ok    ${name}`);
      return true;
    } catch (error) {
      failed = true;
      log(`FAIL  ${name}: ${describe(error)}`);
      return false;
    }
  };

  for (const [n, user] of [one, two].entries()) {
    const label = `user ${n + 1}`;
    await step(`${label}: register`, async () => {
      const answer = await user.oy.auth.register({
        name: user.name,
        identifier: user.email,
        password: user.password,
      });
      same(answer.status, 'verification_sent', 'the answer to the registration');
    });
    await step(`${label}: sign-in is refused until the address is confirmed`, async () => {
      const error = await rejected(
        user.oy.auth.signIn({ identifier: user.email, password: user.password }),
      );
      same(error.code, 'email_not_verified', 'the error code');
    });
    await step(`${label}: confirm the address from the e-mail`, async () => {
      const text = await mailpit.waitForTextTo(user.email, {
        timeoutMs: options.mailTimeoutMs ?? 60_000,
        intervalMs: 500,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
      const link = findVerificationLink(text);
      if (link === undefined) throw new Error('The e-mail has no verification link.');
      await confirmRegistration(link, fetchFn, options.lookup);
    });
    await step(`${label}: sign in`, async () => {
      await user.oy.auth.signIn({ identifier: user.email, password: user.password });
      same(user.oy.session.state.status, 'signedIn', 'the session state');
      const me = await user.oy.auth.me();
      same(me.user.email, user.email, 'the e-mail address in /rest/me');
    });
  }

  const title = `End-to-end ${run}`;
  const todos = one.oy.records('todos');
  let id = '';
  await step('user 1: create a record', async () => {
    const created = await todos.create({ title });
    id = created.id;
    same(created['title'], title, 'the title of the created record');
  });
  await step('user 1: the record is in the list', async () => {
    const ids: string[] = [];
    for await (const record of todos.all({ perPage: 100 })) ids.push(record.id);
    if (!ids.includes(id)) throw new Error('The new record is not in the list.');
  });
  await step('user 2: does not see it in the list', async () => {
    const ids: string[] = [];
    for await (const record of two.oy.records('todos').all({ perPage: 100 })) ids.push(record.id);
    if (ids.includes(id)) throw new Error('The other person sees the record in the list.');
  });
  await step('user 2: cannot read it by its id (404)', async () => {
    const error = await rejected(two.oy.records('todos').get(id));
    same(error.status, 404, 'the status');
  });
  await step('user 1: update it', async () => {
    const updated = await todos.update(id, { done: true });
    same(updated['done'], true, 'done in the answer');
    same((await todos.get(id))['done'], true, 'done after reading it again');
  });
  await step('user 1: delete it', async () => {
    await todos.delete(id);
    const error = await rejected(todos.get(id));
    same(error.status, 404, 'the status of reading it again');
  });
  for (const [n, user] of [one, two].entries()) {
    await step(`user ${n + 1}: sign out`, async () => {
      await user.oy.auth.signOut();
      same(user.oy.session.state.status, 'signedOut', 'the session state');
      const error = await rejected(user.oy.records('todos').list());
      same(error.kind, 'signedOut', 'the error kind of a call after signing out');
    });
  }

  log(failed ? 'The end-to-end check FAILED.' : 'The end-to-end check passed.');
  return !failed;
}

async function rejected(call: Promise<unknown>): Promise<OrganiseYouError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof OrganiseYouError) return error;
    throw error;
  }
  throw new Error('The call was expected to fail and succeeded.');
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function describe(error: unknown): string {
  if (error instanceof OrganiseYouError) {
    return `${error.kind}${error.status === undefined ? '' : ` ${error.status}`}${error.code === undefined ? '' : ` ${error.code}`}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
