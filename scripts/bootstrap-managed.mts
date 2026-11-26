/**
 * Bootstrap for a MANAGED Postgres (Render) -- the provisioner that
 * db/bootstrap/00_roles.sql says creates the roles "in every other environment".
 *
 *   ADMIN_DATABASE_URL='postgres://<render user>:<pw>@<external host>/katkitchen?sslmode=require' \
 *   KATKITCHEN_OWNER_PASSWORD=... KATKITCHEN_APP_PASSWORD=... KATKITCHEN_READONLY_PASSWORD=... \
 *   pnpm db:bootstrap:managed
 *
 * A managed host gives no superuser. Its admin user has CREATEROLE and owns the
 * database it created, which is enough, with one step the local bootstrap does
 * not need: the admin is made a member of katkitchen_owner so it may hand the
 * database to it. The admin is the stand-in for `postgres` locally -- it is
 * never put in any environment the application or the scheduler reads.
 *
 * Step 2 runs db/bootstrap/01_database.sql itself rather than a copy of it, so
 * the schema, extension and search_path shape has one definition.
 *
 * Idempotent: re-running re-asserts the role attributes and RESETS the three
 * passwords, which is also how they are rotated.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const adminUrl = required('ADMIN_DATABASE_URL');
const databaseName = process.env['KATKITCHEN_DATABASE_NAME'] ?? 'katkitchen';
const passwords = {
  katkitchen_owner: required('KATKITCHEN_OWNER_PASSWORD'),
  katkitchen_app: required('KATKITCHEN_APP_PASSWORD'),
  katkitchen_platform_readonly: required('KATKITCHEN_READONLY_PASSWORD'),
};
for (const [role, password] of Object.entries(passwords)) {
  if (password.length < 24) throw new Error(`the password for ${role} must be at least 24 characters`);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const { rows: [where] } = await client.query<{ db: string; admin: string }>(
    'SELECT current_database() AS db, current_user AS admin',
  );
  // Render may suffix the name (katkitchen_fc08). It is stated rather than taken
  // from the url, so a url pointing at the wrong database is still refused.
  if (where!.db !== databaseName) {
    throw new Error(`connected to database "${where!.db}"; expected "${databaseName}" (KATKITCHEN_DATABASE_NAME)`);
  }
  const admin = client.escapeIdentifier(where!.admin);
  const database = client.escapeIdentifier(databaseName);

  // Step 1: the roles, with the attributes 00_roles.sql gives them.
  // A non-superuser may not even RESTATE NOSUPERUSER/NOBYPASSRLS on ALTER, and
  // cannot grant either, so ALTER omits them; the check below still verifies both.
  const attributes: Record<keyof typeof passwords, string> = {
    katkitchen_owner: 'NOCREATEROLE',
    katkitchen_app: 'NOCREATEROLE NOCREATEDB',
    katkitchen_platform_readonly: 'NOCREATEROLE NOCREATEDB',
  };
  for (const [role, password] of Object.entries(passwords) as [keyof typeof passwords, string][]) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const verb = rowCount === 0 ? 'CREATE' : 'ALTER';
    const create = verb === 'CREATE' ? 'NOBYPASSRLS NOSUPERUSER ' : '';
    await client.query(
      `${verb} ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(password)} ${create}${attributes[role]}`,
    );
    console.log(`${verb === 'CREATE' ? 'created' : 'updated'} role ${role}`);
  }

  await client.query(`GRANT katkitchen_owner TO ${admin}`);
  await client.query(`ALTER DATABASE ${database} OWNER TO katkitchen_owner`);
  await client.query(`ALTER DATABASE ${database} SET timezone = 'UTC'`);

  // Step 2: the database shape, from the one definition of it.
  const sqlPath = fileURLToPath(new URL('../db/bootstrap/01_database.sql', import.meta.url));
  const sql = readFileSync(sqlPath, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  await client.query(sql);
  console.log('applied db/bootstrap/01_database.sql');

  // The startup probe re-checks this on every boot; checking here too means a
  // host that silently grants more than asked fails now, not at first deploy.
  const { rows } = await client.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1)`,
    [Object.keys(passwords)],
  );
  const wrong = rows.filter((r) => r.rolbypassrls || r.rolsuper).map((r) => r.rolname);
  if (rows.length !== 3 || wrong.length > 0) {
    throw new Error(`role check failed: found ${rows.length} of 3, privileged: ${wrong.join(', ') || 'none'}`);
  }
  console.log('verified: three roles, none superuser, none BYPASSRLS');
} finally {
  await client.end();
}
