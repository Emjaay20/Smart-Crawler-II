import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { safeFetch } from '../src/egress.js';

it('rejects a private DNS answer before a real socket can reach the fixture', async () => {
  let connections = 0;
  const server = createServer((_request, response) => response.end('private fixture'));
  server.on('connection', () => { connections += 1; });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    await expect(safeFetch(`http://egress-fixture.example:${(server.address() as AddressInfo).port}/`, {}, {
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    })).rejects.toThrow('non-public');
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
