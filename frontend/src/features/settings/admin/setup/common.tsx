import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ApiError, type Api } from '../../../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { Label } from '@/components/ui/label.js';
import { Input } from '@/components/ui/input.js';
import { Pagination, pageCount } from '../../../../components/platform/Pagination.js';
import { RequiredMark } from '../../../../components/admin/required-mark.js';
import { TableBones } from '../../../../components/admin/skeletons.js';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { formatMinor, minorFrom, minorFromTyped, typedFromMinor } from '../../../../lib/money.js';

/** Shared pieces of the setup screens: loading a list, a field, a table, words for a refusal. */

export const selectClass = 'h-10 w-full rounded-md border border-input bg-card px-2.5 text-sm';
const fieldLabel = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';

export function withBranch(path: string, branchId: string | null): string {
  return branchId === null ? path : `${path}${path.includes('?') ? '&' : '?'}branchId=${encodeURIComponent(branchId)}`;
}

/** "Butter Naan (Large)" -> "butter_naan_large": the shape every key in the schema has. */
export function keyFrom(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  if (base === '') return 'item';
  return /^[a-z]/.test(base) ? base : `x_${base}`;
}

/** "249.50" -> 24950: the money module's parser, so there is one set of rounding rules. */
export function paiseFrom(rupees: string): number | null {
  return minorFromTyped(rupees);
}

export function rupeesFrom(paise: number): string {
  return typedFromMinor(minorFrom(paise));
}

/** "₹" or "AED": the restaurant's currency, for a field label. */
export { currencySymbol } from '../../../../lib/money.js';

export function formatRupees(paise: number): string {
  return formatMinor(minorFrom(paise));
}

/** The server's own sentence, which names the field or the row it refused. */
export function refusalOf(error: unknown): string {
  if (!(error instanceof ApiError)) return 'That did not go through.';
  if (error.failure.kind === 'offline') return 'No connection, so nothing was saved.';
  if (error.failure.kind === 'signed-out') return 'You have been signed out.';
  if (error.failure.kind === 'refused' && error.failure.status === 403 && error.failure.code === 'forbidden') {
    return 'This sign-in is not allowed to change this.';
  }
  switch (error.failure.code) {
    case 'already_exists':
      return 'Something with that name already exists here.';
    case 'invariant_refused':
      return `That value is not allowed (${error.message}).`;
    case 'reference_invalid':
      return 'Something it refers to is at another branch or no longer exists.';
    default: {
      const text = error.message;
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
}

export function useList<T>(api: Api, path: string | null): {
  rows: readonly T[] | null; failed: boolean; reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<readonly T[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    if (path === null) return;
    try {
      // A generic admin list comes back in batches (`more`). Every batch is read:
      // search, filters and paging run over the whole list here, and stopping at
      // the first batch would hide the 51st table without saying so.
      const all: T[] = [];
      for (let offset = 0; ; offset += 200) {
        const read = await api.get<{ rows: T[]; more?: boolean } | T[]>(
          `${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`);
        if (Array.isArray(read)) { all.push(...read); break; }
        all.push(...read.rows);
        if (!read.more) break;
      }
      setRows(all);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api, path]);
  useEffect(() => { void reload(); }, [reload]);
  return { rows, failed, reload };
}

export function Field(props: {
  label: string; required?: boolean; hint?: string | undefined; error?: string | null | undefined; children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className={fieldLabel}>{props.label}{props.required && <RequiredMark />}</Label>
      {props.children}
      {props.error ? <span className="text-[11px] text-destructive">{props.error}</span>
        : props.hint !== undefined && <span className="text-[11px] text-muted-foreground">{props.hint}</span>}
    </div>
  );
}

export interface Column<T> {
  readonly title: string;
  readonly render: (row: T) => ReactNode;
  /** The column's plain value. Giving one makes the column sortable and searchable. */
  readonly value?: (row: T) => string | number | null;
}

/**
 * A filter over the rows already loaded. A `choice` offers the distinct values
 * the list actually has -- and is not shown at all when there are fewer than
 * two, since a filter with one option filters nothing. A `range` takes a min
 * and max in display units (`scale` turns stored units into them: paise -> ₹).
 */
export type Filter<T> =
  | { readonly kind: 'choice'; readonly label: string; readonly value: (row: T) => string | null }
  | { readonly kind: 'range'; readonly label: string; readonly value: (row: T) => number | null; readonly scale?: number };

export const PAGE_SIZE = 10;
type Sort = { readonly title: string; readonly dir: 1 | -1 } | null;

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null || a === '') return b === null || b === '' ? 0 : 1;
  if (b === null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function StepTable<T extends { readonly id: string }>(props: {
  rows: readonly T[] | null;
  failed: boolean;
  columns: readonly Column<T>[];
  filters?: readonly Filter<T>[] | undefined;
  empty: string;
  /** What the rows are, for "1–10 of 47 tables". */
  noun?: string;
  onEdit: (row: T) => void;
  onRemove?: ((row: T) => void) | undefined;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [ranges, setRanges] = useState<Readonly<Record<string, { min: string; max: string }>>>({});
  const [sort, setSort] = useState<Sort>(null);
  const [page, setPage] = useState(1);
  const all = useMemo(() => props.rows ?? [], [props.rows]);

  // Choice filters offer only values the list has; one value is no choice.
  const filters = useMemo(() => (props.filters ?? []).map((f) => ({
    filter: f,
    options: f.kind === 'choice'
      ? [...new Set(all.map((r) => f.value(r)).filter((v): v is string => v !== null && v !== ''))]
        .sort((a, b) => compare(a, b))
      : [],
  })).filter((f) => f.filter.kind === 'range' || f.options.length > 1), [props.filters, all]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = all.filter((row) => {
      if (needle !== '' && !props.columns.some((c) => String(c.value?.(row) ?? '').toLowerCase().includes(needle))) return false;
      for (const { filter } of filters) {
        if (filter.kind === 'choice') {
          const want = chosen[filter.label];
          if (want !== undefined && want !== '' && filter.value(row) !== want) return false;
        } else {
          const bounds = ranges[filter.label];
          const v = filter.value(row);
          const scale = filter.scale ?? 1;
          if (bounds?.min && (v === null || v / scale < Number(bounds.min))) return false;
          if (bounds?.max && (v === null || v / scale > Number(bounds.max))) return false;
        }
      }
      return true;
    });
    const column = sort === null ? undefined : props.columns.find((c) => c.title === sort.title);
    return column?.value === undefined ? matches
      : [...matches].sort((a, b) => sort!.dir * compare(column.value!(a), column.value!(b)));
  }, [all, query, chosen, ranges, sort, filters, props.columns]);

  // A page that no longer exists -- after a filter or a delete emptied it -- moves to the last one there is.
  const pages = pageCount(shown.length, PAGE_SIZE);
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);

  const narrowed = query.trim() !== '' || Object.values(chosen).some(Boolean)
    || Object.values(ranges).some((r) => r.min !== '' || r.max !== '');
  const reset = (): void => { setQuery(''); setChosen({}); setRanges({}); setPage(1); };
  const searchable = props.columns.some((c) => c.value !== undefined);

  if (props.failed) return <p className="text-sm text-destructive">This list did not load.</p>;
  if (props.rows === null) {
    return (
      <Loading label={props.noun ?? 'records'} className="flex flex-col gap-3">
        {(searchable || filters.length > 0) && (
          <div className="flex flex-wrap items-end gap-2">
            {searchable && <Skeleton className="h-9 w-56" />}
            {filters.map(({ filter }) => <Skeleton key={filter.label} className="h-9 w-36" />)}
          </div>
        )}
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <TableBones columns={props.columns.map((c) => c.title)} rows={PAGE_SIZE / 2} />
        </div>
        <Skeleton className="h-4 w-40" />
      </Loading>
    );
  }
  if (props.rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {props.empty}
      </div>
    );
  }
  const visible = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      {(searchable || filters.length > 0) && (
        <div className="flex flex-wrap items-end gap-2">
          {searchable && (
            <Input type="search" value={query} placeholder="Search…" aria-label="Search"
              onChange={(e) => { setQuery(e.target.value); setPage(1); }} className="h-9 w-56" />
          )}
          {filters.map(({ filter, options }) => filter.kind === 'choice' ? (
            <select key={filter.label} aria-label={filter.label} value={chosen[filter.label] ?? ''}
              onChange={(e) => { setChosen((c) => ({ ...c, [filter.label]: e.target.value })); setPage(1); }}
              className="h-9 min-w-36 rounded-md border border-input bg-card px-2.5 text-sm">
              <option value="">{filter.label}: all</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <span key={filter.label} className="flex items-center gap-1 text-xs text-muted-foreground">
              {filter.label}
              {(['min', 'max'] as const).map((edge) => (
                <Input key={edge} type="number" min={0} inputMode="decimal" placeholder={edge} aria-label={`${filter.label} ${edge}`}
                  value={ranges[filter.label]?.[edge] ?? ''} className="h-9 w-20"
                  onChange={(e) => {
                    setRanges((r) => ({ ...r, [filter.label]: { min: '', max: '', ...r[filter.label], [edge]: e.target.value } }));
                    setPage(1);
                  }} />
              ))}
            </span>
          ))}
          {narrowed && <Button type="button" variant="ghost" size="sm" onClick={reset}>Clear</Button>}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-border text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {props.columns.map((c) => {
                const active = sort?.title === c.title ? sort : null;
                return (
                  <th key={c.title} className="px-3 py-2.5"
                    aria-sort={active === null ? undefined : active.dir === 1 ? 'ascending' : 'descending'}>
                    {c.value === undefined ? c.title : (
                      // Sorting keeps the page: the user is reordering what they see, not asking a new question.
                      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                        onClick={() => setSort(active?.dir === 1 ? { title: c.title, dir: -1 } : { title: c.title, dir: 1 })}>
                        {c.title}
                        <span aria-hidden className={active === null ? 'opacity-30' : 'text-foreground'}>
                          {active === null ? '↕' : active.dir === 1 ? '↑' : '↓'}
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={props.columns.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                  No records found.{' '}
                  {narrowed && <Button type="button" variant="link" size="sm" className="px-0" onClick={reset}>Clear search and filters</Button>}
                </td>
              </tr>
            ) : visible.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                {props.columns.map((c) => <td key={c.title} className="px-3 py-2.5">{c.render(row)}</td>)}
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Button type="button" variant="outline" size="sm" onClick={() => props.onEdit(row)}>Edit</Button>
                  {props.onRemove && (
                    <Button type="button" variant="ghost" size="sm" className="ml-1 text-destructive"
                      onClick={() => props.onRemove!(row)}>Remove</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={Math.min(page, pages)} total={shown.length} pageSize={PAGE_SIZE} noun={props.noun ?? 'records'} onPage={setPage} />
    </div>
  );
}

export function StepHeader(props: { title: string; hint: string; addLabel: string; onAdd: () => void; disabled?: string | undefined }): ReactElement {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="m-0 text-lg font-bold tracking-tight">{props.title}</h2>
        <span className="text-[13px] text-muted-foreground">{props.disabled ?? props.hint}</span>
      </div>
      <Button type="button" onClick={props.onAdd} disabled={props.disabled !== undefined}
        className="ml-auto h-9 bg-brand-gradient px-4 font-bold text-primary-foreground hover:opacity-90">
        {props.addLabel}
      </Button>
    </div>
  );
}

export function ModalFooter(props: { busy: boolean; saveLabel: string; onSave: () => void; onCancel: () => void }): ReactElement {
  return (
    <>
      <Button type="button" onClick={props.onSave} disabled={props.busy}
        className="h-10 bg-brand-gradient px-5 font-bold text-primary-foreground hover:opacity-90">
        {props.busy ? 'Saving…' : props.saveLabel}
      </Button>
      <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy} className="h-10">Cancel</Button>
      <span className="ml-auto text-xs text-muted-foreground"><RequiredMark /> required</span>
    </>
  );
}
