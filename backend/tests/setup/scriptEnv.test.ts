import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every script a human runs loads `.env`.
 *
 * ###########################################################################
 * THE API SERVER COULD NOT BE STARTED FROM A FRESH SHELL.
 *
 * `pnpm dev:api` was `tsx watch src/server/server.ts` -- no `--env-file-if-exists`.
 * From a shell that had not exported the file by hand it answered
 * `startup failed: JWT_SIGNING_KEY is not set`, which reads as "this branch is
 * broken" rather than "this shell has no env".
 *
 * That is the SECOND time this exact defect has shipped. Phase 13 hit it on the
 * test runner, fixed `vitest.config.ts` and the five `db:*` scripts, and wrote
 * down why -- and left `api`, `dev:api`, `seed:demo`, all five `job:*`,
 * `probe:host`, `start` and `db:migrate:built` untouched. A fix applied to the
 * instances somebody happened to hit, rather than to the class.
 *
 * The jobs are the worse half. Under Docker Compose they take their environment
 * from the compose file, so the scheduler profile works and nothing looks wrong;
 * run by hand during an incident -- which is exactly when somebody runs
 * `pnpm job:outbox-drain` -- they fail on a connection error that names no
 * cause.
 *
 * So this reads `package.json` rather than listing the scripts: a script added
 * next year fails this test on the commit that introduces it.
 * ###########################################################################
 */

const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Package name after the scope -> its folder in the repo. */
const WORKSPACE_DIR: Record<string, string> = { api: 'backend', web: 'frontend', shared: 'shared' };

/**
 * Every manifest whose scripts start a node process, and the flag each must
 * carry. Two, because the repo is a workspace: operator scripts at the root
 * and the api package's own `start`/`dev`, which run from `backend` and so
 * reach the one `.env` as `../.env`.
 */
const MANIFESTS: readonly { file: string; flag: string }[] = [
  { file: path.join(ROOT, 'package.json'), flag: '--env-file-if-exists=.env' },
  { file: path.join(ROOT, 'backend/package.json'), flag: '--env-file-if-exists=../.env' },
];

async function scriptsOf(): Promise<readonly { name: string; command: string; flag: string }[]> {
  const out: { name: string; command: string; flag: string }[] = [];
  for (const manifest of MANIFESTS) {
    const parsed = JSON.parse(await readFile(manifest.file, 'utf8')) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(parsed.scripts)) {
      out.push({ name: `${path.relative(ROOT, manifest.file)}:${name}`, command, flag: manifest.flag });
    }
  }
  return out;
}

/**
 * Scripts that start a node process. `vitest` is exempt because
 * `vitest.config.ts` parses `.env` itself -- an exemption with a reason, not a
 * hole -- and the lockfile check touches no database.
 */
const STARTS_NODE = /(^|\s)(tsx|node)\s/;
const EXEMPT = /vitest|check-lockfiles|^tsc|^pnpm /;

describe('the scripts a human runs can find their environment', () => {
  it('passes --env-file-if-exists to every script that starts a node process', async () => {
    const relevant = (await scriptsOf())
      .filter(({ command }) => STARTS_NODE.test(command) && !EXEMPT.test(command));

    // Non-vacuity: if a refactor moved every script out of this file, the filter
    // above would match nothing and the assertion below would pass forever.
    expect(
      relevant.length,
      'no scripts matched, so this gate is checking nothing',
    ).toBeGreaterThanOrEqual(15);

    const missing = relevant
      .filter(({ command, flag }) => !command.includes(flag))
      .map(({ name }) => name);

    expect(
      missing,
      'these scripts start a node process without loading .env. Run from a fresh '
        + 'shell they fail on a missing variable, which reads as a broken branch '
        + 'rather than an unset environment. Add --env-file-if-exists=.env.',
    ).toEqual([]);
  });

  it('names only script files that exist', async () => {
    // The restructure moved every file these scripts run, and the scripts kept
    // pointing at the old paths with every test still green -- `pnpm db:status`
    // was the first thing to notice. Each file argument is resolved against the
    // directory its manifest runs from.
    const FILE_ARG = /(?:^|\s)((?:\.\.\/|[\w.-]+\/)*[\w.-]+\.(?:m?ts|m?js))(?=\s|$)/g;
    const checked: string[] = [];
    const missing: string[] = [];
    for (const manifest of MANIFESTS) {
      const parsed = JSON.parse(await readFile(manifest.file, 'utf8')) as { scripts: Record<string, string> };
      const base = path.dirname(manifest.file);
      for (const [name, command] of Object.entries(parsed.scripts)) {
        // `pnpm --filter @universalpos/<pkg> exec ...` runs inside that package.
        const filtered = /--filter\s+@universalpos\/(\w+)/.exec(command)?.[1];
        const cwd = filtered !== undefined ? path.join(ROOT, WORKSPACE_DIR[filtered] ?? filtered) : base;
        for (const match of command.matchAll(FILE_ARG)) {
          const file = match[1]!;
          if (file.includes('dist/')) continue; // build output: exists only after a build
          checked.push(`${name}: ${file}`);
          if (!existsSync(path.join(cwd, file))) missing.push(`${path.relative(ROOT, manifest.file)} ${name}: ${file}`);
        }
      }
    }
    expect(checked.length, 'no script file arguments were found, so this checks nothing').toBeGreaterThanOrEqual(15);
    expect(missing, 'these scripts run files that do not exist').toEqual([]);
  });

  it('puts the flag where the runtime will read it, not after the script name',
    async () => {
      // `node dist/server/server.js --env-file-if-exists=.env` passes the flag to the
      // PROGRAM as an argument and node ignores it -- the script would look
      // fixed, run identically, and fail identically. Position is the whole
      // difference, so it is asserted rather than assumed.
      const manifest = JSON.parse(
        await readFile(path.join(ROOT, 'package.json'), 'utf8')) as
        { scripts: Record<string, string> };

      const wrong = Object.entries(manifest.scripts)
        .filter(([, command]) => command.includes('--env-file-if-exists=.env'))
        .filter(([, command]) => {
          const parts = command.split(/\s+/);
          const flag = parts.findIndex((part) => part.startsWith('--env-file-if-exists'));
          const script = parts.findIndex(
            (part, index) => index > 0 && /\.(ts|mts|js)$/.test(part));
          return script !== -1 && flag > script;
        })
        .map(([name]) => name);

      expect(
        wrong,
        'the flag must come BEFORE the script path, or the runtime treats it as '
          + 'an argument to the program and silently ignores it',
      ).toEqual([]);
    });
});
