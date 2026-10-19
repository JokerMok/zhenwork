import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { fromNodeHeaders } from 'better-auth/node';
import { readJson, type Context } from './http.ts';
import { HttpError, authenticate } from './auth.ts';
import { readSecret } from './config.ts';
import { transaction } from './db.ts';
const Login = z.object({ email: z.string().email().max(254).transform(v => v.trim().toLowerCase()), password: z.string().min(1).max(128) }).strict();
const Change = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) }).strict();
let hashes = 0;
const queue: Array<() => void> = [];
export async function boundedHash<T>(fn: () => Promise<T>): Promise<T> {
    if (hashes >= 4) {
        if (queue.length >= 24)
            throw new HttpError(429, 'RateLimit');
        await new Promise<void>(r => queue.push(r));
    }
    else
        hashes++;
    try {
        return await fn();
    }
    finally {
        const next = queue.shift();
        if (next)
            next();
        else
            hashes--;
    }
}
export async function authRoute(c: Omit<Context, 'principal'>): Promise<void> {
    const { req, res, url, auth, pool, audit, config, requestId, reply } = c;
    if (req.method !== 'POST')
        throw new HttpError(405);
    // This internal header is always overwritten; caller-supplied X-Forwarded-For is ignored.
    req.headers['x-workspace-client-ip'] = req.socket.remoteAddress || '127.0.0.1';
    const headers = fromNodeHeaders(req.headers);
    let response: Response;
    const limit = async (key: string, max: number) => { const { rows } = await pool.query(`INSERT INTO auth_attempt_limits(key,window_start,count) VALUES($1,NOW(),1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_attempt_limits.window_start < NOW()-INTERVAL '1 minute' THEN 1 ELSE auth_attempt_limits.count+1 END,window_start=CASE WHEN auth_attempt_limits.window_start < NOW()-INTERVAL '1 minute' THEN NOW() ELSE auth_attempt_limits.window_start END RETURNING count`, [key]); if (rows[0].count > max) {
        res.setHeader('retry-after', '60');
        await audit.append({ action: 'auth.throttled', result: 'denied', requestId });
        throw new HttpError(429, 'RateLimit');
    } };
    const fingerprint = (namespace: string, value: string) => createHmac('sha256', readSecret(config.authSecretFile)).update(namespace + ':' + value).digest('hex');
    await limit(fingerprint('ip', req.socket.remoteAddress || 'loopback'), 120);
    if (url.pathname === '/api/auth/sign-in/email') {
        const body = await readJson(req, Login);
        await limit(fingerprint('login-ip', req.socket.remoteAddress || 'loopback'), 40);
        await limit(fingerprint('account', body.email), 5);
        response = await transaction(pool, async (db) => {
            // Serialize session creation against disable/reset/revoke, per user. Auth has a separate bounded pool.
            const account = await db.query('SELECT u.id,u.enabled FROM users u JOIN auth_users a ON a.id=u.id WHERE lower(a.email)=$1 FOR UPDATE OF u', [body.email]);
            const result = account.rows[0]?.enabled === false ? await boundedHash(async () => { await (await auth.$context).password.hash(body.password); return Response.json({}, { status: 401 }); }) : await boundedHash(() => auth.api.signInEmail({ body, headers, asResponse: true }));
            const identity = result.ok ? await result.clone().json() as {
                user?: {
                    id: string;
                };
            } : null;
            await audit.append({ actorId: identity?.user?.id, action: 'auth.login', result: result.ok ? 'success' : 'denied', requestId, metadata: { status: result.status } }, db);
            return result;
        });
    }
    else if (url.pathname === '/api/auth/sign-out') {
        const before = await auth.api.getSession({ headers });
        response = await auth.api.signOut({ headers, asResponse: true });
        if (before) {
            const remaining = await pool.query('SELECT 1 FROM auth_sessions WHERE id=$1', [before.session.id]);
            if (remaining.rowCount)
                throw new HttpError(503, 'InternalError');
        }
        await audit.append({ actorId: before?.user.id, action: 'auth.logout', result: response.ok ? 'success' : 'error', requestId });
    }
    else if (url.pathname === '/api/auth/change-password') {
        const p = await authenticate(auth, pool, req);
        const body = await readJson(req, Change);
        response = await transaction(pool, async (db) => {
            const current = await db.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE', [p.id]);
            if (!current.rows[0]?.enabled)
                throw new HttpError(403);
            // Re-check the session after acquiring the user lock; concurrent reset may have revoked it.
            await authenticate(auth, db, req);
            const result = await boundedHash(() => auth.api.changePassword({ body: { ...body, revokeOtherSessions: true }, headers, asResponse: true }));
            if (result.ok) {
                await db.query('UPDATE users SET must_change_password=FALSE,auth_version=auth_version+1 WHERE id=$1', [p.id]);
                await audit.append({ actorId: p.id, action: 'auth.password_changed', result: 'success', requestId }, db);
            }
            return result;
        });
    }
    else
        throw new HttpError(404);
    if (!response.ok) {
        if (response.status === 429) {
            res.setHeader('retry-after', response.headers.get('retry-after') || '60');
            throw new HttpError(429, 'RateLimit');
        }
        throw new HttpError(response.status >= 500 ? 503 : 401, response.status >= 500 ? 'InternalError' : 'PermissionDenied');
    }
    // Better Auth owns cookie lifecycle; the session token is never sent in a JSON body.
    for (const cookie of response.headers.getSetCookie())
        res.appendHeader('set-cookie', cookie);
    reply(200, { success: true });
}
