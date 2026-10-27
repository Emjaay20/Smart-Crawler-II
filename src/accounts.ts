import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface AccountIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
}

export interface Account {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  plan: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoginAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

/**
 * Stores SmartCrawl product accounts separately from the external identity
 * provider. The OIDC issuer + subject pair is the stable identity key; email
 * is display data and must not be used to merge accounts.
 */
export class AccountStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        name TEXT,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS oidc_login_attempts (
        state_hash TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  upsertUser(identity: AccountIdentity): Account {
    const issuer = identity.issuer.trim().replace(/\/$/, '');
    const subject = identity.subject.trim();
    if (!issuer || !subject) throw new Error('OIDC identity is missing issuer or subject');

    const now = Date.now();
    const existing = this.db.prepare('SELECT id FROM users WHERE issuer = ? AND subject = ?').get(issuer, subject) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE users
        SET email = COALESCE(?, email), name = COALESCE(?, name), updated_at = ?
        WHERE id = ?
      `).run(cleanText(identity.email), cleanText(identity.name), now, existing.id);
      return this.getUser(existing.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, issuer, subject, email, name, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'free', ?, ?)
    `).run(id, issuer, subject, cleanText(identity.email), cleanText(identity.name), now, now);
    return this.getUser(id)!;
  }

  getUser(id: string): Account | null {
    const row = this.db.prepare(`
      SELECT id, issuer, subject, email, name, plan, created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id) as Account | undefined;
    return row ?? null;
  }

  createSession(userId: string, ttlMs = SESSION_TTL_MS): string {
    const token = `scs_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).run(hash(token), userId, now + ttlMs, now);
    return token;
  }

  getSessionUser(token: string | undefined): Account | null {
    if (!token) return null;
    const now = Date.now();
    this.db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
    const row = this.db.prepare(`
      SELECT u.id, u.issuer, u.subject, u.email, u.name, u.plan, u.created_at AS createdAt, u.updated_at AS updatedAt
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hash(token), now) as Account | undefined;
    return row ?? null;
  }

  revokeSession(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hash(token));
  }

  createLoginAttempt(): LoginAttempt {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const now = Date.now();
    this.db.prepare('DELETE FROM oidc_login_attempts WHERE expires_at <= ?').run(now);
    this.db.prepare(`
      INSERT INTO oidc_login_attempts (state_hash, nonce, code_verifier, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash(state), nonce, codeVerifier, now + LOGIN_TTL_MS, now);
    return { state, nonce, codeVerifier };
  }

  consumeLoginAttempt(state: string | undefined): Omit<LoginAttempt, 'state'> | null {
    if (!state) return null;
    const now = Date.now();
    const stateHash = hash(state);
    const row = this.db.prepare(`
      SELECT nonce, code_verifier AS codeVerifier, expires_at AS expiresAt
      FROM oidc_login_attempts WHERE state_hash = ?
    `).get(stateHash) as { nonce: string; codeVerifier: string; expiresAt: number } | undefined;
    this.db.prepare('DELETE FROM oidc_login_attempts WHERE state_hash = ?').run(stateHash);
    if (!row || row.expiresAt <= now) return null;
    return { nonce: row.nonce, codeVerifier: row.codeVerifier };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text.slice(0, 320) : null;
}
