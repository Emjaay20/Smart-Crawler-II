import { InvalidUrlError } from './url.js';

export type ErrorCode =
  | 'invalid_url'
  | 'robots_blocked'
  | 'timeout'
  | 'dns'
  | 'http_4xx'
  | 'http_5xx'
  | 'js_required'
  | 'provider_unavailable'
  | 'extract_empty'
  | 'unknown';

export class ScrapeError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ScrapeError';
    this.cause = options?.cause;
  }
}

export function classifyError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof ScrapeError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof InvalidUrlError) {
    return { code: 'invalid_url', message: err.message };
  }

  const name = errorName(err);
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return { code: 'timeout', message };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'dns', message };
  }

  return { code: 'unknown', message };
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name;
  }
  return '';
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  if ('code' in err && typeof err.code === 'string') return err.code;
  if ('cause' in err && err.cause && typeof err.cause === 'object' && 'code' in err.cause) {
    const causeCode = (err.cause as { code?: unknown }).code;
    return typeof causeCode === 'string' ? causeCode : '';
  }
  return '';
}
