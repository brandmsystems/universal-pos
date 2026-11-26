import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api } from '../../../services/api.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { TilesSkeleton } from '../../../components/admin/skeletons.js';
import { ChartSkeleton, LinesSkeleton } from '@/components/ui/skeleton.js';
import { formatMinor, minorFrom } from '../../../lib/money.js';
import { gridline, magnitude, series, status } from '../../../app/admin/viz.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Missing } from '../../../components/admin/missing.js';
import { cn } from '@/lib/utils.js';

/**
 * The owner's dashboard.
 *
 * ###########################################################################
 * ONE REQUEST FOR THE MONEY, SO NO TWO TILES CAN DISAGREE ABOUT THE DATE RANGE.
 *
 * `GET /admin/reports/sales` carries the summary, the requested dimensions, the
 * payment split and the comparison window in one response. Fetching them
 * separately would have been three chances for the range to drift between
 * tiles -- and a dashboard whose average ticket covers a different week from its
 * net sales is worse than one that shows neither.
 *
 * The exception panel is a second request because it is a different report with
 * a different permission: an owner who cannot see it should lose that panel and
 * keep the rest.
 * ###########################################################################
 *
 * ###########################################################################
 * NOT ONE `?? 0` ON THIS SCREEN.
 *
 * Every figure is `known`, `stale` or `unknown`. A dashboard is the single worst
 * place for absence to be rendered as zero: "₹0 today" is a sentence an owner
 * acts on -- rings the manager, drives to the restaurant -- and a failed fetch
 * must never be able to say it. Unknown draws hatched with the reason; stale
 * draws the last figures with the time they were read.
 * ###########################################################################
 *
 * ###########################################################################
 * THE CHARTS BELOW ARE DELIBERATELY NOT SHADCN/RECHARTS COMPONENTS.
 *
 * `viz.ts` documents six series colours run through a colourblind-vision
 * validator (protanopia/tritanopia separation), a fixed status palette, and a
 * written rule that colour never carries meaning alone -- the payment split
 * ships a labelled list beside its bar specifically because two of those hues
 * sit under 3:1 contrast and would otherwise be unreadable to some viewers.
 * Rebuilding these on a different rendering engine (Recharts) would mean
 * re-running that whole validation before trusting them again. Only the CHROME
 * around them (Card, Tile, the range buttons) is Tailwind/shadcn now; the draw
 * functions below are unchanged from before this phase, reading viz.ts exactly
 * as they always did.
 * ###########################################################################
 */

interface SalesRow {
  readonly key: string;
  readonly label: string;
  readonly netMinor: number;
  readonly quantitySold: number;
}

interface Summary {
  readonly orders: number;
  readonly coversServed: number;
  readonly netMinor: number;
  readonly averageTicketMinor: number;
}

interface PaymentRow {
  readonly method: string;
  readonly collectedMinor: number;
  readonly voidedMinor: number;
  readonly voidCount: number;
  readonly manualCount: number;
}

interface Delta {
  readonly ordersPct: number | null;
  readonly netPct: number | null;
  readonly averageTicketPct: number | null;
  readonly coversPct: number | null;
}

interface SalesReport {
  readonly summary: Summary;
  readonly dimensions: Record<string, readonly SalesRow[]>;
  readonly payments: readonly PaymentRow[] | null;
  readonly comparison: {
    readonly window: { fromDate: string; toDate: string };
    readonly previous: Summary | null;
    readonly delta: Delta | null;
  } | null;
  readonly caveats: readonly { kind: string; detail: string }[];
}

interface Anomaly {
  readonly actorUserId: string;
  readonly actorName: string;
  readonly action: string;
  readonly countInPeriod: number;
  readonly observedPerDay: number;
  readonly baselinePerDay: number;
  readonly lift: number;
}

interface ExceptionReport {
  readonly anomalies: readonly Anomaly[];
}

/* ------------------------------------------------------------ date ranges --- */

const DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Business dates, and the label says so.
 *
 * A restaurant's day ends at 3am, and the server compares these against
 * `sales_order.business_date` rather than a wall clock. A password session
 * carries no branch, so it also carries no single day-start -- the server
 * returns a `branch_clock_unknown` caveat for exactly that, and this screen
 * prints it rather than hiding it.
 */
const RANGES: readonly { id: string; label: string; days: number; offset: number }[] = [
  { id: 'today', label: 'Today', days: 1, offset: 0 },
  { id: 'yesterday', label: 'Yesterday', days: 1, offset: 1 },
  { id: '7', label: 'Last 7 days', days: 7, offset: 0 },
  { id: '30', label: 'Last 30 days', days: 30, offset: 0 },
];

function windowFor(range: { days: number; offset: number }): { from: string; to: string } {
  const end = new Date(Date.now() - range.offset * DAY);
  const start = new Date(end.getTime() - (range.days - 1) * DAY);
  return { from: iso(start), to: iso(end) };
}

/* ------------------------------------------------------------- primitives --- */

function DashCard(props: { title: string; hint?: string; children: ReactElement | ReactElement[] }):
ReactElement {
  return (
    <Card className="min-w-0 gap-0 border-border p-[18px] transition-shadow duration-200 hover:shadow-md">
      <CardHeader className="p-0">
        <CardTitle className="text-[13px] font-bold uppercase tracking-wider text-muted-foreground">
          {props.title}
        </CardTitle>
        {props.hint !== undefined && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{props.hint}</p>
        )}
      </CardHeader>
      <CardContent className="mt-3.5 p-0">{props.children}</CardContent>
    </Card>
  );
}

/**
 * A stat tile. Proportional figures, not tabular: equal-width digits make a
 * large standalone number look loose.
 */
function Tile(props: {
  label: string; value: string; deltaPct: number | null; comparedTo: string | null;
}): ReactElement {
  const up = props.deltaPct !== null && props.deltaPct > 0;
  const flat = props.deltaPct === 0;
  return (
    <Card className="min-w-0 gap-0 border-border p-4 py-4 transition-shadow duration-200 hover:shadow-md">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      <div className="mt-2 text-[24px] font-bold tracking-tight text-foreground sm:text-[30px]"
        style={{ fontVariantNumeric: 'proportional-nums' }}>
        {props.value}
      </div>
      {/* A delta with no baseline says so. It is never drawn as 0%, which reads
          as "flat", and never as Infinity. */}
      {props.deltaPct === null ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          no comparison {props.comparedTo === null ? '' : `· nothing in ${props.comparedTo}`}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-foreground/70">
          <span aria-hidden className="font-bold"
            style={{ color: flat ? undefined : up ? status.good : status.critical }}>
            {flat ? '=' : up ? '▲' : '▼'}
          </span>
          <span>
            {flat ? 'level with' : `${Math.abs(props.deltaPct)}% ${up ? 'up on' : 'down on'}`}
            {' '}{props.comparedTo ?? 'the period before'}
          </span>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- charts --- */

/** Clean axis tops: 0 / 1,000 / 2,000 rather than 0 / 1,137 / 2,274. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitudeOf = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitudeOf) * magnitudeOf;
}

const inr = (minor: number): string => formatMinor(minorFrom(minor));

/**
 * Sales by hour of day. One series, so no legend: the card title names it.
 *
 * The server's `hour` dimension keys on business_date AND hour, because an hour
 * column alone would merge 8pm Friday with 8pm Saturday. For a multi-day range
 * this folds those back to hour-of-day deliberately -- that is the question
 * "when is my rush", which is a different question from "what happened on
 * Friday" and the fold is what makes it answerable.
 */
function HourCurve(props: { rows: readonly SalesRow[] }): ReactElement {
  const byHour = new Map<number, number>();
  for (const row of props.rows) {
    const hour = Number(row.key.slice(-2));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    byHour.set(hour, (byHour.get(hour) ?? 0) + row.netMinor);
  }
  if (byHour.size === 0) {
    return <Missing reason="no sales in this range">Nothing was sold in this period.</Missing>;
  }

  const hours = [...byHour.keys()].sort((x, y) => x - y);
  const first = hours[0]!;
  const last = hours[hours.length - 1]!;
  const span = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const top = niceCeiling(Math.max(...byHour.values()));
  const peak = span.reduce((best, h) =>
    (byHour.get(h) ?? 0) > (byHour.get(best) ?? 0) ? h : best, first);

  // The container includes the axis band, so the card never grows a nested
  // scrollbar to show its own hour labels.
  const plotH = 150;
  const axisH = 22;
  const barMax = 24;
  const slot = 100 / span.length;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ width: 56, height: plotH, position: 'relative', flexShrink: 0 }}>
          {[1, 0.5, 0].map((f) => (
            <span key={f} className="absolute right-0 font-mono text-[10px] text-muted-foreground"
              style={{ top: `${(1 - f) * 100}%`, transform: 'translateY(-50%)' }}>
              {f === 0 ? '0' : inr(top * f)}
            </span>
          ))}
        </div>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <div style={{ position: 'relative', height: plotH }}>
            {[1, 0.5, 0].map((f) => (
              <div key={f} style={{ position: 'absolute', left: 0, right: 0,
                                    top: `${(1 - f) * 100}%`, height: 1,
                                    background: gridline }} />
            ))}
            {span.map((hour) => {
              const value = byHour.get(hour) ?? 0;
              const h = Math.round((value / top) * plotH);
              return (
                <div key={hour} style={{ position: 'absolute', bottom: 0,
                                         left: `${span.indexOf(hour) * slot}%`,
                                         width: `${slot}%`, height: plotH,
                                         display: 'flex', alignItems: 'flex-end',
                                         justifyContent: 'center' }}>
                  <div title={`${String(hour).padStart(2, '0')}:00 · ${inr(value)}`}
                    style={{ width: `min(${barMax}px, 78%)`, height: Math.max(h, value > 0 ? 2 : 0),
                             background: magnitude,
                             borderRadius: '4px 4px 0 0' }} />
                </div>
              );
            })}
            {/* One direct label: the peak. A value on every column goes unread.
                Anchored to the PLOT EDGE when the peak is near one, because a
                label centred on the last slot overflows the card -- which is
                what it did, and a clipped label is worse than none. */}
            {(() => {
              const at = span.indexOf(peak);
              const nearEnd = at >= span.length - 2;
              const nearStart = at <= 1;
              const edge = nearEnd ? { right: 0 } : nearStart ? { left: 0 }
                : { left: `${at * slot}%`, width: `${slot}%`, textAlign: 'center' as const };
              return (
                <span style={{ position: 'absolute',
                               bottom: (byHour.get(peak) ?? 0) / top * plotH + 4,
                               ...edge, fontSize: 11, fontWeight: 700,
                               color: '#111111', whiteSpace: 'nowrap' }}>
                  {inr(byHour.get(peak) ?? 0)}
                </span>
              );
            })()}
          </div>
          <div style={{ height: axisH, display: 'flex', paddingTop: 5 }}>
            {span.map((hour) => (
              <span key={hour} className="font-mono text-[10px] text-muted-foreground"
                style={{ width: `${slot}%`, textAlign: 'center' }}>
                {span.length > 14 && hour % 2 === 1 ? '' : String(hour).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Busiest hour {String(peak).padStart(2, '0')}:00. Hours with no sales are shown empty
        rather than skipped, so the gap in a shift is visible.
      </p>
    </div>
  );
}

const METHOD_LABEL: Readonly<Record<string, string>> = {
  cash: 'Cash', card: 'Card', upi: 'UPI', wallet: 'Wallet',
  voucher: 'Voucher', other: 'Other',
};

/**
 * How the money arrived. Part-to-whole at a glance, six segments at most --
 * which is why it is one stacked bar and not a donut.
 *
 * The list under it is not decoration: three of these six hues sit below 3:1 on
 * a white card and the worst adjacent pair is 5.8 under tritanopia, so the
 * validator's report obliges visible labels. Every segment is named with its
 * amount and share, and the bar is the glance.
 */
function PaymentSplit(props: { rows: readonly PaymentRow[] }): ReactElement {
  const taken = props.rows.filter((r) => r.collectedMinor !== 0);
  if (taken.length === 0) {
    return <Missing reason="no tenders in this range">Nothing was collected in this period.</Missing>;
  }
  const total = taken.reduce((sum, r) => sum + r.collectedMinor, 0);
  const colourOf = (index: number): string => series[index % series.length]!;

  return (
    <div>
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: '#FFFFFF' }}>
        {taken.map((row, i) => (
          <div key={row.method}
            title={`${METHOD_LABEL[row.method] ?? row.method} · ${inr(row.collectedMinor)}`}
            style={{ width: `${(row.collectedMinor / total) * 100}%`,
                     background: colourOf(i),
                     // 2px of SURFACE between segments. Never a border: a stroke
                     // adds ink that is not data.
                     borderRight: i === taken.length - 1 ? 'none' : '2px solid #FFFFFF',
                     borderRadius: i === 0 ? '4px 0 0 4px'
                       : i === taken.length - 1 ? '0 4px 4px 0' : 0 }} />
        ))}
      </div>
      <div className="overflow-x-auto">
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
          <tbody>
            {taken.map((row, i) => (
              <tr key={row.method}>
                <td style={{ padding: '5px 0', width: 18 }}>
                  <span aria-hidden style={{ display: 'inline-block', width: 10, height: 10,
                                             borderRadius: 2, background: colourOf(i) }} />
                </td>
                <td className="text-foreground" style={{ padding: '5px 0', fontSize: 13 }}>
                  {METHOD_LABEL[row.method] ?? row.method}
                </td>
                <td className="font-mono tabular-nums text-foreground"
                  style={{ padding: '5px 0', fontSize: 13, textAlign: 'right' }}>
                  {inr(row.collectedMinor)}
                </td>
                <td className="font-mono tabular-nums text-muted-foreground"
                  style={{ padding: '5px 0 5px 12px', fontSize: 12, textAlign: 'right', width: 46 }}>
                  {Math.round((row.collectedMinor / total) * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Reversals are counted, not just netted. Two captures with one void look
          identical to one capture until the reversals are shown. */}
      {taken.some((r) => r.voidCount > 0 || r.manualCount > 0) && (
        <p className="mt-2.5 text-xs leading-relaxed text-foreground/70">
          {taken.filter((r) => r.voidCount > 0).map((r) =>
            `${r.voidCount} reversed on ${METHOD_LABEL[r.method] ?? r.method} (${inr(-r.voidedMinor)})`)
            .join(' · ')}
          {taken.some((r) => r.manualCount > 0) && (
            <>
              {taken.some((r) => r.voidCount > 0) ? ' · ' : ''}
              {taken.reduce((n, r) => n + r.manualCount, 0)} taken outside the system
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Top items by net. One series, value at the tip, no legend. */
function TopItems(props: { rows: readonly SalesRow[] }): ReactElement {
  const top = [...props.rows]
    .filter((r) => r.netMinor > 0)
    .sort((x, y) => y.netMinor - x.netMinor)
    .slice(0, 8);
  if (top.length === 0) {
    return <Missing reason="no sales in this range">Nothing was sold in this period.</Missing>;
  }
  const max = top[0]!.netMinor;

  return (
    <div className="overflow-x-auto">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {top.map((row) => (
            <tr key={row.key}>
              <td className="text-foreground" style={{ padding: '6px 10px 6px 0', fontSize: 13,
                           whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden',
                           textOverflow: 'ellipsis' }}>
                {row.label}
              </td>
              <td style={{ padding: '6px 0', width: '55%' }}>
                <div style={{ height: 10, width: `${(row.netMinor / max) * 100}%`,
                              background: magnitude, borderRadius: '0 4px 4px 0',
                              minWidth: 2 }} />
              </td>
              <td className="font-mono tabular-nums text-foreground"
                style={{ padding: '6px 0 6px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {inr(row.netMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Who is voiding, comping and discounting more than they usually do.
 *
 * This is the panel no other POS surfaces, and it is why the exception report
 * ranks by LIFT against each actor's own baseline rather than by count: the
 * busiest cashier will always have the most voids, and that is not the finding.
 *
 * A status colour never carries the meaning alone -- each row is worded.
 */
function Leakage(props: { anomalies: readonly Anomaly[] }): ReactElement {
  const ranked = [...props.anomalies].sort((x, y) => y.lift - x.lift).slice(0, 6);
  if (ranked.length === 0) {
    return (
      <p className="m-0 flex items-baseline gap-2 text-[13px] leading-relaxed text-foreground/70">
        <span aria-hidden className="font-bold" style={{ color: status.good }}>✓</span>
        <span>
          Nobody is adjusting more than they normally do. This compares each person
          against their own recent average, not against each other.
        </span>
      </p>
    );
  }

  const band = (lift: number): { colour: string; word: string; mark: string } =>
    lift >= 4 ? { colour: status.critical, word: 'far above', mark: '!!' }
      : lift >= 2 ? { colour: status.serious, word: 'above', mark: '!' }
        : { colour: status.warning, word: 'slightly above', mark: '·' };

  return (
    <div className="overflow-x-auto">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {ranked.map((row) => {
            const it = band(row.lift);
            return (
              <tr key={`${row.actorUserId}:${row.action}`} className="border-t border-border">
                <td style={{ padding: '9px 8px 9px 0', width: 20, textAlign: 'center',
                             color: it.colour, fontWeight: 700, fontSize: 13 }}>
                  <span aria-hidden>{it.mark}</span>
                </td>
                <td className="text-foreground" style={{ padding: '9px 0', fontSize: 13 }}>
                  {row.actorName}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {row.action.replace(/\./g, ' ')} · {it.word} their usual
                  </div>
                </td>
                <td className="font-mono tabular-nums text-foreground"
                  style={{ padding: '9px 0', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  ×{row.lift.toFixed(1)}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {row.countInPeriod} in period
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- the screen --- */

export function Dashboard(props: {
  api: Api;
  /**
   * Whether the plan includes the exception report. Undefined when the plan
   * could not be read: the panel then asks, and the API's answer decides.
   */
  exceptionReport?: { included: true } | { included: false; availableOn: string };
}): ReactElement {
  const [rangeId, setRangeId] = useState(RANGES[2]!.id);
  const [sales, setSales] = useState<Remote<SalesReport>>(unknown<SalesReport>());
  const [exceptions, setExceptions] = useState<Remote<ExceptionReport>>(
    unknown<ExceptionReport>());

  const range = RANGES.find((r) => r.id === rangeId)!;

  const read = useCallback(async (): Promise<void> => {
    const { from, to } = windowFor(range);
    const query = `from=${from}&to=${to}`;

    try {
      setSales(known(await props.api.get<SalesReport>(
        `/admin/reports/sales?${query}&dimensions=hour,item&payments=1&compare=previous`)));
    } catch (error) {
      setSales((current) =>
        error instanceof ApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<SalesReport>('read-failed'));
    }

    // Its own request and its own failure: an owner without the exception
    // permission loses this panel and keeps the money. Not asked at all when
    // the plan leaves the report out -- the answer is already known.
    if (props.exceptionReport?.included === false) return;
    try {
      setExceptions(known(await props.api.get<ExceptionReport>(
        `/admin/reports/exception?${query}`)));
    } catch (error) {
      setExceptions(
        error instanceof ApiError && error.failure.kind === 'refused'
          && error.failure.status === 403
          ? unknown<ExceptionReport>('not-permitted')
          : unknown<ExceptionReport>('read-failed'));
    }
  }, [props.api, props.exceptionReport, range]);

  useEffect(() => { void read(); }, [read]);

  const comparedTo = sales.state === 'unknown' ? null
    : sales.value.comparison === null ? null
      : `${sales.value.comparison.window.fromDate} – ${sales.value.comparison.window.toDate}`;
  const delta: Delta | null = sales.state === 'unknown' ? null
    : sales.value.comparison?.delta ?? null;
  const summary: Summary | null = sales.state === 'unknown' ? null : sales.value.summary;
  // Asked and not yet answered -- distinct from a read that failed.
  const salesLoading = sales.state === 'unknown' && sales.reason === 'never-read';

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex flex-wrap items-baseline gap-4">
        <h1 className="m-0 text-[22px] font-bold tracking-tight">Dashboard</h1>
        {/* Filters in ONE row above the charts, never beside them. */}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <Button key={r.id} type="button" variant="outline" onClick={() => setRangeId(r.id)}
              className={cn(
                'h-8 px-3 text-[13px]',
                rangeId === r.id
                  ? 'border-foreground bg-card font-bold text-foreground'
                  : 'border-border bg-transparent font-medium text-foreground/70',
              )}>
              {r.label}
            </Button>
          ))}
        </div>
      </header>

      {sales.state === 'stale' && (
        <p className="m-0 text-xs text-ink-orange">
          Showing the last figures that were read. The connection is down, so these
          are not current.
        </p>
      )}

      {/* min(...,100%): a fixed minimum wider than a phone pushed tiles past the edge. */}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
        {salesLoading ? (
          <TilesSkeleton />
        ) : summary === null ? (
          <div className="col-span-full">
            <Missing reason={`sales · ${sales.state === 'unknown' ? sales.reason : ''}`}>
              The figures could not be read, so none is shown. A zero here would be a
              sentence an owner acts on.
            </Missing>
          </div>
        ) : (
          <>
            <Tile label="Net sales" value={inr(summary.netMinor)}
              deltaPct={delta?.netPct ?? null} comparedTo={comparedTo} />
            <Tile label="Orders" value={String(summary.orders)}
              deltaPct={delta?.ordersPct ?? null} comparedTo={comparedTo} />
            <Tile label="Average ticket" value={inr(summary.averageTicketMinor)}
              deltaPct={delta?.averageTicketPct ?? null} comparedTo={comparedTo} />
            <Tile label="Covers" value={String(summary.coversServed)}
              deltaPct={delta?.coversPct ?? null} comparedTo={comparedTo} />
          </>
        )}
      </div>

      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
        <DashCard title="When the money comes in"
          hint="Net sales by hour of day, folded across the range.">
          {salesLoading ? <ChartSkeleton label="sales by hour" />
            : sales.state === 'unknown'
            ? <Missing reason={`sales · ${sales.reason}`} />
            : <HourCurve rows={sales.value.dimensions['hour'] ?? []} />}
        </DashCard>

        <DashCard title="How it was paid"
          hint="What was actually collected. Reversals are counted, not hidden in the net.">
          {salesLoading ? <LinesSkeleton label="payments" lines={4} />
            : sales.state === 'unknown'
            ? <Missing reason={`sales · ${sales.reason}`} />
            : sales.value.payments === null
              ? <Missing reason="payments were not requested" />
              : <PaymentSplit rows={sales.value.payments} />}
        </DashCard>

        <DashCard title="Top items" hint="By net, after voids, comps and discounts.">
          {salesLoading ? <LinesSkeleton label="top items" />
            : sales.state === 'unknown'
            ? <Missing reason={`sales · ${sales.reason}`} />
            : <TopItems rows={sales.value.dimensions['item'] ?? []} />}
        </DashCard>

        <DashCard title="Worth a look"
          hint="Each person against their OWN recent average, so the busiest till is not the finding.">
          {props.exceptionReport?.included === false
            ? <Missing reason="not in this plan">
                {`The exception report is included in the ${props.exceptionReport.availableOn} plan.`}
              </Missing>
            : exceptions.state === 'unknown' && exceptions.reason === 'never-read'
            ? <LinesSkeleton label="exceptions" lines={3} />
            : exceptions.state === 'unknown'
            ? <Missing reason={`exceptions · ${exceptions.reason}`}>
                {exceptions.reason === 'not-permitted'
                  ? 'This sign-in cannot read the exception report.'
                  : 'The exception report could not be read just now.'}
              </Missing>
            : <Leakage anomalies={exceptions.value.anomalies} />}
        </DashCard>
      </div>

      {sales.state !== 'unknown' && sales.value.caveats.length > 0 && (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {sales.value.caveats.map((c) => (
            <p key={c.kind} className="my-1">{c.detail}</p>
          ))}
        </div>
      )}
    </div>
  );
}
