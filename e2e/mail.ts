import { assertLocalUrl, type Lookup } from './local.js';

type FetchFn = typeof fetch;

/** The part of the Mailpit API this check reads: search by recipient, then read one message. */
export class Mailpit {
  readonly #base: string;
  readonly #fetch: FetchFn;

  constructor(baseUrl: string, fetchFn: FetchFn) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchFn;
  }

  /** The text of the newest message to an address, or `undefined` when there is none yet. */
  async newestTextTo(address: string): Promise<string | undefined> {
    const found = await this.#json(
      `/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=1`,
    );
    const messages = (found as { messages?: { ID?: unknown }[] }).messages;
    const id = messages?.[0]?.ID;
    if (typeof id !== 'string' || id === '') return undefined;
    const message = (await this.#json(`/api/v1/message/${encodeURIComponent(id)}`)) as {
      Text?: unknown;
      HTML?: unknown;
    };
    const text = typeof message.Text === 'string' ? message.Text : '';
    const html = typeof message.HTML === 'string' ? decodeEntities(message.HTML) : '';
    return `${text}\n${html}`;
  }

  /** Waits for a message to an address, then returns its text. */
  async waitForTextTo(
    address: string,
    options: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<string> {
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let waited = 0;
    for (;;) {
      const text = await this.newestTextTo(address);
      if (text !== undefined) return text;
      if (waited >= options.timeoutMs) {
        throw new Error(
          'No e-mail arrived at the local Mailpit in time. Is the queue worker running (Horizon), and is the address of Mailpit right?',
        );
      }
      await sleep(options.intervalMs);
      waited += options.intervalMs;
    }
  }

  async #json(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new Error('Mailpit cannot be reached. Pass its address with --mailpit-url.');
    }
    if (!response.ok)
      throw new Error(`Mailpit answered ${response.status} to ${path.split('?')[0]}.`);
    return (await response.json()) as unknown;
  }
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
    .replace(/&quot;/g, '"');
}

const LINK = /https?:\/\/[^\s<>"'()[\]]+\/auth\/verify\/[^\s<>"'()[\]]+/;

/** The verification link of a registration mail, or `undefined`. */
export function findVerificationLink(text: string): string | undefined {
  return LINK.exec(text)?.[0];
}

/**
 * Confirms a registration the way a person does: opens the link (a page with a button) and presses the button, which
 * is a POST of the page's form with its CSRF token and cookies. The link must be a local one: a mail is not trusted
 * to send this check anywhere.
 */
export async function confirmRegistration(
  link: string,
  fetchFn: FetchFn,
  lookup?: Lookup,
): Promise<void> {
  const url = await assertLocalUrl(link, 'The verification link', lookup);
  if (!url.pathname.startsWith('/auth/verify/')) {
    throw new Error('The verification link is not an /auth/verify/ link.');
  }

  const page = await fetchFn(url, { redirect: 'manual', headers: { Accept: 'text/html' } });
  if (page.status !== 200) throw new Error(`The verification page answered ${page.status}.`);
  const token = /<input[^>]*\bname="_token"[^>]*\bvalue="([^"]+)"/.exec(await page.text())?.[1];
  if (token === undefined) throw new Error('The verification page has no confirm form.');
  const cookie = page.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');

  const confirmed = await fetchFn(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie === '' ? {} : { Cookie: cookie }),
    },
    body: new URLSearchParams({ _token: token }).toString(),
  });
  if (confirmed.status !== 200)
    throw new Error(`Confirming the address answered ${confirmed.status}.`);
}
