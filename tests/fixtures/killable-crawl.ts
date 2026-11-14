/**
 * A deliberately killable crawl worker for a subprocess integration test.
 * Uses synthetic responses only; it never performs an external HTTP request.
 */
import { JobStore } from '../../src/jobs.js';
import { crawlSite } from '../../src/crawl.js';

const [database, jobId] = process.argv.slice(2);
if (!database || !jobId) throw new Error('Expected database path and job ID');

const store = new JobStore(database);
const job = store.getJob(jobId);
if (!job || !store.claimPending(jobId)) throw new Error('Job must be pending');

const root = 'https://checkpoint.example/';
const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
  if (url === root) {
    return new Response(
      '<!doctype html><html><head><title>Seed</title></head><body><article>' +
        '<h1>Seed</h1><p>Checkpoint seed page content.</p>' +
        '<a href="/child-one">one</a><a href="/child-two">two</a></article></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }
  // Keep an actual event-loop handle alive while simulating a stalled request.
  // The test parent will send SIGKILL only after observing a committed checkpoint.
  while (true) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
}) as typeof fetch;

void crawlSite({ ...job.options, url: job.url } as never, {
  fetch: fetchImpl,
  onCheckpoint(checkpoint) {
    if (!store.saveCrawlCheckpoint(jobId, checkpoint)) throw Error('Job lost claim');
    if (checkpoint.pages.length === 1) process.stdout.write('CHECKPOINT_READY\n');
  },
}).catch((error: unknown) => {
  console.error('Worker failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
