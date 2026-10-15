export function matchesPathPattern(pathname: string, pattern: string): boolean {
  const path = normalizePath(pathname);
  const raw = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const pat = raw.endsWith('/*') ? raw.slice(0, -2) || '/' : raw.replace(/\/$/, '') || '/';

  if (raw.endsWith('/*')) {
    if (pat === '/') return true;
    return path === pat || path.startsWith(`${pat}/`);
  }

  if (pat.includes('*')) {
    const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(path);
  }

  return path === pat || path.startsWith(`${pat}/`);
}

export function isAllowedPath(pathname: string, includePaths: string[] = [], excludePaths: string[] = []): boolean {
  if (excludePaths.some((pattern) => matchesPathPattern(pathname, pattern))) return false;
  if (!includePaths.length) return true;
  return includePaths.some((pattern) => matchesPathPattern(pathname, pattern));
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
