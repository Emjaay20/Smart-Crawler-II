import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs.js';
import { KeyStore } from '../src/keys.js';

describe('opaque guest sessions', () => {
  it('persists only a token hash and supports server restart and expiry', () => {
    const store = new JobStore(':memory:');
    const keys = new KeyStore(store.db);
    const now = 1_800_000_000_000;
    const guest = keys.createGuestSession(now);
    expect(guest.token).toMatch(/^sc_guest_[A-Za-z0-9_-]{43}$/);
    expect(guest.id).toMatch(/^[a-f0-9]{64}$/);
    expect(guest.token).not.toBe(guest.id);
    expect(keys.authenticateGuestSession(guest.token, now + 1000)?.id).toBe(guest.id);
    expect(keys.authenticateGuestSession('sc_guest_invalid', now)).toBeNull();
    expect(keys.authenticateGuestSession(guest.token + 'x', now)).toBeNull();
    expect(keys.authenticateGuestSession(guest.token, guest.expiresAt)).toBeNull();
    const raw = store.db.prepare('SELECT * FROM guest_sessions WHERE id = ?')
      .get(guest.id) as Record<string, unknown>;
    expect(JSON.stringify(raw)).not.toContain(guest.token);
    store.close();
  });

  it('atomically consumes a per-address allowance without resetting it through session changes', () => {
    const store = new JobStore(':memory:');
    const keys = new KeyStore(store.db);
    const ip = '203.0.113.20';
    const day = '2026-11-14';
    const firstSession = keys.createGuestSession();
    const secondSession = keys.createGuestSession();
    expect(firstSession.id).not.toEqual(secondSession.id);
    expect(keys.consumeGuest(ip, day, 2)).toMatchObject({ ok: true, used: 1, remaining: 1 });
    expect(keys.consumeGuest(ip, day, 2)).toMatchObject({ ok: true, used: 2, remaining: 0 });
    expect(keys.consumeGuest(ip, day, 2)).toMatchObject({ ok: false, used: 2, remaining: 0 });
    store.close();
  });
});
