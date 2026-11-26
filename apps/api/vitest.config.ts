import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * ###########################################################################
 * `.env` IS LOADED HERE, BECAUSE THE SUITE IS USELESS WITHOUT IT.
 *
 * Every DB-touching suite calls `ownerClient()`, which throws
 * `DATABASE_URL_OWNER is not set`, and `tests/hooks/defaultPartitionEmpty.ts`
 * refuses to run at all without it -- deliberately, since an assertion that
 * quietly does not run is worse than one that fails. The consequence was that
 * `pnpm test` from a shell which had not exported the file failed 52 of 52
 * suites on a connection error, which reads as "this branch is broken" rather
 * than "this shell has no env". That is exactly what happened on a Windows
 * machine where the env had been exported by hand in an earlier session.
 *
 * ---------------------------------------------------------------------------
 * PARSED HERE RATHER THAN WITH `loadEnv` FROM VITE, AND THAT IS THE POINT.
 *
 * The first version of this file imported `loadEnv` from `vite`. It worked in
 * one checkout and failed with `ERR_MODULE_NOT_FOUND` in the real one, because
 * `vite` is a dependency of the WEB workspace and this is the ROOT package --
 * pnpm does not flatten it into a place the root can resolve, and nor should
 * it. A root config that reaches for a workspace's build tool is wrong even
 * where the resolution happens to succeed.
 *
 * So: no dependency at all. Reading a `KEY=value` file is nine lines, and it
 * cannot be broken by a package layout.
 * ###########################################################################
 */
function envFromFile(path: URL): Readonly<Record<string, string>> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Absent is normal: CI supplies these from secrets and ships no `.env`.
    // Silence here, and a loud failure later from whoever needed the value.
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    // Quotes stripped, because a password containing `#` is legitimate and a
    // naive comment-strip would truncate it.
    out[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// The repo root's `.env`: the suite runs from apps/api, and there is one
// environment file for the whole repo, shared with the operator scripts.
const fileEnv = envFromFile(new URL('../../.env', import.meta.url));
for (const [key, value] of Object.entries(fileEnv)) {
  // Only when absent. An exported value is the operator being explicit and
  // must win over a file that happens to sit in the working directory.
  if (process.env[key] === undefined) process.env[key] = value;
}

/**
 * ###########################################################################
 * THE SUITE RUNS AGAINST ITS OWN DATABASE, NEVER THE ONE THE OWNER USES.
 *
 * Every suite provisions probe restaurants, users and plans, and production
 * never deletes a tenant, so fixtures cannot clean up after themselves. Pointed
 * at `katkitchen` the suite left 326 test restaurants among the owner's real
 * ones. So every DATABASE_URL_* is re-pointed at `katkitchen_test` (created by
 * `pnpm db:test:create`, migrated and seeded by tests/hooks/globalSetup.ts),
 * through the same roles and the same pooler, so the postures are unchanged.
 * TEST_DATABASE_NAME overrides the name, e.g. for a CI database.
 * ###########################################################################
 */
const testDatabase = process.env['TEST_DATABASE_NAME'] ?? 'katkitchen_test';
for (const key of Object.keys(process.env)) {
  if (!key.startsWith('DATABASE_URL')) continue;
  const url = new URL(process.env[key]!);
  url.pathname = `/${testDatabase}`;
  process.env[key] = url.toString();
}

export default defineConfig({
  test: {
    globalSetup: ['./tests/hooks/globalSetup.ts'],
    /**
     * The WEB workspace tests are not ours to run.
     *
     * Vitest's default `include` is repo-relative, so `web/tests/**` would be
     * collected by this config -- in the NODE environment, with the audit
     * partition hook below demanding a database connection, for a test whose
     * whole purpose is to render a component into a DOM. It would fail on
     * `document is not defined` and read as a broken branch.
     *
     * `web` has its own vitest config with a jsdom environment and no database
     * hook, run by `pnpm --filter ./web test`. Same reasoning as the note above
     * about `loadEnv`: a root config must not reach into a workspace, and a
     * workspace's suite must not be dragged into the root's.
     */
    exclude: ['**/node_modules/**', '**/dist/**'],
    // These suites open transactions that do DDL against a shared database.
    // Running files in parallel would have them lock each other out.
    fileParallelism: false,
    // Runs after EVERY test file: the DEFAULT audit partition must be empty.
    // A non-empty default is the production alert that the partition job has
    // stopped, and it can only be trusted if fixtures cannot dirty it. Per-file
    // so the failure names the suite responsible.
    setupFiles: ['./tests/hooks/defaultPartitionEmpty.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
