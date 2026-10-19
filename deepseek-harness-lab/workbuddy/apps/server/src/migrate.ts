import path from 'node:path';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from '../../../packages/database/src/migrate.ts';
const pool = createPool(loadConfig(), true);
try {
    const result = await migrate(pool, process.env.WORKSPACE_MIGRATIONS_DIR || path.resolve('migrations'));
    console.log(JSON.stringify({ migration: result }));
}
finally {
    await pool.end();
}
