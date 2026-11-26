# Local print agent: the design, and what was built (2026-11-11, migration 0085)

**Status:** built 2026-11-11 (migration 0085), with these changes from the proposal below:

- **No pairing code and no JWT** (decisions 3 and 5). The manager is shown the agent token `<slug>.<secret>` once, and the agent sends it as its bearer on every poll; the server checks its hash against `app.print_agent` each time. That is one step fewer and makes revocation immediate, with no token lifetime to wait out.
- **Short polling every 2 s** instead of a 25 s long poll: no request holds a connection, and a ticket waits at most about 2 s.
- **One route**, `POST /api/agent/poll`: it reports the last results and takes the next jobs.
- **`print_job.claimed_by = 'agent:<id>'`** instead of a new column.
- **Test print and reachability live on `app.printer`** (`reach_*`, `test_print_*`), not as a `print_job` kind, so `print_job.kot_id` stays NOT NULL.
- **No DPAPI** (decision 9): the token is in `agent.json`, protected by file permissions.
- Kitchen tickets only; bills keep the print dialog (decision 6). A crash between sending and reporting can print a ticket twice (open question 1). The agent remembers what it sent, so a report that was merely lost does not reprint.

Setup: `apps/print-agent/README.md`. Behaviour: `katkitchen.md` 5.5.

## The problem

The print worker runs on the server. On Render that server is in the cloud and
cannot open a TCP connection to `192.168.1.50:9100` in a restaurant. So on the
hosted site, Wi-Fi and Ethernet printers never get a kitchen ticket. Bills can
reach them only through the till's print dialog, which works only if the printer
is installed in Windows.

## The shape

A small program on one PC in the restaurant (usually the till) that:

1. holds its own credential for **one branch of one restaurant**;
2. connects **out** to the API over HTTPS and long-polls for that branch's print jobs;
3. sends each job to the network printer **named on the printer row**, never to an
   address carried in the job;
4. reports printed or failed, so the existing attempts, backoff and fallback apply.

Nothing listens on the restaurant's network or the internet. The agent opens no
port, and Render never connects in.

## Decisions it rests on

| # | Decision | Proposal | Why |
|---|---|---|---|
| 1 | Who claims a network job | **The agent, when the branch has a live agent; else the server worker as today.** One claim column, so a job is never printed by both | The worker already claims with `claimed_by` and reclaims by age. A second claimant fits that model; a second queue would be a duplicate printing system |
| 2 | The credential | A row in a **new `app.print_agent`** table (tenant, branch, name, token hash, status, `last_seen_at`, revoked by and when). Reversible migration | `app.device` is a till that people sign in on: a PIN, leases, the tablet limit. An agent has none of those, and reusing the row would make every device query exclude it (absence as a discriminator) |
| 3 | The token | A **fourth token shape**, `typ: 'print_agent'`, carrying `agent_id` and `act_branch_id`, **not** `tenant_id`. Rejected by the tenant and platform guards by type and by shape, like impersonation | A tenant JWT for an agent would pass every `/api/t/*` guard. The agent must reach only its own routes |
| 4 | Its routes | `/api/agent/*`, a new plane with its own registrar: `GET /jobs` (long poll, 25 s), `POST /jobs/:id/result`, `POST /heartbeat`. Every call re-reads `print_agent.status`, as refresh re-reads `device.status` | Revocation must work within one poll. The registrar sets the tenant GUC from the agent row, so RLS applies |
| 5 | Pairing | Manager screens → Printers → **Set up print agent** issues a single-use code `<slug>.<secret>` (hash stored, 15-minute expiry, `printer.edit`, audited). The agent redeems it once at `POST /api/auth/print-agent/pair` (recorded in `auth_attempt`) | The same shape as the old tablet setup codes, which the project already reasoned through |
| 6 | Bills on a network printer | **Phase 2 of the agent.** `print_job` is tied to a kitchen ticket (`kot_id NOT NULL`); bills need a `kind` column with a `bill_id` and a positive CHECK. Until then, bills keep the print dialog | Kitchen tickets are the gap today. Bills already have a working path |
| 7 | Where it may print | Only printers of **its branch**, `connection_kind = 'network'`, address passing `parsePrinterAddress`. Checked on the server (the job query) **and** in the agent before it dials | The agent is on the LAN, so this is what stops a stolen agent token from scanning the network |
| 8 | Test connection / Test print for a network printer | Manager screens send a `test` job through the same queue; the panel shows the agent's result and `last_seen_at` | One path. The server cannot test a LAN printer itself |
| 9 | Packaging | Node 22 script in `apps/print-agent`, no dependencies beyond Node, run by Windows **Task Scheduler** at logon with restart on failure. The token is stored with Windows DPAPI (current user) | An installer or service wrapper is a later convenience; this one can be run and inspected |

## Failure behaviour

- **Agent offline:** jobs wait. After the existing claim timeout and attempts they
  walk to the fallback printer. The Printers page shows "Print agent last seen
  12 min ago" from `last_seen_at`.
- **Two agents at one branch:** both may poll; `FOR UPDATE SKIP LOCKED` gives each
  job to one of them.
- **A result that never comes back** (the agent crashed mid-send): the claim ages
  out and the job is retried. A ticket can then print twice, which is the trade
  the worker already makes. The ticket says REPRINT only for a manual reprint, so
  this needs a decision: accept it, or mark a reclaimed job "may be a duplicate".

## What it costs

- One reversible migration: `app.print_agent`, the pairing code table, and
  `print_job.claimed_by_agent_id`.
- A token type, a guard, a registrar and three routes. The plane gates need
  updating: registrar, audit posture, error contract, route ratchets.
- `apps/print-agent` with its own tests against a fake TCP printer.
- Docs: the install steps.

Estimated at several days. It cannot be tested against a real network printer
here, because the owner's ATPOS M80 is USB and Bluetooth only.

## Open questions for the owner

1. Accept that a crash between send and report can print a ticket twice (above)?
2. Bills through the agent in the first version, or kitchen tickets first?
3. Task Scheduler and a script, or is a proper Windows installer needed from the start?
