#!/usr/bin/env node
import { Command } from 'commander';
import { SmartCrawl, SmartCrawlError } from './client.js';

const program = new Command();

program
  .name('smartcrawl')
  .description('URL in. Clean markdown and structured JSON out.')
  .option('--base <url>', 'API base URL', process.env.SMARTCRAWL_URL ?? 'https://smart-crawler.aetherhost.com.ng')
  .option('--key <key>', 'API key', process.env.SMARTCRAWL_API_KEY);

program
  .command('health')
  .description('Check API liveness')
  .action(async () => {
    const sc = client(program);
    print(await sc.health());
  });

program
  .command('scrape')
  .description('Scrape one URL to markdown')
  .argument('<url>')
  .option('--js <mode>', 'auto | true | false', 'auto')
  .action(async (url: string, opts: { js: string }) => {
    const sc = client(program);
    print(await sc.scrape(url, { js: parseJs(opts.js) }));
  });

program
  .command('map')
  .description('Discover same-origin URLs')
  .argument('<url>')
  .option('--limit <n>', 'max links', '50')
  .action(async (url: string, opts: { limit: string }) => {
    const sc = client(program);
    print(await sc.map(url, { limit: Number(opts.limit) }));
  });

program
  .command('crawl')
  .description('Crawl multiple pages')
  .argument('<url>')
  .option('--limit <n>', 'max pages', '5')
  .action(async (url: string, opts: { limit: string }) => {
    const sc = client(program);
    print(await sc.crawl(url, { limit: Number(opts.limit) }));
  });

program
  .command('job')
  .description('Get a job by id')
  .argument('<id>')
  .action(async (id: string) => {
    const sc = client(program);
    print(await sc.job(id));
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof SmartCrawlError) {
    console.error(`${err.status} ${err.message}`);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

function client(root: Command): SmartCrawl {
  const opts = root.opts<{ base: string; key?: string }>();
  return new SmartCrawl({ baseUrl: opts.base, apiKey: opts.key || undefined });
}

function parseJs(value: string): boolean | 'auto' {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'auto';
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
