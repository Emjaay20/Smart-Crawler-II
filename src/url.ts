export class InvalidUrlError extends Error {
  readonly code = 'invalid_url' as const;

  constructor(message = 'URL is invalid. Only http and https URLs are allowed.') {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

export function validateHttpUrl(input: string, base?: string): URL {
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

  return parsed;
}

export function canonicalizeUrl(input: string, base?: string): string {
  const url = validateHttpUrl(input, base);
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
