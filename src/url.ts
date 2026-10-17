export class InvalidUrlError extends Error {
  readonly code = 'invalid_url' as const;

  constructor(message = 'URL is invalid. Only http and https URLs are allowed.') {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  '[fd00:ec2::254]',
  'fd00:ec2::254',
]);

export interface UrlValidationOptions {
  allowPrivateNetworks?: boolean;
}

export function isBlockedHost(hostname: string, options: UrlValidationOptions = {}): { blocked: boolean; reason?: string } {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return { blocked: true, reason: 'URL hostname is required' };
  }

  if (BLOCKED_METADATA_HOSTS.has(host) || host.startsWith('169.254.')) {
    return {
      blocked: true,
      reason: 'Cloud metadata and link-local addresses are forbidden (SSRF protection)',
    };
  }

  const allowPrivate =
    options.allowPrivateNetworks ?? process.env.SMARTCRAWL_ALLOW_PRIVATE_NETWORKS === 'true';

  if (!allowPrivate && isPrivateOrLoopbackHost(host)) {
    return {
      blocked: true,
      reason: 'Private or loopback network targets are forbidden (SSRF protection)',
    };
  }

  return { blocked: false };
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (
    unwrapped === 'localhost' ||
    unwrapped.endsWith('.localhost') ||
    unwrapped.endsWith('.local') ||
    unwrapped.endsWith('.internal') ||
    unwrapped === '::1' ||
    unwrapped === '::' ||
    unwrapped.startsWith('fe80:') ||
    unwrapped.startsWith('fc00:') ||
    unwrapped.startsWith('fd00:')
  ) {
    return true;
  }

  // IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  const v4Mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(unwrapped);
  const ipv4Candidate = v4Mapped ? v4Mapped[1]! : unwrapped;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4Candidate);
  if (!ipv4Match) {
    return false;
  }

  const octets = [
    Number(ipv4Match[1]),
    Number(ipv4Match[2]),
    Number(ipv4Match[3]),
    Number(ipv4Match[4]),
  ];
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

export function validateHttpUrl(input: string, base?: string, options?: UrlValidationOptions): URL {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidUrlError('URL is required');
  }

  let parsed: URL;
  try {
    parsed = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    throw new InvalidUrlError(`Malformed URL: ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUrlError(`Unsupported protocol: ${parsed.protocol}`);
  }

  const check = isBlockedHost(parsed.hostname, options);
  if (check.blocked) {
    throw new InvalidUrlError(check.reason);
  }

  return parsed;
}

export function canonicalizeUrl(input: string, base?: string, options?: UrlValidationOptions): string {
  const url = validateHttpUrl(input, base, options);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}
