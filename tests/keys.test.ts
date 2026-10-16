import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';

describe('KeyStore', () => {
  const stores: JobStore[] = [];
  afterEach(() => {
    while (stores.length) stores.pop()?.close();
  });

  function keys(): KeyStore {
    const jobs = new JobStore(':memory:');
    stores.push(jobs);
    return new KeyStore(jobs.db);
  }

  it('issues a key once and looks it up by the raw secret', () => {
    const store = keys();
    const issued = store.createKey('alice', 20);
    expect(issued.key.startsWith('sc_live_')).toBe(true);
    expect(issued.prefix).toBe(issued.key.slice(0, 12));
    expect(issued.name).toBe('alice');
    expect(issued.dailyLimit).toBe(20);

    const found = store.authenticate(issued.key);
    expect(found?.id).toBe(issued.id);
    expect(store.authenticate('sc_live_nope')).toBeNull();
  });

  it('does not store the raw key', () => {
    const store = keys();
    const issued = store.createKey('bob');
    expect(JSON.stringify(store.listKeys())).not.toContain(issued.key.slice(12));
  });

  it('consumes quota and rejects when the daily limit is hit', () => {
    const store = keys();
    const issued = store.createKey('limited', 2);
    const day = '2026-10-16';
    expect(store.consume(issued.id, day).ok).toBe(true);
    expect(store.consume(issued.id, day).remaining).toBe(0);
    const blocked = store.consume(issued.id, day);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('resets usage on a new UTC day', () => {
    const store = keys();
    const issued = store.createKey('daily', 1);
    expect(store.consume(issued.id, '2026-10-16').ok).toBe(true);
    expect(store.consume(issued.id, '2026-10-16').ok).toBe(false);
    expect(store.consume(issued.id, '2026-10-17').ok).toBe(true);
  });

  it('revokes a key so authenticate fails', () => {
    const store = keys();
    const issued = store.createKey('gone');
    store.revoke(issued.id);
    expect(store.authenticate(issued.key)).toBeNull();
  });
});
