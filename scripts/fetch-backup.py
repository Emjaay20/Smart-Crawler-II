#!/usr/bin/env python3
"""Pull one verified server snapshot over SSH without copying credentials."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
REMOTE_ROOT = '/var/backups/smartcrawl'


def validate_manifest(manifest, allow_stale=False):
    if not isinstance(manifest, dict):
        raise ValueError('Backup manifest must be an object')
    directory = manifest.get('snapshotDirectory', '')
    if not isinstance(directory, str) or not re.fullmatch(
        REMOTE_ROOT + r'/run-\d{8}T\d{6}Z-[A-Za-z0-9]{8}/smartcrawl-[A-Za-z0-9]{8}', directory
    ):
        raise ValueError('Unexpected server snapshot path; refusing the transfer')
    if manifest.get('version') != 1 or manifest.get('file') != 'jobs.sqlite':
        raise ValueError('Unsupported backup manifest')
    if manifest.get('integrityCheck') != 'ok' or manifest.get('restoreCheck') != 'ok':
        raise ValueError('The server has not verified this snapshot')
    if not isinstance(manifest.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', manifest['sha256']):
        raise ValueError('Invalid snapshot checksum')
    size = manifest.get('bytes')
    if type(size) is not int or size <= 0 or size > 100 * 1024**3:
        raise ValueError('Invalid snapshot size')
    if not isinstance(manifest.get('verifiedAt'), str):
        raise ValueError('Snapshot verification time is missing')
    verified = datetime.datetime.fromisoformat(manifest['verifiedAt'])
    if verified.tzinfo is None:
        raise ValueError('Snapshot verification time must include its timezone')
    age = datetime.datetime.now(datetime.timezone.utc) - verified
    if age.total_seconds() < -300:
        raise ValueError('Snapshot verification time is in the future')
    if age > datetime.timedelta(hours=36) and not allow_stale:
        raise ValueError('Latest backup is older than 36 hours; inspect the server backup job or use --allow-stale for recovery')
    return directory


def fetch_latest(host, destination, allow_stale=False):
    if not re.fullmatch(r'(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*', host):
        raise ValueError('Use an SSH host name or user@host')
    destination = destination.expanduser().resolve()
    if destination.is_relative_to(REPO):
        raise ValueError('Choose a backup destination outside the source repository')
    options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15']
    response = subprocess.run(
        ['ssh', *options, host, 'cat', REMOTE_ROOT + '/latest-success.json'],
        check=True, capture_output=True, text=True, timeout=30,
    )
    manifest = json.loads(response.stdout)
    remote_directory = validate_manifest(manifest, allow_stale)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(destination).free < manifest['bytes'] + 1024**3:
        raise ValueError('At least the snapshot size plus 1 GiB of free local space is required')
    local = Path(tempfile.mkdtemp(prefix='smartcrawl-offserver-', dir=destination))
    subprocess.run(
        ['scp', *options, host + ':' + remote_directory + '/jobs.sqlite', str(local / 'jobs.sqlite')],
        check=True, capture_output=True, timeout=300,
    )
    snapshot = local / 'jobs.sqlite'
    snapshot.chmod(0o600)
    digest = hashlib.sha256()
    with snapshot.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if snapshot.stat().st_size != manifest['bytes'] or digest.hexdigest() != manifest['sha256']:
        raise ValueError('Downloaded snapshot does not match the server checksum; do not restore it')
    source_manifest = local / 'source-manifest.json'
    with open(source_manifest, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
        json.dump(manifest, stream, indent=2)
        stream.write('\n')
    runpy.run_path(str(REPO / 'scripts' / 'verify-backup.py'))['verify'](local)
    return local


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='root@194.163.172.101')
    parser.add_argument('--destination', type=Path, default=Path.home() / '.codex/backups/smartcrawl')
    parser.add_argument('--allow-stale', action='store_true', help='Allow a snapshot older than 36 hours for disaster recovery')
    arguments = parser.parse_args()
    try:
        saved = fetch_latest(arguments.host, arguments.destination, arguments.allow_stale)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Backup transfer did not complete verification: {error}\n')
    print(f'Off-server snapshot verified and saved privately in {saved}')
