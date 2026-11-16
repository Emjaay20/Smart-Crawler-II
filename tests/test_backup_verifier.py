import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

VERIFIER = Path(__file__).resolve().parents[1] / 'scripts' / 'verify-backup.py'


class BackupVerifierTest(unittest.TestCase):
    def test_verified_restore_writes_private_manifest_without_row_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / 'jobs.sqlite'
            with closing(sqlite3.connect(snapshot)) as database, database:
                database.execute('CREATE TABLE jobs (id TEXT, data TEXT)')
                database.execute('INSERT INTO jobs VALUES (?, ?)', ('job-1', 'private-content'))
            subprocess.run(['python3', str(VERIFIER), directory], check=True, capture_output=True)
            manifest = json.loads((root / 'manifest.json').read_text())
            self.assertEqual(manifest['jobCount'], 1)
            self.assertEqual(manifest['sha256'], hashlib.sha256(snapshot.read_bytes()).hexdigest())
            self.assertEqual(manifest['restoreCheck'], 'ok')
            self.assertNotIn('private-content', json.dumps(manifest))
            self.assertEqual((root / 'manifest.json').stat().st_mode & 0o777, 0o600)

    def test_corruption_does_not_publish_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'jobs.sqlite').write_bytes(b'not a SQLite database')
            result = subprocess.run(['python3', str(VERIFIER), directory], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'manifest.json').exists())
