# Dockerfile and Code Explanation

## 1. Dockerfile Explanation

The `Dockerfile` is a blueprint for creating a **Docker Image**. This image contains everything your application needs to run (Node.js, Playwright browsers, dependencies, and your code), ensuring it runs exactly the same way on any machine.

Here is a line-by-line breakdown of your `Dockerfile`:

```dockerfile
# 1. Base Image
FROM mcr.microsoft.com/playwright:v1.40.0-focal
```
*   **What it does**: Starts with an official Playwright image provided by Microsoft.
*   **Why**: Playwright requires specific system dependencies (like libraries for rendering fonts and graphics) to run browsers like Chromium. This image comes pre-installed with Node.js, the browsers, and all necessary OS-level dependencies, saving you hours of setup time.

```dockerfile
# 2. Working Directory
WORKDIR /app
```
*   **What it does**: Sets `/app` as the current directory inside the container. All subsequent commands will happen here.

```dockerfile
# 3. Install Dependencies
COPY package.json package-lock.json ./
RUN npm install
```
*   **What it does**: Copies your dependency definitions first and installs them.
*   **Why**: We copy *only* these files first to take advantage of Docker's **layer caching**. If you change your code but not your dependencies, Docker skips this step and reuses the cached "layer," making builds much faster.

```dockerfile
# 4. Copy Source Code
COPY . .
```
*   **What it does**: Copies the rest of your project files (like `src/` and `tsconfig.json`) into the container.

```dockerfile
# 5. Build TypeScript
RUN npx tsc
```
*   **What it does**: Compiles your TypeScript code (`src/crawler.ts`) into JavaScript (`dist/crawler.js`).
*   **Why**: Node.js cannot run TypeScript directly; it needs JavaScript.

```dockerfile
# 6. Entry Point
ENTRYPOINT ["node", "dist/crawler.js"]
```
*   **What it does**: Defines the command that runs when you start the container.
*   **Usage**: When you run `docker run smart-crawler --url ...`, Docker effectively runs `node dist/crawler.js --url ...`.

---

## 2. Code Explanation (`src/crawler.ts`)

The crawler is a Node.js script that uses **Playwright** to automate a web browser. It is designed to be fast and robust.

### Key Concepts

#### A. Setup and CLI
*   **Commander**: The script uses the `commander` library to handle command-line arguments like `--url` and `--output`.
*   **Browser Launch**: It launches a **Chromium** browser in "headless" mode (no visible UI) for speed.

#### B. Performance Optimization (Network Interception)
This is the "Smart" part of the crawler. Loading images, fonts, and ads takes a lot of time and bandwidth. The code actively blocks them:

```typescript
await page.route('**/*', (route: Route) => {
    const type = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        return route.abort(); // Block these requests
    }
    return route.continue(); // Allow everything else (HTML, JS, API calls)
});
```
*   **Result**: The page loads much faster because it only downloads the HTML and scripts needed to render the text and structure.

#### C. Robustness (Retry Logic)
Networks are flaky. The `withRetry` function ensures the crawler doesn't crash on a temporary glitch.

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000) { ... }
```
*   It wraps operations like `page.goto()` and `page.evaluate()`.
*   If an error occurs (e.g., timeout), it waits 2 seconds and tries again, up to 3 times.

#### D. Handling Dynamic Content
Many modern sites (like Twitter or LinkedIn) load content only when you scroll down.
*   **`autoScroll(page)`**: This function simulates a user scrolling to the bottom of the page. It moves down in 100px increments, waiting for new content to load, ensuring the crawler sees everything.

#### E. Data Extraction
Once the page is loaded and scrolled:
1.  It runs code *inside* the browser context (`page.evaluate`).
2.  It grabs the **Title** and **Meta Description**.
3.  It looks for common list items (using selectors like `article`, `.card`, `.product`) and extracts their text and links.
