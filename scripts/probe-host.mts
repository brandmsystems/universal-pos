/**
 * Host probe: is a candidate Postgres deployment one this system can run on?
 *
 * ###########################################################################
 * RUN THIS BEFORE CHOOSING A HOST, NOT AFTER.
 *
 * Several requirements here are not tunables -- they are the conditions under
 * which tenant isolation, the kitchen display and the job runner work at all. A
 * managed product that cannot satisfy them is not a slower option, it is a
 * different architecture. CLAUDE.md: "if the host cannot provide them, that is a
 * hosting decision to change."
 *
 *   pnpm probe:host --pooled "postgres://app@pooler/db" --direct "postgres://owner@db/db"
 *
 * Two URLs, because two requirements are about the DIFFERENCE between them: SET
 * LOCAL must survive its transaction through the pooler, and LISTEN must survive
 * on a session the pooler never touches. Pointing both at the same URL is a
 * valid smoke test and proves nothing about the pooler.
 *
 * Exits non-zero if any requirement fails, and prints every requirement either
 * way -- "which ones passed" is the question a hosting decision turns on.
 * ###########################################################################
 */
import pg from 'pg';
import { assertDatabaseSafety } from '../backend/src/core/database/startupChecks.js';

const REQUIRED_MAJOR = 16;
const EXPECTED_ROLES = [
  'katkitchen_owner',
  'katkitchen_app',
  'katkitchen_platform_readonly',
] as const;

export interface Requirement {
  readonly id: string;
  readonly why: string;
  /** Which connection it must be checked on. The distinction IS the requirement. */
  readonly on: 'pooled' | 'direct';
  readonly check: (client: pg.Client) => Promise<void>;
}

export class RequirementFailed extends Error {
  constructor(readonly id: string, message: string) {
    super(message);
    this.name = 'RequirementFailed';
  }
}

function fail(id: string, message: string): never {
  throw new RequirementFailed(id, message);
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    id: 'server-version',
    on: 'direct',
    why:
      'row-level triggers on a partitioned parent propagate to partitions created later, ' +
      'which is what lets the append-only guard on the audit log be a trigger at all',
    check: async (client) => {
      const { rows } = await client.query<{ v: string }>('SHOW server_version_num');
      const major = Math.floor(Number(rows[0]!.v) / 10000);
      if (major < REQUIRED_MAJOR) {
        fail('server-version', `server is major ${major}; ${REQUIRED_MAJOR} or later is required`);
      }
    },
  },
  {
    id: 'three-roles',
    on: 'direct',
    why:
      'three roles, never two: the owner runs DDL, the app serves requests under RLS, the ' +
      'read-only role reads the control plane. A host that will not let you create roles ' +
      'cannot separate them',
    check: async (client) => {
      const { rows } = await client.query<{ rolname: string }>(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
        [[...EXPECTED_ROLES]],
      );
      const present = new Set(rows.map((r) => r.rolname));
      const missing = EXPECTED_ROLES.filter((r) => !present.has(r));
      if (missing.length > 0) fail('three-roles', `missing role(s): ${missing.join(', ')}`);
    },
  },
  {
    id: 'no-rls-bypassing-roles',
    on: 'direct',
    why:
      'a superuser bypasses RLS unconditionally. If the host forces your administrative role ' +
      'to be superuser, the owner cannot be the migration role and the isolation model has ' +
      'no floor',
    check: async (client) => {
      const { rows } = await client.query<{
        rolname: string; rolsuper: boolean; rolbypassrls: boolean;
      }>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])',
        [[...EXPECTED_ROLES]],
      );
      const bad = rows.filter((r) => r.rolsuper || r.rolbypassrls);
      if (bad.length > 0) {
        const named = bad
          .map((r) => `${r.rolname}${r.rolsuper ? ' (SUPERUSER)' : ''}` +
            `${r.rolbypassrls ? ' (BYPASSRLS)' : ''}`)
          .join(', ');
        fail('no-rls-bypassing-roles', `these roles bypass RLS: ${named}`);
      }
    },
  },
  {
    id: 'database-timezone-utc',
    on: 'direct',
    why:
      "rule 8, and it makes date_trunc('month', now()) in the partition job independent of " +
      'whatever timezone a calling session happens to carry',
    check: async (client) => {
      const { rows } = await client.query<{ TimeZone: string }>('SHOW timezone');
      const tz = Object.values(rows[0]!)[0] as string;
      if (tz !== 'UTC') fail('database-timezone-utc', `database timezone is ${tz}, expected UTC`);
    },
  },
  {
    id: 'citext-available',
    on: 'direct',
    why:
      'email and slug uniqueness are case-insensitive at the database rather than in ' +
      'application code, so a host that forbids the extension changes the identity model',
    check: async (client) => {
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_available_extensions WHERE name = 'citext'",
      );
      if (Number(rows[0]!.n) === 0) {
        fail('citext-available', 'the citext extension is not available on this host');
      }
    },
  },
  {
    id: 'listen-on-direct-connection',
    on: 'direct',
    why:
      'the kitchen display fans out through LISTEN/NOTIFY. LISTEN is SESSION-scoped, so a ' +
      'transaction-mode pooler hands the session away at COMMIT and the subscription appears ' +
      'to succeed and then silently receives nothing',
    check: async (client) => {
      const received: string[] = [];
      client.on('notification', (msg) => {
        received.push(msg.payload ?? '');
      });
      await client.query('LISTEN katkitchen_probe');
      // Committing between LISTEN and NOTIFY is deliberate: that COMMIT is
      // exactly where a transaction-mode pooler takes the session back.
      await client.query('BEGIN');
      await client.query("SELECT pg_notify('katkitchen_probe', 'ping')");
      await client.query('COMMIT');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('UNLISTEN katkitchen_probe').catch(() => undefined);
      if (!received.includes('ping')) {
        fail(
          'listen-on-direct-connection',
          'a NOTIFY sent after LISTEN was never delivered. Either this connection goes through ' +
            'a transaction-mode pooler, or the host does not support LISTEN/NOTIFY. Every ' +
            'kitchen screen depends on it.',
        );
      }
    },
  },
  {
    id: 'session-advisory-locks',
    on: 'direct',
    why:
      'the job runner holds pg_advisory_lock for the whole job so a second copy cannot start ' +
      'on top of it, and releases it by dropping the connection. Both need a session the ' +
      'pooler is not reusing underneath',
    check: async (client) => {
      const key = 872_401_001;
      const taken = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS ok', [key]);
      if (!taken.rows[0]!.ok) fail('session-advisory-locks', 'could not take an advisory lock');
      // Held ACROSS statements, which is the property a job run depends on.
      const held = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND pid = pg_backend_pid()`,
        [key],
      );
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
      if (Number(held.rows[0]!.n) === 0) {
        fail(
          'session-advisory-locks',
          'the advisory lock was not held on the following statement, so a pooler is reusing ' +
            'the session underneath and two copies of a job could run at once.',
        );
      }
    },
  },
  {
    id: 'transaction-scoped-pooling-and-app-posture',
    on: 'pooled',
    why:
      'SET LOCAL must survive to the end of its transaction and not past it; the app role must ' +
      'not bypass RLS, must not own tenant tables, and must hold neither UPDATE nor DELETE on ' +
      'either audit log',
    check: async (client) => {
      // Reused rather than re-implemented. A second copy of the startup checks
      // would drift from the ones that actually gate a boot.
      await assertDatabaseSafety(client);
    },
  },
];

export interface ProbeResult {
  readonly id: string;
  readonly ok: boolean;
  readonly on: 'pooled' | 'direct';
  readonly detail?: string;
}

export async function probeHost(urls: {
  readonly pooled: string;
  readonly direct: string;
}): Promise<readonly ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const kind of ['direct', 'pooled'] as const) {
    const applicable = REQUIREMENTS.filter((r) => r.on === kind);
    if (applicable.length === 0) continue;

    const client = new pg.Client({ connectionString: urls[kind] });
    try {
      await client.connect();
    } catch (error) {
      // A refused connection is a failed requirement, not a crash: the report is
      // more useful than a stack trace when comparing two candidate hosts.
      for (const requirement of applicable) {
        results.push({
          id: requirement.id,
          ok: false,
          on: kind,
          detail: `could not connect on the ${kind} url: ${(error as Error).message}`,
        });
      }
      continue;
    }

    for (const requirement of applicable) {
      try {
        await requirement.check(client);
        results.push({ id: requirement.id, ok: true, on: kind });
      } catch (error) {
        results.push({
          id: requirement.id, ok: false, on: kind, detail: (error as Error).message,
        });
      }
    }
    await client.end().catch(() => undefined);
  }

  return results;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const pooled = arg('pooled') ?? process.env['DATABASE_URL_APP'];
  const direct = arg('direct') ?? process.env['DATABASE_URL_OWNER'];
  if (!pooled || !direct) {
    console.error(
      'usage: probe-host --pooled <app url THROUGH the pooler> --direct <owner url, no pooler>\n' +
        '   or: DATABASE_URL_APP and DATABASE_URL_OWNER in the environment\n\n' +
        'The two must genuinely differ in production: several requirements are about which ' +
        'behaviours survive the pooler and which need a session it never touches.',
    );
    process.exit(2);
  }

  // Host:port rather than string equality -- the two urls almost always differ by
  // role, and a note that only fires on byte-identical strings would never fire.
  const endpoint = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}:${parsed.port}`;
    } catch {
      return url;
    }
  };

  if (endpoint(pooled) === endpoint(direct)) {
    console.log(
      'note: --pooled and --direct reach the same endpoint, so no pooler is in the path. ' +
        'Every requirement below can pass while a transaction-mode pooler would break ' +
        'LISTEN and advisory locks. Re-run against the real pooled endpoint before deciding.\n',
    );
  }

  const results = await probeHost({ pooled, direct });
  const width = Math.max(...results.map((r) => r.id.length));

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id.padEnd(width)}  (${result.on})`);
    if (!result.ok) console.log(`      ${result.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} requirements met.`);
  if (failed.length > 0) {
    console.log(
      '\nA failure here is a hosting decision rather than a configuration task. The reason ' +
        'each requirement exists is in this file and in CLAUDE.md.',
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
