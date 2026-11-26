import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { known, unknown, type Remote } from '../../../lib/remote.js';
import { CalendarClock, CalendarX, CircleCheck, CreditCard, IndianRupee, Store } from 'lucide-react';
import { StatTile, failedRead, formatMoney } from '../../../components/platform/kit.js';
import {
  EXPIRING_WITHIN_DAYS, subscriptionHealth, type SubscriptionHealth,
} from '../../restaurants/platform/subscription.js';
import type { TenantSummary } from '../../../types/restaurant.js';
import { RestaurantManager, type RestaurantPermissions } from '../../restaurants/platform/RestaurantManager.js';
import { Skeleton } from '@/components/ui/skeleton.js';

/**
 * A Salesperson's home: their own book and nothing else.
 *
 * The figures are folded from the SAME scoped read the table below makes --
 * `GET /tenants` answers a `sales` token with the restaurants that rep
 * provisioned -- so a tile can never count a restaurant the table would not
 * show. Nothing here is filtered by rep on the client.
 */

export function SalesDashboard(props: {
  api: PlatformApi; can: RestaurantPermissions;
  /** The signed-in rep's name from their account (`GET /me`); null until it has loaded. */
  name: string | null;
}): ReactElement {
  const [book, setBook] = useState<Remote<readonly TenantSummary[]>>(unknown<readonly TenantSummary[]>());

  const read = useCallback(async (): Promise<void> => {
    try {
      setBook(known(await props.api.get<readonly TenantSummary[]>('/tenants?limit=200')));
    } catch (error) {
      setBook((current) => failedRead(error, current));
    }
  }, [props.api]);

  useEffect(() => { void read(); }, [read]);

  const rows = book.state === 'unknown' ? null : book.value;
  const health = rows?.map((t) => subscriptionHealth(t)) ?? [];
  const count = (h: SubscriptionHealth): number => health.filter((x) => x === h).length;
  const activeRestaurants = rows?.filter((t) => t.status === 'active').length ?? 0;
  // Live and inside their paid (or trial) period: what a rep can call "active".
  const activeSubscriptions = count('active') + count('expiring');
  // One currency across the book today (every standard plan is INR). If that
  // ever stops being true this sum would mix currencies, so it states which.
  const currency = rows?.[0]?.defaultCurrency ?? 'INR';
  const revenue = rows?.reduce((sum, t) => sum + t.revenueMinor, 0) ?? 0;
  // Asked and not answered: a bar where the figure lands. A failed read keeps its dash.
  const loading = book.state === 'unknown' && book.reason === 'never-read';
  const dash = loading ? <Skeleton className="skeleton-appear my-0.5 h-8 w-20" />
    : book.state === 'unknown' ? '—' : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {props.name === null ? 'Welcome' : `Welcome, ${props.name}`}
        </span>
        <span className="max-w-[640px] text-sm leading-relaxed text-muted-foreground">
          The restaurants you have sold. Every restaurant you create is linked to you
          automatically.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6"
        aria-busy={loading} aria-label={loading ? 'Loading sales figures' : undefined}>
        <StatTile label="Restaurants sold" icon={<Store className="size-4" />}
          value={dash ?? String(rows!.length)} />
        <StatTile label="Active restaurants" icon={<CircleCheck className="size-4" />}
          value={dash ?? String(activeRestaurants)} caption="open and trading" />
        <StatTile label="Active subscriptions" icon={<CreditCard className="size-4" />}
          value={dash ?? String(activeSubscriptions)} caption="inside their paid or trial period" />
        <StatTile label="Expiring soon" icon={<CalendarClock className="size-4" />}
          value={dash ?? String(count('expiring'))} tone={count('expiring') > 0 ? 'warn' : undefined}
          caption={`in the next ${EXPIRING_WITHIN_DAYS} days`} />
        <StatTile label="Expired" icon={<CalendarX className="size-4" />}
          value={dash ?? String(count('expired'))} tone={count('expired') > 0 ? 'warn' : undefined}
          caption="renew or change plan" />
        <StatTile label="Total revenue" icon={<IndianRupee className="size-4" />}
          value={dash ?? formatMoney(revenue, currency)} caption="paid invoices" />
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold text-foreground">My restaurants</span>
        <RestaurantManager api={props.api} mode="sales" can={props.can} onChanged={() => { void read(); }} />
      </div>
    </div>
  );
}
