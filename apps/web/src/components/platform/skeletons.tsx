import type { ReactElement } from 'react';
import { cn } from 'cn';
import { Card } from '@/components/ui/card.js';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';

/**
 * Loading shapes for the console, drawn at the size of what replaces them.
 *
 * A skeleton means "asked, not answered yet" (`never-read`) and nothing else:
 * a refused or failed read keeps its own message, and an empty list its own
 * empty text. Labels and column titles are known before the read answers, so
 * they are drawn as text rather than as bars.
 */

/** One figure tile, at StatTile's padding and type sizes. */
export function StatTileSkeleton(props: { label: string }): ReactElement {
  return (
    <Loading label={props.label}>
      <Card className="h-full gap-2 p-5">
        <span className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">{props.label}</span>
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-3 w-32" />
      </Card>
    </Loading>
  );
}

/** Tailwind needs literal class names, so the breakpoint is one of these. */
const SWITCH = {
  lg: { table: 'hidden lg:block', cards: 'lg:hidden' },
  xl: { table: 'hidden xl:block', cards: 'xl:hidden' },
} as const;

/**
 * A list: optionally its search toolbar, then a table under its real column
 * titles. `cardsBelow` mirrors screens that swap the table for one card per row
 * on narrow widths, so the skeleton never scrolls sideways where the list does not.
 */
export function ListSkeleton(props: {
  label: string;
  columns: readonly string[];
  rows?: number;
  toolbar?: boolean;
  headClassName?: string;
  cardsBelow?: keyof typeof SWITCH;
}): ReactElement {
  const rows = Array.from({ length: props.rows ?? 6 }, (_, i) => i);
  return (
    <Loading label={props.label} className="flex flex-col gap-3">
      {props.toolbar === true && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Skeleton className="h-9 w-full sm:max-w-sm" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
      )}
      <div className={cn('overflow-x-auto rounded-lg border border-border bg-card',
        props.cardsBelow !== undefined && SWITCH[props.cardsBelow].table)}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {props.columns.map((title, i) => (
                <TableHead key={i} className={props.headClassName}>{title}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row} className="border-border/60 hover:bg-transparent">
                {props.columns.map((_, i) => (
                  <TableCell key={i} className="py-3">
                    <Skeleton className={cn('h-4', i === 0 ? 'w-32' : row % 2 === 0 ? 'w-24' : 'w-16')} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {props.cardsBelow !== undefined && (
        <div className={cn('flex flex-col gap-2.5', SWITCH[props.cardsBelow].cards)}>
          {rows.slice(0, 4).map((row) => (
            <div key={row} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Loading>
  );
}

/** Plan cards: name, key and status on one line, a description, a version table. */
export function PlanCardsSkeleton(props: { cards?: number }): ReactElement {
  return (
    <Loading label="plans" className="flex flex-col gap-3">
      {Array.from({ length: props.cards ?? 2 }, (_, card) => (
        <section key={card} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-4 w-full max-w-md" />
          <div className="mt-1 flex flex-col gap-2.5">
            {[0, 1].map((row) => (
              <div key={row} className="flex items-center gap-4">
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="hidden h-4 w-16 sm:block" />
                <Skeleton className="hidden h-4 w-20 sm:block" />
                <Skeleton className="ml-auto h-4 w-28" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </Loading>
  );
}
