import robotsParser from 'robots-parser';

export function isUrlAllowedByRobots(robotsTxt: string, userAgent: string, url: string): boolean {
  if (!robotsTxt.trim()) return true;
  const origin = new URL(url).origin;
  const parser = robotsParser(`${origin}/robots.txt`, robotsTxt);
  return parser.isAllowed(url, userAgent) !== false;
}
