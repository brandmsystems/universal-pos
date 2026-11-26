/**
 * The bootstrap superadmin: the first person who can open the control plane.
 *
 * ###########################################################################
 * MIGRATION 0002 ANTICIPATED THIS AND NOTHING PERFORMED IT.
 *
 * `platform.platform_user.created_by_platform_user_id` is documented as "NULL
 * only for the bootstrap superadmin, who has no creator" -- so the schema has
 * always expected a first account created by nobody. Nothing created one.
 * `seed-demo.mts` inserts a row with the literal password hash
 * 'argon2id$stub', which is not a hash and cannot verify, because that row
 * exists only to attribute the demo provisioning and was never meant to sign in.
 *
 * With the control-plane login now served, that gap is the difference between a
 * console that works and one nobody can enter.
 * ###########################################################################
 *
 *   PLATFORM_PASSWORD='...' pnpm seed:platform-user
 *
 * Idempotent on the email: run it again to RESET the password of an account
 * that already exists, which is also the recovery path for a locked-out
 * superadmin. It clears the lockout counters, because an administrator who has
 * just proven owner-level database access should not then wait out a timer.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';

const EMAIL = process.env['PLATFORM_EMAIL'] ?? 'admin@katkitchen.local';
const PASSWORD = process.env['PLATFORM_PASSWORD'];
const NAME = process.env['PLATFORM_NAME'] ?? 'Platform Administrator';
const ROLE = process.env['PLATFORM_ROLE'] ?? 'super_admin';

/**
 * No default password, deliberately, and the same argument as `JWT_SIGNING_KEY`:
 * a credential with a fallback is one that every install which forgot to set it
 * shares. A seeded `admin/admin` on a control plane that can enter any
 * restaurant in the estate is not a convenience, it is the incident.
 */
if (!PASSWORD || PASSWORD.length < 12) {
  console.error(
    'PLATFORM_PASSWORD must be set and at least 12 characters.\n\n'
    + "  PowerShell:  $env:PLATFORM_PASSWORD='...'; pnpm seed:platform-user\n"
    + "  bash:        PLATFORM_PASSWORD='...' pnpm seed:platform-user\n",
  );
  process.exit(1);
}

const url = process.env['DATABASE_URL_OWNER'];
if (!url) {
  console.error('DATABASE_URL_OWNER is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const owner = new pg.Client({ connectionString: url });
await owner.connect();

try {
  const role = await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = $1`, [ROLE]);
  const roleId = role.rows[0]?.id;
  if (!roleId) {
    console.error(
      `no platform role ${JSON.stringify(ROLE)} exists. Run \`pnpm db:seed\` first, `
      + 'which seeds the platform role catalogue.');
    process.exit(1);
  }

  // The SAME parameters the login path verifies against, imported from nowhere
  // because this script must not be the second place they are decided. They are
  // stated once here and asserted by the login itself refusing a hash it cannot
  // verify -- if these drift, the account simply will not work and the failure
  // is immediate rather than subtle.
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
  });

  const existing = await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_user WHERE email = $1`, [EMAIL]);

  if (existing.rows[0]) {
    await owner.query(
      `UPDATE platform.platform_user
          SET password_hash = $2, platform_role_id = $3, status = 'active',
              failed_login_count = 0, locked_until = NULL,
              password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [existing.rows[0].id, hash, roleId]);
    console.log(`reset  ${EMAIL} (${ROLE}), lockout cleared`);
  } else {
    await owner.query(
      `INSERT INTO platform.platform_user
         (id, email, password_hash, full_name, platform_role_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), EMAIL, hash, NAME, roleId]);
    console.log(`created ${EMAIL} (${ROLE})`);
  }

  console.log('sign in at /superadmin');
} finally {
  await owner.end();
}
