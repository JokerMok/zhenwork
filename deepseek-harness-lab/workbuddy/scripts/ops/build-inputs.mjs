import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const excluded = new Set(['node_modules', '.next', '.git', '.DS_Store']);
export const runtimeInputs = ['runtime/v1', 'scripts/ops/prune-runtime-image.mjs'];
export const controlInputs = ['package.json', 'package-lock.json', 'apps', 'packages', 'migrations', 'deploy/v1', 'scripts/v1/grant-local-db.mjs'];
export function hashInputs(base, inputs) {
  const rows = [];
  function visit(relative) {
    const name = path.basename(relative);
    if (excluded.has(name) || name.endsWith('.tsbuildinfo') || name.startsWith('.env')) return;
    const full = path.join(base, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw Error('Build source symlink needs explicit review: ' + relative);
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) visit(path.join(relative, child));
    else if (stat.isFile()) rows.push({ path: relative, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  }
  for (const input of inputs) visit(input);
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), files: rows };
}
