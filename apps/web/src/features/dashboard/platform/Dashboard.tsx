import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { PlatformApiError, type PlatformApi } from '../../../services/platformApi.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { invoiceStatusWord } from '../../../app/platform/tokens.js';
import { money } from '../../billing/platform/Plans.js';
import { Card } from '@/components/ui/card.js';
import { cn } from 'cn';
import { standardPlans } from '../../../lib/plans.js';
import { ChartSkeleton, LinesSkeleton } from '@/components/ui/skeleton.js';
import { StatTileSkeleton } from '../../../components/platform/skeletons.js';

/**
 * The one screen the console opens on.
 *
 * ###########################################################################
 * EVERY NUMBER HERE IS SOMETHING THIS CONSOLE CAN ALREADY READ.
 *
 * Nothing is invented for the sake of a stat tile. The control plane's own
 * rule is "never queries the orders table; aggregates arrive by rollup or
 * not at all" -- this screen holds to the tenant-plane version of that:
 * every figure below is composed from GET /tenants, GET /plans, GET
 * /invoices and GET /dunning, which this console already reads elsewhere,
 * and nothing is summed across a currency boundary without grouping by
 * currency first. There is no ecommerce-style "conversion rate" or "repeat
 * purchase rate" tile here, because there is no route that answers either
 * question -- see FRONTEND's snapshot-only reporting rule applied one level
 * up: a dashboard reads what exists, it does not gesture at what a nicer
 * mockup would show.
 * ###########################################################################
 */

interface TenantSummary {
  readonly tenantId: string;
  readonly status: string;
  readonly createdAt: string;
}

interface PlanVersionRow {
  readonly priceMinor: number;
  readonly currency: string;
  readonly publishedAt: string | null;
  readonly liveSubscriptions: number;
}

interface PlanRow {
  readonly planId: string;
  readonly key: string;
  readonly name: string;
  readonly versions: readonly PlanVersionRow[];
}

interface InvoiceRow {
  readonly invoiceId: string;
  readonly tenantSlug: string;
  readonly number: string;
  readonly issueDate: string;
  readonly status: string;
  readonly currency: string;
  readonly totalMinor: number;
}

interface DunningRow {
  readonly tenantId: string;
}

const INVOICE_WINDOW = 200;

/** The dominant currency group's total, and how many rows disagreed with it. */
function dominantCurrencyTotal(
  rows: readonly { currency: string; totalMinor: number }[],
): { currency: string; totalMinor: number; otherCurrencies: number } | null {
  if (rows.length === 0) return null;
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.totalMinor);
  }
  const [currency, totalMinor] = [...byCurrency.entries()]
    .sort(([, a], [, b]) => b - a)[0]!;
  return { currency, totalMinor, otherCurrencies: byCurrency.size - 1 };
}

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 5, 10];
  for (const step of steps) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

export function Dashboard(props: { api: PlatformApi }): ReactElement {
  const [tenants, setTenants] = useState<Remote<readonly TenantSummary[]>>(
    unknown<readonly TenantSummary[]>());
  const [plans, setPlans] = useState<Remote<readonly PlanRow[]>>(unknown<readonly PlanRow[]>());
  const [invoices, setInvoices] = useState<Remote<readonly InvoiceRow[]>>(
    unknown<readonly InvoiceRow[]>());
  const [dunning, setDunning] = useState<Remote<readonly DunningRow[]>>(
    unknown<readonly DunningRow[]>());

  useEffect(() => {
    void (async () => {
      try {
        setTenants(known(await props.api.get<readonly TenantSummary[]>('/tenants?limit=200')));
      } catch (error) {
        setTenants((current) => failed(error, current));
      }
    })();
    void (async () => {
      try {
        setPlans(known(standardPlans(await props.api.get<readonly PlanRow[]>('/plans'))));
      } catch (error) {
        setPlans((current) => failed(error, current));
      }
    })();
    void (async () => {
      try {
        setInvoices(known(await props.api.get<readonly InvoiceRow[]>(
          `/invoices?limit=${INVOICE_WINDOW}`)));
      } catch (error) {
        setInvoices((current) => failed(error, current));
      }
    })();
    void (async () => {
      try {
        setDunning(known(await props.api.get<readonly DunningRow[]>('/dunning')));
      } catch (error) {
        setDunning((current) => failed(error, current));
      }
    })();
  }, [props.api]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-xl font-bold tracking-tight sm:text-2xl">Dashboard</span>
        <span className="max-w-[680px] text-sm leading-relaxed text-muted-foreground">
          The whole estate, at a glance. Every figure here is read from a route
          this console already has — nothing is estimated.
        </span>
      </div>

      {/* ---- stat tiles ------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <RestaurantsTile tenants={tenants} />
        <MrrTile plans={plans} />
        <AttentionTile dunning={dunning} />
        <InvoicedTile invoices={invoices} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        {/* ---- invoiced amount over time ------------------------------- */}
        <Card className="gap-3 p-5">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Invoiced, by day
          </span>
          <InvoicedChart invoices={invoices} />
        </Card>

        {/* ---- plan popularity ------------------------------------------ */}
        <Card className="gap-3 p-5">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Plans by live subscription
          </span>
          <PlanPopularity plans={plans} />
        </Card>
      </div>

      {/* ---- recent invoices -------------------------------------------- */}
      <Card className="gap-3 p-5">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Recent invoices
        </span>
        <RecentInvoices invoices={invoices} />
      </Card>
    </div>
  );
}

function failed<T>(error: unknown, current: Remote<T>): Remote<T> {
  if (error instanceof PlatformApiError && error.failure.kind === 'offline') {
    return stale(current);
  }
  return unknown<T>(
    error instanceof PlatformApiError && error.failure.kind === 'refused'
      && error.failure.status === 403 ? 'not-permitted' : 'read-failed');
}

function Tile(props: { label: string; children: ReactElement | string; caption?: string }): ReactElement {
  return (
    <Card className="gap-2 p-5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <span className="text-3xl font-bold tabular-nums">{props.children}</span>
      {props.caption !== undefined && (
        <span className="text-xs text-muted-foreground">{props.caption}</span>
      )}
    </Card>
  );
}

function Missing(props: { reason: string }): ReactElement {
  return (
    <Card className="gap-2 p-5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Not available
      </span>
      <span className="text-sm text-muted-foreground">
        {props.reason === 'not-permitted' ? 'This role cannot read this.' : 'Could not be read just now.'}
      </span>
    </Card>
  );
}

function RestaurantsTile(props: { tenants: Remote<readonly TenantSummary[]> }): ReactElement {
  if (props.tenants.state === 'unknown') {
    return props.tenants.reason === 'never-read'
      ? <StatTileSkeleton label="Restaurants" /> : <Missing reason={props.tenants.reason} />;
  }
  const rows = props.tenants.value;
  const active = rows.filter((t) => t.status === 'active').length;
  const behind = rows.length - active;
  return (
    <Tile label="Restaurants"
      caption={behind === 0 ? 'all active'
        : `${active} active · ${behind} on the ladder`}>
      {rows.length >= 200 ? '200+' : String(rows.length)}
    </Tile>
  );
}

/** Sum(price × live subscriptions) over PUBLISHED versions only. */
function MrrTile(props: { plans: Remote<readonly PlanRow[]> }): ReactElement {
  if (props.plans.state === 'unknown') {
    return props.plans.reason === 'never-read'
      ? <StatTileSkeleton label="Monthly recurring" /> : <Missing reason={props.plans.reason} />;
  }
  const rows = props.plans.value.flatMap((plan) => plan.versions)
    .filter((v) => v.publishedAt !== null && v.liveSubscriptions > 0)
    .map((v) => ({ currency: v.currency, totalMinor: v.priceMinor * v.liveSubscriptions }));
  const totals = dominantCurrencyTotal(rows);
  return (
    <Tile label="Monthly recurring"
      caption={totals === null ? 'nothing live'
        : totals.otherCurrencies > 0
          ? `+${totals.otherCurrencies} more currenc${totals.otherCurrencies === 1 ? 'y' : 'ies'} not shown`
          : 'published versions, price × subscribers'}>
      {totals === null ? '—' : money(totals.totalMinor, totals.currency)}
    </Tile>
  );
}

function AttentionTile(props: { dunning: Remote<readonly DunningRow[]> }): ReactElement {
  if (props.dunning.state === 'unknown') {
    return props.dunning.reason === 'never-read'
      ? <StatTileSkeleton label="Needs chasing today" /> : <Missing reason={props.dunning.reason} />;
  }
  const count = props.dunning.value.length;
  return (
    <Tile label="Needs chasing today" caption="on the dunning queue">
      <span className={count > 0 ? 'text-status-warn' : undefined}>{count}</span>
    </Tile>
  );
}

function InvoicedTile(props: { invoices: Remote<readonly InvoiceRow[]> }): ReactElement {
  if (props.invoices.state === 'unknown') {
    return props.invoices.reason === 'never-read'
      ? <StatTileSkeleton label="Invoiced" /> : <Missing reason={props.invoices.reason} />;
  }
  const rows = props.invoices.value;
  const totals = dominantCurrencyTotal(rows);
  return (
    <Tile label="Invoiced"
      caption={rows.length >= INVOICE_WINDOW
        ? `first ${INVOICE_WINDOW} invoices — there may be more`
        : `${rows.length} invoice${rows.length === 1 ? '' : 's'} read`}>
      {totals === null ? '—' : money(totals.totalMinor, totals.currency)}
    </Tile>
  );
}

/**
 * A hand-rolled bar chart, the same technique admin's Dashboard already
 * uses: DOM divs positioned by percentage, not a charting library. One
 * series (invoiced amount), the skill's validated dark-mode magnitude hue,
 * a direct label on the peak day only, and a table alternative below it —
 * see the dataviz skill's marks-and-anatomy and accessibility-pass steps.
 */
function InvoicedChart(props: { invoices: Remote<readonly InvoiceRow[]> }): ReactElement {
  if (props.invoices.state === 'unknown') {
    return props.invoices.reason === 'never-read'
      ? <ChartSkeleton label="invoiced by day" /> : <Missing reason={props.invoices.reason} />;
  }
  const rows = props.invoices.value;
  if (rows.length === 0) {
    return <span className="text-sm text-muted-foreground">No invoices have been raised.</span>;
  }

  // Grouped by the DOMINANT currency only, same reasoning as the tiles: a bar
  // chart summing across currencies would be adding apples to yen.
  const totals = dominantCurrencyTotal(rows)!;
  const byDate = new Map<string, number>();
  for (const row of rows) {
    if (row.currency !== totals.currency) continue;
    byDate.set(row.issueDate, (byDate.get(row.issueDate) ?? 0) + row.totalMinor);
  }
  const dates = [...byDate.keys()].sort();
  const top = niceCeiling(Math.max(...byDate.values()));
  const peakDate = dates.reduce((best, d) =>
    (byDate.get(d) ?? 0) > (byDate.get(best) ?? 0) ? d : best, dates[0]!);

  const plotH = 160;
  const slot = 100 / dates.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2.5">
        <div className="relative h-[160px] w-14 shrink-0" style={{ height: plotH }}>
          {[1, 0.5, 0].map((f) => (
            <span key={f}
              className="absolute right-0 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
              style={{ top: `${(1 - f) * 100}%` }}>
              {f === 0 ? '0' : money(Math.round(top * f), totals.currency)}
            </span>
          ))}
        </div>
        <div className="min-w-0 grow">
          <div className="relative" style={{ height: plotH }}>
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="absolute inset-x-0 h-px bg-border"
                style={{ top: `${(1 - f) * 100}%` }} />
            ))}
            {dates.map((date, index) => {
              const value = byDate.get(date) ?? 0;
              const h = Math.round((value / top) * plotH);
              return (
                <div key={date}
                  className="absolute bottom-0 flex items-end justify-center"
                  style={{ left: `${index * slot}%`, width: `${slot}%`, height: plotH }}>
                  <div title={`${date} · ${money(value, totals.currency)}`}
                    className="w-[min(28px,78%)] rounded-t bg-[color:var(--color-chart-1)]"
                    style={{ height: Math.max(h, value > 0 ? 2 : 0) }} />
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex text-[10px] text-muted-foreground">
            {dates.map((date) => (
              <span key={date} style={{ width: `${slot}%` }}
                className={cn('truncate text-center', date === peakDate && 'font-bold text-foreground')}>
                {date.slice(5)}
              </span>
            ))}
          </div>
        </div>
      </div>
      {rows.length >= INVOICE_WINDOW && (
        <span className="text-[11px] text-muted-foreground">
          Only the first {INVOICE_WINDOW} invoices this console read are charted — an
          older invoice than that is not represented here.
        </span>
      )}
    </div>
  );
}

function PlanPopularity(props: { plans: Remote<readonly PlanRow[]> }): ReactElement {
  if (props.plans.state === 'unknown') {
    return props.plans.reason === 'never-read'
      ? <LinesSkeleton label="plans by subscription" lines={2} /> : <Missing reason={props.plans.reason} />;
  }
  const rows = [...props.plans.value]
    .map((plan) => ({
      name: plan.name,
      liveSubscriptions: plan.versions.reduce((sum, v) => sum + v.liveSubscriptions, 0),
    }))
    .filter((row) => row.liveSubscriptions > 0)
    .sort((a, b) => b.liveSubscriptions - a.liveSubscriptions)
    .slice(0, 6);

  if (rows.length === 0) {
    return <span className="text-sm text-muted-foreground">No plan has a live subscription.</span>;
  }
  const max = Math.max(...rows.map((r) => r.liveSubscriptions));

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-sm">{row.name}</span>
          <div className="h-2 grow overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[color:var(--color-chart-1)]"
              style={{ width: `${(row.liveSubscriptions / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
            {row.liveSubscriptions}
          </span>
        </div>
      ))}
    </div>
  );
}

function RecentInvoices(props: { invoices: Remote<readonly InvoiceRow[]> }): ReactElement {
  if (props.invoices.state === 'unknown') {
    return props.invoices.reason === 'never-read'
      ? <LinesSkeleton label="recent invoices" lines={8} /> : <Missing reason={props.invoices.reason} />;
  }
  const rows = [...props.invoices.value]
    .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1))
    .slice(0, 8);
  if (rows.length === 0) {
    return <span className="text-sm text-muted-foreground">No invoices have been raised.</span>;
  }
  return (
    <div className="flex flex-col divide-y divide-border">
      {rows.map((row) => (
        <div key={row.invoiceId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
          {/* The invoice number and the date are the first things to give up
              the row on a phone width -- the tenant, the amount and the
              status are what answers "who owes what, and is it settled". */}
          <span className="hidden w-40 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block">
            {row.number}
          </span>
          <span className="min-w-0 grow truncate">{row.tenantSlug}</span>
          <span className="hidden shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:block">
            {row.issueDate}
          </span>
          <span className="shrink-0 text-right font-mono tabular-nums sm:w-24">
            {money(row.totalMinor, row.currency)}
          </span>
          <span className="shrink-0 text-right text-xs font-semibold text-muted-foreground sm:w-16">
            {invoiceStatusWord(row.status)}
          </span>
        </div>
      ))}
    </div>
  );
}
