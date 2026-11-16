#!/usr/bin/env python3
"""Verify a standalone snapshot and a clean-directory restore; emit no row data."""
import datetime
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


def inspect_database(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as database:
        if database.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('database integrity check failed')
        return database.execute('SELECT count(*) FROM jobs').fetchone()[0]


def verify(directory):
    snapshot = directory / 'jobs.sqlite'
    jobs = inspect_database(snapshot)
    with tempfile.TemporaryDirectory(prefix='smartcrawl-restore-') as temporary:
        restored = Path(temporary) / 'jobs.sqlite'
        shutil.copyfile(snapshot, restored)
        if inspect_database(restored) != jobs:
            raise ValueError('restored job count differs from the snapshot')
    digest = hashlib.sha256()
    with snapshot.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    manifest = {
        'version': 1,
        'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'file': 'jobs.sqlite',
        'sha256': digest.hexdigest(),
        'bytes': snapshot.stat().st_size,
        'jobCount': jobs,
        'integrityCheck': 'ok',
        'restoreCheck': 'ok',
    }
    descriptor, temporary = tempfile.mkstemp(prefix='.manifest-', dir=directory)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
        os.replace(temporary, directory / 'manifest.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Snapshot integrity and clean-directory restore verified.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: verify-backup.py BACKUP_DIRECTORY')
    verify(Path(sys.argv[1]))
