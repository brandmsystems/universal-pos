import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { PlatformApiError, type PlatformApi } from '../../../services/platformApi.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { invoiceStatusWord } from '../../../app/platform/tokens.js';
import { money } from './Plans.js';
import { selectClass } from '../../../components/platform/kit.js';
import { Pagination, TableToolbar, useClientTable } from '../../../components/platform/Pagination.js';
import { ListSkeleton } from '../../../components/platform/skeletons.js';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Card } from '@/components/ui/card.js';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';
import { minorFrom, typedFromMinor } from '../../../lib/money.js';
import { Switch } from '@/components/ui/switch.js';

/**
 * What is owed, and who has been chased about it.
 *
 * ###########################################################################
 * TWO QUESTIONS, NOT ONE LIST SORTED TWO WAYS.
 *
 * The invoice ledger answers "what has been billed". The dunning queue answers
 * "who do I ring today, and how long before the product locks them out". They
 * share rows and are not the same screen: the ledger is a record and the queue
 * is a worklist, and `daysUntilSoftLock` -- computed by the server from the SAME
 * configurable thresholds the ladder enforces -- only belongs on the second.
 *
 * That number is never recomputed here. A second copy of the ladder's arithmetic
 * on the client would drift from the job that actually suspends the tenant, and
 * the screen would confidently show a date the ladder disagrees with.
 * ###########################################################################
 */

interface Invoice {
  readonly invoiceId: string;
  readonly tenantSlug: string;
  readonly number: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly status: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly capturedMinor: number;
  readonly paidAt: string | null;
  readonly overdue: boolean;
}

interface DunningRow {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly totalMinor: number;
  readonly dueDate: string;
  readonly attemptsMade: number;
  readonly delinquentSince: string | null;
  readonly daysUntilSoftLock: number | null;
  readonly lastOutreachAt: string | null;
}

const CHANNELS = ['email', 'phone', 'in_app'] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_WORDS: Readonly<Record<Channel, string>> = {
  email: 'Emailed', phone: 'Phoned', in_app: 'In-app message',
};

export function Billing(props: { api: PlatformApi }): ReactElement {
  const [queue, setQueue] = useState<Remote<readonly DunningRow[]>>(
    unknown<readonly DunningRow[]>());
  const [invoices, setInvoices] = useState<Remote<readonly Invoice[]>>(
    unknown<readonly Invoice[]>());
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [openTenant, setOpenTenant] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('');

  const queueTable = useClientTable(queue.state === 'unknown' ? [] : queue.value, {
    haystack: (row) => [row.tenantName, row.invoiceNumber],
  });
  const invoiceTable = useClientTable(invoices.state === 'unknown' ? [] : invoices.value, {
    haystack: (invoice) => [invoice.number, invoice.tenantSlug],
    keep: (invoice) => statusFilter === '' || invoice.status === statusFilter,
    filterKey: statusFilter,
  });
  const invoiceStatuses = invoices.state === 'unknown'
    ? [] : [...new Set(invoices.value.map((invoice) => invoice.status))].sort();

  const readQueue = useCallback(async (): Promise<void> => {
    try {
      setQueue(known(await props.api.get<readonly DunningRow[]>('/dunning')));
    } catch (error) {
      setQueue((current) => failed(error, current));
    }
  }, [props.api]);

  const readInvoices = useCallback(async (overdue: boolean): Promise<void> => {
    try {
      setInvoices(known(await props.api.get<readonly Invoice[]>(
        `/invoices${overdue ? '?overdue=true' : ''}`)));
    } catch (error) {
      setInvoices((current) => failed(error, current));
    }
  }, [props.api]);

  useEffect(() => { void readQueue(); }, [readQueue]);
  useEffect(() => { void readInvoices(overdueOnly); }, [readInvoices, overdueOnly]);

  async function record(tenantId: string): Promise<void> {
    if (channel === '') return;
    setBusy(true); setRefusal(null); setDone(null);
    try {
      await props.api.post(`/dunning/${tenantId}/outreach`, {
        channel,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setDone(`${CHANNEL_WORDS[channel]}. Recorded against this restaurant, so the`
        + ' next person on the queue can see it happened.');
      setChannel(''); setNote('');
      await readQueue();
    } catch (error) {
      setRefusal(error instanceof PlatformApiError
        ? error.failure.kind === 'refused'
          ? error.failure.status === 403
            ? 'This role can see the dunning queue but cannot record an outreach.'
            : error.message.charAt(0).toUpperCase() + error.message.slice(1)
          : 'The server could not be reached, so nothing was recorded.'
        : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-xl font-bold tracking-tight sm:text-2xl">Billing</span>
        <span className="max-w-[680px] text-sm leading-relaxed text-muted-foreground">
          The queue is who to chase today. The ledger below is every invoice. The
          countdown to a soft lock comes from the server, computed against the same
          thresholds the suspension ladder uses — it is not worked out here.
        </span>
      </div>

      {/* ---- the worklist -------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Chase today
        </span>

        {queue.state === 'unknown' ? (
          queue.reason === 'never-read'
            ? <ListSkeleton label="dunning queue" rows={4} toolbar
              columns={['Restaurant', 'Invoice', 'Due', 'Attempts', 'Soft lock', 'Last chased']} />
            : <Missing what="dunning" reason={queue.reason} />
        ) : queue.value.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Nobody is behind on payment.
          </span>
        ) : (
          <>
            <TableToolbar query={queueTable.query} onQuery={queueTable.setQuery}
              placeholder="Search restaurant or invoice number" label="Search the dunning queue" />
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Restaurant</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Soft lock</TableHead>
                    <TableHead>Last chased</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueTable.matched.length === 0 && (
                    <NoMatch columns={7} />
                  )}
                  {queueTable.visible.map((row) => (
                    <TableRow key={row.invoiceId}>
                      <TableCell className="font-semibold">{row.tenantName}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.invoiceNumber}
                        <span className="ml-2 text-muted-foreground">
                          {typedFromMinor(minorFrom(row.totalMinor))}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.dueDate.slice(0, 10)}</TableCell>
                      <TableCell className="font-mono text-xs">{row.attemptsMade}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <SoftLock days={row.daysUntilSoftLock} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {/* Never an em dash on this column. "Nobody has rung them"
                            and "the read failed" must not look identical, because
                            one of them means a restaurant is about to be locked out
                            having never been told. */}
                        {row.lastOutreachAt === null
                          ? <span className="text-status-warn">never</span>
                          : row.lastOutreachAt.slice(0, 10)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button type="button" variant="outline" size="sm"
                          onClick={() => {
                            setOpenTenant(openTenant === row.tenantId ? null : row.tenantId);
                            setChannel(''); setNote(''); setRefusal(null); setDone(null);
                          }}>
                          {openTenant === row.tenantId ? 'Close' : 'Record a chase'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={queueTable.page} total={queueTable.matched.length}
              pageSize={queueTable.pageSize} noun="to chase" onPage={queueTable.setPage} />
          </>
        )}

        {openTenant !== null && (
          <Card className="gap-3 border-2 border-primary/40 p-4">
            <span className="text-sm font-bold">Record an outreach</span>
            {/* The log is the point. An outreach nobody recorded is one the next
                person repeats, and a tenant chased four times in a day leaves. */}
            <span className="text-xs leading-relaxed text-muted-foreground">
              This records that contact happened. It does not send anything — the
              product has no outbound channel, and a button that implied otherwise
              would be worse than none.
            </span>

            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((option) => {
                const on = channel === option;
                return (
                  <Button key={option} type="button" size="sm"
                    variant={on ? 'default' : 'outline'}
                    onClick={() => setChannel(on ? '' : option)}>
                    {CHANNEL_WORDS[option]}
                  </Button>
                );
              })}
            </div>

            <Input value={note} placeholder="what was said (optional)"
              onChange={(event) => setNote(event.target.value)}
              className="h-9" />

            {refusal !== null && (
              <Alert variant="destructive">
                <AlertDescription>{refusal}</AlertDescription>
              </Alert>
            )}
            {done !== null && (
              <Alert className="border-primary/40">
                <AlertDescription className="text-primary/90">{done}</AlertDescription>
              </Alert>
            )}

            <div>
              <Button type="button" onClick={() => { void record(openTenant); }}
                disabled={busy || channel === ''}>
                {busy ? 'Recording…' : channel === '' ? 'Pick how' : 'Record it'}
              </Button>
            </div>
          </Card>
        )}
      </section>

      {/* ---- the ledger ---------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3.5">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Invoices
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
            <Switch checked={overdueOnly} onCheckedChange={setOverdueOnly} aria-label="Overdue only" />
            Overdue only
          </label>
        </div>

        {invoices.state === 'unknown' ? (
          invoices.reason === 'never-read'
            ? <ListSkeleton label="invoices" toolbar
              columns={['Invoice', 'Restaurant', 'Issued', 'Due', 'Total', 'Captured', 'Status']} />
            : <Missing what="invoices" reason={invoices.reason} />
        ) : invoices.value.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            {overdueOnly ? 'No invoice is overdue.' : 'No invoices have been raised.'}
          </span>
        ) : (
          <>
            <TableToolbar query={invoiceTable.query} onQuery={invoiceTable.setQuery}
              placeholder="Search invoice number or restaurant" label="Search invoices"
              filtersActive={statusFilter !== ''} onClear={() => setStatusFilter('')}>
              <select aria-label="Filter by status" value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)} className={cn(selectClass, 'h-9 sm:w-44')}>
                <option value="">All statuses</option>
                {invoiceStatuses.map((status) => (
                  <option key={status} value={status}>{invoiceStatusWord(status)}</option>
                ))}
              </select>
            </TableToolbar>
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Restaurant</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Captured</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoiceTable.matched.length === 0 && (
                    <NoMatch columns={7} />
                  )}
                  {invoiceTable.visible.map((invoice) => (
                    <TableRow key={invoice.invoiceId}>
                      <TableCell className="font-mono text-xs">{invoice.number}</TableCell>
                      <TableCell className="font-mono text-xs">{invoice.tenantSlug}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {invoice.issueDate.slice(0, 10)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {invoice.dueDate.slice(0, 10)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {money(invoice.totalMinor, invoice.currency)}
                      </TableCell>
                      {/* Captured is shown beside the total rather than folded into a
                          "balance": a part payment is a different conversation from
                          no payment, and one number cannot say which happened. */}
                      <TableCell className={cn(
                        'font-mono text-xs',
                        invoice.capturedMinor === 0 ? 'text-muted-foreground' : 'text-foreground',
                      )}>
                        {money(invoice.capturedMinor, invoice.currency)}
                      </TableCell>
                      <TableCell>
                        <span className={cn(
                          'font-semibold',
                          invoice.overdue ? 'text-status-warn' : 'text-muted-foreground',
                        )}>
                          {invoiceStatusWord(invoice.status)}
                          {invoice.overdue && ' · overdue'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={invoiceTable.page} total={invoiceTable.matched.length}
              pageSize={invoiceTable.pageSize} noun="invoices" onPage={invoiceTable.setPage} />
          </>
        )}
      </section>
    </div>
  );
}

function NoMatch(props: { columns: number }): ReactElement {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={props.columns} className="py-8 text-center text-sm text-muted-foreground">
        Nothing matches this search.
      </TableCell>
    </TableRow>
  );
}

/**
 * The countdown, as the operator reads it.
 *
 * Negative means the threshold has passed and the ladder is due to act, which is
 * a different sentence from "three days left" and must not render as `-2 days`.
 */
function SoftLock(props: { days: number | null }): ReactElement {
  if (props.days === null) {
    return <span className="text-muted-foreground">not set</span>;
  }
  if (props.days < 0) {
    return (
      <span className="font-bold text-destructive">
        due now ({Math.abs(props.days)}d past)
      </span>
    );
  }
  return (
    <span className={cn(props.days <= 3 ? 'font-bold text-status-warn' : 'text-muted-foreground')}>
      {props.days}d
    </span>
  );
}

function Missing(props: { what: string; reason: string }): ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-border p-3.5 text-sm leading-relaxed text-muted-foreground">
      {props.reason === 'not-permitted'
        ? 'This role cannot read that.'
        : 'That could not be read just now, so this list is not "empty" — it is unknown.'}
      <div className="mt-1.5 font-mono text-[11px] text-muted-foreground/70">
        {props.what} · {props.reason}
      </div>
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
