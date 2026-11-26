/**
 * Why was that control-plane sign-in refused?
 *
 * The login route answers an unknown email and a wrong password IDENTICALLY, on
 * purpose -- distinguishing them turns it into an oracle for which addresses are
 * platform staff. The reason is recorded server-side instead, which is the half
 * an investigation needs and a prober must not have.
 *
 * This reads it back.
 *
 *   pnpm why-refused                      the last 10 platform attempts
 *   pnpm why-refused you@example.com      just that address
 */
import pg from 'pg';

const email = process.argv[2] ?? null;
const url = process.env['DATABASE_URL_OWNER'];
if (!url) { console.error('DATABASE_URL_OWNER is not set.'); process.exit(1); }

const owner = new pg.Client({ connectionString: url });
await owner.connect();
try {
  const attempts = await owner.query<{
    occurred_at: string; outcome: string; reason: string | null;
    claimed_subject: string | null; platform_user_id: string | null;
  }>(
    `SELECT occurred_at::text, outcome, reason, claimed_subject, platform_user_id
       FROM platform.auth_attempt
      WHERE tenant_id IS NULL
        AND ($1::text IS NULL OR claimed_subject = $1::text)
      ORDER BY occurred_at DESC
      LIMIT 10`,
    [email],
  );

  if (attempts.rows.length === 0) {
    console.log('no control-plane attempts recorded.');
    console.log('If the browser showed a refusal and nothing is here, the request');
    console.log('never reached the API -- check the dev-server proxy, not the password.');
  }
  for (const row of attempts.rows) {
    console.log(
      `${row.occurred_at.slice(0, 19)}  ${row.outcome.padEnd(8)}`
      + `${(row.reason ?? '-').padEnd(20)}${row.claimed_subject ?? '-'}`);
  }

  // The account's own state, which is what a lockout actually looks like.
  const who = await owner.query<{
    email: string; status: string; failed_login_count: number;
    locked_until: string | null; last_login_at: string | null;
  }>(
    `SELECT email::text, status, failed_login_count, locked_until::text, last_login_at::text
       FROM platform.platform_user
      WHERE ($1::text IS NULL OR email = $1::text)
      ORDER BY updated_at DESC LIMIT 5`,
    [email],
  );
  console.log('\naccounts:');
  for (const row of who.rows) {
    const locked = row.locked_until !== null && new Date(row.locked_until) > new Date();
    console.log(
      `  ${row.email}  status=${row.status}  failed=${row.failed_login_count}`
      + `  ${locked ? `LOCKED until ${row.locked_until}` : 'not locked'}`
      + `  last_login=${row.last_login_at ?? 'never'}`);
  }
} finally {
  await owner.end();
}
