import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  PLAN_FEATURES, REPORT_TIERS, entitlementsFromTerms, planTermsFor,
  type PlanEntitlements, type PlanFeature, type ReportTier,
} from '@katkitchen/shared';
import { PlatformApiError, type PlatformApi } from '../../../services/platformApi.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { cn } from 'cn';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Modal, Notice, SelectField, TextField, refusalMessage } from '../../../components/platform/kit.js';
import { Pagination, pageCount } from '../../../components/platform/Pagination.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';
import { standardPlans } from '../../../lib/plans.js';
import { PlanCardsSkeleton } from '../../../components/platform/skeletons.js';
import { minorFrom, minorFromTyped, typedFromMinor } from '../../../lib/money.js';
import { Switch } from '@/components/ui/switch.js';

/**
 * The plan catalogue, and what is actually sold on each version.
 *
 * ###########################################################################
 * VERSIONS ARE NOT HISTORY, THEY ARE LIVE PRODUCTS.
 *
 * A subscription points at a plan VERSION, not a plan, so two restaurants on
 * "Pro" can be paying different prices under different limits -- which is the
 * point: a price rise must not rewrite what an existing customer agreed to.
 * That makes `liveSubscriptions` per version the number that matters here, and
 * it is why this screen lists versions rather than collapsing them to the
 * newest. Retiring a version with customers on it is a migration, not a delete.
 * ###########################################################################
 */

interface PlanVersion {
  readonly planVersionId: string;
  readonly version: number;
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingPeriod: string;
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
  readonly publishedAt: string | null;
  readonly liveSubscriptions: number;
  readonly subscriptionsByStatus?: {
    readonly trialing: number; readonly active: number; readonly past_due: number;
  };
}

interface Plan {
  readonly planId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly versions: readonly PlanVersion[];
}

/** Plans per page. Each card carries its own version table, so a page is
 * already several rows tall; six keeps one page to about a screen. */
const PAGE_SIZE = 6;

/** Minor units to a readable amount. The currency is the version's own. */
export function money(minor: number, currency: string): string {
  return `${currency} ${typedFromMinor(minorFrom(minor))}`;
}

export function Plans(props: { api: PlatformApi; canPublish: boolean }): ReactElement {
  const [plans, setPlans] = useState<Remote<readonly Plan[]>>(unknown<readonly Plan[]>());
  const [page, setPage] = useState(1);
  const [publishing, setPublishing] = useState<Plan | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const read = useCallback(async (): Promise<void> => {
    try {
      setPlans(known(standardPlans(await props.api.get<readonly Plan[]>('/plans'))));
    } catch (error) {
      setPlans((current) =>
        error instanceof PlatformApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<readonly Plan[]>(
            error instanceof PlatformApiError && error.failure.kind === 'refused'
              && error.failure.status === 403 ? 'not-permitted' : 'read-failed'));
    }
  }, [props.api]);

  useEffect(() => { void read(); }, [read]);

  if (plans.state === 'unknown' && plans.reason === 'never-read') {
    return (
      <div className="flex flex-col gap-4">
        <Heading />
        <PlanCardsSkeleton />
      </div>
    );
  }
  if (plans.state === 'unknown') {
    return (
      <div className="flex flex-col gap-3.5">
        <Heading />
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {plans.reason === 'not-permitted'
            ? 'This role cannot read the plan catalogue.'
            : 'The plan catalogue could not be read just now.'}
          <div className="mt-1.5 font-mono text-[11px] text-subtle-foreground">
            plans · {plans.reason}
          </div>
        </div>
      </div>
    );
  }

  // Clamped rather than trusted: a re-read that returns fewer plans must not
  // leave the screen on a page that no longer exists.
  const current = Math.min(page, pageCount(plans.value.length, PAGE_SIZE));
  // Cheapest first -- Basic, Pro -- by the newest published price, the
  // order a customer compares them in. The server lists by key.
  const newestPrice = (plan: Plan): number => [...plan.versions]
    .filter((v) => v.publishedAt !== null)
    .sort((x, y) => y.version - x.version)[0]?.priceMinor ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...plans.value].sort((x, y) =>
    Number(x.status !== 'active') - Number(y.status !== 'active') || newestPrice(x) - newestPrice(y));
  const visible = ordered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // Deactivating a plan stops it being SOLD; restaurants on it keep it. The
  // server refuses provisioning on an inactive plan, so this is not cosmetic.
  async function toggle(plan: Plan): Promise<void> {
    const next = plan.status === 'active' ? 'retired' : 'active';
    try {
      await props.api.post(`/plans/${plan.planId}/status`, { status: next });
      setFlash({ tone: 'success', text: next === 'active'
        ? `${plan.name} is active and can be sold again.`
        : `${plan.name} is inactive. It is no longer offered for new restaurants; existing ones keep it.` });
      await read();
    } catch (error) {
      setFlash({ tone: 'error', text: refusalMessage(error, 'nothing changed') });
    }
  }

  const goTo = (next: number): void => {
    setPage(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="flex flex-col gap-4">
      <Heading />

      {plans.state === 'stale' && (
        <span className="text-xs font-semibold text-status-warn">
          Showing the last read; the server could not be reached just now.
        </span>
      )}

      {plans.value.length === 0 ? (
        <span className="text-sm text-muted-foreground">No plans exist yet.</span>
      ) : (
        <>
          {flash !== null && <Notice tone={flash.tone}>{flash.text}</Notice>}
          <div className="flex flex-col gap-3">
            {visible.map((plan) => (
              <PlanCard key={plan.planId} plan={plan}
                onPublish={props.canPublish && plan.status === 'active' ? () => setPublishing(plan) : undefined}
                onToggle={props.canPublish ? () => { void toggle(plan); } : undefined} />
            ))}
          </div>
          <Pagination page={current} total={plans.value.length} pageSize={PAGE_SIZE}
            noun="plans" onPage={goTo} />
        </>
      )}

      <PublishVersionModal api={props.api} plan={publishing} onClose={() => setPublishing(null)}
        onPublished={(message) => { setFlash({ tone: 'success', text: message }); void read(); }} />
    </div>
  );
}

const HEAD = 'h-8 px-2 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground';

function PlanCard(props: {
  plan: Plan; onPublish?: (() => void) | undefined; onToggle?: (() => void) | undefined;
}): ReactElement {
  const { plan } = props;
  const live = plan.versions.reduce((sum, v) => sum + v.liveSubscriptions, 0);
  const byStatus = plan.versions.reduce(
    (acc, v) => ({
      trialing: acc.trialing + (v.subscriptionsByStatus?.trialing ?? 0),
      active: acc.active + (v.subscriptionsByStatus?.active ?? 0),
      past_due: acc.past_due + (v.subscriptionsByStatus?.past_due ?? 0),
    }),
    { trialing: 0, active: 0, past_due: 0 });

  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[15px] font-semibold text-foreground">{plan.name}</span>
          <span className="font-mono text-xs text-subtle-foreground">{plan.key}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold',
            plan.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>
            {plan.status === 'active' ? 'Active' : 'Inactive'}
          </span>
        </div>
        <span className="flex items-center gap-3 text-xs tabular-nums text-subtle-foreground">
          <span>
            {plan.versions.length} {plan.versions.length === 1 ? 'version' : 'versions'}
            {' · '}
            <span className="text-muted-foreground">{live} subscribed</span>
            {live > 0 && (
              <span className="hidden sm:inline">
                {' '}({byStatus.active} active · {byStatus.trialing} trial
                {byStatus.past_due > 0 && <span className="text-status-warn"> · {byStatus.past_due} past due</span>})
              </span>
            )}
          </span>
          {props.onToggle !== undefined && (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground"
              onClick={props.onToggle}>
              {plan.status === 'active' ? 'Deactivate' : 'Activate'}
            </Button>
          )}
          {props.onPublish !== undefined && (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={props.onPublish}>
              <Plus className="size-3.5" /> New version
            </Button>
          )}
        </span>
      </div>
      {plan.description !== null && (
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{plan.description}</p>
      )}

      {/* A plan created and not yet priced is a real state, and the server
          returns it as an empty version list rather than a phantom row. */}
      {plan.versions.length === 0 ? (
        <p className="mt-2.5 text-sm text-status-warn">
          No versions yet — nothing can be sold on this plan.
        </p>
      ) : (
        <>
          {/* lg and up: one compact table. Below 1024px its fixed columns are too
              narrow and the headers ran into each other, so tablets get the
              stacked blocks too. */}
          <div className="mt-2.5 hidden lg:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={cn(HEAD, 'w-[9%]')}>Version</TableHead>
                  <TableHead className={cn(HEAD, 'w-[18%]')}>Price</TableHead>
                  <TableHead className={cn(HEAD, 'w-[13%]')}>Period</TableHead>
                  <TableHead className={cn(HEAD, 'w-[15%]')}>Published</TableHead>
                  <TableHead className={cn(HEAD, 'w-[13%] text-right')}>Subscribers</TableHead>
                  <TableHead className={cn(HEAD, 'pl-6')}>Includes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.versions.map((version) => (
                  <TableRow key={version.planVersionId} className="border-border/60 hover:bg-muted/40">
                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">
                      v{version.version}
                    </TableCell>
                    <TableCell className="py-2 font-medium tabular-nums text-foreground">
                      {money(version.priceMinor, version.currency)}
                    </TableCell>
                    <TableCell className="py-2 text-muted-foreground">{version.billingPeriod}</TableCell>
                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">
                      <Published at={version.publishedAt} />
                    </TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums text-foreground">
                      {/* The number that decides whether this version can be
                          retired. Zero and "a hundred" are different decisions. */}
                      {version.liveSubscriptions}
                    </TableCell>
                    <TableCell className="whitespace-normal py-2 pl-6 text-xs text-muted-foreground">
                      <Includes version={version} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Below lg: one stacked block per version, no sideways scroll. */}
          <div className="mt-3 flex flex-col divide-y divide-border/60 lg:hidden">
            {plan.versions.map((version) => (
              <div key={version.planVersionId} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-subtle-foreground">v{version.version}</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {money(version.priceMinor, version.currency)}
                    </span>
                    <span className="text-xs text-muted-foreground">/ {version.billingPeriod}</span>
                  </span>
                  <span className="text-xs tabular-nums text-subtle-foreground">
                    <span className="font-medium text-foreground">{version.liveSubscriptions}</span>
                    {' '}subscribers
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    <span className="text-subtle-foreground">Published </span>
                    <span className="font-mono"><Published at={version.publishedAt} /></span>
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="text-subtle-foreground">Includes </span>
                    <Includes version={version} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Published(props: { at: string | null }): ReactElement {
  return props.at === null
    ? <span className="text-status-warn">draft</span>
    : <>{props.at.slice(0, 10)}</>;
}

const FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = {
  kot: 'KOT staff, kitchen tickets and billing hand-over',
  kds: 'kitchen screen (KDS) -- needs KOT',
  staff_tablets: 'staff tablets with setup codes (off: one owner till, as on Basic)',
  tables: 'floors and tables (off: dine-in numbered at the counter, as on Basic)',
};

/** Every feature, each from the plan version -- derived, so a new feature cannot be left out. */
const featuresOf = (held: PlanEntitlements | null): Record<PlanFeature, boolean> =>
  Object.fromEntries(PLAN_FEATURES.map((f) => [f, held?.[f] ?? false])) as Record<PlanFeature, boolean>;

const REPORT_LABELS: Readonly<Record<ReportTier, string>> = {
  basic: 'Dashboard only',
  advanced: 'Dashboard + sales, staff, exception and GST reports',
};

/** Read through the same function the API gates with, so the card cannot describe a different plan. */
function Includes(props: { version: { limits: Readonly<Record<string, number>>; features: Readonly<Record<string, boolean>> } }): ReactElement {
  const e = entitlementsFromTerms(props.version);
  const features = PLAN_FEATURES.filter((f) => e[f]).map((f) => FEATURE_LABELS[f]);
  return (
    <>
      {[
        `${e.branches} ${e.branches === 1 ? 'branch' : 'branches'}`,
        `${e.devices} ${e.devices === 1 ? 'tablet' : 'tablets'}`,
        `${e.users} ${e.users === 1 ? 'user' : 'users'}`,
        features.length > 0 ? features.join(', ') : 'no stock control',
        e.reports === 'basic' ? 'dashboard only' : e.reports === 'advanced' ? 'advanced reports' : 'all reports',
      ].join(' · ')}
    </>
  );
}

function Heading(): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Plans</span>
      <span className="max-w-[680px] text-sm leading-relaxed text-muted-foreground">
        What is sold, by version. A subscription points at a version and not at a
        plan, so raising a price never rewrites what an existing customer agreed
        to — and a version with restaurants on it cannot simply be removed.
      </span>
    </div>
  );
}

/**
 * A new version of a plan. The earlier versions stay exactly as sold, with
 * every restaurant still on them -- this changes what NEW restaurants are put
 * on, and what an existing one can move to. Limits and features the form does
 * not show are carried over from the newest version unchanged, so publishing a
 * price change cannot silently drop a limit this screen does not know about.
 */
function PublishVersionModal(props: {
  api: PlatformApi;
  plan: Plan | null;
  onClose: () => void;
  onPublished: (message: string) => void;
}): ReactElement | null {
  const latest = props.plan === null ? undefined
    : [...props.plan.versions].sort((a, b) => b.version - a.version)[0];
  const [price, setPrice] = useState('');
  const [period, setPeriod] = useState('monthly');
  const [branches, setBranches] = useState('');
  const [devices, setDevices] = useState('');
  const [users, setUsers] = useState('');
  const [features, setFeatures] = useState<Record<PlanFeature, boolean>>(() => featuresOf(null));
  const [reports, setReports] = useState<ReportTier>('basic');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setPrice(latest === undefined ? '' : typedFromMinor(minorFrom(latest.priceMinor)));
    setPeriod(latest?.billingPeriod ?? 'monthly');
    setBranches(latest?.limits['branches'] === undefined ? '' : String(latest.limits['branches']));
    setDevices(latest?.limits['devices'] === undefined ? '' : String(latest.limits['devices']));
    setUsers(latest?.limits['users'] === undefined ? '' : String(latest.limits['users']));
    const held = latest === undefined ? null : entitlementsFromTerms(latest);
    setFeatures(featuresOf(held));
    setReports(held?.reports ?? 'basic');
    setRefusal(null);
  }, [props.plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rupees typed, minor units sent: whole paise only, never a float on the wire.
  const priceMinor = minorFromTyped(price);
  const branchLimit = /^\d+$/.test(branches.trim()) ? Number(branches.trim()) : null;
  const deviceLimit = /^\d+$/.test(devices.trim()) ? Number(devices.trim()) : null;
  const userLimit = /^\d+$/.test(users.trim()) ? Number(users.trim()) : null;
  const errors = {
    price: priceMinor === null ? 'A whole amount, up to two decimal places.' : null,
    branches: branchLimit === null || branchLimit < 1 ? 'A whole number, 1 or more.' : null,
    devices: deviceLimit === null || deviceLimit < 1
      ? 'A whole number, 1 or more: a restaurant with no tablet cannot take an order.' : null,
    users: userLimit === null || userLimit < 1 ? 'A whole number, 1 or more: the owner is a user.' : null,
  };
  const valid = errors.price === null && errors.branches === null && errors.devices === null && errors.users === null;

  async function publish(): Promise<void> {
    if (props.plan === null || !valid) return;
    setBusy(true); setRefusal(null);
    try {
      const published = await props.api.post<{ version: number }>(`/plans/${props.plan.planId}/versions`, {
        priceMinor, currency: latest?.currency ?? 'INR', billingPeriod: period,
        // Every plan key is stated (the API refuses a version missing one);
        // anything else the newest version carried is kept as it was.
        ...((terms) => ({
          limits: { ...(latest?.limits ?? {}), ...terms.limits },
          features: { ...(latest?.features ?? {}), ...terms.features },
        }))(planTermsFor({ branches: branchLimit!, devices: deviceLimit!, users: userLimit!, ...features, reports })),
      });
      props.onPublished(`${props.plan.name} v${published.version} is published. New restaurants go on it; existing ones stay where they are.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was published'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.plan !== null} onClose={props.onClose} busy={busy}
      title={`New version of ${props.plan?.name ?? ''}`}
      description="Restaurants already on this plan keep the version they were sold. This only changes what is sold from now on."
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void publish(); }} disabled={busy || !valid}>
            {busy ? 'Publishing…' : 'Publish version'}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-3.5">
        {refusal !== null && <Notice tone="error">{refusal}</Notice>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField label={`Price (${latest?.currency ?? 'INR'})`} value={price} onChange={setPrice}
            mono required error={errors.price} />
          <SelectField label="Billing period" value={period} onChange={setPeriod}
            options={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }]} />
          <TextField label="Branches allowed" value={branches} onChange={setBranches}
            mono required error={errors.branches} />
          <TextField label="Tablets allowed (KOT, kitchen, billing)" value={devices} onChange={setDevices}
            mono required error={errors.devices} />
          <TextField label="Restaurant users allowed (owner included)" value={users} onChange={setUsers}
            mono required error={errors.users} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Features
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLAN_FEATURES.map((feature) => (
              <label key={feature} className="flex items-center gap-2.5 text-sm text-foreground">
                <Switch checked={features[feature]}
                  onCheckedChange={(on) => setFeatures((f) => ({ ...f, [feature]: on }))} />
                {FEATURE_LABELS[feature].charAt(0).toUpperCase() + FEATURE_LABELS[feature].slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
        <SelectField label="Reports" value={reports} onChange={(v) => setReports(v as ReportTier)}
          options={REPORT_TIERS.map((tier) => ({ value: tier, label: REPORT_LABELS[tier] }))} />
      </div>
    </Modal>
  );
}
