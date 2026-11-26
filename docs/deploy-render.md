# Deploying to Render

Everything runs on Render, from one Blueprint (`render.yaml`):

| Service | Render type | What it is |
|---|---|---|
| `katkitchen-web` | web service (Docker, nginx) | **the public address**: manager screens, POS, Super Admin |
| `katkitchen-api` | web service (Docker) | the API server |
| `katkitchen-scheduler` | background worker (Docker) | the cron jobs |
| `katkitchen-db` | Postgres 16 + PgBouncer (transaction mode) | the database |
| `katkitchen-redis` | Key Value | the entitlement cache |

`katkitchen-web` is the same nginx image as the local stack. It forwards
`/api/*` to `katkitchen-api` over Render's private network, so the browser sees
one origin and the client keeps its relative paths. nginx re-resolves the API's
address every 10 seconds, because a redeployed API gets a new one.

All five services are pinned to one region: the private network only joins
services in the same region.

> **Free trial instead?** `render.free.yaml` runs the same app on free plans,
> for demos only. Follow [Free trial](#free-trial-renderfreeyaml) at the end;
> it changes steps 1, 3, 4 and 6.

---

## 0. Before you start

Generate three role passwords from a secure random source. Hex keeps them safe
inside a URL:

```powershell
1..3 | % { $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') }) }
```

Keep them in a password manager as OWNER, APP and READONLY. Commit and push
`render.yaml` to the branch Render will build.

## 1. Render: create the Blueprint

Render dashboard → **New → Blueprint** → choose this repository.

It asks for the `DATABASE_URL_*` values of each service. They cannot be known
yet: enter `pending` for each. **The first deploys of
`katkitchen-api` and `katkitchen-scheduler` will fail. That is expected**, and
step 3 fixes it.

Wait until `katkitchen-db` shows **Available**.

## 2. Create the three roles (once)

Render gives no superuser. `scripts/bootstrap-managed.mts` uses the database's
admin user to do what `db/bootstrap/*.sql` does locally: it creates the
`katkitchen_owner`, `katkitchen_app` and `katkitchen_platform_readonly` roles,
hands the database to `katkitchen_owner`, and installs `citext` in the
`extensions` schema.

From `katkitchen-db` → **Connect → External**, copy the URL and run this from
the repository root:

```powershell
$env:ADMIN_DATABASE_URL = '<External Database URL>?sslmode=require'
$env:KATKITCHEN_OWNER_PASSWORD = '<OWNER>'
$env:KATKITCHEN_APP_PASSWORD = '<APP>'
$env:KATKITCHEN_READONLY_PASSWORD = '<READONLY>'
pnpm db:bootstrap:managed
```

Render may add a suffix to the database name (`katkitchen_fc08`); the name is at
the end of the URL. If it did, also set `$env:KATKITCHEN_DATABASE_NAME =
'katkitchen_fc08'` before running this. The script refuses any database other than
the one named, so a URL pointing at the wrong database still stops here.

It ends with `verified: three roles, none superuser, none BYPASSRLS`. It is safe
to run again; a rerun resets the three passwords, which is also how you rotate
them.

## 3. Fill in the database URLs

From **Connect → Internal**, take the hostname (it looks like `dpg-xxxxxxxx-a`).
In **katkitchen-api → Environment**, set all four below; in
**katkitchen-scheduler → Environment**, set the first two. (They are on each
service rather than in a shared group because Render ignores `sync: false`
values inside an environment group.)

| Key | Value |
|---|---|
| `DATABASE_URL_OWNER` | `postgres://katkitchen_owner:<OWNER>@<host>:5432/katkitchen` |
| `DATABASE_URL_APP` | `postgres://katkitchen_app:<APP>@<host>:6432/katkitchen` |
| `DATABASE_URL_PLATFORM_READONLY` | `postgres://katkitchen_platform_readonly:<READONLY>@<host>:5432/katkitchen` |

If Render suffixed the database name (step 2), use the suffixed name at the end of
each URL, here and in step 5.

Only `DATABASE_URL_APP` uses **6432**, Render's PgBouncer. The others must be
direct: migrations and the scheduler's job lock need a session of their own.
(Older versions also asked for `DATABASE_URL_APP_DIRECT`, for the kitchen
screen's `LISTEN`; it went with the kitchen screen. An existing one can be
deleted from the service's environment, or left: nothing reads it.)

## 4. Deploy the API and the scheduler

> **Updating an existing deployment to the Basic-only version (migration 0077)?**
> The pre-deploy step applies 0077 and seeds the new console keys on its own. Then,
> once, against the live database (its External URL in `DATABASE_URL_OWNER`):
>
> 1. **Back it up first** (`pg_dump -Fc`).
> 2. `corepack pnpm tsx scripts/move-to-basic.mts --dry-run`, read what it would
>    move, then run it without `--dry-run`. It moves every live subscription to
>    Basic through the ordinary plan change and retires Standard and Pro. Nothing
>    is deleted.
> 3. Empty the Key Value cache (`FLUSHALL` from the Render shell), so every
>    restaurant reads its new plan at once.
> 4. Staff passwords were revoked by 0077 (staff are PIN-only now). Each staff
>    member needs a 4-digit PIN from their Sales person (console → Restaurants →
>    the restaurant → Staff) before they can sign in on the till.

**Manual Deploy** on `katkitchen-api`, then on `katkitchen-scheduler`.

The API's pre-deploy step runs the migrations and the seed as the owner role.
In the API's logs, look for:

```
startup: database safety probes passed
listening on :<port> — 166 routes served
```

If the probes fail, **the API refuses to start, and that is the design
working**. The one thing not yet tested against real Render is whether its
PgBouncer accepts our own roles (it was tested against a simulated non-superuser
host). If `DATABASE_URL_APP` is refused at login, the fallback is to run
`db/pgbouncer/transaction.ini` as a private Render service of its own.

The scheduler's logs should show `scheduler.heartbeat: succeeded` every five
minutes, and `outbox.drain` and `print.drain` every minute.

## 5. The first Super Admin

```powershell
$env:DATABASE_URL_OWNER = 'postgres://katkitchen_owner:<OWNER>@<external host>:5432/katkitchen?sslmode=require'
$env:PLATFORM_EMAIL = 'you@yourcompany.com'
$env:PLATFORM_PASSWORD = '<a strong password>'
pnpm seed:platform-user
```

Restaurants are then provisioned from `/superadmin`. Do **not** run
`seed:demo` against production.

## 6. The web address

`katkitchen-web` deploys on its own once the API exists; if its first deploy
ran before the API's address was known, **Manual Deploy** it once. Its URL
(`https://katkitchen-web.onrender.com`, or with a suffix) is the address you
give restaurants: `/{slug}` for the manager, `/{slug}/pos` (the one POS link; older
`/{slug}/kot` and `/{slug}/billing` links open the same POS), and `/superadmin`.

Check that `/api` reaches the API through it:

```powershell
curl.exe https://<katkitchen-web URL>/api/public/restaurants/nobody
# {"error":"restaurant_not_found",...}  <- JSON from the API, through nginx
```

A custom domain goes on `katkitchen-web` only (Settings → Custom Domains). The
API needs no public domain of its own.

## 7. Afterwards

- **Close the database to the internet.** The bootstrap and `seed:platform-user`
  are the only steps that need the external URL. Add your IP to the
  database's access control, or remove external access, when you are done.
- **Network printers.** The print worker sends ESC/POS over TCP from Render, so
  a printer on a restaurant's local network cannot be reached. Those jobs fall
  through to the fallback printer, which is the documented behaviour; bills and
  copies printed from the till itself still work.
- **Rotating `JWT_SIGNING_KEY`** (Render → api → Environment) signs everyone
  out. That is the only way to revoke every token at once.

---

## Free trial (`render.free.yaml`)

No card needed, but this is **for demos only**:

- Services **sleep after 15 minutes** without traffic. The next visitor waits
  about a minute.
- **No scheduler** (Render has no free workers): nothing prints, nightly checks
  do not run, and a plan change takes up to 5 minutes to show.
- **The database is deleted 30 days after it is created**, with every
  restaurant in it. Moving to the paid Blueprint later means a new database.
- Render allows **one free database and one free Key Value per workspace**.

What changes from the steps above:

**Step 1.** New → Blueprint → this repository, and in **Blueprint Path** enter
`render.free.yaml`. Enter `pending` for every value it asks for, including
`API_UPSTREAM`.

**Step 3.** Free Postgres has no pooler, so `DATABASE_URL_APP` is **direct, on
port 5432**, like the others:

| Key | Value |
|---|---|
| `DATABASE_URL_OWNER` | `postgres://katkitchen_owner:<OWNER>@<host>:5432/katkitchen` |
| `DATABASE_URL_APP` | `postgres://katkitchen_app:<APP>@<host>:5432/katkitchen` |
| `DATABASE_URL_PLATFORM_READONLY` | `postgres://katkitchen_platform_readonly:<READONLY>@<host>:5432/katkitchen` |

**Step 4: the API migrates itself.** Free services have no pre-deploy step, so
the free Blueprint sets `MIGRATE_ON_START=1` on `katkitchen-api`, and the image's
start script (`deploy/api-start.sh`) then applies the migrations and the seed, as
the owner role from `DATABASE_URL_OWNER`, before the API starts. Every deploy and
every wake brings the schema up to date; with nothing new it says "nothing to
apply" and starts. A failed migration stops the API from starting -- read its
logs. (Before this, nothing migrated a free database, and new code met an old
schema: `relation "platform.tenant_slug_history" does not exist`.)

On a service created before this existed: **Environment** → add
`MIGRATE_ON_START` = `1`, and leave **Settings → Docker Command** EMPTY. A chained
command typed there does not work -- Render passes it without a shell's quoting,
so `sh -c "a && b"` fails with "not found".

Then **Manual Deploy** on `katkitchen-api`. There is no scheduler to deploy.

**Step 6.** A free service cannot receive Render's private-network traffic, so
the web reaches the API at its public address. Copy the API's URL from its
page (e.g. `https://katkitchen-api-xxxx.onrender.com`) and set
`katkitchen-web` → Environment → `API_UPSTREAM` to the host part only:
`katkitchen-api-xxxx.onrender.com`. Then **Manual Deploy** `katkitchen-web`.
