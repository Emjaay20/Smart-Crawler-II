import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/** SQLite creates a consistent standalone snapshot, including committed WAL data.
 * The destination must not already contain a database; never overwrite a backup.
 */
export function backupJobDatabase(source: string, destination: string): void {
  if (resolve(source) === resolve(destination)) throw new Error('Backup must use a different path');
  const database = new DatabaseSync(source, { readOnly: true });
  let reserved = false;
  try {
    closeSync(openSync(destination, 'wx', 0o600));
    reserved = true;
    database.exec('PRAGMA busy_timeout = 5000');
    database.prepare('VACUUM INTO ?').run(destination);
  } catch (error) {
    if (reserved) unlinkSync(destination);
    throw error;
  } finally {
    database.close();
  }
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = snapshot.prepare('PRAGMA integrity_check').get();
    if (result?.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
  } finally {
    snapshot.close();
  }
}
