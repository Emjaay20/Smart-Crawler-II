import type { DatabaseSync } from 'node:sqlite';

export type AuditAction =
  | 'admin.key.created'
  | 'admin.key.revoked'
  | 'account.key.created'
  | 'account.key.revoked'
  | 'admin.crawl.resumed';

export interface AuditEvent {
  id: number;
  action: AuditAction;
  actorType: 'admin' | 'account';
  actorRef: string | null;
  resourceRef: string;
  createdAt: number;
}

/**
 * Minimal data-sparing audit trail. Deliberately excludes tokens, request
 * bodies, client IPs, user URLs and credentials. Not tamper-evident.
 */
export class AuditStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS audit_events (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,' +
      'actor_type TEXT NOT NULL, actor_ref TEXT, resource_ref TEXT NOT NULL,' +
      'created_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS audit_events_time_idx ON audit_events(created_at DESC, id DESC);'
    );
  }

  record(action: AuditAction, actorType: 'admin' | 'account', resourceRef: string, actorRef?: string): void {
    if (!/^[0-9a-f-]{1,64}$/i.test(resourceRef) ||
        (actorRef !== undefined && !/^[0-9a-f-]{1,64}$/i.test(actorRef))) {
      throw new Error('Audit resources must be opaque identifiers, not user input');
    }
    this.db.prepare(
      'INSERT INTO audit_events (action, actor_type, actor_ref, resource_ref, created_at)' +
      ' VALUES (?, ?, ?, ?, ?)'
    ).run(action, actorType, actorRef ?? null, resourceRef, Date.now());
  }

  list(limit = 50): AuditEvent[] {
    const cap = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    return this.db.prepare(
      'SELECT id, action, actor_type AS actorType, actor_ref AS actorRef,' +
      'resource_ref AS resourceRef, created_at AS createdAt' +
      ' FROM audit_events ORDER BY id DESC LIMIT ?'
    ).all(cap) as unknown as AuditEvent[];
  }
}
