import { Auth } from './auth.js';
import { type ClientOptions, organizationBaseUrl, resolveConfig } from './config.js';
import type { RateLimit } from './error.js';
import { Session, SessionEngine } from './session.js';
import { MemoryTokenStore, type TokenStore } from './store.js';
import { Transport } from './transport.js';

export interface OrganiseYouOptions extends ClientOptions {
  /** The API address of one organization: `https://<host>/api/<slug>`. */
  baseUrl: string;
  /** Where the session is kept. Defaults to a `MemoryTokenStore`. */
  tokenStore?: TokenStore;
}

/** A client for one organization's API. */
export class OrganiseYou {
  readonly #transport: Transport;
  /** The session: its state, changes, and `restore()`. */
  readonly session: Session;
  /** Sign-in, sign-out, registration and password reset. */
  readonly auth: Auth;

  constructor(options: OrganiseYouOptions) {
    this.#transport = new Transport(resolveConfig(options.baseUrl, options));
    const engine = new SessionEngine(this.#transport, options.tokenStore ?? new MemoryTokenStore());
    this.session = new Session(engine);
    this.auth = new Auth(engine, this.#transport);
  }

  /**
   * A client from the host and the organization's slug, for example `forOrganization('api.example.test', 'acme')`.
   * The host may carry a port and a scheme; it uses `https` when it has none.
   */
  static forOrganization(
    host: string,
    slug: string,
    options: Omit<OrganiseYouOptions, 'baseUrl'> = {},
  ): OrganiseYou {
    return new OrganiseYou({ ...options, baseUrl: organizationBaseUrl(host, slug) });
  }

  /** The rate limit headers of the latest answer that carried them, or `undefined` before the first. */
  get lastRateLimit(): RateLimit | undefined {
    return this.#transport.lastRateLimit;
  }
}
