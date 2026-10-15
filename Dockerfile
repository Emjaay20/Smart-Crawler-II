# Slim image for AetherHost. Tenant containers are capped at 512MB, so Chromium
# is not installed. Scrape is fetch-first; Playwright remains a local fallback.
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY ui/package.json ui/package-lock.json ./ui/
RUN npm --prefix ui ci

COPY . .
RUN npx tsc -p tsconfig.json && npm --prefix ui run build

RUN mkdir -p /app/data && chown -R node:node /app/data /app/ui/dist

ENV PORT=3000
ENV NODE_ENV=production
ENV JOBS_DB=/app/data/jobs.sqlite
ENV PUBLIC_DIR=/app/ui/dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "dist/server.js"]
