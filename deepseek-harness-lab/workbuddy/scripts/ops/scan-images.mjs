import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const arch = process.argv[2];
if (!['arm64', 'amd64'].includes(arch)) throw Error('Choose arm64 or amd64');
const trivy = path.resolve(process.env.TRIVY_BIN || '.build/tools/trivy');
const output = path.resolve(process.env.IMAGE_SCAN_OUTPUT || `evidence/v1/p8/image-scan-${arch}`);
fs.mkdirSync(output, { recursive: true });
const rows = [];
for (const name of ['server', 'manager', 'gateway', 'parser', 'web', 'entry', 'runtime', 'postgres']) {
  const ref = name==='postgres'?(process.env.POSTGRES_RELEASE_IMAGE||`postgres:17-alpine-${arch}`):`workspace-${name}:p8-${arch}`;
  const info = JSON.parse(execFileSync('docker', ['image', 'inspect', ref], { encoding: 'utf8' }))[0];
  if (info.Architecture !== arch) throw Error(`Wrong architecture: ${ref}`);
  const common = ['image', '--cache-dir', '.build/trivy-cache', '--skip-db-update', '--scanners', 'vuln', '--no-progress', '--timeout', '15m'];
  const log = fs.openSync(path.join(output, `${name}.log`), 'w');
  const result = spawnSync(trivy, [...common, '--list-all-pkgs', '--format', 'json', '--output', path.join(output, `${name}.json`), info.Id], { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  if (result.status !== 0) throw Error(`Scanner failed: ${name}`);
  const report = JSON.parse(fs.readFileSync(path.join(output, `${name}.json`)));
  const findings = (report.Results || []).flatMap(r => (r.Vulnerabilities || []).map(v => ({ target: r.Target, id: v.VulnerabilityID, package: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null, severity: v.Severity, path: v.PkgPath || null })));
  const counts = findings.reduce((a, v) => { a[v.severity] = (a[v.severity] || 0) + 1; return a; }, {});
  execFileSync(trivy, ['convert', '--format', 'cyclonedx', '--output', path.join(output, `${name}.cdx.json`), path.join(output, `${name}.json`)], { stdio: 'pipe' });
  rows.push({ name, ref, imageDigest: info.Id, architecture: arch, counts, status: (counts.CRITICAL || counts.HIGH) ? 'REVIEW_REQUIRED' : 'PASS', highFindings: findings.filter(v => ['HIGH', 'CRITICAL'].includes(v.severity)) });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ date: new Date().toISOString(), database: JSON.parse(fs.readFileSync('.build/trivy-cache/db/metadata.json')), scope: 'actual final image filesystem; no severity suppression', rows }, null, 2) + '\n');
  console.log(JSON.stringify(rows.at(-1)));
}
if (rows.some(r => r.status !== 'PASS')) process.exitCode = 1;
