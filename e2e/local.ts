import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Resolves a host name to the addresses it points at. Replaceable, so a test needs no DNS. */
export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true });
  return found.map((entry) => entry.address);
};

/** Whether an IP address is on this machine: `127.0.0.0/8`, `::1`, or an IPv4 address mapped into IPv6. */
export function isLoopbackAddress(address: string): boolean {
  const unwrapped = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(unwrapped);
  const text = mapped?.[1] ?? unwrapped;
  if (isIP(text) === 4) return text.split('.')[0] === '127';
  return text === '::1' || text === '0:0:0:0:0:0:0:1';
}

/**
 * Refuses an address that is not on this machine. The host is resolved and every address it points at must be a
 * loopback address, so a local development host name (`localhost`, a DDEV name) passes and a real server never
 * does, however the host is spelled. Only `http` and `https`, and no user name or password in the address.
 */
export async function assertLocalUrl(
  value: string,
  what: string,
  lookup: Lookup = systemLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a valid address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${what} must start with http:// or https://.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${what} must not hold a user name or a password.`);
  }
  let addresses: string[];
  try {
    addresses =
      isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
        ? await lookup(url.hostname)
        : [url.hostname];
  } catch {
    throw new Error(
      `${what}: the host ${url.hostname} cannot be resolved, so it cannot be shown to be local.`,
    );
  }
  if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
    throw new Error(
      `${what} is refused: ${url.hostname} is not on this machine. The end-to-end check runs only against a local server.`,
    );
  }
  return url;
}
