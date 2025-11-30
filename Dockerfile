# Use the official image (already contains node, browsers, and OS deps)
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

# Build TypeScript
RUN npx tsc

# Entry point
ENTRYPOINT ["node", "dist/crawler.js"]
