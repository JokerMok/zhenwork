#!/usr/bin/env python3
"""Owned, disposable build inputs; durable artifacts contain no source/targets."""
import argparse
import datetime as dt
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write(path, value):
    temporary = path.with_suffix('.writing')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def paths(repo, sha, kind):
    if kind == 'full':
        return []
    app = 'AionUi-enterprise-poc'
    selected = ['VERSION', 'deploy/tencent']
    if kind == 'host':
        selected += [f'{app}/{p}' for p in ('packages', 'package.json', 'bun.lock', 'tsconfig.json')]
    else:
        # Freeze the Web component, never Rust trees, previous outputs or the backend.
        entries = subprocess.check_output(
            ['git', '-C', str(repo), 'ls-tree', '-z', '--name-only', f'{sha}:{app}'])
        excluded = {'upstream-core', 'upstream-aionrs', 'out', 'node_modules',
                    'tests', 'docs', '.github', 'mobile', 'homebrew', 'examples'}
        selected += [f'{app}/{p.decode()}' for p in entries.split(b'\0') if p and p.decode() not in excluded]
        if kind == 'web':
            selected.append('deepseek-harness-lab/workbuddy/platform/plus-ui')
    return selected


def begin(repo, artifact_root, temporary_root, release, sha, kind, pid, max_pending):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}', release):
        raise ValueError('Invalid release ID')
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Expected an immutable source SHA')
    artifact_root.mkdir(parents=True, exist_ok=True)
    if artifact_root.is_symlink() or temporary_root.is_symlink():
        raise ValueError('Build roots must not be symlinks')
    lock = artifact_root / '.build-admission.lock'
    if lock.is_symlink():
        raise ValueError('Refusing symlink admission lock')
    with lock.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return admit(repo, artifact_root, temporary_root, release, sha, kind, pid, max_pending)


def admit(repo, artifact_root, temporary_root, release, sha, kind, pid, max_pending):
    pending = 0
    for p in artifact_root.glob('*/BUILD.json'):
        try:
            pending += json.loads(p.read_text()).get('status') in ('building', 'candidate', 'cleanup-failed')
        except (ValueError, OSError):
            raise ValueError(f'Invalid build record: {p}')
    if max_pending < 1 or pending >= max_pending:
        raise ValueError('Pending candidate limit reached; review existing candidates before building more')
    record = artifact_root / release
    record.mkdir(mode=0o700)  # Never overwrite an earlier candidate, even after failure.
    temporary_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    work = Path(tempfile.mkdtemp(prefix='zw-build-', dir=temporary_root))
    marker = {'repo': str(repo.resolve()), 'record': str(record.resolve()),
              'tempRoot': str(temporary_root.resolve()), 'pid': pid,
              'release': release, 'sourceSha': sha, 'kind': kind, 'startedAt': now()}
    write(work / 'OWNER.json', marker)
    write(record / 'BUILD.json', {**marker, 'status': 'building'})
    (work / 'source').mkdir()
    (work / 'stage').mkdir()
    return work


def owned(work):
    if work.is_symlink():
        raise ValueError('Refusing symlink workspace')
    marker = json.loads((work / 'OWNER.json').read_text())
    if work.resolve().parent != Path(marker['tempRoot']) or not work.name.startswith('zw-build-'):
        raise ValueError('Workspace ownership mismatch')
    record = Path(marker['record'])
    if record.is_symlink() or json.loads((record / 'BUILD.json').read_text())['sourceSha'] != marker['sourceSha']:
        raise ValueError('Build record mismatch')
    return marker, record


def extract(work):
    marker, record = owned(work)
    selected = paths(Path(marker['repo']), marker['sourceSha'], marker['kind'])
    command = ['git', '-C', marker['repo'], 'archive', '--format=tar', marker['sourceSha']]
    if selected:
        command += ['--', *selected]
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            archive.extractall(work / 'source', filter='data')
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()
    if process.wait() != 0:
        raise RuntimeError('Frozen source extraction failed')
    meta = json.loads((record / 'BUILD.json').read_text())
    meta['inputPaths'] = selected or ['complete committed tree (full build only)']
    write(record / 'BUILD.json', meta)


def complete(work):
    marker, record = owned(work)
    source = work / 'stage'
    files = {}
    for p in sorted(source.rglob('*')):
        if p.is_symlink():
            raise ValueError(f'Artifact contains a symlink: {p}')
        if p.is_file():
            files[str(p.relative_to(source))] = hashlib.sha256(p.read_bytes()).hexdigest()
    if not files:
        raise ValueError('No final artifacts produced')
    shutil.move(str(source), str(record / 'artifacts'))
    meta = json.loads((record / 'BUILD.json').read_text())
    meta.update(status='candidate', finishedAt=now(), artifactSha256=files)
    version = work / 'source/VERSION'
    if version.is_file():
        meta['appVersion'] = version.read_text().strip()
    write(record / 'BUILD.json', meta)


def close(work, exit_code):
    _, record = owned(work)
    meta = json.loads((record / 'BUILD.json').read_text())
    if meta['status'] == 'building':
        meta.update(status='failed', exitCode=exit_code, finishedAt=now())
    try:
        shutil.rmtree(work)
    except OSError as error:
        meta.update(statusBeforeCleanup=meta.get('statusBeforeCleanup', meta['status']),
                    status='cleanup-failed', cleanupError=str(error), cleanupPath=str(work))
        write(record / 'BUILD.json', meta)
        raise
    meta['temporaryInputsRemoved'] = True
    if meta['status'] == 'cleanup-failed':
        meta['status'] = meta.pop('statusBeforeCleanup')
        meta.pop('cleanupError', None)
        meta.pop('cleanupPath', None)
    write(record / 'BUILD.json', meta)


def accept(record, receipt):
    if record.is_symlink():
        raise ValueError('Refusing symlink record')
    meta = json.loads((record / 'BUILD.json').read_text())
    proof = json.loads(receipt.read_text())
    if meta['status'] != 'candidate' or proof.get('sourceSha') != meta['sourceSha'] or not (
            proof.get('status') == 'PASS' or proof.get('verdict') == 'GO' or proof.get('verified') is True):
        raise ValueError('Matching explicit successful acceptance receipt required')
    if not meta.get('temporaryInputsRemoved'):
        raise ValueError('Temporary cleanup must finish before acceptance')
    meta.update(status='verified', verifiedAt=now(), receiptSha256=hashlib.sha256(receipt.read_bytes()).hexdigest())
    write(record / 'BUILD.json', meta)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['begin', 'extract', 'complete', 'close', 'accept'])
    parser.add_argument('--work', type=Path)
    parser.add_argument('--repo', type=Path)
    parser.add_argument('--artifacts', type=Path)
    parser.add_argument('--temporary', type=Path)
    parser.add_argument('--release')
    parser.add_argument('--sha')
    parser.add_argument('--kind', choices=['full', 'host', 'web', 'employee'])
    parser.add_argument('--pid', type=int, default=os.getppid())
    parser.add_argument('--max-pending', type=int, default=10)
    parser.add_argument('--exit-code', type=int, default=1)
    parser.add_argument('--record', type=Path)
    parser.add_argument('--receipt', type=Path)
    a = parser.parse_args()
    if a.command == 'begin':
        print(begin(a.repo, a.artifacts, a.temporary, a.release, a.sha, a.kind, a.pid, a.max_pending))
    elif a.command == 'extract':
        extract(a.work)
    elif a.command == 'complete':
        complete(a.work)
    elif a.command == 'close':
        close(a.work, a.exit_code)
    else:
        accept(a.record, a.receipt)


if __name__ == '__main__':
    main()
