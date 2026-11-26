import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { CalendarRange, ChevronDown, Download, FileSpreadsheet, FileText, LoaderCircle, Printer, RefreshCw } from 'lucide-react';
import { ApiError, type Api } from '../../../services/api.js';
import { Sheet } from '../../../components/pos/ui.js';
import { cn } from 'cn';
import { printHtml } from '../print/receipt.js';
import {
  PERIOD_LABEL, cellText, periodText, downloadTakingsExcel, downloadTakingsPdf, rangeProblem, renderTakingsHtml, takingsReport,
  type TakingsPeriod, type TakingsSummary,
} from '../print/takingsReport.js';

type Selection = { readonly period: TakingsPeriod } | { readonly from: string; readonly to: string };

const pathFor = (s: Selection): string =>
  'period' in s ? `/pos/my-takings?period=${s.period}` : `/pos/my-takings?from=${s.from}&to=${s.to}`;

/**
 * My takings: what the signed-in person took on this till, by day, week or
 * month, or between two business dates they choose (`GET /pos/my-takings`).
 * Their own bills and payments only -- the till's X-read, not the restaurant's
 * books, which stay with the manager's reports. View reads it again; PDF and
 * Excel are built from the same figures shown; Print is a compact copy for the
 * receipt printer.
 */
export function MyTakings(props: { api: Api; restaurant: string; who: string | null; onClose: () => void }): ReactElement {
  const [selection, setSelection] = useState<Selection>({ period: 'day' });
  const [summary, setSummary] = useState<TakingsSummary | null>(null);
  const [busy, setBusy] = useState<'read' | 'pdf' | 'excel' | null>('read');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // The till's business date: a named period always ends on it.
  const [today, setToday] = useState<string | null>(null);
  const [dateProblem, setDateProblem] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const read = useCallback(async (which: Selection): Promise<void> => {
    setBusy('read');
    setRefusal(null);
    try {
      const answer = await props.api.get<TakingsSummary>(pathFor(which));
      setSummary(answer);
      if ('period' in which) {
        setToday(answer.toDate);
        setFrom(answer.fromDate);
        setTo(answer.toDate);
      }
    } catch (error) {
      setSummary(null);
      setRefusal(error instanceof ApiError && error.failure.kind === 'offline'
        ? 'No connection. Your takings are read from the till, so this needs one.'
        : error instanceof ApiError && error.failure.kind === 'refused' && error.failure.status === 403
          ? 'This sign-in does not take payments, so it has no takings to show.'
          : error instanceof ApiError && error.failure.kind === 'refused' && error.failure.code === 'till_range_invalid'
            ? 'Those dates cannot be used: choose From on or before To, neither after today, at most 366 days apart.'
            : 'Your takings could not be read just now. Try again.');
    } finally {
      setBusy(null);
    }
  }, [props.api]);
  useEffect(() => { void read(selection); }, [read, selection]);

  function applyRange(): void {
    const problem = rangeProblem(from, to, today);
    setDateProblem(problem);
    if (problem === null) setSelection({ from, to });
  }

  const report = useMemo(() => (summary === null ? null : takingsReport(summary, props.who)), [summary, props.who]);

  async function download(kind: 'pdf' | 'excel'): Promise<void> {
    setMenuOpen(false);
    if (summary === null || report === null) return;
    setBusy(kind);
    setRefusal(null);
    try {
      if (kind === 'pdf') await downloadTakingsPdf(report, summary, props.restaurant);
      else await downloadTakingsExcel(report, summary);
    } catch {
      setRefusal(`The ${kind === 'pdf' ? 'PDF' : 'Excel file'} could not be made. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  const action = 'flex h-11 items-center justify-center gap-2 rounded-xl border border-input bg-card px-3 text-sm font-semibold transition-colors hover:bg-background active:scale-[0.98] disabled:opacity-50';
  const field = 'h-11 w-full min-w-0 rounded-xl border border-input bg-card px-2.5 text-sm transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none';
  const menuItem = 'flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold hover:bg-background';

  return (
    <Sheet title="My takings" subtitle={report?.subtitle ?? 'Your bills and payments on this till'} onClose={props.onClose}>
      <div role="tablist" aria-label="Period" className="grid grid-cols-3 gap-1 rounded-xl bg-card p-1 ring-1 ring-border">
        {(['day', 'week', 'month'] as const).map((p) => {
          const chosen = 'period' in selection && selection.period === p;
          return (
            <button key={p} type="button" role="tab" aria-selected={chosen}
              onClick={() => { setDateProblem(null); setSelection({ period: p }); }}
              className={cn('h-10 rounded-lg text-sm font-semibold transition-colors',
                chosen ? 'bg-primary text-white shadow-sm' : 'text-foreground hover:bg-background')}>
              {PERIOD_LABEL[p]}
            </button>
          );
        })}
      </div>

      <form aria-label="Date range" noValidate
        onSubmit={(e) => { e.preventDefault(); applyRange(); }}
        className={cn('grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]',
          !('period' in selection) && 'rounded-xl p-2 ring-2 ring-primary/40')}>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
          From date
          <input type="date" value={from} max={to || today || undefined} className={field}
            onChange={(e) => { setFrom(e.target.value); setDateProblem(null); }} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
          To date
          <input type="date" value={to} min={from || undefined} max={today ?? undefined} className={field}
            onChange={(e) => { setTo(e.target.value); setDateProblem(null); }} />
        </label>
        <button type="submit" disabled={busy !== null} className={cn(action, 'col-span-2 sm:col-span-1')}>
          <CalendarRange aria-hidden className="size-4" /> Apply dates
        </button>
      </form>
      {dateProblem !== null && (
        <p role="alert" className="m-0 rounded-xl border border-destructive bg-destructive/10 p-3 text-sm">{dateProblem}</p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void read(selection)} className={action}>
          {busy === 'read' ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <RefreshCw aria-hidden className="size-4" />}
          View report
        </button>
        <div className="relative"
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false); }}>
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen}
            disabled={busy !== null || summary === null} onClick={() => setMenuOpen((o) => !o)} className={cn(action, 'w-full')}>
            {busy === 'pdf' || busy === 'excel'
              ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Download aria-hidden className="size-4" />}
            Download
            <ChevronDown aria-hidden className="size-4" />
          </button>
          {menuOpen && (
            <div role="menu" aria-label="Download as"
              className="absolute inset-x-0 top-full z-10 mt-1 min-w-40 rounded-xl border border-border bg-card p-1 shadow-lg">
              <button type="button" role="menuitem" onClick={() => void download('pdf')} className={menuItem}>
                <FileText aria-hidden className="size-4" /> PDF
              </button>
              <button type="button" role="menuitem" onClick={() => void download('excel')} className={menuItem}>
                <FileSpreadsheet aria-hidden className="size-4" /> Excel (.xlsx)
              </button>
            </div>
          )}
        </div>
        <button type="button" disabled={busy !== null || report === null}
          onClick={() => { if (report !== null) printHtml(renderTakingsHtml(report, props.restaurant)); }} className={action}>
          <Printer aria-hidden className="size-4" /> Print
        </button>
      </div>

      {refusal !== null && (
        <p role="alert" className="m-0 rounded-xl border border-destructive bg-destructive/10 p-3 text-sm">{refusal}</p>
      )}

      {summary !== null && summary.totals.bills === 0 && (
        <p role="status" className="m-0 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
          No takings for {periodText(summary)}: you took no payments on a bill in these dates.
        </p>
      )}

      {report !== null && report.sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <h3 className="m-0 text-xs font-bold uppercase tracking-wider text-muted-foreground">{s.title}</h3>
          {s.rows.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">{s.empty}</p>
          ) : (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                {s.head.some((h) => h !== '') && (
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      {s.head.map((h, i) => <th key={i} className={cn('pb-1 font-semibold', s.right.includes(i) && 'text-right')}>{h}</th>)}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {s.rows.map((row, r) => (
                    <tr key={r} className={cn('border-t border-border first:border-t-0',
                      s.title === 'Transactions' && r === s.rows.length - 1 && s.rows.length > 1 && 'font-bold')}>
                      {row.map((cell, i) => (
                        <td key={i} className={cn('py-1.5', s.right.includes(i) && 'text-right font-mono tabular-nums',
                          s.title === 'Sales Summary' && i === 1 && 'font-semibold')}>
                          {cellText(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </Sheet>
  );
}
