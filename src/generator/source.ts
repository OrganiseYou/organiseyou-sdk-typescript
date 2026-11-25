import { readFile } from 'node:fs/promises';
import { resolveBaseUrl } from '../config.js';
import { OrganiseYou, OrganiseYouError } from '../index.js';
import { MemoryTokenStore, type StoredSession } from '../store.js';

/** What the generator needs from its surroundings, so a test needs no terminal and no network. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Asks a question on the terminal and returns the answer. */
  ask(question: string): Promise<string>;
  /** Asks a question on the terminal without showing what is typed. */
  askSecret(question: string): Promise<string>;
  env: Readonly<Record<string, string | undefined>>;
  /** The working folder: relative paths are made from it. */
  cwd: string;
  fetch: typeof fetch;
}

/** A document that could not be read or fetched. */
export class SourceError extends Error {
  override readonly name = 'SourceError';
}

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 32 * 1024 * 1024;

export async function readInputFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new SourceError(`The input file ${path} cannot be read.`);
  }
}

export type Credential = { kind: 'env'; name: string } | { kind: 'login' };

/**
 * Fetches `<url>/rest/openapi.json` with a credential that is never written anywhere: an access token from the
 * environment, or a sign-in with an e-mail address and a password typed at the terminal (which signs out again at
 * the end). The address follows the same rule as the client: `https`, or plain `http` for this machine only.
 */
export async function fetchDocument(url: string, credential: Credential, io: Io): Promise<string> {
  let base: string;
  try {
    base = resolveBaseUrl(url);
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : 'The address is not valid.');
  }

  if (credential.kind === 'env') {
    const token = io.env[credential.name];
    if (token === undefined || token === '') {
      throw new SourceError(
        `The environment variable ${credential.name} is not set. Set it to an access token, or use --login.`,
      );
    }
    return download(base, token, io);
  }

  let identifier: string;
  let password: string;
  try {
    identifier = (await io.ask('E-mail address: ')).trim();
    password = await io.askSecret('Password: ');
  } catch (error) {
    throw new SourceError(
      error instanceof Error ? error.message : 'Nothing could be read from the terminal.',
    );
  }
  if (identifier === '' || password === '')
    throw new SourceError('An e-mail address and a password are needed.');

  // The sign-in is the core's. The token store only hands the access token back; nothing is kept.
  let session: StoredSession | undefined;
  const store = new (class extends MemoryTokenStore {
    override async save(saved: StoredSession): Promise<void> {
      session = saved;
      await super.save(saved);
    }
  })();
  const client = new OrganiseYou({ baseUrl: base, fetch: io.fetch, tokenStore: store });
  try {
    await client.auth.signIn({ identifier, password });
  } catch (error) {
    throw new SourceError(`The sign-in failed: ${describe(error)}`);
  }
  try {
    if (session === undefined) throw new SourceError('The sign-in gave no session.');
    return await download(base, session.accessToken, io);
  } finally {
    // Always sign out, so the token the document was read with does not stay valid
    await client.auth.signOut().catch(() => undefined);
  }
}

async function download(base: string, token: string, io: Io): Promise<string> {
  let response: Response;
  try {
    response = await io.fetch(`${base}/rest/openapi.json`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      // The token goes to this address only
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SourceError('The document could not be fetched: no answer from the server.');
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new SourceError('The document is larger than 32 MB.');
  if (!response.ok) {
    throw new SourceError(
      `The server answered ${response.status} when the document was asked for${serverMessage(text)}.`,
    );
  }
  return text;
}

/** The server's own error code and message, when the body is its error shape. Never anything else from the body. */
function serverMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const code = typeof body.error === 'string' ? body.error : undefined;
    const message = typeof body.message === 'string' ? body.message : undefined;
    if (code === undefined && message === undefined) return '';
    return ` (${[code, message].filter((part) => part !== undefined).join(': ')})`;
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  if (error instanceof OrganiseYouError)
    return error.code === undefined ? error.message : `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
