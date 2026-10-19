import { randomUUID } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type pg from 'pg';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.ts';
import { readSecret } from './config.ts';
import type { Principal, Permission } from '../../../packages/contracts/src/index.ts';
export function authOptions(pool: pg.Pool, config: Config): BetterAuthOptions {
    return {
        database: pool, baseURL: config.publicOrigin, basePath: '/api/auth', secret: readSecret(config.authSecretFile), trustedOrigins: [config.publicOrigin],
        user: { modelName: 'auth_users' }, account: { modelName: 'auth_accounts' }, verification: { modelName: 'auth_verifications' },
        emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true },
        session: { modelName: 'auth_sessions', expiresIn: 12 * 3600, updateAge: 1800, cookieCache: { enabled: false } },
        rateLimit: { modelName: 'rate_limit', enabled: true, storage: 'database', window: 60, max: 120, customRules: { '/sign-in/email': { window: 60, max: 40 } } },
        advanced: { database: { generateId: () => randomUUID() }, useSecureCookies: config.mode === 'production', cookies: { session_token: { name: config.mode === 'production' ? '__Host-workspace-session' : 'workspace-session', attributes: { httpOnly: true, secure: config.mode === 'production', sameSite: 'lax', path: '/' } } }, ipAddress: { ipAddressHeaders: ['x-workspace-client-ip'] } },
        databaseHooks: { session: { create: { before: async (session) => { const { rows } = await pool.query<{
                        enabled: boolean;
                    }>('SELECT enabled FROM users WHERE id=$1', [session.userId]); if (!rows[0]?.enabled)
                        return false; return { data: session }; } } } },
        logger: { level: 'error' }
    };
}
export function createAuth(pool: pg.Pool, config: Config) { return betterAuth(authOptions(pool, config)); }
export type Auth = ReturnType<typeof createAuth>;
export class HttpError extends Error {
    status: number;
    code: string;
    constructor(status: number, code = 'PermissionDenied') { super(code); this.status = status; this.code = code; }
}
export async function getPrincipalById(pool: pg.Pool | pg.PoolClient, id: string): Promise<Principal> {
    const { rows } = await pool.query(`SELECT u.id,a.name,a.email,u.department_id,u.enabled,u.auth_version,u.must_change_password,o.acl_version,
 COALESCE(array_agg(DISTINCT r.id::text) FILTER(WHERE r.id IS NOT NULL),'{}') AS role_ids,
 COALESCE(array_agg(DISTINCT r.code) FILTER(WHERE r.id IS NOT NULL),'{}') AS role_codes,
 COALESCE(array_agg(DISTINCT rp.permission_code) FILTER(WHERE rp.permission_code IS NOT NULL),'{}') AS permissions
 FROM users u JOIN auth_users a ON a.id=u.id JOIN organizations o ON o.id=u.organization_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE u.id=$1 GROUP BY u.id,a.id,o.id`, [id]);
    const u = rows[0];
    if (!u?.enabled)
        throw new HttpError(403);
    return { id: u.id, name: u.name, email: u.email, departmentId: u.department_id, roleIds: u.role_ids, roleCodes: u.role_codes, permissions: u.permissions, authVersion: u.auth_version, aclVersion: Number(u.acl_version), mustChangePassword: u.must_change_password };
}
export async function authenticate(auth: Auth, pool: pg.Pool | pg.PoolClient, req: IncomingMessage, permission?: Permission): Promise<Principal> {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session)
        throw new HttpError(401);
    const p = await getPrincipalById(pool, session.user.id);
    if (permission && !p.permissions.includes(permission))
        throw new HttpError(403);
    return p;
}
export function requirePermission(principal: Principal, permission: Permission) { if (!principal.permissions.includes(permission))
    throw new HttpError(403); }
