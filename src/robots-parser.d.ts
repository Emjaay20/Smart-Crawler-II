declare module 'robots-parser' {
  interface Robots {
    isAllowed(url: string, userAgent?: string): boolean | undefined;
  }
  function robotsParser(url: string, robotsTxt: string): Robots;
  export default robotsParser;
}
