import { createInterface } from 'node:readline';
import { SmartCrawl } from './client.js';

interface McpRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const SERVER_NAME = 'smartcrawl-mcp';
const SERVER_VERSION = '1.0.0';

/**
 * Standard Model Context Protocol (MCP) server over stdio.
 * Provides AI coding tools (Claude Code, Cursor, Windsurf, Codex) with native
 * smartcrawl_scrape and smartcrawl_crawl capabilities.
 */
export async function runMcpServer(options: { baseUrl?: string; apiKey?: string } = {}): Promise<void> {
  const client = new SmartCrawl({
    baseUrl: options.baseUrl ?? process.env.SMARTCRAWL_URL ?? 'http://127.0.0.1:3000',
    apiKey: options.apiKey ?? process.env.SMARTCRAWL_API_KEY,
  });

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  readline.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: McpRequest;
    try {
      req = JSON.parse(trimmed) as McpRequest;
    } catch {
      sendError(null, -32700, 'Parse error: invalid JSON');
      return;
    }

    const id = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize': {
          sendResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
          });
          break;
        }

        case 'notifications/initialized': {
          // No-op for notification
          break;
        }

        case 'tools/list': {
          sendResponse(id, {
            tools: [
              {
                name: 'smartcrawl_scrape',
                description: 'Scrape a single URL to clean markdown and structured content using SmartCrawl.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'The web page URL to scrape' },
                    js: {
                      type: 'string',
                      enum: ['auto', 'true', 'false'],
                      description: 'Whether to execute JavaScript with headless browser',
                    },
                    provider: {
                      type: 'string',
                      enum: ['local', 'auto', 'firecrawl'],
                      description: 'Execution provider: local engine, auto fallback, or Firecrawl',
                    },
                  },
                  required: ['url'],
                },
              },
              {
                name: 'smartcrawl_crawl',
                description: 'Recursively discover and crawl multiple pages on the same domain.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'Starting URL to crawl' },
                    limit: { type: 'number', description: 'Maximum number of pages to crawl (default 5, max 50)' },
                  },
                  required: ['url'],
                },
              },
              {
                name: 'smartcrawl_map',
                description: 'Quickly map out all same-origin links and sitemap URLs for a given website.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'Website URL to map' },
                    limit: { type: 'number', description: 'Maximum number of URLs to discover' },
                  },
                  required: ['url'],
                },
              },
            ],
          });
          break;
        }

        case 'tools/call': {
          const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const name = params.name;
          const args = params.arguments ?? {};

          if (name === 'smartcrawl_scrape') {
            const url = String(args.url || '');
            if (!url) {
              sendError(id, -32602, 'Missing required argument: url');
              return;
            }
            const jsArg = args.js === 'true' ? true : args.js === 'false' ? false : 'auto';
            const providerArg = args.provider === 'firecrawl' || args.provider === 'auto' ? args.provider : 'local';
            const result = await client.scrape(url, { js: jsArg, provider: providerArg });
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: result.markdown || result.html || JSON.stringify(result, null, 2),
                },
              ],
            });
          } else if (name === 'smartcrawl_crawl') {
            const url = String(args.url || '');
            if (!url) {
              sendError(id, -32602, 'Missing required argument: url');
              return;
            }
            const limit = typeof args.limit === 'number' ? args.limit : 5;
            const result = await client.crawl(url, { limit });
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            });
          } else if (name === 'smartcrawl_map') {
            const url = String(args.url || '');
            if (!url) {
              sendError(id, -32602, 'Missing required argument: url');
              return;
            }
            const limit = typeof args.limit === 'number' ? args.limit : 50;
            const result = await client.map(url, { limit });
            sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            });
          } else {
            sendError(id, -32601, `Unknown tool: ${name}`);
          }
          break;
        }

        default: {
          if (id !== null) {
            sendError(id, -32601, `Method not found: ${req.method}`);
          }
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(id, -32603, message);
    }
  });
}

function sendResponse(id: string | number | null, result: unknown): void {
  const payload: McpResponse = {
    jsonrpc: '2.0',
    id,
    result,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendError(id: string | number | null, code: number, message: string): void {
  const payload: McpResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
