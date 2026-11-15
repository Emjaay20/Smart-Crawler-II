import { backupJobDatabase } from '../src/backup.js';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: npm run db:backup -- SOURCE.sqlite NEW_BACKUP.sqlite');
  process.exitCode = 1;
} else {
  backupJobDatabase(source, destination);
  console.log('Created and integrity-checked database snapshot. Keep it private.');
}
