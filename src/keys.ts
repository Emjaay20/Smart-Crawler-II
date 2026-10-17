import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface IssuedKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
  dailyLimit: number;
}

export interface PublicKey {
  id: string;
  name: string;
  prefix: string;
  dailyLimit: number;
  usedToday: number;
  revoked: boolean;
  createdAt: number;
}

export interface AuthKey {
  id: string;
  name: string;
  prefix: string;
  dailyLimit: number;
}

export interface KeyUsage extends AuthKey {
  usedToday: number;
  remaining: number;
}

const DEFAULT_DAILY_LIMIT = 50;

export class KeyStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        daily_limit INTEGER NOT NULL,
        used_today INTEGER NOT NULL DEFAULT 0,
        used_on TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
  }

  createKey(name: string, dailyLimit = DEFAULT_DAILY_LIMIT): IssuedKey {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const key = `sc_live_${secret}`;
    const prefix = key.slice(0, 12);
    const hash = hashKey(key);
    const limit = Math.max(1, Math.floor(dailyLimit));
    this.db.prepare(`
      INSERT INTO api_keys (id, name, prefix, hash, daily_limit, used_today, used_on, revoked, created_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, 0, ?)
    `).run(id, name.trim() || 'unnamed', prefix, hash, limit, Date.now());
    return { id, name: name.trim() || 'unnamed', key, prefix, dailyLimit: limit };
  }

  authenticate(rawKey: string): AuthKey | null {
    const hash = hashKey(rawKey.trim());
    const row = this.db.prepare(`
      SELECT id, name, prefix, daily_limit AS dailyLimit, revoked
      FROM api_keys WHERE hash = ?
    `).get(hash) as { id: string; name: string; prefix: string; dailyLimit: number; revoked: number } | undefined;
    if (!row || row.revoked) return null;
    return { id: row.id, name: row.name, prefix: row.prefix, dailyLimit: row.dailyLimit };
  }

  getUsage(id: string, day = utcDay(new Date())): KeyUsage | null {
    const row = this.db.prepare(`
      SELECT id, name, prefix, daily_limit AS dailyLimit, used_today AS usedToday, used_on AS usedOn, revoked
      FROM api_keys WHERE id = ?
    `).get(id) as {
      id: string;
      name: string;
      prefix: string;
      dailyLimit: number;
      usedToday: number;
      usedOn: string | null;
      revoked: number;
    } | undefined;
    if (!row || row.revoked) return null;
    const usedToday = row.usedOn === day ? row.usedToday : 0;
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      dailyLimit: row.dailyLimit,
      usedToday,
      remaining: Math.max(0, row.dailyLimit - usedToday),
    };
  }

  consume(id: string, day: string): { ok: boolean; remaining: number } {
    const row = this.db.prepare(`
      SELECT daily_limit AS dailyLimit, used_today AS usedToday, used_on AS usedOn, revoked
      FROM api_keys WHERE id = ?
    `).get(id) as { dailyLimit: number; usedToday: number; usedOn: string | null; revoked: number } | undefined;
    if (!row || row.revoked) return { ok: false, remaining: 0 };

    const usedToday = row.usedOn === day ? row.usedToday : 0;
    if (usedToday >= row.dailyLimit) {
      return { ok: false, remaining: 0 };
    }
    const next = usedToday + 1;
    this.db.prepare(`
      UPDATE api_keys SET used_today = ?, used_on = ? WHERE id = ?
    `).run(next, day, id);
    return { ok: true, remaining: row.dailyLimit - next };
  }

  revoke(id: string): boolean {
    const res = this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  listKeys(): PublicKey[] {
    const rows = this.db.prepare(`
      SELECT id, name, prefix, daily_limit AS dailyLimit, used_today AS usedToday,
             used_on AS usedOn, revoked, created_at AS createdAt
      FROM api_keys ORDER BY created_at DESC
    `).all() as Array<{
      id: string;
      name: string;
      prefix: string;
      dailyLimit: number;
      usedToday: number;
      usedOn: string | null;
      revoked: number;
      createdAt: number;
    }>;
    const today = utcDay(new Date());
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      dailyLimit: row.dailyLimit,
      usedToday: row.usedOn === today ? row.usedToday : 0,
      revoked: Boolean(row.revoked),
      createdAt: row.createdAt,
    }));
  }
}

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function safeEqualToken(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
