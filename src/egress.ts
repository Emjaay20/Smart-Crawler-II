import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { InvalidUrlError, validateHttpUrl } from './url.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolveHost?: HostResolver;
  maxRedirects?: number;
  maxBytes?: number;
}

const blockedV4 = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) {
  blockedV4.addSubnet(base, prefix, 'ipv4');
}

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [base, prefix] of [
  ['2001:db8::', 32], ['2001::', 23], ['2001:10::', 28],
  ['2001:20::', 28], ['2002::', 16],
] as Array<[string, number]>) {
  blockedV6.addSubnet(base, prefix, 'ipv6');
}

/**
 * Conservative public-address policy. Only globally routable IPs are usable.
 * All IPv4-mapped IPv6 forms are classified as their embedded IPv4 address.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(bare);
  if (family === 4) return !blockedV4.check(bare, 'ipv4');
  if (family === 6) return globalV6.check(bare, 'ipv6') && !blockedV6.check(bare, 'ipv6');
  return false;
}

export async function resolvePublicAddresses(url: URL, resolver: HostResolver = systemResolver): Promise<ResolvedAddress[]> {
  validateHttpUrl(url.href);
  if (url.username || url.password) throw new InvalidUrlError('URLs containing credentials are not allowed');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : await resolver(host);

  if (addresses.length === 0 || addresses.some((item) =>
    item.family !== isIP(item.address) || !isPublicAddress(item.address)
  )) {
    throw new InvalidUrlError('Target resolves to a non-public or unknown network address');
  }
  return addresses;
}

async function systemResolver(hostname: string): Promise<ResolvedAddress[]> {
  const values = await lookup(hostname, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function pinToAddress(host: string, approved: ResolvedAddress): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname.toLowerCase().replace(/^\[|\]$/g, '') !== host.toLowerCase()) {
          callback(new Error('Unexpected DNS hostname at connection time'), undefined as never);
          return;
        }
        if (options.all) {
          callback(null, [{ address: approved.address, family: approved.family }]);
        } else {
          callback(null, approved.address, approved.family);
        }
      },
    },
  });
}

/**
 * Safe HTTP(S) GET/HEAD transport: validate every redirect before connecting,
 * resolve all records, and pin the direct socket to the approved DNS answer.
 *
 * Injected fetch implementations are for controlled offline tests only.
 * Production calls use the native fetch and the pinned Undici dispatcher.
 *
 * Explicit third-party proxies require a separately secured egress gateway:
 * a proxy may re-resolve a hostname itself, so DNS pinning cannot be assured here.
 */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit & { dispatcher?: Agent } = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  if (init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase())) {
    throw new InvalidUrlError('Safe fetch supports only GET or HEAD');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = Math.max(0, Math.min(10, options.maxRedirects ?? 5));
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  let current = validateHttpUrl(input instanceof Request ? input.url : String(input)).href;
  const allowTrustedProxy = process.env.SMARTCRAWL_TRUSTED_PROXY_EGRESS === 'true';

  if (init.dispatcher && !allowTrustedProxy) {
    throw new InvalidUrlError('Proxy scraping requires an operator-controlled egress gateway');
  }

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const url = validateHttpUrl(current);
    const nativeTransport = fetchImpl === globalThis.fetch;
    const addresses = (nativeTransport || options.resolveHost)
      ? await resolvePublicAddresses(url, options.resolveHost ?? systemResolver)
      : [];
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const agent = nativeTransport && !init.dispatcher && isIP(host) === 0
      ? pinToAddress(host, addresses[0]!)
      : undefined;

    try {
      const response = await fetchImpl(current, {
        ...init,
        redirect: 'manual',
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (location) {
          await response.body?.cancel();
          if (redirects === maxRedirects) throw new InvalidUrlError('Redirect limit exceeded');
          current = validateHttpUrl(new URL(location, current).href).href;
          continue;
        }
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel();
              throw new InvalidUrlError('Response body exceeds safe size limit');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const rebuilt = new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status,
        headers: response.headers,
      });
      Object.defineProperty(rebuilt, 'url', { value: current, configurable: true });
      return rebuilt;
    } finally {
      await agent?.close();
    }
  }
  throw new InvalidUrlError('Redirect limit exceeded');
}

export function createSafeFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    safeFetch(input, init, { fetchImpl })) as typeof fetch;
}
