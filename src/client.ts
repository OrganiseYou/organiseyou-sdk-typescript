import { type ClientOptions, organizationBaseUrl, resolveConfig } from './config.js';
import type { RateLimit } from './error.js';
import { Transport } from './transport.js';

export interface OrganiseYouOptions extends ClientOptions {
  /** The API address of one organization: `https://<host>/api/<slug>`. */
  baseUrl: string;
}

/** A client for one organization's API. */
export class OrganiseYou {
  readonly #transport: Transport;

  constructor(options: OrganiseYouOptions) {
    this.#transport = new Transport(resolveConfig(options.baseUrl, options));
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
