import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Keep the raw scanner findings and the scoped disposition as separate evidence.
export function collectCandidateEvidence(arch, images, runtimeImageDigest, parserImageDigest) {
  const expected = new Set([...Object.values(images), runtimeImageDigest, parserImageDigest]);
  const records = [];
  function bind(file) {
    const bytes = fs.readFileSync(file);
    records.push({path:file, sha256:createHash('sha256').update(bytes).digest('hex')});
    return bytes;
  }
  const read = file => JSON.parse(bind(file));
  const prefix = 'evidence/v1/p8/';
  const review = read(prefix + `image-security-review-${arch}.json`);
  assert.equal(review.architecture, arch);
  assert.equal(review.status, 'PASS_WITH_SCOPED_RUNTIME_MITIGATIONS');
  assert.deepEqual(new Set(review.rows.map(row => row.imageDigest)), expected, 'Security review must cover the exact candidate images');
  const scan = read(prefix + `image-scan-${arch}/summary.json`);
  assert.deepEqual(new Set(scan.rows.map(row => row.imageDigest)), expected, 'Raw scan images differ from candidate');
  for (const row of scan.rows) {
    read(prefix + `image-scan-${arch}/${row.name}.json`);
    read(prefix + `image-scan-${arch}/${row.name}.cdx.json`);
  }
  read(prefix + `gosu-${arch}-final-binary.json`);
  bind(prefix + `gosu-${arch}-govulncheck.jsonstream`);
  bind(prefix + `gosu-${arch}-govulncheck.stderr`);
  const policy = read(prefix + `runtime-${arch}-policy.json`);
  assert.equal(policy.status, 'IMAGE_POLICY_PASS');
  assert.equal(policy.imageDigest, runtimeImageDigest);
  const smoke = read(prefix + `runtime-${arch}-final-smoke.json`);
  assert.equal(smoke.status, 'PASS');
  assert.equal(smoke.imageDigest, runtimeImageDigest);
  assert.equal(smoke.arch, arch === 'amd64' ? 'x64' : 'arm64');
  const web = read(prefix + `web-${arch}-native-final.json`);
  assert.equal(web.status, 'PASS');
  assert.equal(web.imageDigest, images.WEB_IMAGE);
  read(prefix + `images-${arch}.json`);
  const build = read(prefix + `runtime-${arch}.json`);
  // ARM64 deployment reports are reference evidence only in an AMD64 candidate.
  const deployment = read(prefix + 'compose-final.json');
  const acceptance = {platform:'linux/arm64', environment:'macOS Docker, synthetic accounts, real Provider',
    appliesToCandidatePlatform:arch === 'arm64', runtimeImageDigest:deployment.runtimeDigest,
    images:deployment.images, parserImageDigest:deployment.parserDigest};
  if (arch === 'arm64') {
    assert.equal(deployment.runtimeDigest, runtimeImageDigest);
    assert.equal(deployment.parserDigest, parserImageDigest);
    assert.deepEqual(deployment.images, images);
  }
  assert.ok(deployment.checks.length >= 5 && deployment.checks.every(row => row.status === 'PASS'));
  const security = read(prefix + 'security-final.json');
  assert.equal(security.summary.passed, 98);
  assert.equal(security.summary.failed, 0);
  assert.equal(security.summary.notRun, 0);
  for (const [name, count] of [['tool-lifecycle-final.json',3],['knowledge-runtime-final.json',4],['update-roundtrip-final.json',4],['restore-final-acceptance.json',3],['backup-negative-final.json',2]]) {
    const result = read(prefix + name);
    assert.ok(result.checks.length >= count && result.checks.every(row => row.status === 'PASS'), name);
  }
  const capacity = read(prefix + 'capacity-final.json');
  assert.equal(capacity.submitted, 20);
  assert.equal(capacity.passed, 20);
  assert.equal(capacity.failed, 0);
  assert.deepEqual(read(prefix + 'license-final.json').failures, []);
  const secrets = read(prefix + 'secret-final-known.json');
  assert.deepEqual(secrets.findings, []);
  assert.ok(secrets.knownLocalSecretCount > 0);
  const remote = read('evidence/v1/p9/remote-api-final.json');
  assert.equal(remote.runtimeDigest, deployment.runtimeDigest);
  assert.ok(remote.rows.length === 5 && remote.rows.every(row => row.status === 'PASS'));
  const browser = read('evidence/v1/p9/candidate-browser-final/report.json');
  assert.equal(browser.runtimeDigest, deployment.runtimeDigest);
  assert.ok(browser.checks.length === 5 && browser.checks.every(row => row.status === 'PASS'));
  assert.deepEqual(browser.errors, []);
  bind('evidence/v1/p9/candidate-browser-final/employee.png');
  bind('evidence/v1/p9/candidate-browser-final/admin.png');
  return {records, imageSecurity:review.status, deploymentAcceptance:acceptance,
    upstreamArchiveSha256:build.upstreamArchiveSha256};
}

export function verifyEvidenceHashes(records) {
  assert.ok(Array.isArray(records) && records.length > 0, 'Candidate evidence is missing');
  for (const record of records) {
    assert.ok(/^evidence\/v1\//.test(record.path) && !record.path.split('/').includes('..'));
    assert.equal(createHash('sha256').update(fs.readFileSync(record.path)).digest('hex'), record.sha256,
      'Candidate evidence changed: ' + record.path);
  }
}
