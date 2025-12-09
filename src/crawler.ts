import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { program } from 'commander';
import fs from 'fs-extra';

import { fileURLToPath } from 'url';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
    program
        .version('1.0.0')
        .requiredOption('-u, --url <url>', 'URL to crawl')
        .option('-o, --output <file>', 'Output JSON file', 'results.json')
        .parse(process.argv);

    const options = program.opts();
    crawl(options.url, options.output);
}

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

export async function crawl(url: string, outputFile: string) {
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

            let items: any[] = [];

            // 1. Expanded Selectors for Modern Apps (YouTube, SPAs, etc)
            const selectors = [
                'article', '.product', '.item', '.card', 'li', 'tr',
                '[role="article"]', '[role="listitem"]',
                'ytd-video-renderer', 'ytd-rich-item-renderer', 'ytd-compact-video-renderer', // YouTube specific
                '.result', '.entry', '.post'
            ];

            const potentialContainers = document.querySelectorAll(selectors.join(', '));

            potentialContainers.forEach(el => {
                const htmlEl = el as HTMLElement;

                // Smarter Text Extraction
                let text = htmlEl.innerText?.trim();
                if (!text) text = htmlEl.getAttribute('aria-label') || htmlEl.getAttribute('title') || '';

                // Clean up text (remove excessive newlines/spaces)
                text = text.replace(/\s+/g, ' ').trim();

                // Find Link
                const linkEl = el.querySelector('a');
                const link = linkEl?.href;

                // Find Image (optional but good for context)
                const imgEl = el.querySelector('img');
                const image = imgEl?.src;

                if (text && text.length > 10 && link) {
                    items.push({
                        text: text.substring(0, 150) + (text.length > 150 ? '...' : ''),
                        link: link,
                        image: image
                    });
                }
            });

            // 2. Fallback: If no items found, try a broad sweep of links with text
            if (items.length === 0) {
                const allLinks = document.querySelectorAll('a');
                allLinks.forEach(a => {
                    let text = a.innerText?.trim();
                    if (!text) text = a.getAttribute('aria-label') || a.getAttribute('title') || '';
                    text = text.replace(/\s+/g, ' ').trim();

                    if (text && text.length > 20 && a.href && !a.href.startsWith('javascript:')) {
                        items.push({
                            text: text.substring(0, 100) + '...',
                            link: a.href
                        });
                    }
                });
            }

            // Deduplicate items by link
            const uniqueItems = Array.from(new Map(items.map(item => [item.link, item])).values());

            return {
                title,
                metaDescription,
                itemCount: uniqueItems.length,
                items: uniqueItems.slice(0, 20) // Increased limit
            };
        }));

        console.log('Extraction complete.');
        // console.log(JSON.stringify(data, null, 2));

        await fs.outputJson(outputFile, data, { spaces: 2 });
        console.log(`Results saved to ${outputFile}`);

        return data;

    } catch (error) {
        console.error('Crawl failed:', error);
        const screenshotPath = `error-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot saved to ${screenshotPath}`);
        throw error;
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


