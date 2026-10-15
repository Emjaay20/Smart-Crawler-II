# Docker and runtime notes

Superseded by the root `README.md`. The image is Node 22, compiles the API, builds the Vite playground, and runs `node dist/server.js` on `PORT` (default 3000). Health check is `GET /health`. Jobs live in SQLite at `JOBS_DB`.
