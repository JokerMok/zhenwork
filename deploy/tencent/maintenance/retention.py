#!/usr/bin/env python3
"""Plan retention without mutation; apply only the exact reviewed, unchanged plan."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil

ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}')


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def load(path):
    if path.is_symlink():
        raise ValueError(f'Symlink metadata is not trusted: {path}')
    return json.loads(path.read_text()) if path.is_file() else None


def pointer(path, root):
    if not path.exists() and not path.is_symlink():
        return None
    if not path.is_symlink():
        raise ValueError(f'Expected a release pointer: {path}')
    target = path.resolve(strict=True)
    if target.parent != root or target.is_symlink():
        raise ValueError(f'Release pointer escapes root: {path}')
    return target.name


def scan(root, policy, layout):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Release root must be an existing, non-symlink directory')
    root = root.resolve()
    keep, days = policy['keepVerified'], policy['maxAgeDays']
    if type(keep) is not int or keep < 1 or type(days) is not int or days < 1:
        raise ValueError('Retention count and age must be positive integers')
    pinned = set(policy.get('protectedReleases', []))
    if any(not ID.fullmatch(p) for p in pinned):
        raise ValueError('Invalid protected release ID')
    pointers = {}
    if layout == 'server':
        for name in ('current', 'previous'):
            value = pointer(root.parent / name, root)
            if name == 'current' and not value:
                raise ValueError('Server retention requires a valid current pointer')
            pointers[name] = value
            if value:
                pinned.add(value)
    protected_versions = policy.get('protectedAppVersions', [])
    approvals = policy.get('verifiedReleases', {})
    entries = []
    for path in sorted(root.iterdir()):
        if not path.is_dir() or path.is_symlink() or not ID.fullmatch(path.name):
            continue
        reason, meta, verified = None, None, None
        metadata_name = 'BUILD.json' if layout == 'local' else 'RELEASE.json'
        source_name = 'SOURCE_SHA'
        if layout == 'legacy':
            candidates = [prefix for prefix in ('release', 'stage') if (path / prefix / 'IMAGE_IDS.json').is_file()]
            if len(candidates) == 1:
                metadata_name = candidates[0] + '/IMAGE_IDS.json'
                source_name = candidates[0] + '/SOURCE_SHA'
            else:
                reason = 'ambiguous-legacy-layout'
        try:
            meta = load(path / metadata_name)
            verified = load(path / 'VERIFIED.json')
            if layout == 'legacy' and isinstance(meta, dict):
                receipt = path / source_name
                if receipt.is_file() and not receipt.is_symlink():
                    received = receipt.read_text().strip()
                    if meta.get('sourceSha') and meta['sourceSha'] != received:
                        reason = 'conflicting-source-receipt'
                    else:
                        meta = {**meta, 'sourceSha': received}
        except (OSError, ValueError):
            reason = 'unreadable-or-invalid-metadata'
        sha = meta.get('sourceSha') if isinstance(meta, dict) else None
        if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha):
            reason = reason or 'unknown-source'
        elif path.name in pinned:
            reason = 'current-previous-or-pinned'
        elif meta.get('formal') or meta.get('appVersion') == '1.0.0-rc.1' or meta.get('appVersion') in protected_versions:
            reason = 'formal-version'
        elif meta.get('status') in ('building', 'candidate', 'cleanup-failed'):
            reason = 'pending-candidate'
        else:
            # Legacy receipts with unknown schemas remain protected until reviewed.
            passed = isinstance(verified, dict) and verified.get('sourceSha') == sha and (
                verified.get('status') == 'PASS' or verified.get('verdict') == 'GO' or verified.get('verified') is True)
            accepted = (layout == 'local' and meta.get('status') == 'verified') or passed
            accepted = accepted or approvals.get(path.name) == sha
            if not accepted:
                reason = reason or 'candidate-or-unreviewed'
        source_file = path / source_name
        if source_file.is_symlink() or (source_file.is_file() and source_file.read_text().strip() != sha):
            reason = 'conflicting-source-receipt'
        if isinstance(meta, dict) and meta.get('release', path.name) != path.name:
            reason = 'conflicting-release-id'
        stamps = {}
        for name in dict.fromkeys(('BUILD.json', 'RELEASE.json', 'VERIFIED.json', 'SHA256SUMS', 'SOURCE_SHA', metadata_name, source_name)):
            p = path / name
            if p.is_file() and not p.is_symlink():
                stamps[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        mtime = path / ('VERIFIED.json' if verified else metadata_name)
        when = mtime.stat().st_mtime if mtime.is_file() else path.stat().st_mtime
        entries.append({'release': path.name, 'sourceSha': sha, 'protectedReason': reason,
                        'time': when, 'inode': path.stat().st_ino, 'metadata': stamps,
                        'verified': verified, 'releaseMetadata': meta})
    # Only an unaccepted delta candidate needs its direct base. Provenance on a
    # fully assembled current release is not a runtime dependency; following
    # every historical baseRelease would accidentally pin all past versions.
    for e in entries:
        if e['protectedReason'] not in ('pending-candidate', 'candidate-or-unreviewed'):
            continue
        m = e['releaseMetadata'] or {}
        reused = m.get('artifactReusedFrom') or {}
        for dependency in (m.get('baseRelease'), reused.get('release')):
            for other in entries:
                if other['release'] == dependency and not other['protectedReason']:
                    other['protectedReason'] = 'base-of-pending-candidate'
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    eligible = sorted([e for e in entries if not e['protectedReason']], key=lambda e: (-e['time'], e['release']))
    ranks = {e['release']: n for n, e in enumerate(eligible)}
    for e in entries:
        expired = now - e['time'] >= days * 86400
        e['action'] = 'delete' if not e['protectedReason'] and (ranks[e['release']] >= keep or expired) else 'keep'
        e['reason'] = e['protectedReason'] or ('retention-expired' if e['action'] == 'delete' else 'within-retention')
        del e['releaseMetadata'], e['verified']
    # Time only determines an already-verified release's retention, never its safety.
    result = {'root': str(root), 'layout': layout, 'policy': policy, 'pointers': pointers, 'entries': entries}
    result['fingerprint'] = digest(result)
    return result


def apply(plan, approved_fingerprint):
    if plan['fingerprint'] != approved_fingerprint or digest({k: v for k, v in plan.items() if k != 'fingerprint'}) != approved_fingerprint:
        raise ValueError('Explicit reviewed fingerprint required')
    root = Path(plan['root'])
    if plan['layout'] == 'server':
        for name in ('activate.sh', 'build-linux.sh'):
            script = root.parent / 'deploy' / name
            if not script.is_file() or script.is_symlink() or '.release-operation.lock' not in script.read_text():
                raise ValueError('Install the cooperating activation/staging locks before server retention apply')
    # Fail closed on any changed pointer, policy, metadata or directory identity.
    fresh = scan(root, plan['policy'], plan['layout'])
    if fresh['fingerprint'] != plan['fingerprint']:
        raise ValueError('Release state changed; generate and review a new plan')
    lock_path = (root.parent if plan['layout'] == 'server' else root) / '.release-operation.lock'
    if lock_path.is_symlink():
        raise ValueError('Refusing symlink operation lock')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if scan(root, plan['policy'], plan['layout'])['fingerprint'] != plan['fingerprint']:
            raise ValueError('Release state changed while acquiring retention lock')
        removed = []
        try:
            for e in plan['entries']:
                if e['action'] != 'delete':
                    continue
                path = root / e['release']
                if path.is_symlink() or path.parent.resolve() != root.resolve() or path.stat().st_ino != e['inode']:
                    raise ValueError('Release directory identity changed')
                if plan['layout'] == 'server':
                    for name, value in plan['pointers'].items():
                        if pointer(root.parent / name, root.resolve()) != value:
                            raise ValueError('Runtime pointer changed; stopping retention')
                shutil.rmtree(path)
                removed.append(e['release'])
        except BaseException as error:
            audit(root, plan, removed, str(error))
            raise
        audit(root, plan, removed, None)
        return removed


def audit(root, plan, removed, error):
    path = root / '.retention-history.jsonl'
    if path.is_symlink():
        raise ValueError('Refusing symlink audit log')
    # Keep a bounded journal, never one new backup/log per run.
    existing = path.read_text().splitlines()[-99:] if path.exists() else []
    record = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'fingerprint': plan['fingerprint'],
              'removed': removed, 'error': error}
    path.write_text('\n'.join([*existing, json.dumps(record)]) + '\n')
    path.chmod(0o600)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['plan', 'apply'])
    p.add_argument('--root', type=Path)
    p.add_argument('--layout', choices=['local', 'legacy', 'server'], default='server')
    p.add_argument('--policy', type=Path)
    p.add_argument('--plan', type=Path)
    p.add_argument('--approved-fingerprint')
    a = p.parse_args()
    if a.command == 'plan':
        print(json.dumps(scan(a.root, json.loads(a.policy.read_text()), a.layout), indent=2))
    else:
        print(json.dumps({'removed': apply(json.loads(a.plan.read_text()), a.approved_fingerprint)}))


if __name__ == '__main__':
    main()
