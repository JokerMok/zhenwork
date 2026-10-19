import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = '/opt/harness';
if (process.argv[2] !== root) throw Error('Disposable image build tree only');
const overlay = path.join(root, '.workbuddy-security');
const requested = JSON.parse(fs.readFileSync(path.join(overlay, 'package.json'))).dependencies;
const allowed = { 'fast-uri': '3.1.6', 'ip-address': '10.3.1', 'js-yaml': '4.3.2', sharp: '0.35.4' };
if (JSON.stringify(requested) !== JSON.stringify(allowed)) throw Error('Unexpected security overlay');
const rows = [];
for (const directory of fs.readdirSync(path.join(root, 'node_modules/.pnpm'))) {
  const parent = path.join(root, 'node_modules/.pnpm', directory, 'node_modules');
  for (const [name, version] of Object.entries(allowed)) {
    const target = path.join(parent, name);
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) continue;
    const previous = JSON.parse(fs.readFileSync(path.join(target, 'package.json')));
    const replacement = path.join(overlay, 'node_modules', name);
    const next = JSON.parse(fs.readFileSync(path.join(replacement, 'package.json')));
    if (next.name !== name || next.version !== version) throw Error('Overlay package identity mismatch');
    rows.push({ name, from: previous.version, to: next.version, originalManifestSha256: createHash('sha256').update(fs.readFileSync(path.join(target, 'package.json'))).digest('hex') });
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(path.relative(parent, replacement), target, 'dir');
  }
}
for (const name of Object.keys(allowed)) if (!rows.some(r => r.name === name)) throw Error('Expected vulnerable package absent: ' + name);
fs.writeFileSync(path.join(root, 'workbuddy-security-overlay.json'), JSON.stringify({ scope: 'third-party packages in disposable image only; Harness Core and original source archive unchanged; original lock retained separately', packageLockSha256: createHash('sha256').update(fs.readFileSync(path.join(overlay, 'package-lock.json'))).digest('hex'), rows }, null, 2) + '\n');
console.log(JSON.stringify({ securityOverlay: rows }));
