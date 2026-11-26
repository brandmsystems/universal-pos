import type { ReactElement } from 'react';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { Card } from '@/components/ui/card.js';
import { cn } from '@/lib/utils.js';

/**
 * Loading shapes for the admin screens, drawn where the content will land and
 * at its size, so the page does not jump when the read answers.
 *
 * A skeleton means "asked, not answered yet" and nothing else. An empty list
 * and a failed read keep their own screens: grey bars over a failed read would
 * say "any moment now" about something that is not coming.
 */
export interface TableShape { columns: number | readonly string[]; rows?: number; actions?: boolean }

/** Table rows under a header. Known column titles are drawn as text: they are not what is loading. */
export function TableSkeleton(props: TableShape & { label: string; className?: string }): ReactElement {
  return (
    <Loading label={props.label} className={cn('overflow-x-auto rounded-[4px] border border-border bg-card', props.className)}>
      <TableBones {...props} />
    </Loading>
  );
}

export function TableBones(props: TableShape): ReactElement {
  const titles = typeof props.columns === 'number' ? null : props.columns;
  const count = titles?.length ?? (props.columns as number);
  const cells = Array.from({ length: count }, (_, i) => i);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b-2 border-border text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {cells.map((i) => (
            <th key={i} className="px-3 py-2.5">
              {titles === null ? <Skeleton className="h-3 w-20" /> : titles[i]}
            </th>
          ))}
          {props.actions !== false && <th className="px-3 py-2.5" />}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: props.rows ?? 6 }, (_, row) => (
          <tr key={row} className="border-b border-border last:border-b-0">
            {cells.map((i) => (
              <td key={i} className="px-3 py-3">
                <Skeleton className={cn('h-4', i === 0 ? 'w-32' : row % 2 === 0 ? 'w-24' : 'w-16')} />
              </td>
            ))}
            {props.actions !== false && (
              <td className="px-3 py-2 text-right"><Skeleton className="ml-auto h-8 w-14" /></td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The dashboard's four figure tiles, at the Tile's own padding and type sizes.
 * The wrapper is `display: contents` so the tiles sit in the page's own grid,
 * which also means it has no box to fade -- each tile carries the delay.
 */
export function TilesSkeleton(): ReactElement {
  return (
    <Loading label="sales figures" className="contents">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i} className="skeleton-appear min-w-0 gap-0 border-border p-4 py-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-8 w-32" />
          <Skeleton className="mt-2.5 h-3 w-28" />
        </Card>
      ))}
    </Loading>
  );
}

/** A screen whose layout is not yet decided: a title, a toolbar and a table. */
export function PageSkeleton(props: { label: string }): ReactElement {
  return (
    <Loading label={props.label} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="ml-auto h-9 w-24" />
      </div>
      <div className="flex gap-2"><Skeleton className="h-9 w-56" /><Skeleton className="h-9 w-36" /></div>
      <div className="overflow-x-auto rounded-[4px] border border-border bg-card"><TableBones columns={4} /></div>
    </Loading>
  );
}
