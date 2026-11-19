import { describe, expect, it, vi } from 'vitest';
import { runMcpServer } from '../src/mcp.js';
import { Readable, Writable } from 'node:stream';

describe('SmartCrawl MCP Server', () => {
  it('handles initialize, tools/list, and tools/call over stdio protocol', async () => {
    const inputLines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'smartcrawl_scrape',
          arguments: { url: 'https://example.com' },
        },
      }),
    ];

    const responses: any[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const lines = String(chunk).trim().split('\n');
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
      return true;
    });

    // Mock fetch so tools/call executes deterministically without hitting external network
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      jobId: 'mcp-test-job',
      status: 'completed',
      data: { markdown: '# Hello from SmartCrawl MCP' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      // Simulate input lines by writing directly to standard input or mocking readline
      const stdinMock = new Readable({
        read() {
          for (const line of inputLines) {
            this.push(line + '\n');
          }
          this.push(null);
        },
      });

      const stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdinMock as any);

      await runMcpServer({ baseUrl: 'http://127.0.0.1:3000' });

      // Allow event loop to process lines
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(responses.length).toBeGreaterThanOrEqual(3);

      // 1. Initialize
      expect(responses[0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'smartcrawl-mcp', version: '1.0.0' },
        },
      });

      // 2. Tools list
      expect(responses[1].id).toBe(2);
      expect(responses[1].result.tools.map((t: any) => t.name)).toContain('smartcrawl_scrape');
      expect(responses[1].result.tools.map((t: any) => t.name)).toContain('smartcrawl_crawl');
      expect(responses[1].result.tools.map((t: any) => t.name)).toContain('smartcrawl_map');

      // 3. Tools call
      expect(responses[2].id).toBe(3);
      expect(responses[2].result.content[0].text).toContain('# Hello from SmartCrawl MCP');

      stdinSpy.mockRestore();
    } finally {
      writeSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
