# FRONTEND.md

Guardrails for the client surfaces: POS (Phase 8), branch admin (10), superadmin (11).
The kitchen display (Phase 9) was removed with Basic-only (0077); its sections are
kept below as history and marked so.

## Where things live

`apps/web/src/app/<app>/` is each app's shell (platform, admin, pos — three
separate HTML documents, enforced at the bundle; the POS is `index.html`). Screens live in
`features/<domain>/<app>/`, so a feature folder never mixes planes. Talking to
the server is `services/`, pure logic is `lib/` (the truth model is
`lib/remote.ts`), and each app's Tailwind theme is `styles/<app>.css`.

**Shared across all three apps (2026-10-14):**
- **On/off is a `Switch`** (`components/ui/switch.tsx`, Radix: `role="switch"`,
  keyboard, a 40px hit area around a 24px track). Same values as the checkbox it
  replaced (`checked` / `onCheckedChange`); new on/off controls use it.
- **Touch sizes come from the pointer, not the width** (`pointer-coarse:` in
  Tailwind, `styles/touch.css` for form controls): on a touch screen buttons,
  icon buttons, selects and inputs are at least 40px; a mouse keeps the compact
  sizes, so desktop layouts do not move.
- **Reduced motion is honoured once, globally** (`styles/motion.css`):
  transitions and animations are cut to an instant, never to a different state.
- **A table on a page that can be narrow sits in `overflow-x-auto`**, never
  `overflow-hidden`, which cut columns off instead of letting them scroll. Grids
  of cards use `minmax(min(Npx, 100%), 1fr)`, so a minimum wider than a phone
  cannot push a card past the edge.

## Why this file exists

The backend is defended structurally. RLS makes a cross-tenant read fail rather
than return the wrong rows; `registerAuditedRoute` refuses at boot; the raw-SQL
gate, the snapshot allowlist, the thin-handler gate and the owner-posture check
all fail a suite rather than a review. **Nothing analogous exists on a client, and
the client is the only part of this system a customer actually looks at.**

The specific hazard is not a crash. A crash is loud and gets fixed in an hour. The
hazard is a screen that shows a number confidently and is wrong: a total that
disagrees with the bill, a menu item priced at yesterday's price, a table that
looks free because a fetch failed, an order that looks sent and is sitting in a
queue. Every one of those is a correct-looking screen, and none of them fails a
type check.

So the rules below are written the same way the schema rules were: the failure is
described as **what a human sees**, and each rule names the mechanism that makes
it fail loudly. A rule with no mechanism is a preference, and preferences do not
survive a busy Friday.

## How to read a rule here

Every rule states its enforcement. Five mechanisms are available, in descending
order of preference:

1. **Unrepresentable.** A type that gives the wrong code nowhere to be written.
   Strongest, because it needs no discipline and no test run.
2. **Boot refusal.** The app declines to start, or the client declines to
   register a screen, exactly as `registerPublicRoute` refuses an audited public
   route. Use where a declaration is missing rather than wrong.
3. **A gate test with a synthetic violation.** An AST scan or lint rule, asserted
   by a component *written the wrong way on purpose* and required to fail. Never
   assert only that production files pass: production files agreeing with a rule
   today is evidence about those files, not about the rule.
4. **A test that runs the real thing.** `assembly.test.ts` found that every login
   would have failed. Its client equivalent boots the real app against the real
   route table.
5. **A runtime invariant** that throws in development and reports in production.
   Weakest, and the only one available for some rules. Say so when it is.

**"Reviewed in PR" is not a mechanism.** Where no mechanism exists, the rule says
`ENFORCEMENT: none yet` and that is a known hole, not a satisfied requirement.

---

## 1. The truth model: every value is `known`, `stale` or `unknown`

A remote value is never simply present or absent. It is one of three things, and
the third is the one that gets skipped:

- **known** — read from a response this client trusts, within its freshness window.
- **stale** — was known, the window has passed or connectivity was lost, the
  value is still the best available.
- **unknown** — never read, or the read failed. **Not empty. Not zero. Not `[]`.**

> **Absence is never a discriminator.** This is the client restatement of the
> NULL-as-absence rule, and it is the highest-value rule in this file.

The bug it prevents: `const tables = data ?? []` renders "no open tables" during a
failed fetch. A supervisor sees an empty floor at 8pm on a Saturday and concludes
the service is over. Nothing threw, nothing logged, the screen is confident and
wrong. The same shape produces "no allergen notes" for a line whose notes did not
load, and that one ends in an ambulance.

**ENFORCEMENT: unrepresentable, plus a gate test.** Remote data enters the app as
`Remote<T> = { state: 'known', value: T, at: Timestamp } | { state: 'stale',
value: T, at: Timestamp } | { state: 'unknown', reason: UnknownReason }`. There is
no `.value` on the `unknown` branch, so a component that renders a value without
handling all three does not compile. The gate scans for `?? []`, `?? 0`, `?? '-'`
and optional-chaining into a render position on any `Remote`-derived value, and
is asserted by a synthetic component that does exactly that.

**Stale must be visible, and per-value, not per-screen.** A banner saying
"offline" at the top of a screen whose body shows six numbers tells the waiter
nothing about which of the six moved. The primitive that renders a stale value
carries its own marking and its `at`.

**A stale value may never be an input to a decision the client presents as
authoritative.** Stale stock is fine to show and may not gate an item's
availability; stale entitlement flags may not enable a button. In both cases the
server already decided — see rule 2.

---

## 2. Provenance: where a number on screen is allowed to come from

**Every figure a customer or a manager acts on comes from a server response, and
the client's job is to render it.** Three prohibitions follow, and each has a
backend decision behind it.

**The client never re-derives menu availability.** `BoardResponse.menu` arrives
with precedence already applied and a reason per item. A tablet holding
`not_listed`, `out_of_service_hours` and `sold_out` as three booleans gets 11:01am
wrong, and "available from 07:00" is not "sold out" to the person asking.

**The client never sums lines to display a bill total.** The deferred balance
trigger is the authority, combo components are priced by largest-remainder
allocation, and a client-side sum will disagree by a rupee on exactly the orders
that contain a combo and a discount. A total that disagrees with the printed bill
in front of the customer is the single most expensive class of bug this file
exists to prevent — expensive because the waiter is the one who has to explain it.

**The client never sends a price.** It sends an item id and a quantity. This is
the thin-handler rule's client half: the gate already stops a handler taking a
catalogue price from a request body, and this stops the tablet offering one.

**ENFORCEMENT: gate test on the API client's request types** — no mutation body
type may contain a field named `price`, `unitPrice`, `amount` for a catalogue
item, or `total`. Tender and discount amounts are the deliberate exceptions,
allowlisted by name with the same reasoning as the backend: the customer handed
over that cash, a manager decided that discount, and each is bounded server-side
by the deferred balance trigger and the role's cap respectively.

---

## 3. Money

**One primitive. Minor units in, a formatted string out, no arithmetic anywhere
else.** No component adds, multiplies, divides or rounds a monetary value, and
`/ 100` appears in exactly one file.

The failure this prevents is not a wrong total — rule 2 already forbids computing
one. It is the quiet kind: a line showing `₹0.00` for a 40-paise modifier because
somebody formatted with one decimal, or a quantity-times-price display that
rounds differently from the server's allocation and makes a correct bill look
arithmetically broken.

**ENFORCEMENT: unrepresentable, plus a gate.** `Minor` is a branded integer with no
arithmetic operators exposed; the formatter is the only consumer.
`apps/web/tests/moneyGate.test.ts` scans every source file outside `lib/money.ts`
for `/ 100`, `* 100` and arithmetic on a `minorFrom(...)` result, proven by
synthetic lines built to violate each rule. Two shapes that are not money are
recognised **per line, never per file**: a CSS percentage (`* 100}%`) and a line
about basis points. **Until 2026-10-10 this paragraph described a gate that did not
exist**; building it found the console formatting money by hand, two private copies
of the rupee parser, and a cart total summed on the client — all now through the
money module, and the cart total removed.

**The one calculation, and why it is allowed: the payment preview (2026-10-20).**
While a cashier types Card / UPI / Other / Cash amounts, the payment panel shows a
dashed box labelled **PREVIEW**: each method as applied (`UPI −₹100.00 · Cash
−₹17.60`), **Added**, **Balance after this payment**, and **Change to return** when
cash is over. It comes from ONE pure function, `previewPayment` in `lib/money.ts`
(integer minor units, so the gate still holds: no arithmetic outside the money
module), which mirrors the server's `takePayment` rule exactly:

- non-cash parts first, in the order given; each one **above what is left is
  refused, not capped** -- the server throws `PaymentExceedsBalanceError`, so the
  preview names the refusal ("Card is more than the ₹x left to pay -- this payment
  would be refused") rather than showing a figure the server will not record;
- then the one cash note pays what is left, and anything over is change, never
  sales; cash when the other methods already pay it all is refused too;
- **Added** is what the payment takes off the bill, change excluded.

It is a preview of a write the cashier is composing, not a figure the screen
presents as the record: it is labelled, it starts from the server's own
`outstanding_minor`, and after **Add payment** it disappears and the server's
answer (`PaymentReceipt`) is shown instead. It never computes a bill total, a line
total or tax -- those stay on the list in rule 10. Asserted in
`tests/paymentPreview.test.ts` (each rule, both refusals, one-paise amounts) and
`tests/paymentPanel.test.tsx` (live updates while typing, the refusal, the preview
giving way to the server's answer).

**The order's estimate is the server's, not a calculation (2026-10-20, 0081).**
Before Confirm the New order screen shows a dashed **ESTIMATE** -- Items, Parcel
charge (on a parcel), Subtotal, each tax head with its rate, **Payable** -- and
re-asks it 250 ms after the cart, a quantity, the Parcel switch or the charge stops
changing. Every figure in it is `POST /pos/quote`'s, priced by the functions the
order and the bill are written with (`docs/decision-history.md`, "A parcel charge is a line"); the
screen formats them and adds nothing. Only the newest answer is drawn (a sequence
ref), so a late reply cannot put a total on screen for a cart that has changed; a
refusal (a charge over the branch's maximum) is said beside it and the box goes.
The cart lines still carry no line total and the cart no sum of its own -- the
"No subtotal" rule stands for the client; the estimate is a server answer labelled
as one. Asserted in `tests/newOrderFlow.test.tsx` ("a parcel charge and the
estimate").

**A bill is paid to the nearest rupee, and the screens show the server's figures (0082).**
The bill box shows Grand total, **Round off** and **Net payable**; Balance due, Full and
Exact use the payable (a whole rupee), so the amount a cashier reads is the amount the
server takes -- no paise left owing, no refusal. The receipt prints TOTAL, Round off and
NET PAYABLE; the order screen's estimate and My takings show the round-off the server
answered. The client computes no rounding. Asserted in `newOrderFlow`, `receipt`,
`myTakings`.

**Superseded the same day by the bill round-off above -- paying the rounded balance by card or UPI was a round-off, not an overpayment (2026-10-24).**
Balance due shows the nearest rupee, so a cashier types ₹263 for a ₹262.50 bill.
`roundOffFor` (`lib/money.ts`) makes that a round-off when -- and only when -- the
card/UPI/other amount is a whole rupee, under a rupee over, and clears the bill:
the preview shows "Round off (not sales) ₹0.50", the panel sends `roundingMinor`
with that part, and the receipt prints "Round off" under the payment. ₹264, ₹262.75
or a part payment with a round-off are still refused. The server (`takePayment`)
enforces the same rule, so no client can book an overpayment as rounding.

**My takings shows the server's figures, in four shapes (2026-10-24).** The POS
header's **My takings** (only on `GET /me` `screens.takings`) opens a `Sheet` with
Daily / Weekly / Monthly, **View report**, **PDF**, **Excel** and **Print**. One
function, `takingsReport` (`features/billing/print/takingsReport.ts`), turns the
answer of `GET /pos/my-takings` into labelled sections -- Sales Summary, Bill
Amount, Item Details, Transactions -- and the screen, the receipt-printer copy
(`renderTakingsHtml`, 58 or 80 mm), the Excel workbook (one sheet per section,
money as summable numbers via `unitsFromMinor`) and the PDF are all drawn from it,
so the four cannot disagree. Nothing is summed on the client; the PDF writes "Rs"
because its standard font has no rupee sign. Asserted in `tests/myTakings.test.tsx`
and `tests/tillPos.test.tsx`.

**Bills: history, edits and day end, one component for both apps (2026-11-21).**
`features/billing/history/BillHistory.tsx` serves the POS header's **Bills** (only on
`/me` `screens.bills`; Edit on `billEdit`, Submit Day Bills on `dayEnd`) and the
manager screens' **Bills** section (`billEditAny`, `dayReopen`), told only its route
base and capacity. Days, figures, payment summaries, each bill's state badge
(Editable / Locked / Submitted -- "Bill locked" on the till / Manager reopened /
Editing enabled by manager), `canEdit` and every total after
an edit are the server's: **Check totals** posts the edit to `.../revise/preview`
(the server runs it and rolls it back) and **Save edit** is disabled until that
answer is on screen and is cleared by any change to the edit. On the till a paid
bill offers no way to take an item off. Today's card carries, on the till, a **Bill
Locked** or **Editing Enabled by Manager** banner once the day is submitted, and on
the manager screens (`dayReopen`) the **Allow POS Bill Editing** switch (on asks a
reason, off does not; disabled until the day is submitted; no switch on any other
day). The list and an open bill re-read every 15 s while visible and on focus, so a
switch shows on the till without a new sign-in; the server decides every save.
Submit Day Bills re-reads `GET /pos/day`
and sends the count and payable it showed as `expected`; a moved day is refused by
the server (`day_changed`), never reconciled here. Till writes go through `mutate`
with one consensus key per intent; the manager's through `postDetailed`. Print /
Reprint fetches the counted print and sends one customer copy the same way the
Desk does (the till's own printer, the dialog, or on a phone a sentence saying no
printer is connected). Asserted in `tests/billHistory.test.tsx`.

**A tax rate's split is read, not worked out (2026-10-20).** The Tax rates page
("On a bill") and the food item form show what a rate prints as -- "CGST 2.5% +
SGST 2.5% — within the state", "IGST 5% — across states" -- from
`GET /admin/tax-splits`, the server's own derivation (`features/settings/admin/TaxSplit.tsx`).
The screen has no CGST, SGST or CESS input, halves nothing itself, and says "could
not be read" on a failed read rather than "no tax". Asserted in `tests/taxSplit.test.tsx`.

**The panel is compact (2026-10-20).** Each method is one row -- label, a short
amount box, **Full** / **Exact** -- with no per-row amount beside it (the preview
carries it) and **no slip / transaction-id box**: payments are sent without a
`reference`, which the server already treats as optional.

---

## 4. Optimistic rendering is permitted exactly where the lease makes the device
the single writer

This is the locality rule, restated for the client. An operation may render
optimistically when its invariant is local to the aggregate this device holds
under its lease, and may not when the invariant is global.

That is the same predicate the offline table already answers, so **it is read
from the offline table rather than decided per call site.** Pre-fire line add,
edit and remove render optimistically. Fire renders optimistically — it is
idempotent on the client fire id. Bill generation, tender, refund, void of a
fired line, comp and discount **never** do: they are consensus acts, the server
may refuse, and a tender that appears on screen and then vanishes is the failure
mode where a customer has already walked out.

**ENFORCEMENT: unrepresentable.** The API client exposes `mutate()` for
consensus operations and `mutateOptimistic()` only for endpoints the offline
table marks local. There is no per-screen flag to set, so a new endpoint gets the
right treatment by default — the wrong one requires editing the offline table,
where the reasoning lives.

---

## 5. Idempotency keys are minted when the intent is enqueued, never in the click
handler

Every POS mutation requires an `Idempotency-Key`; the route layer returns 400
without one. **The key is generated at the moment the operation enters the local
queue, stored with it, and reused on every retry for the lifetime of that
operation.**

A key minted inside `onClick` is a new key on the second tap. The waiter taps
Fire, the spinner does not move because the wifi is bad, they tap again, and the
kitchen receives two tickets and the stock ledger two deductions. The header
exists precisely to make that harmless, and minting the key in the handler
disarms it while appearing to satisfy the requirement.

**ENFORCEMENT: unrepresentable, plus a gate.** No component can reach the fetch
layer; only the queue can. Key generation lives in the queue module, and the gate
forbids `randomUUID`/`crypto.randomUUID` and any `Idempotency-Key` literal
outside it, asserted by a synthetic component that mints one.

**X-Lease-Token is attached by the queue too**, from the lease the operation was
enqueued under — not from the current lease. An operation queued under a lease
that has since been force-released must arrive carrying the old token so the
server can quarantine it. Attaching the current token would launder a stranded
device's writes into apparently valid ones, which defeats the only mechanism that
makes force release survivable.

---

## 6. Draft, queued, committed — and what the tablet sleeping does to each

**DECIDED: every keystroke persists to local storage as a draft; nothing becomes a
server operation until fire.**

Three states, and a line is always in exactly one:

| State | Lives in | Survives sleep | Server knows |
|---|---|---|---|
| draft | local storage, written on change | yes | no |
| queued | the outbound queue, with its idempotency key | yes | not yet |
| committed | acknowledged by a response | yes | yes |

Sleep and crash are therefore the same event and need no separate handling: on
resume the draft is still there, the queue is still there, and the board read
reconciles committed state. **A waiter never loses a half-typed order, and a
mis-tap never becomes a void.**

The alternatives, and why not: queueing every line on entry means a mis-tap is a
real operation requiring a manager's void, and pre-fire edits generate queue churn
that the sync path then has to order. An explicit unsaved state with a Save action
loses the in-progress line on sleep, which is the case that prompted the question.

**The cost is a third state to reason about, and it is paid by making it visible
rather than clever.** A drafted line is visually distinct from a queued one, and
a queued one from a committed one. Three states rendered identically is worse than
two states, because the waiter cannot tell whether the kitchen has it.

**ENFORCEMENT: a runtime invariant plus a test that runs the real thing.** The
invariant: a line in the render tree carries its state, and there is no default —
same posture as `audit: 'none'` being explicit. The test drives a real order, kills
the process, restarts it, and asserts the draft and the queue both survived with
the same idempotency keys. `ENFORCEMENT: none yet` for the visual distinction
itself; it is a review item until there is a snapshot suite.

---

## 7. Degradation vocabulary

Every one of these is a state the waiter will meet during a service, and each one
gets its own words. **A generic error toast is a defect in this file's terms**,
because the recovery action differs and the waiter picks wrong.

### The lease going stale

**DECIDED: a countdown becomes visible at 2 minutes remaining; the screen goes
read-only 30 seconds before expiry.**

Read-only *before* the server would reject means the waiter never types a full
order into a dead session — which is the actual cost of the alternative, paid in
front of a table.

**Server time decides, always.** The countdown is rendered from
`lease.expires_at` minus the *server-derived* offset measured at the last
response, never from the device clock. A tablet with a wrong clock must show a
wrong-looking countdown rather than compute a confident one: the offset is
observable, the device's absolute time is not. Renewal is attempted well before
the read-only threshold, and a failed renewal is a stale-lease state, not an
error.

The 30-second margin exists because the lease is renewable and a renewal is a
round trip on the same bad wifi that made this necessary.

**The backend side of this is now built.** `BoardResponse` carries `serverNow`,
so the client measures the OFFSET between its clock and the server's at the last
response and renders the countdown from that. Absolute device time is never an
input. A tablet with a wrong clock shows a wrong-looking countdown rather than a
confident one, which is the correct failure: the offset is observable, the
device's own idea of "now" is not.

**A lease in the response is not necessarily this device's.** The board's lease
query is not filtered by `device_id`; it returns whoever holds the live lease. The
client compares `lease.device_id` to its own and renders "table held by another
device" rather than assuming the lease is a grant to itself.

### Force release

A force-released device **is told**, in those terms, and told what happens to what
it holds: a manager took the table, and anything queued here will be reviewed
rather than applied. Discovering read-only with no explanation makes a waiter
retry, then reboot the tablet, then re-key the order on another one.

This is the one place the client explains quarantine to a non-operator, and it is
worth the words: the batch is kept verbatim and resolved by someone, so nothing
the waiter typed is lost — it is just not theirs to apply any more.

**The backend side of this is now built, and it was the load-bearing one.** The
board used to filter `released_at IS NULL AND force_released_at IS NULL AND
expires_at > now()`, so a force-released lease, an expired one, a normally
released one and a session never leased **all arrived as `lease: null`** — the
client could not tell a manager taking the table from a lease quietly timing out,
which is exactly the distinction this subsection needs.

It now returns the most recent lease row whatever state it is in, carrying
`state` (`live | expired | released | force_released`, force release outranking
expiry) and `seconds_remaining`. **`lease: null` now means exactly one thing:
this session has never been leased.** The client compares `device_id` to its own —
a live lease in the response is not necessarily a grant to the device reading it.

### Print failure

**DECIDED: the print worker retries; the floor is told only when attempts are
exhausted.**

The row is created in the fire transaction and the attempt is not, `max_attempts`
and a fallback printer already exist, so most failures resolve without anyone on
the floor knowing — which is the correct outcome, because the waiter can do
nothing useful about a paper jam mid-retry.

When it does escalate, the words are **"sent, not printed"** and never "failed".
The fire committed. The KOT exists, the stock moved, the kitchen has no paper. A
waiter who reads "failed" re-fires and the kitchen cooks the order twice.

The escalated state offers exactly one action from the POS: reprint, which routes
to `POST /pos/kot/:id/reprint` with `origin = 'reprint'` and is counted. It does
not offer a re-fire, and there is no path from this state to one.

**ENFORCEMENT: a gate on the string.** The KOT-failure surface may not render any
copy from the generic error catalogue; asserted by a synthetic component that
tries.

### Quarantine

Five reasons exist server-side and **the reason is shown, not a boolean.** An
operator resolving one needs to know which of five things happened; a waiter needs
to know only that it is held and by whom it will be looked at. Same data, two
renderings — the operator's is in branch admin, not on the tablet.

### Connectivity

Offline is a first-class mode, not an error state, and it is announced by the
queue's depth and the oldest queued item's age rather than by a network event.
`navigator.onLine` reports the radio, not whether the server is reachable, and a
captive portal in a restaurant reports online while nothing resolves.

**The offline window is a client-visible constraint.** `OFFLINE_WINDOW_HOURS * 3 <
REQUEST_CLAIM_RETENTION_DAYS * 24` is asserted at module load server-side; the
client must show how much of that window is left, because a device that exceeds it
gets its whole batch quarantined. A tablet quietly accumulating twelve hours of
orders is the failure this display exists to prevent.

**A cached menu is used only with its `menuVersion`**, and a version mismatch on
reconnect invalidates it rather than merging. The field exists on `BoardResponse`
for this and for nothing else yet.

---

## 8. Boot, enrolment and identity

The device enrols once, redeeming a single-use token, and holds a device
credential thereafter. A user then identifies with a PIN against that device.
**The device credential and the user session are separate lifetimes and must be
separately renderable:** "this tablet is not enrolled" and "your PIN session
expired" are different problems with different people fixing them, and one screen
saying "please log in again" for both sends the waiter to the wrong person.

PIN lockout is server-side and the remaining lockout is shown as time, not as
attempts. A waiter told "3 attempts remaining" during a rush enters a fourth
guess; one told "locked for 40 seconds" waits.

**The tenant is in the URL for login and PIN** — `/api/auth/:tenantSlug/login`
and `/api/auth/:tenantSlug/pin` — so a client must hold its tenant slug from
first run, before it holds anything else. Enrolment is the exception: the token a
staff member reads out is `<slug>.<secret>` and the tablet posts it whole to
`/api/auth/device/enrol`, which is where the slug comes from in the first place.
**So the slug is the first thing a tablet learns and the last thing it should
forget** — persist it with the device credential, not with the user session.

**A slug can change (0073), and the stored identity moves with it.** When the
public lookup answers with a different slug than the address asked for, or lists
`formerSlugs` at the new one, `moveRestaurantStorage` moves the `pos:`, `kds:`
and `billing:` namespaces and rewrites every stored `tenantSlug` — then the page
opens the same screen at the new address. A tablet opened at either address stays
set up.

**A refused refresh returns the screen to sign-in (2026-10-10).** The client
dropped the session on a refused refresh but told no one, so a shift whose
12-hour refresh had lapsed sat on "the floor has not loaded" with every panel
failing. `api.onSessionEnded` now tells each tenant shell, which shows its
sign-in (the PIN screen, or the owner's till sign-in).

**Two tokens, two lifetimes: access 15 minutes, refresh 12 hours.** The client
refreshes on a 401 and at most once per failed request, never on a timer — a
timer plus a sleeping tablet produces a thundering refresh at every shift change.
A refresh token is not a bearer credential and the server rejects it as one, so it
belongs somewhere the ordinary request path cannot reach by accident.

**A refused refresh is a re-authentication, not an error.** `device_revoked` means
a manager revoked this terminal, and the words say so; anything else means the
shift ended and the waiter enters a PIN. Neither is a generic error toast.

**The owner's till is the second way to become a device (2026-10-09; replaced 2026-10-10 by the one login page, below — `/admin/till` is gone and `setUpTill` is one call to `/api/auth/:slug/till`).** A fresh POS
browser opens on "Sign in to the till": the owner's email and password, then
`POST /admin/till` registers the browser and answers with the till's own session
— the office sign-in is used for two calls and never left behind. A browser that
already holds a device signs THAT till back in (`/admin/till/:id/session`) rather
than registering another, because a second registration spends a second tablet
on the plan; only `till_unknown` makes it register afresh, keeping the browser's
fingerprint. The device identity and the session are stored exactly as enrolment
and PIN store them, so everything downstream — leases, queue, refresh — cannot
tell a till from a tablet.

**Which tabs a POS shows is the server's answer, not the client's guess.** The
Billing tab appears on `GET /me`'s `screens.billing` and the KOT tab on
`screens.kot`, read from the person's permission keys at this branch. The client
never decides it from the plan, the role name or the account type.

**Where dine-in sits is the plan's answer.** `GET /me`'s `seatsAtTables`
(false on Basic) makes the Dine-in tab the counter list (`Parcels kind="dine_in"`,
numbered D-n) instead of the floor; the admin's Setup drops the floor-plan steps on
`entitlements.tables`.

**Where a person lands after signing in is the server's answer, too.** The
restaurant's one login page (`/{slug}`, `SignIn`) reads `lands` from the login
response: `admin` stays on the manager screens; `pos` (or a manager arriving with
`?to=pos`) is signed in on this computer's till with the same credentials
(`api.setUpTill`, one call to `/api/auth/:slug/till`) and sent to `/{slug}/pos`,
keeping no manager-screens session. `/{slug}/pos` has no sign-in screen of its own:
without a session it goes to `/{slug}?to=pos`. The client never decides who is a
manager.

**One POS screen (Basic, 2026-10-13).** No Dine-in, Parcel or KOT tabs: the till
opens on **New order** (`features/billing/billing/NewOrder.tsx`) beside the orders
waiting to be paid (`BillingWorkspace`). Billing staff take dine-in or parcel orders
here. A Parcel switch and an optional customer name sit on the order; each item
takes a quantity and a note for the kitchen (folded behind a **+ Note** until wanted).
The Parcel switch adds a **Parcel charge** box (0081), filled with the branch's usual
charge from the first estimate and editable up to the branch's maximum ("Up to
₹50.00"); a branch with no maximum shows the box disabled and says so; a non-amount
stops Confirm. **Confirm order** writes online, one
step at a time -- open (`/pos/dine-in` or `/pos/parcel`), lines, the parcel charge
(`/pos/order/:id/parcel-charge`, only when above 0, under its own fixed key), `fire`,
hand-over -- and the order then opens with its bill made, for payment. The charge is
a line of the order, so the bill, the Desk's line list, payment and every printed or
reprinted copy carry it ("Parcel charge" above Sub Total on the customer and counter
copies; never on the kitchen copy). On the bill screen (Desk) a parcel order keeps a
**Parcel charge** box with **Update** and **Remove** until money is taken: the
server voids the unpaid bill and the Desk makes it again (same route and key as
Create bill). A charge cleared to 0 stays a line on the server and is not listed.
Asserted in `tests/newOrderFlow.test.tsx` ("changing the parcel charge on the bill
screen"). `fire` stays: it is what
records the lines as sent to the kitchen, numbers the ticket, and lets the hand-over
pass; there is no kitchen screen and no KOT workflow to drive.

**Confirm prints nothing. The copies print once the bill is PAID (0078).** Confirm
opens the order and makes its bill; no print dialog opens. When a payment answers
`outstandingMinor <= 0` the till prints the branch's copies ONCE (a ref keyed by bill
id, so a replayed payment answer does not print twice) -- straight to the print dialog
when the branch prints automatically, otherwise into the **print preview** with a Print
button. A part payment prints nothing by itself; **Print bill** is there for it. The
copies, each labelled at the top (`renderCopiesHtml`, `print/receipt.ts`):

| Copy | Content | Where it goes |
|---|---|---|
| **CUSTOMER** | the bill: order number (D-n / P-n), bill no, items, quantities, totals, payments, balance | handed to the customer |
| **KITCHEN** | the kitchen ticket: same order number, KOT number, items, quantities, add-ons, notes, no money | billing staff hand it to the kitchen |
| **COUNTER** | the same bill as the customer's | kept at the counter |

The labels are short because they head a 2-inch roll (2026-10-20; they were "CUSTOMER COPY", "KITCHEN COPY - hand to the kitchen", "BILLING COUNTER COPY - keep at the counter"). A reprint adds **· REPRINT** to the label, and the bill title reads **BILL**, **PART PAID** or **INVOICE** (paid in full; was RECEIPT) -- the defaults of the branch's own headings, set on the **Printed bill** page (0088) -- with **· COPY n** on a counted reprint (was "PART-PAYMENT RECEIPT" and "- REPRINT (copy n)"). The name can be switched off on the **Printed bill** page ("Copy name at the top", `branch.bill_show_copy_label`, 0080): it hides CUSTOMER / KITCHEN / COUNTER only -- a reprint still says **REPRINT**, so a second copy never passes for the first. Every copy of a parcel also says **PARCEL**. The figures are the server's
and the kitchen copy is the server's own ticket text (`renderTicket`, read through
`GET /pos/order/:id/tickets`); the till composes neither.

**A printed set is one counted print, and a reprint never re-sends the order.** The
customer and counter copies come from ONE `POST /pos/bill/:id/print` (copy 1 of a
planned set, so neither says REPRINT). Each copy has its own **Reprint** button, which
opens the preview (`PrintPreview`, one tab per copy, drawn at the paper's width by the
same renderer) and prints from its Print button:
customer and counter reprints are a new counted print (copy 2, 3 -- marked REPRINT on
the paper); a kitchen reprint only READS the ticket again and is marked REPRINT --
never `fire`, never `/pos/kot/:id/reprint`, never a new order, print job or ticket. A
copy that could not be fetched is named on screen ("Did not print: kitchen copy") and
the others still print. The automatic set prints once per paid bill (a ref, not
state); after that, printing is only ever the buttons. Asserted in
`tests/newOrderFlow.test.tsx` (nothing on Confirm, dine-in and parcel paid in cash,
part then full payment, preview when automatic printing is off, each reprint, a failed
fetch) and `tests/receipt.test.ts` (labels, order, parcel marking, no money on the
kitchen copy, paper sizes, show settings).

**The layout is the branch's, carried on every printout (0078).** `POST /pos/bill/:id/print`
answers `layout`: the branch's bill printer (type, paper, orientation, margin, font),
what the bill shows (logo, address and phone, customer name, tax breakdown, payments),
which copies print, and whether they print by themselves. The till never keeps a copy
of these. Printer TYPE is chosen before PAPER and decides it: thermal takes a 2, 3 or
4-inch roll (portrait only), laser and inkjet take A5 or A4 (portrait or landscape);
the table's CHECKs hold the pair together and a network printer is thermal. With no
bill printer chosen the paper is the 3-inch roll every bill used before. A roll's content
is laid out inside the print head's width, not the paper's (`rollContent`: 72 mm on a
79-80 mm roll; a direct print is 48 characters across it, `rollChars`). The counter
copy always carries the payments and leaves the logo and footer to the customer's.
Turning the tax breakdown off prints the bill's own `taxMinor` as one Tax line -- a
total the server sends, never a sum made here; the GSTIN always prints. Set on the
admin **Printed bill** page, previewed by the same renderer, with **Print a test page**
from this computer (`tests/printerSettings.test.tsx`).
On a roll the copies of one print run on one strip, one straight after the other,
parted by a dashed **tear here** line; only a sheet (A5, A4) gives each copy its own
page. A page break on a roll made the driver feed a whole paper length, or a new
sheet, per copy (`tests/receipt.test.ts`).

**Bill headings (0088).** The bill title is the branch's wording, carried as
`layout.headings` (`unpaid`, `partPaid`, `paid`; an older API's payload without it
prints the defaults BILL, PART PAID, INVOICE). `receiptTitle(doc, headings)` is the one
place that picks one -- from the server's `kind` and `paidMinor` -- and every path calls
it: the print and preview HTML (customer and counter copies, escaped), the direct
ESC/POS lines, the print frame's title, the Printed bill preview and test page, and
reprints from Bills. A kitchen ticket never carries it. The **Printed bill** page edits
the three in a **Bill headings** section (suggestions as you type, one tap for the
common paid headings, **Reset to default**), checks them with `headingProblem` -- the
same rule as the column CHECK, 1-20 printable ASCII characters after trimming -- and
saves them with its Save. The preview has an **Unpaid / Part paid / Paid** switch and
follows the heading being typed; a blank one previews the default
(`tests/printerSettings.test.tsx`, `tests/receipt.test.ts`, `tests/directPrint.test.ts`).

**What each connection really does.** A NETWORK printer gets kitchen tickets from the
server (ESC/POS over TCP); bills reach it only through this computer's print dialog.
The server cannot reach a USB or Bluetooth printer, and the settings page says so
rather than offering it. **The till can (2026-10-29):** when the bill printer is USB
or Bluetooth, on a roll, and this browser has connected a serial port
(`print/serialPrinter.ts`, Web Serial -- a Bluetooth Classic printer through the COM
port Windows makes when it is paired; Web Bluetooth is BLE and cannot), the copies go
to it as ESC/POS text with no dialog. Everything else stays on the dialog.

- **One send path.** `sendCopies` is the only caller of `printHtml` for copies and the
  only writer to the port; Desk and the Printed bill test page both use it. It takes
  pages already fetched, so a Retry resends THOSE pages -- no counted print, ticket
  read, order or payment is asked for again (asserted in `newOrderFlow`).
- **One set of rows.** `copyLines` lays out the rows `renderCopiesHtml` prints
  (place, tax rows, payment rows, status, labels -- shared helpers in `receipt.ts`),
  in fixed-width code-page-437 text; the kitchen copy is the server's ticket text.
  No logo; a script the code page lacks prints `?`.
- **Nothing is claimed.** A serial printer reports nothing, so the status is
  "sent", never "printed". A copy that broke mid-write is not re-sent by itself: it
  and the copies after it are named, with Retry and Use the print dialog.
- **Per till, in this browser:** the port permission (the browser's own) and the
  "Cut the paper" switch (localStorage, off by default -- a cut sent to a printer
  without a cutter may print as junk). Status in the POS header (`PrinterConnection`).

**The kitchen printer.** `fire` still queues the server's own kitchen print job for
the kitchen's configured printer. With the manual hand-over, the kitchen copy above
IS the kitchen's ticket, so a restaurant that also has a **network** kitchen printer
configured gets that ticket twice -- set its kitchen to the till's printer (USB), or
decide to stop the server job on Basic, which is a backend change.
**Idempotency-key custody:** one Confirm is one attempt whose keys are minted ONCE,
one per step and per line, and reused on every retry; an in-flight ref (not state)
refuses a second tap in the same instant. Once the order exists the cart locks and
the button reads **Try again**, which resumes the same order -- a retry can never
open a second order or a second kitchen ticket. A retry that finds the order
already in billing (`order_in_billing`) is the hand-over having landed, and counts
as done. The automatic bill uses the same key as the Create bill button. Asserted in
`tests/newOrderFlow.test.tsx`, including a dropped connection mid-way.

**Staff Login: cards, then the PIN; the manager by username and password (2026-10-16).**
`/{slug}` is the manager's page with **Staff Login** top right. On a till, `/{slug}/pos`
shows the staff as cards (`PinLogin`, Screen 2), then the tapped person's 4-digit PIN
(Screen 3, auto-submits on the 4th digit), then the POS. Its **Manager login** opens
the form below. Asserted in `tests/staffPin.test.tsx` and `tests/tillPos.test.tsx`.

**Username and password, one form, two doors (2026-10-16).** `/{slug}` is the manager's page, with **Staff Login** top right;
`/{slug}/pos` shows the SAME `SignIn` form in POS mode (`pos.onTill`), signing in on
this computer's till for staff and the manager alike -- no staff list, no PIN, no
`?to=pos`, no redirect. The Sales person sets every username and password (console:
restaurant -> Sign-ins; create restaurant sets the manager's). Asserted in
`tests/oneLogin.test.tsx`, `tests/tillPos.test.tsx` (direct `/{slug}/pos`),
`tests/staffSignIns.test.tsx` and API `salesStaffSignIn`.

**One sign-in on the till for staff and the manager (0078, superseded).** A card per staff member
and ONE unnamed **Manager** card; whoever is tapped types a **username** and the
4-digit PIN. A staff card sends the tapped `userId` AND the typed username, and the
server signs in only when both name the same person (otherwise `subject_unknown`,
indistinguishable from a wrong PIN). The Manager card sends the username alone. The
public list never names a manager (`tillStaff` excludes holders of `user.view`), so the
till shows no name worth guessing a PIN for. The manager sets their own username and
PIN on POS Access (`POST /admin/access/me/pin`, current password required); the Sales
person still cannot. Asserted in `tests/staffPin.test.tsx` and API `tillSignIn`.

**Staff sign in on the till by name and 4-digit PIN (0077).** `PinLogin` shows the
till's staff as tiles from `GET /api/public/restaurants/:slug/till/staff` (the
fingerprint in `x-device-fingerprint`), then a keypad: it submits on the 4th digit,
hides the PIN unless asked, and says how long a lockout lasts from the server's
`retryAfterSeconds` rather than its own guess. A `tablet_not_set_up` answer forgets
the till and shows "Manager sign-in" (`/{slug}?to=pos`); there is no setup code and
no other way to make a till. The restaurant's login page is the manager's alone: a
staff account is refused by the server (`staff_use_pin`), and the page says where
staff sign in. The admin offers no staff management -- **POS Access** is read only;
staff are added, given PINs and switched off by the Sales person in the console
(`features/restaurants/platform/TenantStaff.tsx`), which never shows a manager as
changeable. Every one of those answers is the server's; the client only stops
offering what would be refused.

**The installable POS app (2026-11-25).**
- **Boot.** Before the first render, `app/pos/main.tsx` links the restaurant's own
  manifest (`services/posApp.ts`: `linkPosManifest`) and registers `/pos-sw.js` with
  the scope `/{slug}/pos` (`updateViaCache: 'none'`). It also starts listening for
  Chrome's install prompt, because the prompt can arrive before React draws.
- **Two slugs.** Each slug gets its own manifest link, `id` and worker scope, so two
  restaurants on one phone are two apps.
- **The worker caches nothing.** It only turns a failed page load into a
  "No connection" page; a deploy reaches an installed app exactly as it reaches a tab.
- **iPhone.** It ignores the manifest's name and icons, so `setPosAppIdentity` sets
  `apple-mobile-web-app-title` ("{name} POS"). It sets `apple-touch-icon` to the logo
  only when the logo is square and at least 180 px; otherwise it uses `index.html`'s
  UniversalPOS icon.
- **Install help.** The POS shows its install help (`InstallHelp`, with one-tap
  install where the browser offers it) only when opened with `?install=1` and not
  already running as the installed app. Closing it removes the query.
- **Manager card.** On the dashboard, **Install POS App** gives the link and a QR code
  drawn on the device from `qrcode`'s matrix (an SVG path, no network). It shows
  "Tills set up: n of m" from `GET /admin/entitlements`' usage and the plan's
  `devices`, says nothing when that read fails, and at the limit says a further phone
  can install but not become a till.
- **iPhone storage.** A Home Screen app keeps its own storage, apart from Safari's,
  so the steps say to set the till up inside the installed app. Setting up in Safari
  first would spend a till on Safari.
- Tests: `tests/posApp.test.tsx`. It also runs the worker in a sandbox and reads
  `deploy/web.nginx.conf` to check where each address goes.

**ENFORCEMENT: a test that runs the real thing** — enrol, identify, refresh,
revoke, against the real routes on the app-role pool. The server half exists now
as `tests/http/authSurface.test.ts`. The client half does not: a POS that has
never been driven through a real enrolment is the same hazard one layer up, and
the backend's version of this bug — every login failing silently because public
routes went through the tenant registrar — was found by booting the real thing
and by nothing else.

---

## 9. Entitlements come from the board, never from the client's idea of the plan

`BoardResponse.entitlement.features` is the authority. The client does not know
what plan the tenant is on and must not infer capability from anything else it can
see. A feature flag absent from the response is `unknown`, and an unknown feature
renders as unavailable rather than as enabled — **the one place in this file where
absence does decide something, and it decides in the safe direction.**

---

## 10. The list of things the client never computes

Kept as a list on purpose, because it is the list somebody will want to add to,
and the addition is where the next defect enters. **A new entry requires a
justification in this file, in the same direction as the reporting allowlist.**

- menu availability, or any of its three reasons
- a bill total, a line total, a tax figure, or a combo component price
- whether a discount is within a role's cap
- whether a lease is valid (only how long the server said it had left)
- whether stock is sufficient to sell an item
- a business date
- whether an invoice is due, overdue, or in dunning

Everything on that list is derived server-side today. A client that computes any
of them is not merely duplicating logic — it is asserting a second answer, and the
two will diverge in production long before anyone notices which is right.

---

## 10a. The brand, and the two places it collides with these rules

Assets: `web/public/brand/katkitchen-wordmark.jpg`, `web/public/brand/katkitchen-mark.jpg`.
Values below are **sampled from those files**, not eyeballed.

| Token | Value | Where it came from |
|---|---|---|
| `--brand-from` | `#F9A008` | top of the gradient, both marks |
| `--brand-to` | `#FA5C00` | bottom of the gradient |
| `--brand-solid` | `#FB7E08` | the midpoint, for where a gradient will not do |
| `--brand-ink` | `#000000` | "Kitchen" in the wordmark, and the tagline |
| `--brand-surface` | `#F7F7F7` | the ground the logo is presented on |

The gradient runs **vertically**, light at the top: `linear-gradient(180deg,
#F9A008, #FA5C00)`. It is the same gradient on the K mark and on "Kat", so one
token drives both and a logo lock-up cannot drift from a button.

### The UI tokens the first design pass settled

Drawn from the POS and kitchen artboards, so code and canvas cannot drift:

| Token | Value | Note |
|---|---|---|
| type, UI | `Archivo` | fallback `'Helvetica Neue', Arial` — close metrics, and PNG/PDF export shows the fallback |
| type, figures | `IBM Plex Mono` | tabular numerals; every quantity, price, time and countdown |
| `--radius` | `4px` | one value for every card, button and field |
| `--stroke` | `1.75` | every inline-SVG icon, on a 16/20/24px grid |
| `--ink-muted` | `#6B6B6B` | 5.32:1 — the floor for body-size grey. `#8A8A8A` (3.45:1) is not usable |
| `--hairline` | `#E2E2E2` | |
| POS hit target | `56px` | 64px+ for anything tapped mid-service; 44px is the floor, not the target |
| KDS ground | `#111111` | the kitchen screen is glanced at across a bright room, not read up close |

**A contrast gate covers the pairs, not the tokens.** Every foreground/background
pair actually used together is enumerated and its ratio computed in a test, with
the floor stated per pair — 4.5 for text, 3.0 for large text and borders. A new
pair fails until it is listed.

### Collision 1: the brand orange cannot be text

Measured against white:

| Colour | on `#FFFFFF` | verdict |
|---|---|---|
| `#F9A008` | **2.09:1** | fails everything |
| `#FB7E08` | **2.60:1** | fails everything |
| `#FA5C00` | **3.18:1** | large display type (≥24px) and UI borders only |

AA needs **4.5:1** for normal text and **3.0:1** for large text and interface
borders. So **no brand orange is ever a text colour at body size**, on white or on
`#F7F7F7` (which is worse: 1.95–2.97:1). Where a label genuinely has to read as
brand-coloured, `#B84300` gives **5.47:1** and is still recognisably the same
hue — it belongs in the token set as `--brand-ink-orange`, and the gradient stays
for marks, fills and large display type.

**A filled orange button takes BLACK text, not white.** White on `#FA5C00` is
3.18:1; black on it is 6.60:1, and black on `#F9A008` is 10.06:1. This is not a
taste call — a tablet at arm's length under kitchen lighting is the worst reading
condition in the building, and it is where every order is entered.

**ENFORCEMENT: a gate.** Every foreground/background token pair used together is
enumerated and its ratio computed in a test, with the floor stated per pair
(4.5 for text, 3.0 for large text and borders). A new pair fails until it is
listed — an allowlist, for the usual reason.

### Collision 2: the brand hue is the warning hue

Orange is what a UI means by "caution", and rule 7 needs a waiter to tell four
degradation states apart at a glance. **If brand orange is also the primary action
colour, "sent, not printed" cannot be orange** — the single most consequential
warning in the product would look like the Fire button.

So the alert palette is chosen **away from the brand hue** and the brand keeps the
primary action:

- primary action, navigation, marks → the brand gradient
- **needs attention** (sent-not-printed, lease expiring, queue near cap) → an
  amber that is deliberately NOT `--brand-solid`, or better, a non-hue signal:
  weight, an icon and a border, so it does not compete with the brand at all
- **stop** (quarantined, force-released, tender refused) → red, reserved and used
  nowhere else
- **unknown** (rule 1) → neutral grey, never a colour that implies a value

**ENFORCEMENT: `none yet` beyond the contrast gate.** "Two oranges a waiter can
tell apart mid-service" is not something a test can assert; it is the first thing
to check with a real person on a real tablet during the pilot.

### One practical gap

Both assets are **JPEG with `#F7F7F7` baked in**, so neither can sit on a dark
surface, a coloured header, or the enrolment screen's own background. A POS runs
on a tablet whose theme may be dark and whose splash needs a transparent mark.
**SVG is the format this needs** — the shapes are flat vector geometry, so it
costs nothing but the export, and it also makes the gradient a token the code sets
rather than pixels nobody can recolour.

---

## 10b. What the first real client changed

### The queue has a pump, and the pump is registered once

`apps/web/src/services/pump.ts`. Started in `App.tsx`, only while somebody is on shift.

`createQueue` minted keys, persisted intents, capped itself and reported its
depth — all correct, all tested — while **nothing in the application ever sent an
item**. An enqueue that is never drained is worse than a failed write: the tap
appeared to work, the depth counter says "1 waiting", and the order does not
exist.

**Strictly serial, strictly FIFO.** Two operations in flight can arrive out of
order, and `order.line.add` followed by `order.line.edit` reordered is an edit to
a line that does not exist yet. The queue is a queue, not a pool. The drain loop
stops the moment the head cannot go, because the next item is not independent of
it.

**One pump per process.** Two would send the same operation twice under two
different keys, which is exactly what the queue exists to prevent. It is created
in `App.tsx` with `useMemo` and nowhere else.

**Backoff is capped and reset on wake.** A tablet coming back from sleep does not
serve out its backoff — the reason it failed was probably that it was asleep.

---

### Refused work is moved aside, never deleted

`queue.reject(id, code, detail)` moves an operation to a persisted `rejected`
list. The shift header shows the count in red with a "Seen" button.

A queued write that vanishes is indistinguishable from one that succeeded. The
whole reason the server *quarantines* a batch rather than dropping it is that
somebody has to be able to see what did not happen; the client owes the same.

It is also moved **out of the head**. A permanently-refused operation left at the
front of a serial queue takes the rest of the shift's work down with it.

**Lease refusals drop the lease too.** On `lease_token_unknown`,
`lease_subject_mismatch`, `lease_not_held` or `lease_force_released` for a
`/pos/session/:id/...` path, the pump calls `leases.forget(sessionId)` —
otherwise every following operation for that table queues behind a credential the
server has already killed. Order and bill paths do **not** carry the session, and
the pump deliberately does not guess: the client does not hold the
order→session mapping for a table it has lost, and inventing one would forget the
wrong table.

---

### `timestamptz::text` is not ISO 8601, and `Date.parse` returns NaN for it

`apps/web/src/lib/pgtime.ts`. One parser, total, returns `number | null`.

Postgres renders `2026-09-01 14:56:42.009022+00`: a space instead of `T`, six
fractional digits, and a **two-digit** offset. `Date.parse` needs `T` and `+00:00`
or `Z`, so the obvious `.replace(' ', 'T')` produces `NaN` — which does not
throw, does not warn, and propagates as a number.

What it cost: a lease countdown that rendered `NaNm NaNs`, and — the real damage
— an order pane that declared itself **read-only**. `secondsRemaining > 0` is
false for NaN, so the read-only branch won and the screen told a waiter the
tablet was not holding a table it was holding.

A comparison against NaN fails *closed*, which is the safe direction and
therefore the direction nobody notices in a test that only asserts refusals: the
wrong answer **was** a refusal.

So: `null`, never NaN, because null is a value the type system makes you handle.
`HeldLease.expiresAtMs` is `number | null`, and a lease with an unparseable
expiry keeps its token, renders "no time shown" rather than zero, and renews on
every tick rather than never.

Tested in `tests/web/pgtime.test.ts`, including an explicit assertion that the
naive replace *is* NaN — so the test is not vacuous.

---

### The lease holder is a map, persisted, on server time

`apps/web/src/services/lease.ts`.

**A map, not a slot.** A waiter working four tables at once is the normal case,
not an edge one. One timer renews all of them; renewal happens when a lease is
under eight minutes, checked every sixty seconds and again on every foreground —
a tablet that slept through its window needs one immediately, and the interval
alone would wait a minute.

**Persisted.** A tablet that reloads mid-service must keep writing. A token held
only in memory means a reload silently drops the table's write authority and
every queued operation for it is refused.

**Server time.** `observeServerNow` records the offset between the server's
instant and `Date.now()` at each read; countdowns are drawn against
`Date.now() + skew`. A tablet with a wrong or wound-back clock must not be able
to show itself more time than it has, for the same reason the server decides
expiry rather than the token.

**A failed renewal does not forget the lease.** Offline, the window is still
running down and the token is still the one queued work must carry. Refused, the
next write will say so with a reason.

**An expired-looking lease still returns its token.** The server decides. A
refusal carrying a reason is more useful than a client that silently declines to
try; what the UI must not do is present it as live.

---

### Four table conditions, and the dangerous one has a name

> **Removed (Basic POS, 2026-10-13):** the floor, the order pane and the KOT board
> were deleted -- see "One POS screen" below. This section and the next are the
> record of what they decided.

`apps/web/src/features/orders/pos/Floor.tsx` (deleted). Occupancy is the **border**; writability is the
**fill**. Two separate facts, drawn separately, so neither can be read off the
other.

```
free       no session at all
ours       a session, and this tablet holds the live lease
theirs     a session, leased by another device
unleased   a session with NO live lease — never claimed, released,
           expired, or force-released
```

`unleased` is the one a naive board loses. A session with `lease: null` looks
exactly like a free table if the only thing rendered is the lease, and a waiter
who reads that as free seats a second party onto a live bill. It is hatched
**and** captioned, because hatching alone reads as decoration — and the caption
says *which* of the four unheld reasons it is, because "a manager took it off a
tablet" and "the tablet holding it went quiet" are not the same event and the
server is the only place that knows which happened.

Opening a table claims its lease in the same gesture. Creating a session with no
lease on purpose would be leaving a trap on the board.

---

### Draft, queued, committed — three states, drawn differently

`apps/web/src/features/orders/pos/Order.tsx` (deleted with the order pane).

A line the waiter has tapped but not sent is a **draft**: theirs, no server
identity, freely changeable, dashed and captioned "not sent". A line handed to
the queue is **queued**: it has an idempotency key, it will be sent, and it
cannot be edited because the edit would race its own creation. A line the server
has acknowledged is **committed** and carries a real total.

Rendering all three identically is how a waiter reads an unsent line as sent,
tells the kitchen it is coming, and the tablet is holding it.

**No subtotal.** `line_total_minor` comes from the server, which snapshotted the
price onto the line. A subtotal added up on the client is a second opinion about
money, and the priced-document rule says there is one. Until a bill exists there
is no total, and the pane shows none rather than inventing one.

**The lease token is read once, at enqueue, for the whole batch.** Every line in
a send carries the epoch it was composed under, so if the lease is force-released
while they sit in the queue they are all refused together — which is correct:
they were one waiter's one intention at a table they no longer hold.

**Fire carries the session version from the board.** Captured at enqueue and sent
verbatim. A version read at *send* time would always agree with the server and
defeat the check.

---

---

## 10c. The kitchen display

> **Removed (0077).** The kitchen screen, its SSE stream and `kds.html` are gone;
> the kitchen works from the KITCHEN COPY the billing staff hand over (see "Three
> printed copies" above). Kept as the
> record of what was decided while it existed. The client pieces it names
> (`services/stream.ts`, `api.stream`) were deleted in the 2026-11-14 cleanup;
> they are in git history (before that date) if a stream ever returns.

### `EventSource` cannot authenticate, so the KDS does not use it

The browser's `EventSource` sends no custom headers — there is no way to attach a
bearer token. The two usual workarounds are both wrong here: a token in the query
string ends up in access logs, proxy logs and browser history, and a cookie would
mean the API accepts cookie auth, which is a CSRF surface the whole token design
exists to avoid.

So `apps/web/src/services/stream.ts` is a plain `fetch` with an Authorization header,
read through a `ReadableStream` and framed by hand. About forty lines, and it buys
back the property that a kitchen screen authenticates like everything else.

Two details that are not optional:

- **Frames are separated by a blank line and a chunk boundary lands anywhere.** A
  partial frame stays in the buffer. Parsing what has arrived so far is how a
  client silently drops every event that happens to be split.
- **A comment frame (`: ping`) is the heartbeat, not an event.** It holds the
  connection open through idle NAT timeouts; treating it as an event would make
  the board re-read every 25 seconds for nothing.

`api.stream` deliberately does **not** apply refresh-on-401. A stream that
silently re-authenticated would reconnect forever against an ended shift with
nobody told; the failure surfaces and the screen says it is disconnected.

### An event is a poke, not a patch

The server publishes `{kind, stationId, at}` — it does not send the new board.
The client must not fight that. Applying a diff from an event means the screen's
state is the sum of everything it has seen, so one missed frame is a screen that
is quietly wrong for the rest of the service. An event triggers a **re-read**,
which is idempotent and self-correcting. The one exception is `snapshot`, sent
once at connect, which *is* the board — and it doubles as the first read, because
a separate initial fetch would be a second instant.

### A kitchen screen must say when it has stopped listening

This matters more here than anywhere else in the product. A POS that loses its
connection queues work and the waiter finds out on the next tap. A kitchen screen
that loses its connection **keeps displaying a board that looks exactly like a
correct one**, and the kitchen cooks from it. Ten minutes of that is a service's
worth of wrong food.

So the connection is drawn permanently, in three distinguishable conditions
rather than a dot that is either there or not — live, connecting, off with a
retry count — encoded as a colour *and* a shape (filled square vs hollow) *and* a
word. And past the first retry, a bar across the whole screen: *"Not connected to
the till. What is on this screen may already be wrong — do not work from it."*
At that point the board below it is a photograph and should be described as one.

### The kitchen board never queues, and says so

Every POS write goes through the queue. No KDS write does. A bump that arrives ten
minutes late is worse than one that did not happen: the ticket has already been
served, or another screen has moved it, and the offline write would re-advance it
on reconnect. The offline message names this rather than saying "retry".

### Tokens are the POS palette inverted, and none of the numbers match

Read from two or three metres, in a hot bright steamy room, by someone whose
hands are full:

- Dark ground. A white screen at that size is a lamp in a room already full of
  light bouncing off steel.
- Type from 22px; the ticket number is 34px. The POS's 15px body is unreadable at
  the pass.
- 96px touch targets, not 56px — the tap is made with a knuckle or the side of a
  hand.
- **Three encodings per state**: colour, position and a word (`waiting` / `on` /
  `ready`). Colour alone fails under a heat lamp, and a red/green pair is the most
  common colour-blind confusion there is. Same for the late warning: a border
  colour, a minute count, and the word "late".
- Minutes only, never seconds. Seconds change every tick and pull the eye off the
  ticket that matters.

### `expectedVersion` is the version the screen is SHOWING

Two screens over one pass is the normal arrangement, not an edge case. The version
sent is the one rendered, so the second screen's tap on an item the first already
moved is refused with `kds_version_conflict` rather than advancing it twice. On
refusal the board re-reads either way — a stale-view refusal means this screen is
behind, and leaving it behind is the failure the refusal exists to catch.

### The screen does not list stations, and that is not a shortcut

The `kds` system role holds `kds.view`, `kds.item.advance`, `kds.item.bump` and
`kds.item.recall`. It does **not** hold `kitchen.station.view`, so a cook's
session cannot read `GET /admin/stations`. There is no route a kitchen screen can
call to find out which stations exist.

Three ways out, and why this one:

| option | why not |
|---|---|
| add the permission to `KITCHEN` | a role change, a Phase 1 decision, does not belong behind a screen build |
| a new `/kds/stations` route | another route and another ratchet, for a list read once in the life of the screen |
| **configure the station on the screen** | what physically happens: it is bolted above one station and never moves |

The id arrives as `kds.html?station=<uuid>`, is verified by **reading the board
once**, and is then persisted. Verified by reading, not by validating the shape:
a well-formed uuid for a station in a sister branch is exactly the mistake a chain
makes when it copies a screen's configuration, and only the server can catch it.
(It could not, until this screen tried — see the `station_unknown` note in
`docs/decision-history.md`.)

Leaving the board clears the **station**, not the session: re-pointing a screen is
a manager's act and must not also sign the kitchen out.

### Two documents, one build, and a gate on the output

`kds.html` is a separate entry point, not a route inside the POS. Two reasons, and
the second is the one that matters: a kitchen screen is often the oldest device in
the building, and if the KDS were a route in the POS bundle then a bug in the
tender flow would be loaded, parsed and evaluated on the kitchen display. The
kitchen losing its board because the till has a problem is the opposite of what a
separate device is for.

`tests/web/bundleSeparation.test.ts` reads the **built** bundles rather than the
import graph — a dynamic import, a barrel re-export, or a bundler hoisting a
shared chunk would all defeat an import check while shipping the code anyway — and
asserts each set of markers is present in its own bundle, so the check cannot go
vacuous on a typo. Current split: 11.9 kB kitchen, 28.8 kB till.

**A bundle is its entry chunk plus everything it loads (2026-10-10).** The gate
used to read only the chunk files whose *names* began with the app's, so the
Billing workspace, hoisted by the bundler into a shared `Desk-*.js`, reached the
KOT document with every assertion green. It now follows the built `import`
statements from each entry, which is the only reading of "what ships" that a
hoisted chunk cannot slip past.

**DECIDED: the KOT document ships the Billing workspace.** The owner's till is
Dine-in, Parcel and Billing on one sign-in, so the money path is in the KOT
bundle on purpose, and the gate asserts it positively rather than letting a
marker go unchecked. What stays separated is the reason the rule existed: the
kitchen display loads no money code at all, and Billing ships no KOT order
taking.

What IS shared: enrolment and PIN sign-in, screens and all. A kitchen display
enrols as a device and signs in with a PIN exactly like a till, and two copies of
an enrolment form is two places for the composite-code rule to drift.

---

## 10d. Branch admin

### Password, not PIN, and that is the whole authentication decision

A PIN is four digits typed in front of a room. It is the right credential for
"this waiter opened table 6" and the wrong one for "this person changed the price
of every item on the menu". Admin signs in with an email and a password over
`POST /api/auth/:slug/login`, and no enrolment is involved: a manager works from a
laptop that is not a registered terminal.

The consequence is visible throughout: a password session carries **no
`branch_id`**. Every branch-scoped list therefore returns every branch, which is
correct for someone signed in at the tenant level — and it is why the admin list
handlers apply the branch scope *from the token* rather than assuming one is
present.

The slug is typed in full, for the same reason the POS asks for a composite
enrolment code: the pre-auth tenant rule is that the tenant comes either from
something verified or from something a human typed in full, and a laptop has
neither a device record nor an enrolment.

### The client does not know what the columns are, and must not

The server returns a declared allowlist per resource. The table renders whatever
comes back. That is not laziness — it is the only arrangement in which the column
allowlist is a single fact. A client with its own per-resource column list is a
second declaration, and the failure is silent in the direction that matters: the
server stops returning a field, the client keeps a header for it, and every row
shows blank where a value used to be.

So `Table.tsx` has no per-resource knowledge at all. What it has is a rendering
rule per **column kind** — money, timestamp, boolean, id, status — declared in
`tokens.ts` and applied by name. A column nobody has named renders as raw text
with its name shown ugly, so a new field arrives *visible* rather than absent.

Two related rules:

- **An em-dash, never an empty cell.** "Not set" and "the column was omitted" are
  different facts and a blank cell says neither.
- **Ids are truncated and monospaced**, so the truncation reads as a truncation
  rather than as the whole value.

### An edit sends only what changed

The server refuses fields it does not declare writable, and refuses the whole
request — so a form submitting every column would lose the one change that was
wanted. The form tracks its own dirty set, offers only the fields the **server**
said are editable, and the Save button says how many changes it will send (or
"Nothing changed", inert).

`fields_not_writable` is shown verbatim, because the server's message names what
the route does accept, and the reason a field is refused is almost always that it
has its own route and its own permission. "Status cannot be set here" is a more
useful sentence than a generic failure.

### Destructive actions take two taps, and the second one names what happens

A single destructive button next to Save is how a manager archives a branch they
meant to rename. The confirm step uses the **server's** word — "Take it out of
use?" for an archive, "Delete it permanently?" for a hard delete — because only
the server knows which this resource does, and a resource that does neither shows
no control at all.

### The nav lists nothing that does not exist

Only resources with served routes appear. A menu entry for "Purchase orders" that
leads to an empty screen is worse than no entry: it tells a manager the feature is
there and broken rather than not built. The eight action surfaces — stock,
purchasing, reports — are named in a line of text at the bottom of the nav
instead, so someone who came looking for them finds out they are not built rather
than concluding they are missing from the product.

### Three documents, and the gate runs both ways

`admin.html` is the third entry point. The blast-radius argument runs in both
directions here: admin edits prices and revokes terminals, and none of that
belongs loaded on a device sitting on the pass or in a waiter's hand. The bundle
gate asserts both directions.

One note on writing that gate: `'Take it'` was a marker for the POS money path
and it matched admin's "Yes, take it out" — a false positive, which in a gate like
this is as damaging as a false negative, because it teaches whoever hits it that
the check is noise. Markers have to be distinctive enough not to collide, and each
one is asserted present in its own bundle so a typo cannot make the check vacuous.

## Decided (additions)

- Admin authenticates with a password and carries no branch; the branch scope is
  applied from whatever the token has.
- No client keeps a copy of a server allowlist — columns, writable fields and the
  meaning of DELETE all arrive in the list response.
- Destructive admin actions are two taps and use the server's word for what will
  happen.

## Open (additions)

- **No create form.** `creatable` arrives in the response and nothing renders it.
  Branches, users, roles and menu items all have working POST routes.
- **No role permission editor.** The `roles` list shows a role's name and key; the
  permissions behind it are `role_permission` rows with no screen.
- **Membership granting has a route and no screen** — which means a newly created
  user cannot yet be given a role from the UI.
- **No stock, purchasing or reports screens.** Roughly twenty served-or-declared
  routes with no UI, and they are actions rather than CRUD so they cannot be
  generated from the resource table.

---

## 11. Testing standards for the clients

The backend's standard carries over unchanged: **a test that verifies zero things
and passes is worse than no test.** Two additions specific to clients.

**Every gate is asserted by a component written the wrong way.** Scanning
production components and finding them clean says nothing about whether the
scanner works — this is the same lesson as the synthetic handler and, at five
instances now, the codebase's default failure mode.

**The POS suite runs against a real server and a small pool.** The board is open
for a whole service; the backend already asserts that a streaming response holds
no connection, with a companion test proving the pool really is that small. The
client half of that is a KDS board left open while POS writes proceed, and it is
the reason to build a thin KDS slice early rather than last.

---

## 12. Decided, and what is still open

### DECIDED: the POS is a PWA

One codebase, no per-restaurant distribution, and every change reaches the floor
without a signing step. **The cost is that rule 6's draft guarantee becomes
conditional**, and pretending otherwise is how a waiter loses an order:

- **Browser storage can be evicted under pressure.** So the client requests
  persistent storage at first run and records whether it was granted. A device
  that was refused is a device whose drafts are at risk, and it says so rather
  than discovering it during a service.

  **The answer is the browser's, it is asynchronous, and the warning follows it**
  (`trackDurability` in `services/storage.ts`). `navigator.storage.persisted()` is
  asked first -- a till granted on an earlier visit is persistent without asking
  again -- then `persist()`. The answer arrives after the first render, so the
  store ANNOUNCES it (`onDurabilityChange`) and the POS keeps it in state; reading
  `durability` once at render left "has not been granted persistent storage" up
  for a whole service on a browser that had granted it a moment later. While the
  answer is `best-effort` the banner offers **Keep this till's work safe**, which
  asks again from a tap (some browsers grant or prompt only on a user gesture); a
  second refusal says what the browser wants (installing or bookmarking the POS)
  and offers **Ask again**. A refusal, a missing API and a throwing one all leave
  `best-effort` and the warning up, never an error. `unavailable` (no storage at
  all) keeps its own hard warning and no button, because asking cannot help.
  **The answer changes what the till SAYS, never what it keeps:** queued work stays
  where the queue put it whatever the browser answers -- it is never dropped to
  match a refusal. Asserted in `tests/storageDurability.test.tsx`.

  Where it is kept is `localStorage`, through this adapter -- not IndexedDB, which
  the original stack line named for Phase 5 and nothing uses. `persist()` covers
  both, so the request protects the store the queue actually uses.
- **The local queue is capped**, and approaching the cap is a visible state — not
  a silent eviction. A tablet quietly holding twelve hours of orders is the
  failure the offline-window display already exists to prevent; storage pressure
  is the same failure with a different cause.
- **All storage sits behind one adapter.** Not for portability in the abstract:
  it is what makes a native shell a replaceable dependency rather than a rewrite,
  and it is the only place `ENFORCEMENT: none yet` for eviction can later become
  a real guarantee.

**ENFORCEMENT: a gate** — no screen imports a storage API directly; `localStorage`,
`indexedDB` and `caches` appear only inside the adapter, asserted by a synthetic
component that reaches for one.

### DECIDED, then REVISED: the control plane is its own document

The original decision was one shell with two route trees, sharing a design
system, an auth stack and the table and form layer, with a gate on the import
graph to stop a superadmin screen importing a tenant-scoped component.

**What shipped goes one level further: a fourth Vite entry, `platform.html`.**
The reason is the argument `bundleSeparation.test.ts` already makes about the
kitchen and the till, one plane further out. A branch admin is a restaurant's
employee. Shipping them the code that lists every tenant, changes plans and
starts impersonation sessions puts the control plane's whole surface area in a
document handed to every customer — readable, and a map of what to attack. And
an import-graph rule is defeated by a dynamic import or a hoisted shared chunk
while the code ships anyway; the built bundle is the only thing that knows what
actually ships.

What is still shared is what this file actually cared about: one design system
(each client has always had its own `tokens.ts` deriving the same palette), one
truth model (`lib/remote.ts`), one storage adapter. What is deliberately NOT
shared is `services/api.ts` — it is built around a tenant session with a slug, a
branch and an offline queue, none of which a control-plane session has. Widening
it would put both planes' session rules in one file.

**ENFORCEMENT: a gate**, on the built output rather than the import graph.
`bundleSeparation.test.ts` asserts the control-plane markers are absent from the
POS, KDS and admin bundles, the tenant markers are absent from the platform
bundle, and — the non-vacuity half — that every marker is present in its own.

**The document has two addresses, and they are addresses, not apps.** Super
Admin lives at `/superadmin/{section}` (`lib/platformPath.ts`), one per sidebar
entry — the section's `path` is its URL slug, separate from its title — and
every other platform role at `/platform.html`. nginx and Vite serve
`platform.html` for both, so there is one shell and one set of screens. The
address follows the signed-in role and is corrected with `replaceState`, never
the other way round: it decides nothing, because every read is authorised by
the server against the token. `superadmin` is a reserved slug
(`SUPERADMIN_SEGMENT`), so no restaurant can shadow it.

### DECIDED (Phase 8)


- The lease token is the client's write credential, persisted, per claim epoch.
  Operations carry the token they were enqueued under.
- Server-rendered timestamps are parsed by `parsePgTimestamp` and by nothing
  else. No `new Date(x)` on a server string anywhere in the client.

### DECIDED (Phase 9) -- history; the kitchen display was removed in 0077


- SSE is consumed by `fetch` + `ReadableStream`, never `EventSource`, and never
  with a token in a URL.
- An SSE event triggers a re-read. No client applies a diff from an event.
- KDS writes never queue.
- The KDS is a separate document, gated on the build output.

### DECIDED (Phase 18): the line-state distinction has a mechanism

> **History:** `lineStates.test.tsx` went with the order pane it gated (Basic POS,
> 2026-10-13). The one POS screen keeps no queued lines -- it writes online, step by
> step -- so there is no third state to draw.

This was the weakest position in this file -- "no mechanism yet, and a snapshot
suite is the obvious candidate". It is now `web/tests/lineStates.test.tsx`, and
it is **not** a snapshot suite.

**A snapshot records whatever was rendered, including a rendering that is
wrong.** A pane drawing all three states identically snapshots green and stays
green, because the snapshot agrees with itself. That is the blocklist-fails-open
shape wearing different clothes: it detects CHANGE, and the rule here is about
DISTINCTNESS. So the gate extracts a signature per state -- outline, fill,
marker, whether a money figure is drawn, whether a control is offered -- and
requires the three to differ on those named properties, not merely to differ.

Proven non-vacuous per section 11 by `PaneDrawnWrong`, a component that draws all
three the tempting way, which the same extraction must catch. The failing
direction was also run against the real pane: with the queued rendering removed
the gate fails naming the missing state.

**BUILDING IT FOUND THE DEFECT IT WAS MEANT TO GUARD.** There were only ever
**two** per-line states. `sendDrafts` cleared the drafts on enqueue and a queued
line has no server id, so it appeared on the board nowhere -- it survived only as
a footer count, `N waiting to reach the till`. Order.tsx's own comment said
"queued lines carry the waiting mark" and there were no queued lines to carry it.

Offline this inverted the very failure the rule exists to prevent: rather than
reading an unsent line as sent, the waiter pressed Send and watched their work
vanish into a counter. Queued lines are now drawn from the queue itself -- which
is what survives a reload, because the device still owes those writes -- solid
but muted, carrying the waiting mark, with no figure and no control, since the
edit would race its own creation.

The pane also now subscribes to `pump.onChange`. It never had: the footer counter
redrew only because the one-second lease tick forced it, a re-render it got by
accident. The subscription also re-reads the board when the queue drains, closing
the window in which an acknowledged line had left the queue but not yet arrived
on the board.

### Still open -- closed by removal

> **History.** Each item below went with the thing it was about: tablet setup
> codes and enrolment (0077; a till is now a browser a manager signs in on), and
> the floor board and order pane (the one-screen POS, 2026-10-13). Kept as the
> record of what was open while they existed.

**How the POS learns its tenant slug on a factory-fresh tablet that has not yet
enrolled.** The slug arrives inside the enrolment token, so the first screen a
tablet ever shows is an enrolment field and nothing else — no branding, no menu,
no tenant name, because it does not know one yet.


- Guest count is not collected when a table is opened, so the floor shows
  `— guests`. Honest, but the flow should ask. Needs a number pad on pickup.
- A cashier role seeing a different floor board — still unanswered.
- The order pane has no line edit, void, comp or discount yet; those routes exist
  and are leased, and the pane will need the manager-authority path for the last
  two.

### Still open (Phase 9) -- closed by removal (0077)


- **Recall has no UI.** `POST /kds/ticket/:id/recall` exists, is served, needs a
  reason code, and no screen calls it. A recall is the loudest thing that happens
  at a pass and it needs a deliberate design, not a button.
- The KDS shows one station per screen. A small kitchen probably wants one screen
  showing two or three, which means a multi-station stream subscription.
- No sound. A ticket arriving on a screen nobody is looking at is the thing a
  bell solves, and browsers only allow audio after a user gesture — so it needs a
  deliberate "tap to enable sound" step rather than a silent failure.
