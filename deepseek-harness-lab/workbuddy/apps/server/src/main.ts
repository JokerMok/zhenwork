import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, readSecret } from './config.ts';
import { createPool } from './db.ts';
import { createAuth, authenticate, HttpError } from './auth.ts';
import { authRoute } from './auth-routes.ts';
import { iamRoute } from './iam.ts';
import {capabilityRoute} from './capabilities.ts';
import {fileRoute} from './files.ts';
import {operationsRoute} from './operations.ts';
import {adminRoute,publicBrandAsset} from './admin.ts';
import {Conversations} from './conversations.ts';
import {knowledgeRoute} from './knowledge.ts';
import {Jobs} from './jobs.ts';
import { Audit } from './audit.ts';
import { verifySchema } from '../../../packages/database/src/migrate.ts';
import { publicErrors, type TerminalCode } from '../../../packages/contracts/src/index.ts';
const config = loadConfig(), pool = createPool(config);
await verifySchema(pool, process.env.WORKSPACE_MIGRATIONS_DIR || path.resolve('migrations'));
const authPool = createPool(config, false, 4), auth = createAuth(authPool, config), audit = new Audit(pool, readSecret(config.auditSecretFile));
const jobs=new Jobs(pool,config,audit);
const conversations=new Conversations(pool,config,auth,audit);await conversations.recover();
const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    let actorId:string|undefined;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'same-origin');
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
        if ((req.url?.length || 0) > 4096)
            throw new HttpError(414, 'InternalError');
        const url = new URL(req.url || '/', config.publicOrigin);
        if (url.pathname === '/health/live')
            return reply(200, { live: true });
        if (url.pathname === '/health/ready') {
            await pool.query('SELECT 1');
            return reply(200, { ready: true });
        }
        if(url.pathname==='/internal/capability')return await capabilityRoute({req,res,url,requestId,config,pool,auth,audit,reply});
        const allowedHosts = [new URL(config.publicOrigin).host];
        if (config.mode === 'local')
            allowedHosts.push(`127.0.0.1:${config.port}`, `localhost:${config.port}`);
        if (!allowedHosts.includes(req.headers.host || ''))
            throw new HttpError(403);
        if (url.origin !== config.publicOrigin)
            throw new HttpError(400, 'InternalError');
        for (const key of new Set(url.searchParams.keys()))
            if (url.searchParams.getAll(key).length > 1)
                throw new HttpError(400, 'InternalError');
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
            if (req.headers.origin !== config.publicOrigin)
                throw new HttpError(403);
            const upload=req.method==='POST'&&(url.pathname==='/api/files'||/^\/api\/admin\/knowledge-bases\/[^/]+\/documents$/.test(url.pathname)||/^\/api\/admin\/documents\/[^/]+$/.test(url.pathname));
            if (req.headers['content-type']?.split(';')[0] !== (upload?'multipart/form-data':'application/json'))
                throw new HttpError(415, 'InternalError');
            if (Number(req.headers['content-length'] || 0) > (upload?config.uploadLimitBytes+65536:url.pathname==='/api/admin/brand/assets'?360000:65536)) {
                req.resume();
                throw new HttpError(413, 'InternalError');
            }
        }
        const context = { req, res, url, requestId, config, pool, auth, audit, reply };
        if (url.pathname.startsWith('/api/auth/'))
            return await authRoute(context);
        if (url.pathname === '/api/brand' && req.method === 'GET') {
            const { rows } = await pool.query('SELECT config,version FROM brand_config WHERE id=TRUE');
            if (!rows[0])
                throw new HttpError(503, 'InternalError');
            return reply(200, { ...rows[0].config, version: rows[0].version });
        }
        if(await publicBrandAsset(context))return;
        const principal = await authenticate(auth, pool, req);
        actorId=principal.id;
        if (url.pathname === '/api/me' && req.method === 'GET')
            return reply(200, principal);
        if (principal.mustChangePassword)
            throw new HttpError(403, 'PermissionDenied');
        if(await knowledgeRoute({...context,principal}))return;
        if(await operationsRoute({...context,principal}))return;
        if(await adminRoute({...context,principal}))return;
        if(await conversations.route({...context,principal}))return;
        if (await fileRoute({...context,principal}))return;
        if (await iamRoute({ ...context, principal }))
            return;
        throw new HttpError(404);
    }
    catch (error) {
        const dbCode = (error as {
            code?: string;
        }).code;
        const status = error instanceof HttpError ? error.status : ['23505', '23503', '23514'].includes(dbCode || '') ? 409 : 500;
        const requested = error instanceof HttpError ? error.code : 'InternalError';
        const code = (requested in publicErrors ? requested : 'InternalError') as Exclude<TerminalCode, 'Completed'>;
        if ((status === 403 || status === 404 && actorId) && !req.url?.startsWith('/api/auth/'))
            await audit.append({ actorId, action: 'access.denied', result: 'denied', requestId, metadata:{status,method:req.method||'UNKNOWN'} }).catch(() => console.error(JSON.stringify({ service: 'audit', requestId, code: 'AuditWriteFailed' })));
        if (!res.headersSent)
            reply(status, { error: { code, message: status === 404 ? '未找到资源' : publicErrors[code], retryable: status >= 500 || status === 429, requestId } });
        else
            res.end();
        if (status >= 500)
            console.error(JSON.stringify({ service: 'bff', requestId, code, status }));
    }
});
conversations.attach(server);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => console.log(JSON.stringify({ service: 'bff', ready: true, port: config.port, mode: config.mode })));
const cleanup = setInterval(() => pool.query("DELETE FROM auth_attempt_limits WHERE window_start<NOW()-INTERVAL '1 day'").catch(() => { }), 3600000);
cleanup.unref();
process.on('SIGTERM', async() => {await conversations.close();await jobs.close();server.close(async () => { clearInterval(cleanup); await Promise.all([pool.end(), authPool.end()]); process.exit(0); });});
