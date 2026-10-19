#!/usr/bin/env node
// Stage an electron-builder update feed. Publishing and code-signature checks
// remain separate release gates; this script never uploads artifacts.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const CHANNELS = new Set(['pilot', 'stable']);
const PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const ARCHES = new Set(['arm64', 'x64']);

export function channelFile(channel, platform, arch) {
  if (!CHANNELS.has(channel) || !PLATFORMS.has(platform) || !ARCHES.has(arch)) {
    throw new Error('Invalid enterprise release target');
  }
  if (platform === 'darwin') return `${channel}${arch === 'arm64' ? '-arm64' : ''}-mac.yml`;
  if (platform === 'win32') return `${channel}${arch === 'arm64' ? '-win-arm64' : ''}.yml`;
  return `${channel}-linux${arch === 'arm64' ? '-arm64' : ''}.yml`;
}

async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

function safeArtifactName(name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name.includes('\\') ||
      name === '.' || name === '..' || name.startsWith('.')) throw new Error('Invalid artifact URL');
  return name;
}

export async function prepareEnterpriseFeed({ artifactDir, metadataFile, outputDir, serverId, channel, platform, arch }) {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(serverId || '')) throw new Error('Invalid RC2 server identity');
  const targetMetadata = channelFile(channel, platform, arch);
  const metadata = yaml.load(await readFile(metadataFile, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) ||
      !Array.isArray(metadata.files) || metadata.files.length === 0 || metadata.files.length > 10) {
    throw new Error('Invalid electron-builder metadata');
  }
  if (await stat(outputDir).then(() => true, () => false)) throw new Error('Output directory already exists');
  const stage = `${outputDir}.tmp-${randomUUID()}`;
  await mkdir(stage, { recursive: false, mode: 0o700 });
  try {
    const candidates = (await readdir(artifactDir)).filter((name) => !name.startsWith('.') &&
      /\.(zip|dmg|exe|AppImage|deb)$/i.test(name));
    const selected = [];
    for (const file of metadata.files) {
      const name = safeArtifactName(file.url);
      if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 || '')) {
        throw new Error(`Invalid checksum or size for ${name}`);
      }
      let source = path.join(artifactDir, name);
      if (!(await stat(source).then((value) => value.size === file.size, () => false))) {
        const sameSize = [];
        for (const candidate of candidates) {
          if ((await stat(path.join(artifactDir, candidate))).size === file.size) sameSize.push(candidate);
        }
        const matches = [];
        for (const candidate of sameSize) {
          if (await sha512(path.join(artifactDir, candidate)) === file.sha512) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error(`Cannot uniquely match artifact ${name}`);
        source = path.join(artifactDir, matches[0]);
      }
      if (await sha512(source) !== file.sha512) throw new Error(`Artifact hash mismatch: ${name}`);
      await copyFile(source, path.join(stage, name));
      const blockmap = `${source}.blockmap`;
      if (await stat(blockmap).then(() => true, () => false)) await copyFile(blockmap, path.join(stage, `${name}.blockmap`));
      selected.push(name);
    }
    if (metadata.path && !selected.includes(safeArtifactName(metadata.path))) {
      throw new Error('Primary artifact missing from files list');
    }
    await writeFile(path.join(stage, targetMetadata), yaml.dump(metadata), { mode: 0o600 });
    await writeFile(path.join(stage, 'enterprise-release.json'), JSON.stringify({
      productId: 'com.aionui.enterprise.pilot', protocolVersion: 2, serverId, channel, platform, arch,
      version: metadata.version,
    }, null, 2) + '\n', { mode: 0o600 });
    await rename(stage, outputDir);
    return { outputDir, metadata: targetMetadata, version: metadata.version, artifacts: selected };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('=');
    if (!arg.startsWith('--') || index < 3) throw new Error('Use --name=value arguments');
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  prepareEnterpriseFeed({
    artifactDir: path.resolve(flags['artifacts'] || ''), metadataFile: path.resolve(flags['metadata'] || ''),
    outputDir: path.resolve(flags['output'] || ''), serverId: flags['server-id'], channel: flags.channel,
    platform: flags.platform, arch: flags.arch,
  }).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
