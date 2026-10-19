import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

import { migrate, verifySchema } from "../src/migrate.ts";

const { Pool } = pg;
const configurationPath = new URL("../../../.state/foundation/config.json", import.meta.url);
const databaseName = `wb_migrate_${process.pid}_${Date.now()}`;

let maintenancePool: pg.Pool;
let controlPool: pg.Pool;
let testDatabaseUrl: string;
let databaseCreated = false;
let scenarioNumber = 0;

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

before(async () => {
  const configuration = process.env.WORKSPACE_TEST_DATABASE_URL ? {databaseURL:process.env.WORKSPACE_TEST_DATABASE_URL} : JSON.parse(await readFile(configurationPath, "utf8")) as {
    databaseURL?: unknown;
  };
  if (typeof configuration.databaseURL !== "string") {
    throw new Error("Foundation databaseURL is missing");
  }

  maintenancePool = new Pool({ connectionString: configuration.databaseURL });
  await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  databaseCreated = true;

  const url = new URL(configuration.databaseURL);
  url.pathname = `/${databaseName}`;
  testDatabaseUrl = url.toString();
  controlPool = new Pool({ connectionString: testDatabaseUrl });
});

after(async () => {
  if (controlPool) {
    await controlPool.end();
  }
  if (maintenancePool) {
    if (databaseCreated) {
      await maintenancePool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    }
    await maintenancePool.end();
  }
});

async function withMigrations<T>(
  files: Record<string, string>,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-migrate-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql, "utf8")),
    );
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withScenario<T>(
  operation: (pool: pg.Pool, schema: string) => Promise<T>,
): Promise<T> {
  scenarioNumber += 1;
  const schema = `migration_case_${scenarioNumber}`;
  await controlPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    options: `-c search_path=${schema},public`,
    max: 4,
  });
  try {
    return await operation(pool, schema);
  } finally {
    await pool.end();
  }
}

test("applies an empty database and reports a repeat run without reapplying", async () => {
  await withScenario(async (pool) => {
    await withMigrations(
      {
        "0001_create_widgets.sql":
          "CREATE TABLE widgets (id integer PRIMARY KEY, value text NOT NULL);",
      },
      async (directory) => {
        const first = await migrate(pool, directory);
        assert.deepEqual(first.map(({ version, applied }) => ({ version, applied })), [
          { version: "0001", applied: true },
        ]);
        assert.match(first[0]!.checksum, /^[a-f0-9]{64}$/);

        const second = await migrate(pool, directory);
        assert.deepEqual(second, [{ ...first[0]!, applied: false }]);
        await verifySchema(pool, directory);

        const tracked = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM schema_migrations",
        );
        assert.equal(tracked.rows[0]!.count, "1");
      },
    );
  });
});

test("serializes concurrent runners with one migration application", async () => {
  await withScenario(async (pool, schema) => {
    await withMigrations(
      {
        "0001_concurrent.sql":
          "SELECT pg_sleep(0.15); CREATE TABLE concurrency_probe (id integer PRIMARY KEY);",
      },
      async (directory) => {
        const secondPool = new Pool({
          connectionString: testDatabaseUrl,
          options: `-c search_path=${schema},public`,
          max: 2,
        });
        try {
          const runs = await Promise.all([migrate(pool, directory), migrate(secondPool, directory)]);
          assert.equal(runs.flat().filter((result) => result.applied).length, 1);
          assert.equal(runs.flat().filter((result) => !result.applied).length, 1);
        } finally {
          await secondPool.end();
        }
      },
    );
  });
});

test("rejects checksum tampering and a missing applied migration", async () => {
  await withScenario(async (pool) => {
    const original = "CREATE TABLE immutable_probe (id integer PRIMARY KEY);";
    await withMigrations({ "0001_immutable.sql": original }, async (directory) => {
      await migrate(pool, directory);
      const filename = join(directory, "0001_immutable.sql");

      await writeFile(filename, `${original}\n-- changed after application\n`, "utf8");
      await assert.rejects(migrate(pool, directory), /Checksum mismatch/);

      await writeFile(filename, original, "utf8");
      await unlink(filename);
      await assert.rejects(migrate(pool, directory), /missing locally/);
    });
  });
});

test("rejects duplicate, gapped, and out-of-order migration histories", async () => {
  await withScenario(async (pool) => {
    await withMigrations(
      { "0001_first.sql": "SELECT 1;", "0001_duplicate.sql": "SELECT 1;" },
      async (directory) => {
        await assert.rejects(migrate(pool, directory), /Duplicate migration version/);
      },
    );

    await withMigrations(
      { "0001_first.sql": "SELECT 1;", "0003_gap.sql": "SELECT 3;" },
      async (directory) => {
        await assert.rejects(migrate(pool, directory), /gap or is out of order/);
      },
    );

    await withMigrations(
      { "0001_first.sql": "SELECT 1;", "0002_second.sql": "SELECT 2;" },
      async (directory) => {
        await migrate(pool, directory);
        await pool.query("DELETE FROM schema_migrations WHERE version = '0001'");
        await assert.rejects(migrate(pool, directory), /Applied migrations are out of order/);
      },
    );
  });
});

test("rolls back both schema effects and tracking when a migration fails", async () => {
  await withScenario(async (pool, schema) => {
    await withMigrations(
      {
        "0001_fails.sql": [
          "CREATE TABLE rollback_probe (id integer PRIMARY KEY);",
          "INSERT INTO rollback_probe (id) VALUES (1);",
          "SELECT missing_column FROM rollback_probe;",
        ].join("\n"),
      },
      async (directory) => {
        await assert.rejects(migrate(pool, directory), /missing_column/);

        const relation = await pool.query<{ relation: string | null }>(
          "SELECT to_regclass($1) AS relation",
          [`${schema}.rollback_probe`],
        );
        assert.equal(relation.rows[0]!.relation, null);

        const tracked = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM schema_migrations",
        );
        assert.equal(tracked.rows[0]!.count, "0");
      },
    );
  });
});

test("applies a forward migration while preserving existing data", async () => {
  await withScenario(async (pool) => {
    await withMigrations(
      {
        "0001_records.sql": [
          "CREATE TABLE records (id integer PRIMARY KEY, value text NOT NULL);",
          "INSERT INTO records (id, value) VALUES (1, 'kept');",
        ].join("\n"),
      },
      async (directory) => {
        await migrate(pool, directory);
        await writeFile(
          join(directory, "0002_add_label.sql"),
          "ALTER TABLE records ADD COLUMN label text NOT NULL DEFAULT 'legacy';",
          "utf8",
        );

        await assert.rejects(verifySchema(pool, directory), /1 migration\(s\) pending/);
        const results = await migrate(pool, directory);
        assert.deepEqual(results.map(({ version, applied }) => ({ version, applied })), [
          { version: "0001", applied: false },
          { version: "0002", applied: true },
        ]);

        const rows = await pool.query<{ id: number; value: string; label: string }>(
          "SELECT id, value, label FROM records",
        );
        assert.deepEqual(rows.rows, [{ id: 1, value: "kept", label: "legacy" }]);
        await verifySchema(pool, directory);
      },
    );
  });
});

test("verification refuses an uninitialized database without creating schema", async () => {
  await withScenario(async (pool) => {await withMigrations({"0001_first.sql":"CREATE TABLE test_item(id int);"},async directory=>{
    await assert.rejects(verifySchema(pool,directory),/have not been applied/);
    const result=await pool.query("SELECT to_regclass('schema_migrations') AS relation");
    assert.equal(result.rows[0].relation,null);
  });});
});
