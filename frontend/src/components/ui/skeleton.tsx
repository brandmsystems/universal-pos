import * as React from "react"
import { cn } from "cn"
import "../../styles/skeleton.css"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-foreground/10 motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

/**
 * The region a skeleton stands in for: announced as loading, and only painted
 * once the wait passes 150ms (skeleton.css), so a fast read never flashes.
 * A skeleton means "asked, not answered yet" -- never a failed or empty read.
 */
function Loading({ label, className, ...props }: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Loading ${label}`}
      data-skeleton={label}
      className={cn("skeleton-appear", className)}
      {...props}
    />
  )
}

/** A bar chart's plot area. */
function ChartSkeleton({ label }: { label: string }) {
  const bars = [40, 65, 30, 80, 55, 90, 45, 70, 35, 60, 25, 50]
  return (
    <Loading label={label} className="flex h-40 items-end gap-1.5">
      {bars.map((height, i) => <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${height}%` }} />)}
    </Loading>
  )
}

/** Label-and-figure lines: top items, payments, recent invoices. */
function LinesSkeleton({ label, lines = 5 }: { label: string; lines?: number }) {
  return (
    <Loading label={label} className="flex flex-col gap-3">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className={cn("h-4", i % 2 === 0 ? "w-40" : "w-28")} />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </Loading>
  )
}

export { ChartSkeleton, LinesSkeleton, Loading, Skeleton }
