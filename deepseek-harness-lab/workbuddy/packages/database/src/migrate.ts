import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as pg from "pg";

const MIGRATION_FILE = /^(\d{4})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;
const MIGRATION_LOCK_ID = "781984231726451";

interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationResult {
  version: string;
  checksum: string;
  applied: boolean;
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.name.endsWith(".sql"));
  const parsed = sqlEntries.map((entry) => {
    if (!entry.isFile()) {
      throw new Error(`Migration path is not a regular file: ${entry.name}`);
    }

    const match = MIGRATION_FILE.exec(entry.name);
    if (!match) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }

    return {
      filename: entry.name,
      version: match[1]!,
      name: match[2]!,
    };
  });

  parsed.sort((left, right) => left.filename.localeCompare(right.filename));

  const versions = new Set<string>();
  for (const [index, migration] of parsed.entries()) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);

    const expected = String(index + 1).padStart(4, "0");
    if (migration.version !== expected) {
      throw new Error(
        `Migration sequence has a gap or is out of order: expected ${expected}, found ${migration.version}`,
      );
    }
  }

  return Promise.all(
    parsed.map(async (migration) => {
      const bytes = await readFile(join(directory, migration.filename));
      return {
        version: migration.version,
        name: migration.name,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        sql: bytes.toString("utf8"),
      };
    }),
  );
}

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function readAppliedMigrations(client: pg.PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows;
}

function validateAppliedMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): void {
  const localByVersion = new Map(files.map((file) => [file.version, file]));

  for (const [index, record] of applied.entries()) {
    if (!/^\d{4}$/.test(record.version)) {
      throw new Error(`Invalid applied migration version: ${record.version}`);
    }

    const local = localByVersion.get(record.version);
    if (!local) {
      throw new Error(`Applied migration ${record.version} is missing locally`);
    }

    const expected = files[index];
    if (!expected || record.version !== expected.version) {
      throw new Error(
        `Applied migrations are out of order: expected ${expected?.version ?? "no further version"}, found ${record.version}`,
      );
    }
    if (record.name !== local.name) {
      throw new Error(`Applied migration ${record.version} has a changed name`);
    }
    if (record.checksum !== local.checksum) {
      throw new Error(`Checksum mismatch for applied migration ${record.version}`);
    }
  }
}

async function withMigrationLock<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    locked = true;
    return await operation(client);
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }
}

export async function migrate(
  pool: pg.Pool,
  directory: string,
): Promise<MigrationResult[]> {
  return withMigrationLock(pool, async (client) => {
    const files = await loadMigrations(directory);
    await ensureMigrationTable(client);
    const applied = await readAppliedMigrations(client);
    validateAppliedMigrations(files, applied);

    const results: MigrationResult[] = files
      .slice(0, applied.length)
      .map((file) => ({ version: file.version, checksum: file.checksum, applied: false }));

    for (const file of files.slice(applied.length)) {
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [file.version, file.name, file.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      results.push({ version: file.version, checksum: file.checksum, applied: true });
    }

    return results;
  });
}

export async function verifySchema(pool: pg.Pool, directory: string): Promise<void> {
  await withMigrationLock(pool, async (client) => {
    const files = await loadMigrations(directory);
    const present = await client.query("SELECT to_regclass('schema_migrations') AS relation");
    if (!present.rows[0]?.relation) throw new Error("Database migrations have not been applied");
    const applied = await readAppliedMigrations(client);
    validateAppliedMigrations(files, applied);

    if (applied.length !== files.length) {
      throw new Error(
        `Database schema is not current: ${files.length - applied.length} migration(s) pending`,
      );
    }
  });
}
