import fs from 'fs-extra';
import { program } from 'commander';
import { fileURLToPath } from 'node:url';
import { scrape } from './scrape.js';
import { renderWithPlaywright } from './browser.js';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  program
    .version('1.0.0')
    .requiredOption('-u, --url <url>', 'URL to crawl')
    .option('-o, --output <file>', 'Output JSON file', 'results.json')
    .parse(process.argv);

  const options = program.opts<{ url: string; output: string }>();
  crawl(options.url, options.output).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export async function crawl(url: string, outputFile: string) {
  const data = await scrape(
    { url },
    { renderWithBrowser: renderWithPlaywright },
  );
  await fs.outputJson(outputFile, data, { spaces: 2 });
  console.log(`Results saved to ${outputFile}`);
  return data;
}
