import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input.js';

/**
 * Client-side paging over a list the server already returned in full.
 *
 * The pages are 1-based. Page numbers collapse to the first, the last and a
 * window around the current one, so fifty pages still fit one row on a phone.
 */
export const PAGE_SIZE = 10;

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function pageItems(page: number, pages: number): readonly (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const window = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const items: (number | 'gap')[] = [1];
  if (window[0]! > 2) items.push('gap');
  items.push(...window);
  if (window[window.length - 1]! < pages - 1) items.push('gap');
  items.push(pages);
  return items;
}

const cell =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-sm '
  + 'transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 '
  + 'disabled:pointer-events-none disabled:opacity-40';

export function Pagination(props: {
  page: number;
  total: number;
  pageSize: number;
  noun: string;
  onPage: (page: number) => void;
}): ReactElement | null {
  const pages = pageCount(props.total, props.pageSize);
  if (props.total === 0) return null;
  const first = (props.page - 1) * props.pageSize + 1;
  const last = Math.min(props.total, props.page * props.pageSize);

  return (
    <nav aria-label="Pagination"
      className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <span className="text-xs text-subtle-foreground tabular-nums">
        {first}–{last} of {props.total} {props.noun}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button type="button" className={cn(cell, 'text-muted-foreground hover:bg-secondary hover:text-foreground')}
            disabled={props.page === 1} onClick={() => props.onPage(props.page - 1)}
            aria-label="Previous page">
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Previous</span>
          </button>
          {pageItems(props.page, pages).map((item, index) => item === 'gap' ? (
            <span key={`gap-${index}`} className="px-1 text-sm text-subtle-foreground">…</span>
          ) : (
            <button key={item} type="button"
              aria-current={item === props.page ? 'page' : undefined}
              onClick={() => props.onPage(item)}
              className={cn(cell, 'tabular-nums', item === props.page
                ? 'bg-accent font-semibold text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground')}>
              {item}
            </button>
          ))}
          <button type="button" className={cn(cell, 'text-muted-foreground hover:bg-secondary hover:text-foreground')}
            disabled={props.page === pages} onClick={() => props.onPage(props.page + 1)}
            aria-label="Next page">
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </nav>
  );
}

/**
 * Search, filter and page one list the server returned in full.
 *
 * `haystack` names the text a row is searched by; `keep` is any further filter.
 * The page resets to 1 whenever the query or a filter dependency changes, so a
 * narrowed list never opens on an empty page 4.
 */
export function useClientTable<T>(rows: readonly T[], options: {
  haystack: (row: T) => readonly (string | null | undefined)[];
  keep?: (row: T) => boolean;
  filterKey?: string;
  pageSize?: number;
}): {
  query: string;
  setQuery: (query: string) => void;
  matched: readonly T[];
  visible: readonly T[];
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
} {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const needle = query.trim().toLowerCase();
  const { haystack, keep } = options;

  const matched = useMemo(() => rows.filter((row) =>
    (keep === undefined || keep(row))
    && (needle === '' || haystack(row).some((field) => field?.toLowerCase().includes(needle)))),
  // haystack/keep are inline closures; filterKey carries what they depend on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, needle, options.filterKey]);

  useEffect(() => { setPage(1); }, [needle, options.filterKey]);

  const current = Math.min(page, pageCount(matched.length, pageSize));
  const visible = matched.slice((current - 1) * pageSize, current * pageSize);
  return { query, setQuery, matched, visible, page: current, setPage, pageSize };
}

/** A search box with optional filter controls beside it, and a clear button. */
export function TableToolbar(props: {
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  label: string;
  filtersActive?: boolean;
  onClear?: () => void;
  children?: ReactNode;
}): ReactElement {
  const active = props.query !== '' || props.filtersActive === true;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground" />
        <Input value={props.query} onChange={(event) => props.onQuery(event.target.value)}
          placeholder={props.placeholder} aria-label={props.label} className="h-9 pl-8" />
      </div>
      {props.children}
      {active && (
        <button type="button"
          onClick={() => { props.onQuery(''); props.onClear?.(); }}
          className="inline-flex h-9 shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground">
          <X className="size-3.5" /> Clear
        </button>
      )}
    </div>
  );
}
