import { createHmac, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from './db.ts';
export function canonical(value: unknown): string { if (value === null || typeof value !== 'object')
    return JSON.stringify(value); if (Array.isArray(value))
    return '[' + value.map(canonical).join(',') + ']'; return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'; }
export type AuditInput = {
    actorId?: string | null;
    action: string;
    resource?: string | null;
    result: 'success' | 'denied' | 'error';
    requestId?: string;
    metadata?: Record<string, string | number | boolean | null>;
};
export class Audit {
    pool: pg.Pool;
    key: string;
    constructor(pool: pg.Pool, key: string) { this.pool = pool; this.key = key; }
    async append(input: AuditInput, db?: pg.PoolClient): Promise<void> {
        if (!db)
            return transaction(this.pool, c => this.append(input, c));
        const { rows } = await db.query('SELECT seq,hash FROM audit_heads WHERE id=TRUE FOR UPDATE');
        if (!rows[0])
            throw Error('Audit chain not initialized');
        const event = { seq: String(BigInt(rows[0].seq) + 1n), actorId: input.actorId || null, action: input.action, resource: input.resource || null, result: input.result, requestId: input.requestId || randomUUID(), metadata: input.metadata || {}, createdAt: new Date().toISOString(), prevHash: rows[0].hash };
        const hash = createHmac('sha256', this.key).update(canonical(event)).digest('hex');
        await db.query('INSERT INTO audit_events(seq,actor_id,action,resource,result,request_id,metadata,created_at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [event.seq, event.actorId, event.action, event.resource, event.result, event.requestId, JSON.stringify(event.metadata), event.createdAt, event.prevHash, hash]);
        await db.query('UPDATE audit_heads SET seq=$1,hash=$2 WHERE id=TRUE', [event.seq, hash]);
    }
}
