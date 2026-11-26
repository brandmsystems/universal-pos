# Who watches the scheduler

## The hole, stated plainly

Every job in the registry alerts on failure and on not-having-run, and
`jobHealth` computes both. But **something has to ask**, and that something
cannot be the scheduler: a scheduler that has stopped cannot report that it has
stopped.

This is the same shape as every other absence problem in the project — a DEFAULT
partition silently absorbing inserts, a job exiting 0 having done nothing — one
level up.

## What exists now

- **`scheduler.heartbeat`** runs every five minutes and writes a `job_run` row.
  Its only purpose is to give "the scheduler stopped" a detectable shape: every
  other job is daily, so a dead scheduler would otherwise be invisible for a day.
  With the heartbeat, staleness is detectable in minutes.
- **`pnpm job:health`** prints every job with its age and window, and **exits
  non-zero** if anything is overdue or failing. It is designed to be the thing an
  external checker runs, not a thing a human reads.

## What does not exist: the external asker

**Deferred, deliberately, and this is the hole.** Two options, both requiring
something outside this repository:

1. **Dead-man's switch** (preferred). The heartbeat job additionally pings an
   external service on each success; that service alerts when the ping stops.
   The property that matters is that the *absence* of a signal is the alert, so
   nothing inside our infrastructure has to survive for the alert to fire.
2. **External uptime monitor** polling a health endpoint that serves
   `jobHealth`. Cheaper to add once Phase 7 exists, but weaker: it depends on the
   API process being up, which is a different failure from the scheduler being
   up.

Until one of these is wired, **a dead scheduler is silent**. The heartbeat makes
it *detectable*; it does not make it *noticed*.

## Why it is not solved in-repo

Anything we run to check the scheduler is itself something that can stop, and
checking *that* needs another checker. The regress only terminates at something
outside the system whose whole job is to notice silence. Adding a second internal
checker would look like a fix and move the hole rather than closing it.

**Wire the dead-man's switch before the first production tenant.**
