import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../../config/env.js';

/**
 * The nearest `db/migrations` above this file. Walked rather than hard-coded
 * because the same module runs from two layouts: the repo
 * (`apps/api/src/core/database/migrate.ts`, migrations at the repo root) and the built
 * image (`/app/dist/db/migrate.js`, migrations copied to `/app/db`). A fixed
 * `../../..` would be right in one and silently point at nothing in the other.
 */
function findMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('no db/migrations directory above ' + fileURLToPath(import.meta.url));
    dir = parent;
  }
}

const MIGRATIONS_DIR = findMigrationsDir();

export interface Migration {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

/**
 * Exported so the reversibility gate uses THIS ordering and THIS missing-down
 * check rather than a second copy of both.
 *
 * A gate that re-derived the order from filenames would agree with the runner
 * today and diverge the first time the naming rule changed -- and it would
 * diverge silently, because both would still produce a plausible sequence. Same
 * reasoning as the reporting scanner deriving its table list instead of
 * enumerating one.
 */
export async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const byVersion = new Map<string, { name: string; up?: string; down?: string }>();

  for (const entry of entries) {
    const match = FILENAME.exec(entry);
    if (!match) continue;
    const [, version, name, direction] = match as unknown as [string, string, string, string];

    const record = byVersion.get(version) ?? { name };
    if (record.name !== name) {
      throw new Error(`migration ${version} has conflicting names: ${record.name} and ${name}`);
    }
    if (direction === 'up') record.up = entry;
    else record.down = entry;
    byVersion.set(version, record);
  }

  return [...byVersion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, record]) => {
      // Reversibility is a hard rule, so a missing down is a load-time error
      // rather than something discovered at rollback time.
      if (!record.up) throw new Error(`migration ${version} has no .up.sql`);
      if (!record.down) throw new Error(`migration ${version} (${record.name}) has no .down.sql`);
      return {
        version,
        name: record.name,
        upPath: path.join(MIGRATIONS_DIR, record.up),
        downPath: path.join(MIGRATIONS_DIR, record.down),
      };
    });
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

async function ensureTracking(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS migration;
    CREATE TABLE IF NOT EXISTS migration.applied (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedRows(client: pg.Client): Promise<AppliedRow[]> {
  const result = await client.query<AppliedRow>(
    'SELECT version, name, checksum FROM migration.applied ORDER BY version',
  );
  return result.rows;
}

/**
 * An applied migration whose file has since been edited is an error, not a
 * silent no-op: the database and the repository have diverged and only one of
 * them knows it.
 */
async function assertNoDrift(migrations: Migration[], applied: AppliedRow[]): Promise<void> {
  for (const row of applied) {
    const migration = migrations.find((m) => m.version === row.version);
    if (!migration) {
      throw new Error(`migration ${row.version} (${row.name}) is applied but its files are missing`);
    }
    const current = checksum(await readFile(migration.upPath, 'utf8'));
    if (current !== row.checksum) {
      throw new Error(
        `migration ${row.version} (${row.name}) has been edited since it was applied. ` +
          `Write a new migration instead.`,
      );
    }
  }
}

async function up(client: pg.Client): Promise<void> {
  const migrations = await loadMigrations();
  const applied = await appliedRows(client);
  await assertNoDrift(migrations, applied);

  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    console.log('nothing to apply');
    return;
  }

  for (const migration of pending) {
    const sql = await readFile(migration.upPath, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO migration.applied (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, checksum(sql)],
      );
      await client.query('COMMIT');
      console.log(`applied  ${migration.version}_${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}

async function down(client: pg.Client, steps: number): Promise<void> {
  const migrations = await loadMigrations();
  const applied = await appliedRows(client);
  await assertNoDrift(migrations, applied);

  const target = applied.slice(-steps).reverse();
  if (target.length === 0) {
    console.log('nothing to roll back');
    return;
  }

  for (const row of target) {
    const migration = migrations.find((m) => m.version === row.version);
    if (!migration) throw new Error(`migration ${row.version} files are missing`);

    const sql = await readFile(migration.downPath, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM migration.applied WHERE version = $1', [row.version]);
      await client.query('COMMIT');
      console.log(`reverted ${migration.version}_${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `rollback of ${migration.version}_${migration.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}

async function status(client: pg.Client): Promise<void> {
  const migrations = await loadMigrations();
  const applied = new Map((await appliedRows(client)).map((r) => [r.version, r]));
  let drifted = false;

  for (const migration of migrations) {
    const row = applied.get(migration.version);
    let mark: string;
    if (!row) {
      mark = 'pending';
    } else if (checksum(await readFile(migration.upPath, 'utf8')) !== row.checksum) {
      // Reported rather than thrown: status is the diagnostic you reach for when
      // up has already refused, so it has to be able to run and say why.
      mark = 'DRIFTED';
      drifted = true;
    } else {
      mark = 'applied';
    }
    console.log(`${mark}  ${migration.version}_${migration.name}`);
  }

  if (drifted) {
    console.error('\nA DRIFTED migration was edited after it was applied. Write a new migration.');
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();

  try {
    await ensureTracking(client);
    switch (command) {
      case 'up':
        await up(client);
        break;
      case 'down': {
        const steps = Number.parseInt(process.argv[3] ?? '1', 10);
        if (!Number.isInteger(steps) || steps < 1) {
          throw new Error(`down expects a positive step count, got ${process.argv[3]}`);
        }
        await down(client, steps);
        break;
      }
      case 'status':
        await status(client);
        break;
      default:
        throw new Error(`unknown command "${command}" (expected up, down or status)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
