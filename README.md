# 🕷️ SmartPlaywright Crawler

A high-performance, containerized web crawler built with **TypeScript**, **Node.js**, and **Playwright**.

![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/-Playwright-45ba4b?style=for-the-badge&logo=Playwright&logoColor=white)

## 🚀 Overview

This project is a robust web scraper designed to handle modern, JavaScript-heavy websites that traditional crawlers (like BeautifulSoup) cannot. It uses **Playwright** to render pages as a real user would, but with significant performance optimizations.

**Key Capabilities:**
*   **Dynamic Content**: Handles infinite scrolling and client-side rendering.
*   **Smart Blocking**: Automatically blocks images, fonts, and stylesheets to reduce bandwidth usage by ~40% and speed up crawling.
*   **Resilience**: Implements auto-retry logic with exponential backoff to handle network flakes.
*   **Containerized**: Fully Dockerized for consistent execution across any environment.

## 🛠️ Tech Stack

*   **Runtime**: Node.js
*   **Language**: TypeScript
*   **Browser Automation**: Playwright (Chromium)
*   **Containerization**: Docker
*   **CLI**: Commander.js

## 📦 Installation & Usage

### Option 1: Run with Docker (Recommended)

The easiest way to run the crawler is using the Docker image. This ensures all browser dependencies are pre-installed.

1.  **Build the Image**
    ```bash
    docker build -t smart-crawler .
    ```

2.  **Run the Crawler**
    ```bash
    # Runs the crawler on Hacker News and saves output to ./output/results.json
    docker run -v $(pwd)/output:/app/output smart-crawler --url "https://news.ycombinator.com" --output "output/results.json"
    ```

### Option 2: Run Locally

1.  **Install Dependencies**
    ```bash
    npm install
    npx playwright install chromium
    ```

2.  **Run the Script**
    ```bash
    npx ts-node src/crawler.ts --url "https://news.ycombinator.com" --output "results.json"
    ```

## 🧩 How It Works

1.  **Initialization**: The script launches a headless Chromium instance.
2.  **Network Interception**: Before navigating, it sets up request interception to abort resource-heavy requests (images, media, CSS).
3.  **Navigation**: It navigates to the target URL, waiting for the DOM to settle.
4.  **Auto-Scroll**: It simulates user scrolling to trigger lazy-loading content.
5.  **Extraction**: It executes code within the browser context to scrape relevant data (titles, links, metadata).
6.  **Output**: Data is structured and saved as a JSON file.

## 📂 Project Structure

```
├── src/
│   └── crawler.ts       # Main crawler logic
├── Dockerfile           # Docker configuration
├── package.json         # Dependencies
└── tsconfig.json        # TypeScript configuration
```

## 🏆 Portfolio Highlights

This project demonstrates:
*   **Systems Engineering**: Building a containerized application that manages its own environment.
*   **Performance Optimization**: Reducing resource consumption via network interception.
*   **Modern Web Scraping**: Handling complex, dynamic web applications.
*   **Robustness**: Error handling and retry mechanisms for production-grade reliability.
