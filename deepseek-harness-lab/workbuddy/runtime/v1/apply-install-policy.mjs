import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = '/opt/harness';
if (process.argv[2] !== root) throw Error('Disposable build tree only');
const ignored = ['@anthropic-ai/claude-agent-sdk-*', '@openai/codex-*', '@trycua/cua-driver-*', '@deepseek-ai/libreoffice-kit-*'];
const field = '\nignoredOptionalDependencies:\n' + ignored.map(name => `  - '${name}'\n`).join('');
const files = ['pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const rows = [];
const removedOptionalEdges = [];
function removeExcludedEdges(text) {
  const lines = text.split('\n'), result = [];
  for (let i = 0; i < lines.length;) {
    const start = /^(\s+)optionalDependencies:\s*$/.exec(lines[i]);
    if (!start) { result.push(lines[i++]); continue; }
    const indent = start[1].length, header = lines[i++], body = [];
    while (i < lines.length && (!lines[i].trim() || /^\s*/.exec(lines[i])[0].length > indent)) {
      const key = /^(\s+)(?:'([^']+)'|"([^"]+)"|([^:\s]+)):/.exec(lines[i]);
      const name = key?.[2] || key?.[3] || key?.[4];
      if (key && key[1].length === indent + 2 && ignored.some(pattern => name.startsWith(pattern.slice(0, -1)))) {
        removedOptionalEdges.push(name); i++;
        while (i < lines.length && lines[i].trim() && /^\s*/.exec(lines[i])[0].length > indent + 2) i++;
      } else body.push(lines[i++]);
    }
    result.push(body.some(line => line.trim()) ? header : header + ' {}', ...body);
  }
  if (!removedOptionalEdges.length) throw Error('Expected optional executable edges not found');
  return result.join('\n');
}
for (const file of files) {
  const original = fs.readFileSync(root + '/' + file, 'utf8');
  if (/^ignoredOptionalDependencies:/m.test(original)) throw Error('Review existing upstream policy first');
  fs.writeFileSync(root + '/.workbuddy-upstream-' + file, original);
  const derived = (file === 'pnpm-lock.yaml' ? removeExcludedEdges(original) : original) + field;
  fs.writeFileSync(root + '/' + file, derived);
  rows.push({ file, originalSha256: createHash('sha256').update(original).digest('hex'), derivedSha256: createHash('sha256').update(derived).digest('hex') });
}
fs.writeFileSync(root + '/workbuddy-install-policy.json', JSON.stringify({ scope: 'remove only excluded optional edges and append matching policy metadata; preserve all package resolutions and all other dependency edges', ignored, removedOptionalEdges, rows }, null, 2) + '\n');
