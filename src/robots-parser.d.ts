declare module 'robots-parser' {
  interface Robots {
    isAllowed(url: string, userAgent?: string): boolean | undefined;
    getCrawlDelay(userAgent?: string): number | undefined;
    getSitemaps(): string[];
    getPreferredHost(): string | null;
  }
  function robotsParser(url: string, robotsTxt: string): Robots;
  export default robotsParser;
}
