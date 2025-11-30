import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { program } from 'commander';
import fs from 'fs-extra';

program
    .version('1.0.0')
    .requiredOption('-u, --url <url>', 'URL to crawl')
    .option('-o, --output <file>', 'Output JSON file', 'results.json')
    .parse(process.argv);

const options = program.opts();

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (retries <= 0) throw error;
        console.log(`Operation failed, retrying in ${delay}ms... (${retries} attempts left)`);
        await new Promise(res => setTimeout(res, delay));
        return withRetry(fn, retries - 1, delay);
    }
}

async function crawl(url: string, outputFile: string) {
    console.log(`Starting crawl for: ${url}`);

    const browser: Browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    const page: Page = await context.newPage();

    try {
        // Network Interception: Block images, fonts, stylesheets
        await page.route('**/*', (route: Route) => {
            const type = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                return route.abort();
            }
            return route.continue();
        });

        console.log('Navigating to page...');
        await withRetry(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));

        // Wait for some content to load
        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch (e) {
            console.log('Network idle timeout, proceeding...');
        }

        // Dynamic Scrolling to trigger lazy loading
        console.log('Scrolling...');
        await autoScroll(page);

        // Extract Data
        console.log('Extracting data...');
        const data = await withRetry(() => page.evaluate(() => {
            const title = document.title;
            const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content');

            const items: any[] = [];
            const potentialContainers = document.querySelectorAll('article, .product, .item, .card, li, tr');

            potentialContainers.forEach(el => {
                const text = (el as HTMLElement).innerText?.trim();
                const link = el.querySelector('a')?.href;
                if (text && text.length > 20 && link) {
                    items.push({
                        text: text.substring(0, 100) + '...',
                        link: link
                    });
                }
            });

            return {
                title,
                metaDescription,
                itemCount: items.length,
                items: items.slice(0, 10)
            };
        }));

        console.log('Extraction complete.');
        console.log(JSON.stringify(data, null, 2));

        await fs.outputJson(outputFile, data, { spaces: 2 });
        console.log(`Results saved to ${outputFile}`);

    } catch (error) {
        console.error('Crawl failed:', error);
        const screenshotPath = `error-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot saved to ${screenshotPath}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

async function autoScroll(page: Page) {
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 15000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

crawl(options.url, options.output);
