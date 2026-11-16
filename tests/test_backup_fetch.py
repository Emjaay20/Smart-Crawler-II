import datetime
from contextlib import closing
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/fetch-backup.py'))


class BackupFetchTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source.sqlite'
        with closing(sqlite3.connect(self.source)) as database, database:
            database.execute('CREATE TABLE jobs (id TEXT)')
            database.execute("INSERT INTO jobs VALUES ('fixture-job')")
        self.manifest = {
            'version': 1, 'file': 'jobs.sqlite', 'integrityCheck': 'ok', 'restoreCheck': 'ok',
            'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest(),
            'bytes': self.source.stat().st_size, 'jobCount': 1,
            'snapshotDirectory': '/var/backups/smartcrawl/run-20261116T010643Z-iJ1jELrJ/smartcrawl-KJaOZUVr',
        }

    def tearDown(self):
        self.temporary.cleanup()

    def transfer(self, command, **kwargs):
        if command[0] == 'ssh':
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(self.manifest))
        shutil.copyfile(self.source, command[-1])
        return subprocess.CompletedProcess(command, 0)

    def test_download_checksum_and_clean_restore_without_exposing_rows(self):
        with patch('subprocess.run', side_effect=self.transfer):
            saved = MODULE['fetch_latest']('root@backup.example', self.root / 'destination')
        self.assertEqual(json.loads((saved / 'manifest.json').read_text())['restoreCheck'], 'ok')
        self.assertEqual((saved / 'jobs.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('fixture-job', (saved / 'source-manifest.json').read_text())

    def test_path_traversal_is_rejected_before_transfer(self):
        self.manifest['snapshotDirectory'] = '/var/backups/smartcrawl/../../etc'
        with patch('subprocess.run', side_effect=self.transfer) as transfer:
            with self.assertRaisesRegex(ValueError, 'snapshot path'):
                MODULE['fetch_latest']('root@backup.example', self.root / 'destination')
        self.assertEqual(transfer.call_count, 1)

    def test_checksum_mismatch_never_creates_verified_manifest(self):
        self.manifest['sha256'] = '0' * 64
        with patch('subprocess.run', side_effect=self.transfer):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                MODULE['fetch_latest']('root@backup.example', self.root / 'destination')
        self.assertEqual(list((self.root / 'destination').glob('*/manifest.json')), [])

    def test_stale_snapshot_requires_explicit_recovery_option(self):
        self.manifest['verifiedAt'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=3)).isoformat()
        with self.assertRaisesRegex(ValueError, 'older than'):
            MODULE['validate_manifest'](self.manifest)
        self.assertEqual(MODULE['validate_manifest'](self.manifest, True), self.manifest['snapshotDirectory'])
