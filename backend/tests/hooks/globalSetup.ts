import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Brings the test database up to date before any suite runs: migrations, the
 * catalogue seed and the audit partitions -- the same three commands an
 * operator runs, through the same entry points, so the test schema cannot be
 * built differently from a real one. Idempotent; a second run applies nothing.
 *
 * Refuses outright if the target is the owner's database: vitest.config.ts
 * re-points every URL, and this is the check that it did.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STEPS = [
  ['backend/src/core/database/migrate.ts', 'up'],
  ['backend/src/core/database/seed.ts'],
  ['backend/src/core/database/partitions.ts'],
] as const;

export default async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL_OWNER'];
  if (url === undefined) throw new Error('DATABASE_URL_OWNER is not set; the suite cannot reach a database');
  const name = new URL(url).pathname.slice(1);
  if (name === 'katkitchen') {
    throw new Error('refusing to run the suite against katkitchen, the development database');
  }

  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
  } catch (error) {
    throw new Error(
      `cannot connect to the test database "${name}" (${(error as Error).message}). ` +
        'Create it once with `corepack pnpm db:test:create`.',
    );
  } finally {
    await probe.end().catch(() => undefined);
  }

  for (const [script, ...args] of STEPS) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: ROOT, env: process.env, encoding: 'utf8',
    });
    if (run.status !== 0) {
      throw new Error(`${script} ${args.join(' ')} failed on ${name}:\n${run.stdout}\n${run.stderr}`);
    }
  }
}
