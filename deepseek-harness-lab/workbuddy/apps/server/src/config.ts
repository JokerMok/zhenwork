import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const ConfigSchema = z.object({ mode: z.enum(['local', 'production']).default('production'), publicOrigin: z.string().url(), port: z.coerce.number().int().min(1024).max(65535).default(3418), host: z.string().default('127.0.0.1'), dataDir: z.string().min(1), databaseURLFile: z.string().min(1), migrationDatabaseURLFile: z.string().min(1), authSecretFile: z.string().min(1), managerSecretFile: z.string().min(1), auditSecretFile: z.string().min(1), capabilitySecretFile: z.string().min(1), managerURL: z.string().url().default('http://127.0.0.1:3419'), uploadLimitBytes: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(20 * 1024 * 1024), maxActiveRuntimes: z.coerce.number().int().min(1).max(100).default(20), runtimeImage: z.string().min(1).default('workspace-runtime:local'), runtimeMemoryMb: z.coerce.number().int().min(384).max(4096).default(768), localBridgeEnabled: z.literal(false).default(false) }).strict();
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(): Config {
    const filename = process.env.WORKSPACE_CONFIG_FILE;
    if (!filename)
        throw Error('WORKSPACE_CONFIG_FILE is required');
    const c = ConfigSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
    const origin = new URL(c.publicOrigin);
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
        throw Error('Public origin must be a single origin');
    if (c.mode === 'production' && origin.protocol !== 'https:')
        throw Error('Production requires HTTPS');
    if (c.mode === 'local' && (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)))
        throw Error('Local mode requires loopback HTTP');
    c.publicOrigin = origin.origin;
    c.dataDir = path.resolve(c.dataDir);
    return c;
}
export function readSecret(filename: string, minLength = 32): string {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw Error('Secret must be a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        throw Error('Secret file permissions must be owner-only');
    const value = fs.readFileSync(filename, 'utf8').trim();
    if (value.length < minLength)
        throw Error('Secret too short');
    return value;
}
