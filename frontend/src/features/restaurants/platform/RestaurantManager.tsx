import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { known, unknown, type Remote } from '../../../lib/remote.js';
import { cn } from 'cn';
import { ArrowLeftRight, Eye, Globe, Pencil, Plus, Power, PowerOff, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';
import { Notice, failedRead, formatDate, formatMoney, selectClass } from '../../../components/platform/kit.js';
import { tenantStatusTone, tenantStatusWord } from '../../../app/platform/tokens.js';
import { Pagination } from '../../../components/platform/Pagination.js';
import {
  BILLING_TONES, BILLING_WORDS, HEALTH_TONES, HEALTH_WORDS, sellableOptions, subscriptionHealth,
} from './subscription.js';
import { usePlans } from '../../../hooks/usePlans.js';
import type { TenantSummary } from '../../../types/restaurant.js';
import {
  ChangePlanModal, CountryModal, EditRestaurantModal, ExpiryText, RestaurantDetailModal, StatusModal,
} from './RestaurantModals.js';
import { NewRestaurantModal } from './NewRestaurantModal.js';
import { ListSkeleton } from '../../../components/platform/skeletons.js';

/**
 * The restaurant list, for the whole estate or for one Salesperson's book.
 *
 * ###########################################################################
 * THE SERVER DECIDES WHOSE ROWS THESE ARE. THIS COMPONENT NEVER FILTERS BY REP.
 *
 * `GET /tenants` scopes a `sales` token to the restaurants that rep provisioned,
 * and it does so even when the query names another rep (asserted in
 * restaurantManagement.test.ts). So `mode: 'sales'` changes which COLUMNS and
 * FILTERS make sense -- a rep's own name on every row is noise -- and nothing
 * about which rows arrive. A client-side filter here would be a second copy of
 * the scoping rule, and the one that can be edited in a browser.
 * ###########################################################################
 *
 * The `can*` flags only decide which buttons are drawn. Every action is
 * authorised at the server against the token's role; a button shown to the
 * wrong role produces a refusal, never a write.
 */

/** `MAX_PAGE_SIZE` on the server; a longer estate shows the saturation notice. */
const READ_LIMIT = 200;
const PAGE_SIZE = 10;

export interface RestaurantPermissions {
  readonly create: boolean;
  readonly edit: boolean;
  readonly toggleStatus: boolean;
  readonly changeSubscription: boolean;
  /** A new address (slug). Super Admin only; the server holds the key. */
  readonly rename: boolean;
  /** A restaurant's staff and their PINs (`platform.tenant.staff`): Sales person and Super Admin. */
  readonly manageStaff: boolean;
  /**
   * Its country and currency, before its first bill (`platform.tenant.country`):
   * Super Admin, and a Sales person only while a Super Admin allows it -- the
   * modal reads that setting and says so; the server decides.
   */
  readonly changeCountry: boolean;
}

const STATUS_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Past due' },
  { value: 'soft_lock', label: 'Soft locked' },
  { value: 'hard_lock', label: 'Hard locked' },
  { value: 'deactivated', label: 'Deactivated' },
  { value: 'retention', label: 'Retention' },
] as const;

const EXPIRY_FILTERS = [
  { value: 'within_7_days', label: 'Expiring in 7 days' },
  { value: 'within_30_days', label: 'Expiring in 30 days' },
  { value: 'expired', label: 'Expired' },
] as const;

interface SalesPersonOption { readonly platformUserId: string; readonly fullName: string }

export function RestaurantManager(props: {
  api: PlatformApi;
  mode: 'estate' | 'sales';
  can: RestaurantPermissions;
  /** Told after any write, so a parent's summary can re-read. */
  onChanged?: () => void;
}): ReactElement {
  const [rows, setRows] = useState<Remote<readonly TenantSummary[]>>(unknown<readonly TenantSummary[]>());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [salesPerson, setSalesPerson] = useState('');
  const [status, setStatus] = useState('');
  const [expiry, setExpiry] = useState('');
  const [page, setPage] = useState(1);
  const [flash, setFlash] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  // By id, not by row: after a renewal or a new setup link the list re-reads,
  // and the open dialog must show the new row rather than the one it opened on.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TenantSummary | null>(null);
  const [toggling, setToggling] = useState<TenantSummary | null>(null);
  const [changing, setChanging] = useState<TenantSummary | null>(null);
  const [moving, setMoving] = useState<TenantSummary | null>(null);

  const plans = usePlans(props.api);
  const planOptions = useMemo(() => sellableOptions(plans), [plans]);
  const [salesPeople, setSalesPeople] = useState<readonly SalesPersonOption[]>([]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(READ_LIMIT) });
    if (search !== '') params.set('search', search);
    if (plan !== '') params.set('plan', plan);
    if (salesPerson !== '') params.set('salesPerson', salesPerson);
    if (status !== '') params.set('status', status);
    if (expiry !== '') params.set('expiry', expiry);
    return params.toString();
  }, [search, plan, salesPerson, status, expiry]);

  const read = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setRows(known(await props.api.get<readonly TenantSummary[]>(`/tenants?${query}`)));
    } catch (error) {
      setRows((current) => failedRead(error, current));
    } finally {
      setLoading(false);
    }
  }, [props.api, query]);

  useEffect(() => { void read(); }, [read]);
  useEffect(() => { setPage(1); }, [query]);

  // The rep filter only exists on the estate view. A Salesperson does not hold
  // platform.user.view, so the read would only ever be refused for them.
  useEffect(() => {
    if (props.mode !== 'estate') return;
    void (async () => {
      try {
        setSalesPeople(await props.api.get<readonly SalesPersonOption[]>('/sales-persons'));
      } catch {
        setSalesPeople([]);
      }
    })();
  }, [props.api, props.mode]);

  const changed = (message?: string): void => {
    if (message !== undefined) setFlash(message);
    void read();
    props.onChanged?.();
  };

  const filtersActive = search !== '' || plan !== '' || salesPerson !== '' || status !== '' || expiry !== '';
  const clearFilters = (): void => {
    setDraft(''); setSearch(''); setPlan(''); setSalesPerson(''); setStatus(''); setExpiry('');
  };

  const all = rows.state === 'unknown' ? [] : rows.value;
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const estate = props.mode === 'estate';
  const viewing = viewingId === null ? null : all.find((t) => t.tenantId === viewingId) ?? null;
  // Opening the details re-reads the list: whether the manager has signed up
  // (and so whether a new link is a password RESET) must be current, not what
  // the list said when the page first loaded.
  const setViewing = (t: TenantSummary): void => { setViewingId(t.tenantId); void read(); };

  return (
    <div className="flex flex-col gap-4">
      {/* ---- toolbar -------------------------------------------------- */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <form className="flex min-w-0 flex-1 gap-2"
            onSubmit={(event) => { event.preventDefault(); setSearch(draft.trim()); }}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground" />
              <Input value={draft} onChange={(event) => setDraft(event.target.value)}
                placeholder="Search name, slug or manager email" aria-label="Search restaurants"
                className="h-9 pl-8" />
            </div>
            <Button type="submit" variant="outline" className="h-9">Search</Button>
          </form>
          {props.can.create && (
            <Button type="button" className="h-9" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Create restaurant
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <select aria-label="Filter by plan" value={plan} onChange={(e) => setPlan(e.target.value)}
            className={cn(selectClass, 'h-9')}>
            <option value="">All plans</option>
            {plans.filter((p) => p.status === 'active').map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
          {estate && (
            <select aria-label="Filter by sales person" value={salesPerson}
              onChange={(e) => setSalesPerson(e.target.value)} className={cn(selectClass, 'h-9')}>
              <option value="">All sales persons</option>
              {salesPeople.map((p) => (
                <option key={p.platformUserId} value={p.platformUserId}>{p.fullName}</option>
              ))}
            </select>
          )}
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}
            className={cn(selectClass, 'h-9')}>
            <option value="">All statuses</option>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select aria-label="Filter by expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}
            className={cn(selectClass, 'h-9')}>
            <option value="">Any expiry</option>
            {EXPIRY_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {filtersActive && (
          <button type="button" onClick={clearFilters}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <X className="size-3.5" /> Clear filters
          </button>
        )}
      </div>

      {flash !== null && (
        <Notice tone="success">
          <span className="flex items-start justify-between gap-3">
            {flash}
            <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
          </span>
        </Notice>
      )}
      {rows.state === 'stale' && (
        <span className="text-xs font-semibold text-status-warn">
          Showing the last read; the server could not be reached just now.
        </span>
      )}
      {all.length >= READ_LIMIT && (
        <span className="text-xs font-semibold text-status-warn">
          Showing the first {READ_LIMIT}. There may be more — search or filter to narrow it.
        </span>
      )}

      {/* ---- body ----------------------------------------------------- */}
      {rows.state === 'unknown' ? (
        loading ? (
          <ListSkeleton label="restaurants" cardsBelow="xl" headClassName={HEAD} columns={[
            'Restaurant', ...(estate ? ['Sales person'] : []), 'Client / Manager', 'Plan', 'Subscription',
            'Start', 'Expiry', 'Status', 'Price', ...(estate ? [] : ['Billing', 'Login']), 'Actions',
          ]} />
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {rows.reason === 'not-permitted'
              ? 'Your role cannot read the restaurant list.'
              : 'The restaurant list could not be read just now.'}
            <Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => { void read(); }}>
              Try again
            </Button>
          </div>
        )
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <span className="text-sm text-muted-foreground">
            {filtersActive ? 'No restaurant matches these filters.'
              : estate ? 'No restaurants yet.' : 'You have not created a restaurant yet.'}
          </span>
          {filtersActive ? (
            <Button type="button" variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
          ) : props.can.create && (
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Create restaurant
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* xl and up: the full table. The estate's column order is the Super
              Admin's reading order -- who sold it comes straight after what it is. */}
          <div className={cn('hidden rounded-lg border border-border bg-card xl:block', loading && 'opacity-60')}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={HEAD}>Restaurant</TableHead>
                  {estate && <TableHead className={HEAD}>Sales person</TableHead>}
                  <TableHead className={HEAD}>Client / Manager</TableHead>
                  <TableHead className={HEAD}>Plan</TableHead>
                  <TableHead className={HEAD}>Subscription</TableHead>
                  <TableHead className={HEAD}>Start</TableHead>
                  <TableHead className={HEAD}>Expiry</TableHead>
                  <TableHead className={HEAD}>Status</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Price</TableHead>
                  {!estate && <TableHead className={HEAD}>Billing</TableHead>}
                  {!estate && <TableHead className={HEAD}>Login</TableHead>}
                  <TableHead className={cn(HEAD, 'text-right')}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((t) => (
                  <TableRow key={t.tenantId} className="border-border/60">
                    <TableCell className="py-2.5">
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">{t.name}</span>
                        <span className="font-mono text-[11px] text-subtle-foreground">{t.slug}</span>
                        {!estate && t.salesPersonName !== null && (
                          <span className="text-[11px] text-subtle-foreground">Sold by {t.salesPersonName}</span>
                        )}
                      </div>
                    </TableCell>
                    {estate && (
                      <TableCell className="max-w-[200px] py-2.5">
                        <SalesPerson tenant={t} />
                      </TableCell>
                    )}
                    <TableCell className="max-w-[220px] py-2.5"><Contact tenant={t} /></TableCell>
                    <TableCell className="py-2.5 text-foreground">
                      {t.planName ?? <span className="text-subtle-foreground">none</span>}
                    </TableCell>
                    <TableCell className="py-2.5"><HealthBadge tenant={t} /></TableCell>
                    <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">
                      {formatDate(t.currentPeriodStart)}
                    </TableCell>
                    <TableCell className="py-2.5"><ExpiryText end={t.currentPeriodEnd} /></TableCell>
                    <TableCell className="py-2.5">
                      <span className={cn('text-xs font-semibold', tenantStatusTone(t.status))}>
                        {tenantStatusWord(t.status)}
                      </span>
                    </TableCell>
                    <TableCell className="py-2.5 text-right">
                      <span className="font-medium tabular-nums text-foreground">{formatMoney(t.priceMinor, t.priceCurrency)}</span>
                      {t.billingPeriod !== null && (
                        <span className="text-xs text-subtle-foreground"> / {t.billingPeriod === 'yearly' ? 'yr' : 'mo'}</span>
                      )}
                    </TableCell>
                    {!estate && (
                      <TableCell className={cn('py-2.5 text-xs', BILLING_TONES[t.billingStatus])}>
                        {BILLING_WORDS[t.billingStatus]}
                      </TableCell>
                    )}
                    {!estate && (
                      <TableCell className="py-2.5 text-xs text-muted-foreground">
                        <InviteState status={t.ownerInviteStatus} />
                      </TableCell>
                    )}
                    <TableCell className="py-2.5">
                      <Actions tenant={t} can={props.can}
                        onView={setViewing} onEdit={setEditing} onToggle={setToggling} onChangePlan={setChanging} onCountry={setMoving} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Below xl: one card per restaurant, nothing scrolls sideways. */}
          <div className={cn('flex flex-col gap-2.5 xl:hidden', loading && 'opacity-60')}>
            {visible.map((t) => (
              <div key={t.tenantId} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-foreground">{t.name}</span>
                    <Contact tenant={t} />
                  </div>
                  <HealthBadge tenant={t} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  <Cell label="Plan">
                    {t.planName ?? '—'}{t.priceMinor !== null && (
                      <span className="text-muted-foreground"> · {formatMoney(t.priceMinor, t.priceCurrency)}</span>
                    )}
                  </Cell>
                  <Cell label="Start"><span className="font-mono">{formatDate(t.currentPeriodStart)}</span></Cell>
                  <Cell label="Expiry"><ExpiryText end={t.currentPeriodEnd} /></Cell>
                  <Cell label="Billing"><span className={BILLING_TONES[t.billingStatus]}>{BILLING_WORDS[t.billingStatus]}</span></Cell>
                  <Cell label="Sales person">{t.salesPersonName ?? '—'}</Cell>
                  <Cell label="Status">
                    <span className={tenantStatusTone(t.status)}>{tenantStatusWord(t.status)}</span>
                  </Cell>
                  <Cell label="Login"><InviteState status={t.ownerInviteStatus} /></Cell>
                </dl>
                <div className="flex justify-end border-t border-border/60 pt-2">
                  <Actions tenant={t} can={props.can}
                    onView={setViewing} onEdit={setEditing} onToggle={setToggling} onChangePlan={setChanging} onCountry={setMoving} />
                </div>
              </div>
            ))}
          </div>

          <Pagination page={current} total={all.length} pageSize={PAGE_SIZE} noun="restaurants"
            onPage={(next) => { setPage(next); window.scrollTo({ top: 0 }); }} />
        </>
      )}

      <NewRestaurantModal api={props.api} open={creating} planOptions={planOptions}
        onClose={() => setCreating(false)} onCreated={() => changed()} />
      <RestaurantDetailModal api={props.api} tenant={viewing}
        planTerms={viewing === null ? null
          : plans.flatMap((plan) => plan.versions).find((v) => v.planVersionId === viewing.planVersionId) ?? null}
        canChangeSubscription={props.can.changeSubscription}
        canIssueSetupLink={props.can.create}
        canManageStaff={props.can.manageStaff}
        onChangePlan={(t) => { setViewingId(null); setChanging(t); }}
        onClose={() => setViewingId(null)} onChanged={() => changed()} />
      <ChangePlanModal api={props.api} tenant={changing} planOptions={planOptions}
        onClose={() => setChanging(null)} onChanged={(message) => changed(message)} />
      <EditRestaurantModal api={props.api} tenant={editing} canRename={props.can.rename}
        onClose={() => setEditing(null)} onSaved={() => changed('Restaurant updated.')} />
      <CountryModal api={props.api} tenant={moving}
        onClose={() => setMoving(null)} onChanged={(message) => changed(message)} />
      <StatusModal api={props.api} tenant={toggling}
        onClose={() => setToggling(null)} onChanged={(message) => changed(message)} />
    </div>
  );
}

const HEAD = 'h-9 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground';

function Cell(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-subtle-foreground">{props.label}</dt>
      <dd className="min-w-0 truncate text-foreground">{props.children}</dd>
    </div>
  );
}

/** Who sold it, from their account: the name, with email and phone beneath. */
function SalesPerson(props: { tenant: TenantSummary }): ReactElement {
  const t = props.tenant;
  if (t.salesPersonName === null) return <span className="text-xs text-subtle-foreground">—</span>;
  return (
    <div className="flex min-w-0 flex-col text-xs">
      <span className="truncate text-sm text-foreground">{t.salesPersonName}</span>
      {t.salesPersonEmail !== null && <span className="truncate text-muted-foreground">{t.salesPersonEmail}</span>}
    </div>
  );
}

/** Who the restaurant was sold to: name, email and phone, as the sale recorded them. */
function Contact(props: { tenant: TenantSummary }): ReactElement {
  const t = props.tenant;
  return (
    <div className="flex min-w-0 flex-col text-xs">
      {t.ownerName !== null && <span className="truncate text-sm text-foreground">{t.ownerName}</span>}
      <span className="truncate text-muted-foreground" title={t.ownerEmail ?? undefined}>{t.ownerEmail ?? '—'}</span>
      {t.ownerPhone !== null && <span className="truncate font-mono text-subtle-foreground">{t.ownerPhone}</span>}
    </div>
  );
}

/** Active / Expiring soon / Expired / Suspended, worked out from the dates each time it renders. */
function HealthBadge(props: { tenant: TenantSummary }): ReactElement {
  const health = subscriptionHealth(props.tenant);
  const trial = props.tenant.subscriptionStatus === 'trialing' && (health === 'active' || health === 'expiring');
  return (
    <span className={cn('inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      HEALTH_TONES[health])}>
      {HEALTH_WORDS[health]}{trial && <span className="font-normal opacity-80">· trial</span>}
    </span>
  );
}

function InviteState(props: { status: string | null }): ReactElement {
  if (props.status === 'accepted') return <span className="text-status-good">Signed up</span>;
  if (props.status === 'pending') return <span>Invite sent</span>;
  if (props.status === null) return <span className="text-subtle-foreground">—</span>;
  return <span className="text-status-warn">Invite {props.status}</span>;
}

const iconButton =
  'inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md text-muted-foreground transition-colors '
  + 'hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function Actions(props: {
  tenant: TenantSummary;
  can: RestaurantPermissions;
  onView: (t: TenantSummary) => void;
  onEdit: (t: TenantSummary) => void;
  onToggle: (t: TenantSummary) => void;
  onChangePlan: (t: TenantSummary) => void;
  onCountry: (t: TenantSummary) => void;
}): ReactElement {
  const t = props.tenant;
  // Only an active restaurant can be deactivated (one owing money is on the
  // ladder), and only a deactivated one can be activated -- so the button is
  // drawn exactly where the server would accept it.
  const toggle = props.can.toggleStatus && (t.status === 'active' || t.status === 'deactivated');
  return (
    <div className="flex items-center justify-end gap-0.5">
      <button type="button" className={iconButton} onClick={() => props.onView(t)}
        aria-label={`View ${t.name}`} title="View details">
        <Eye className="size-4" />
      </button>
      {props.can.edit && (
        <button type="button" className={iconButton} onClick={() => props.onEdit(t)}
          aria-label={`Edit ${t.name}`} title="Edit">
          <Pencil className="size-4" />
        </button>
      )}
      {props.can.changeSubscription && t.subscriptionId !== null && (
        <button type="button" className={iconButton} onClick={() => props.onChangePlan(t)}
          aria-label={`Change plan for ${t.name}`} title="Change plan">
          <ArrowLeftRight className="size-4" />
        </button>
      )}
      {props.can.changeCountry && (
        <button type="button" className={iconButton} onClick={() => props.onCountry(t)}
          aria-label={`Country and currency of ${t.name}`} title="Country & currency">
          <Globe className="size-4" />
        </button>
      )}
      {toggle && (
        <button type="button" onClick={() => props.onToggle(t)}
          className={cn(iconButton, t.status === 'active'
            ? 'hover:bg-destructive/10 hover:text-destructive'
            : 'hover:bg-primary/10 hover:text-primary')}
          aria-label={`${t.status === 'active' ? 'Deactivate' : 'Activate'} ${t.name}`}
          title={t.status === 'active' ? 'Deactivate' : 'Activate'}>
          {t.status === 'active' ? <PowerOff className="size-4" /> : <Power className="size-4" />}
        </button>
      )}
    </div>
  );
}
