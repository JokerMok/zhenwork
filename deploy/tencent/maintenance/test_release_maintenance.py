#!/usr/bin/env python3
"""Scoped lifecycle tests using disposable Git and release trees, no servers."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


w, r = module('workspace'), module('retention')


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='zw-maintenance-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        for name in ['VERSION', 'deploy/tencent/build-web.mjs',
                     'AionUi-enterprise-poc/package.json', 'AionUi-enterprise-poc/bun.lock',
                     'AionUi-enterprise-poc/tsconfig.json', 'AionUi-enterprise-poc/packages/web-host/src/main.ts',
                     'AionUi-enterprise-poc/packages/desktop/src/renderer/main.ts',
                     'AionUi-enterprise-poc/upstream-core/private.rs',
                     'AionUi-enterprise-poc/out/old-bundle.js',
                     'deepseek-harness-lab/workbuddy/platform/plus-ui/src/main.ts',
                     'deepseek-harness-lab/workbuddy/platform/ruoyi/pom.xml']:
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('fixture\n')
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture')
        self.sha = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def begin(self, kind='host', release='fixture-release', limit=10):
        return w.begin(self.repo, self.root / 'artifacts', self.root / 'temporary',
                       release, self.sha, kind, os.getpid(), limit)

    def test_host_and_web_inputs_are_scoped_and_immutable(self):
        p = self.repo / 'AionUi-enterprise-poc/packages/web-host/src/main.ts'
        p.write_text('uncommitted change\n')
        for kind in ('host', 'web', 'employee'):
            work = self.begin(kind, kind + '-fixture')
            w.extract(work)
            self.assertEqual((work / 'source' / p.relative_to(self.repo)).read_text(), 'fixture\n')
            self.assertFalse((work / 'source/AionUi-enterprise-poc/upstream-core').exists())
            self.assertFalse((work / 'source/AionUi-enterprise-poc/out').exists())
            self.assertFalse((work / 'source/deepseek-harness-lab/workbuddy/platform/ruoyi').exists())
            self.assertEqual((work / 'source/deepseek-harness-lab/workbuddy/platform/plus-ui').exists(), kind == 'web')
            w.close(work, 1)

    def test_only_artifacts_survive_and_acceptance_requires_matching_receipt(self):
        work = self.begin('full')
        w.extract(work)
        (work / 'stage/rc2.jar').write_bytes(b'compiled fixture')
        w.complete(work)
        w.close(work, 0)
        record = self.root / 'artifacts/fixture-release'
        self.assertFalse(work.exists())
        self.assertEqual(sorted(p.name for p in record.iterdir()), ['BUILD.json', 'artifacts'])
        self.assertEqual((record / 'artifacts/rc2.jar').read_bytes(), b'compiled fixture')
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({'sourceSha': 'f' * 40, 'status': 'PASS'}))
        with self.assertRaises(ValueError):
            w.accept(record, receipt)
        receipt.write_text(json.dumps({'sourceSha': self.sha, 'status': 'PASS'}))
        w.accept(record, receipt)
        self.assertEqual(json.loads((record / 'BUILD.json').read_text())['status'], 'verified')

    def test_failure_cleanup_and_pending_cap_preserve_candidates(self):
        first = self.begin(limit=1)
        with self.assertRaises(ValueError):
            self.begin(release='second-release', limit=1)
        self.assertTrue(first.exists())
        w.close(first, 27)
        meta = json.loads((self.root / 'artifacts/fixture-release/BUILD.json').read_text())
        self.assertEqual(meta['exitCode'], 27)
        self.assertFalse(first.exists())
        with self.assertRaises(FileExistsError):
            self.begin()

    def test_cleanup_failure_is_reported_and_not_hidden(self):
        work = self.begin()
        with patch.object(w.shutil, 'rmtree', side_effect=OSError('fixture cleanup denied')):
            with self.assertRaises(OSError):
                w.close(work, 0)
        meta = json.loads((self.root / 'artifacts/fixture-release/BUILD.json').read_text())
        self.assertEqual(meta['status'], 'cleanup-failed')
        self.assertIn('fixture cleanup denied', meta['cleanupError'])
        w.close(work, 1)
        meta = json.loads((self.root / 'artifacts/fixture-release/BUILD.json').read_text())
        self.assertFalse(work.exists())
        self.assertTrue(meta['temporaryInputsRemoved'])
        self.assertEqual(meta['status'], 'failed')

    def test_exit_and_termination_cleanup_in_real_shell(self):
        # Exercise the real Bash EXIT/TERM traps, never the user's processes.
        for terminated in (False, True):
            code = '''set -euo pipefail
repo=$1; release=$2; sha=$3
source "$4/workspace.sh"
zw_build_begin host
if [[ $5 == terminate ]]; then sleep 20; else exit 23; fi
'''
            # The shell helper deliberately comes from the script's repo path.
            helpers = self.repo / 'deploy/tencent/maintenance'
            helpers.mkdir(exist_ok=True)
            for n in ('workspace.sh', 'workspace.py'):
                (helpers / n).write_text((HERE / n).read_text())
            env = {**os.environ, 'ZHENWORK_RELEASE_ARTIFACTS': str(self.root / 'shell-artifacts'),
                   'ZHENWORK_BUILD_TMPDIR': str(self.root / 'shell-temporary')}
            proc = subprocess.Popen(['bash', '-c', code, 'fixture', str(self.repo),
                                     'terminated-release' if terminated else 'failed-release', self.sha,
                                     str(HERE), 'terminate' if terminated else 'fail'], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            if terminated:
                for _ in range(100):
                    if list((self.root / 'shell-temporary').glob('*/source/VERSION')):
                        break
                    time.sleep(.02)
                os.killpg(proc.pid, signal.SIGTERM)
            _, err = proc.communicate(timeout=8)
            self.assertEqual(proc.returncode, 143 if terminated else 23, err.decode())
            self.assertEqual(list((self.root / 'shell-temporary').iterdir()), [])


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='zw-retention-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'releases'
        self.root.mkdir()
        scripts = self.root.parent / 'deploy'
        scripts.mkdir()
        for name in ('activate.sh', 'build-linux.sh'):
            (scripts / name).write_text('fixture .release-operation.lock\n')
        self.policy = {'keepVerified': 1, 'maxAgeDays': 30,
                       'protectedReleases': ['pinned-release'],
                       'protectedAppVersions': ['1.0.0-rc.1'], 'verifiedReleases': {}}
        for name in ('current-release', 'previous-release', 'pinned-release', 'formal-release',
                     'pending-release', 'older-release', 'newest-release'):
            self.release(name, name != 'pending-release')
        (self.root.parent / 'current').symlink_to('releases/current-release')
        (self.root.parent / 'previous').symlink_to('releases/previous-release')
        self.update('formal-release', appVersion='1.0.0-rc.1')
        stamp = time.time() - 10
        os.utime(self.root / 'older-release/VERIFIED.json', (stamp, stamp))

    def release(self, name, passed=True):
        p = self.root / name
        p.mkdir()
        (p / 'RELEASE.json').write_text(json.dumps({'sourceSha': 'a' * 40, 'release': name}))
        if passed:
            (p / 'VERIFIED.json').write_text(json.dumps({'sourceSha': 'a' * 40, 'status': 'PASS'}))
        (p / 'artifact').write_bytes(b'fixture')

    def update(self, name, **values):
        p = self.root / name / 'RELEASE.json'
        m = json.loads(p.read_text())
        p.write_text(json.dumps({**m, **values}))

    def plan(self):
        return r.scan(self.root, self.policy, 'server')

    def test_protected_versions_and_unaccepted_candidates_survive_actual_apply(self):
        plan = self.plan()
        self.assertEqual([e['release'] for e in plan['entries'] if e['action'] == 'delete'], ['older-release'])
        self.assertEqual(r.apply(plan, plan['fingerprint']), ['older-release'])
        for n in ('formal', 'current', 'previous', 'pending', 'pinned', 'newest'):
            self.assertTrue((self.root / (n + '-release')).exists())

    def test_changed_current_or_metadata_and_tampered_plan_are_rejected(self):
        plan = self.plan()
        plan['entries'][0]['action'] = 'delete'
        with self.assertRaises(ValueError):
            r.apply(plan, plan['fingerprint'])
        plan = self.plan()
        self.update('older-release', extra='changed')
        with self.assertRaises(ValueError):
            r.apply(plan, plan['fingerprint'])
        plan = self.plan()
        link = self.root.parent / 'current'
        link.unlink()
        link.symlink_to('releases/older-release')
        with self.assertRaises(ValueError):
            r.apply(plan, plan['fingerprint'])
        self.assertTrue((self.root / 'older-release').exists())

    def test_age_policy_requires_verification_and_unknown_receipts_stay_protected(self):
        stamp = time.time() - 40 * 86400
        os.utime(self.root / 'newest-release/VERIFIED.json', (stamp, stamp))
        self.assertIn('newest-release', [e['release'] for e in self.plan()['entries'] if e['action'] == 'delete'])
        (self.root / 'older-release/VERIFIED.json').write_text('{"status":"FAIL"}')
        self.assertEqual(next(e for e in self.plan()['entries'] if e['release'] == 'older-release')['action'], 'keep')

    def test_pending_base_protected_but_provenance_does_not_pin_all_history(self):
        self.update('current-release', baseRelease='older-release')
        self.assertIn('older-release', [e['release'] for e in self.plan()['entries'] if e['action'] == 'delete'])
        self.update('pending-release', baseRelease='older-release')
        self.assertNotIn('older-release', [e['release'] for e in self.plan()['entries'] if e['action'] == 'delete'])

    def test_escaping_pointer_and_symlink_directory_are_never_deleted(self):
        link = self.root.parent / 'current'
        link.unlink()
        link.symlink_to(self.root.parent)
        with self.assertRaises(ValueError):
            self.plan()

    def test_deletion_failure_stops_and_leaves_a_journal(self):
        plan = self.plan()
        with patch.object(r.shutil, 'rmtree', side_effect=OSError('fixture denied')):
            with self.assertRaises(OSError):
                r.apply(plan, plan['fingerprint'])
        log = json.loads((self.root / '.retention-history.jsonl').read_text())
        self.assertIn('fixture denied', log['error'])
        self.assertTrue((self.root / 'older-release').exists())

    def test_missing_cooperating_lock_prevents_server_apply(self):
        (self.root.parent / 'deploy/activate.sh').unlink()
        plan = self.plan()
        with self.assertRaises(ValueError):
            r.apply(plan, plan['fingerprint'])

    def test_conflicting_source_receipt_is_protected(self):
        (self.root / 'older-release/SOURCE_SHA').write_text('f' * 40)
        e = next(e for e in self.plan()['entries'] if e['release'] == 'older-release')
        self.assertEqual((e['action'], e['reason']), ('keep', 'conflicting-source-receipt'))

    def test_legacy_builds_require_explicit_matching_review(self):
        root = self.root.parent / 'legacy'
        stage = root / 'legacy-release' / 'stage'
        stage.mkdir(parents=True)
        (stage / 'IMAGE_IDS.json').write_text(json.dumps({'release': 'legacy-release'}))
        (stage / 'SOURCE_SHA').write_text('c' * 40)
        policy = {**self.policy, 'verifiedReleases': {}}
        plan = r.scan(root, policy, 'legacy')
        self.assertEqual(plan['entries'][0]['action'], 'keep')
        policy['verifiedReleases'] = {'legacy-release': 'c' * 40}
        stamp = time.time() - 40 * 86400
        os.utime(stage / 'IMAGE_IDS.json', (stamp, stamp))
        plan = r.scan(root, policy, 'legacy')
        self.assertEqual(plan['entries'][0]['action'], 'delete')
        self.assertEqual(r.apply(plan, plan['fingerprint']), ['legacy-release'])


if __name__ == '__main__':
    unittest.main()
