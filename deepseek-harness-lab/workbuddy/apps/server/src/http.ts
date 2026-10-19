import {strictJson} from './strict-json.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { z } from 'zod';
import type { Config } from './config.ts';
import type { Auth } from './auth.ts';
import { HttpError } from './auth.ts';
import type { Principal } from '../../../packages/contracts/src/index.ts';
import type { Audit } from './audit.ts';
export type Context = {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    requestId: string;
    config: Config;
    pool: pg.Pool;
    auth: Auth;
    audit: Audit;
    principal: Principal;
    reply: (status: number, value: unknown) => void;
};
export async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>,maxBytes=65536): Promise<T> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > maxBytes) {
            req.resume();
            throw new HttpError(413, 'InternalError');
        }
        chunks.push(chunk);
    }
    try {
        return schema.parse(strictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
    }
    catch {
        throw new HttpError(400, 'InternalError');
    }
}
export function resourceId(raw: string | undefined): string { if (!raw || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(raw))
    throw new HttpError(404); return raw; }
export function paging(url: URL) { const limit = Number(url.searchParams.get('limit') || 100), offset = Number(url.searchParams.get('offset') || 0); if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 100000)
    throw new HttpError(400, 'InternalError'); return { limit, offset }; }
