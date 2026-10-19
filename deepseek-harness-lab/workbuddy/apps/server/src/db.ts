import pg from 'pg';
import type { Config } from './config.ts';
import { readSecret } from './config.ts';
export function createPool(config: Config, migration = false, max = 12) { return new pg.Pool({ connectionString: readSecret(migration ? config.migrationDatabaseURLFile : config.databaseURLFile), max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, application_name: 'enterprise-workspace' }); }
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
}
catch (error) {
    await client.query('ROLLBACK');
    throw error;
}
finally {
    client.release();
} }
