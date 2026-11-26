import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.js';
import {
  CopyField, Modal, Notice, SelectField, TextArea, TextField, daysUntil, formatDate, formatMoney,
  refusalMessage, restaurantUrl, setupLink,
} from '../../../components/platform/kit.js';
import { subscriptionStatusWord, tenantStatusTone, tenantStatusWord } from '../../../app/platform/tokens.js';
import {
  BILLING_TONES, BILLING_WORDS, HEALTH_TONES, HEALTH_WORDS, subscriptionHealth,
} from './subscription.js';
import type { CountrySettings, PlanOption, PlanVersion, TenantSummary } from '../../../types/restaurant.js';
import { restaurantLinks } from '../../../lib/restaurantPath.js';
import { TenantStaff } from './TenantStaff.js';
import { ADDRESS_MIN_LENGTH, entitlementsFromTerms, normaliseThemeColor, slugProblem } from '@katkitchen/shared';
import {
  BrandPreview, LogoField, ThemeColorField, readLogo, type LogoChoice,
} from '../../../components/platform/branding.js';

/* ------------------------------------------------------------------ edit --- */

/**
 * Name, legal name, address, theme colour and logo -- and, for a Super Admin,
 * the slug. A new slug does not break anything that carries the old one: the
 * old address keeps resolving (links redirect, tablets keep signing in) and no
 * other restaurant can ever take it. Everyone else sees it read-only. The manager's details are shown read-only too: after sign-up they
 * belong to the restaurant's own account, which the control plane does not edit.
 */
export function EditRestaurantModal(props: {
  api: PlatformApi;
  tenant: TenantSummary | null;
  canRename: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement | null {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTaken, setSlugTaken] = useState<string | null>(null);
  const [legalName, setLegalName] = useState('');
  const [address, setAddress] = useState('');
  const [themeColor, setThemeColor] = useState('');
  const [themeColorSecondary, setThemeColorSecondary] = useState('');
  const [logo, setLogo] = useState<LogoChoice | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setName(props.tenant?.name ?? '');
    setSlug(props.tenant?.slug ?? ''); setSlugTaken(null);
    setLegalName(props.tenant?.legalName ?? '');
    setAddress(props.tenant?.address ?? '');
    setThemeColor(props.tenant?.themeColor ?? '');
    setThemeColorSecondary(props.tenant?.themeColorSecondary ?? '');
    setLogo(null); setLogoRemoved(false); setLogoError(null);
    setRefusal(null);
  }, [props.tenant]);

  const nameError = name.trim().length < 2 ? 'At least 2 characters.' : null;
  const addressError = address.trim() !== '' && address.trim().length < ADDRESS_MIN_LENGTH
    ? `At least ${ADDRESS_MIN_LENGTH} characters.` : null;
  const colour = themeColor.trim() === '' ? null : normaliseThemeColor(themeColor);
  const colourError = themeColor.trim() !== '' && colour === null ? 'A hex colour like #fa5c00.' : null;
  const secondColour = themeColorSecondary.trim() === '' ? null : normaliseThemeColor(themeColorSecondary);
  const secondColourError = themeColorSecondary.trim() !== '' && secondColour === null ? 'A hex colour like #1b7f3a.' : null;
  const fields: Record<string, unknown> = {};
  if (props.tenant !== null) {
    if (name.trim() !== props.tenant.name) fields['name'] = name.trim();
    if (legalName.trim() !== (props.tenant.legalName ?? '')) fields['legalName'] = legalName.trim() === '' ? null : legalName.trim();
    if (address.trim() !== (props.tenant.address ?? '')) fields['address'] = address.trim() === '' ? null : address.trim();
    if (colour !== props.tenant.themeColor && colourError === null) fields['themeColor'] = colour;
    if (secondColour !== (props.tenant.themeColorSecondary ?? null) && secondColourError === null) fields['themeColorSecondary'] = secondColour;
  }
  const slugChanged = props.canRename && props.tenant !== null && slug.trim() !== props.tenant.slug;
  const slugError = slugChanged ? slugProblem(slug.trim()) ?? slugTaken : null;

  // The server's availability answer, for a slug that passes the shared rule.
  useEffect(() => {
    setSlugTaken(null);
    if (!slugChanged || slugProblem(slug.trim()) !== null) return;
    let live = true;
    const handle = setTimeout(() => {
      props.api.get<{ available: boolean; problem: string | null }>(
        `/tenants/slug-available?slug=${encodeURIComponent(slug.trim())}`)
        .then((answer) => { if (live && !answer.available) setSlugTaken(answer.problem ?? 'This slug cannot be used.'); })
        .catch(() => undefined);
    }, 300);
    return () => { live = false; clearTimeout(handle); };
  }, [slug, slugChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  const logoChanged = logo !== null || (logoRemoved && props.tenant?.logoUrl != null);
  const changed = Object.keys(fields).length > 0 || logoChanged || slugChanged;
  const invalid = nameError !== null || addressError !== null || colourError !== null || secondColourError !== null || slugError !== null;

  async function save(): Promise<void> {
    if (props.tenant === null || invalid) return;
    setBusy(true); setRefusal(null);
    try {
      if (slugChanged) await props.api.post(`/tenants/${props.tenant.tenantId}/slug`, { slug: slug.trim() });
      if (Object.keys(fields).length > 0) await props.api.patch(`/tenants/${props.tenant.tenantId}`, fields);
      if (logo !== null) {
        await props.api.post(`/tenants/${props.tenant.tenantId}/logo`,
          { contentType: logo.contentType, dataBase64: logo.dataBase64 });
      } else if (logoRemoved && props.tenant.logoUrl !== null) {
        await props.api.del(`/tenants/${props.tenant.tenantId}/logo`);
      }
      props.onSaved();
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'not everything was saved'));
      props.onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.tenant !== null} onClose={props.onClose} busy={busy}
      title="Edit restaurant"
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void save(); }} disabled={busy || !changed || invalid}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-3.5">
        {refusal !== null && <Notice tone="error">{refusal}</Notice>}
        <TextField label="Restaurant name" value={name} onChange={setName} required error={nameError} />
        <TextField label="Legal name" value={legalName} onChange={setLegalName}
          hint="As it appears on invoices. Optional." />
        {props.canRename ? (
          <TextField label="Slug (restaurant address)" value={slug} onChange={(v) => setSlug(v.toLowerCase())} mono
            error={slugError}
            hint={slugChanged
              ? `New address /${slug.trim()}. The old one, /${props.tenant?.slug ?? ''}, keeps working and redirects here; tablets stay set up; no other restaurant can take it.`
              : 'The restaurant\'s address and sign-in path. Changing it keeps the old one working.'} />
        ) : (
          <TextField label="Slug" value={props.tenant?.slug ?? ''} onChange={() => undefined} mono disabled
            hint="The restaurant's address and sign-in path. Only a Super Admin can change it." />
        )}
        <TextArea label="Address" value={address} onChange={setAddress}
          hint={addressError ?? 'Where the restaurant is.'} />
        <div className="grid gap-3.5 sm:grid-cols-2">
          <LogoField current={props.tenant?.logoUrl ?? null} choice={logo} removed={logoRemoved} error={logoError}
            onChoose={(file) => {
              void readLogo(file).then((read) => {
                if (typeof read === 'string') { setLogoError(read); return; }
                setLogoError(null); setLogo(read); setLogoRemoved(false);
              });
            }}
            onRemove={() => { setLogo(null); setLogoRemoved(true); }}
            onUndo={() => { setLogo(null); setLogoRemoved(false); }} />
          <BrandPreview name={name} primary={themeColor} secondary={themeColorSecondary}
            logoUrl={logo?.previewUrl ?? (logoRemoved ? null : props.tenant?.logoUrl ?? null)} />
          <ThemeColorField label="Primary colour" value={themeColor} onChange={setThemeColor}
            usage="Buttons, the PIN and highlights" />
          <ThemeColorField label="Secondary colour" value={themeColorSecondary} onChange={setThemeColorSecondary}
            usage="Bands, card accents and the background glow" />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField label="Manager" value={props.tenant?.ownerName ?? ''} onChange={() => undefined} disabled />
          <TextField label="Manager email" value={props.tenant?.ownerEmail ?? ''} onChange={() => undefined} disabled
            hint="Belongs to the restaurant's own account once the manager has signed up." />
          <TextField label="Manager phone" value={props.tenant?.ownerPhone ?? ''} onChange={() => undefined} disabled />
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- deactivation --- */

export function StatusModal(props: {
  api: PlatformApi;
  tenant: TenantSummary | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactElement | null {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { setReason(''); setRefusal(null); }, [props.tenant]);

  const deactivating = props.tenant?.status !== 'deactivated';
  const reasonOk = reason.trim().length >= 3;

  async function confirm(): Promise<void> {
    if (props.tenant === null || !reasonOk) return;
    setBusy(true); setRefusal(null);
    try {
      await props.api.post(
        `/tenants/${props.tenant.tenantId}/${deactivating ? 'deactivate' : 'reactivate'}`,
        { reason: reason.trim() });
      props.onChanged(deactivating
        ? `${props.tenant.name} is deactivated. Its staff are signed out within fifteen minutes.`
        : `${props.tenant.name} is active again. Its staff can sign in.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was changed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.tenant !== null} onClose={props.onClose} busy={busy}
      title={deactivating ? `Deactivate ${props.tenant?.name ?? ''}` : `Activate ${props.tenant?.name ?? ''}`}
      description={deactivating
        ? 'Staff can no longer sign in and every tablet stops within fifteen minutes. All data is kept, and you can activate it again at any time.'
        : 'Staff can sign in again straight away. The restaurant returns exactly as it was.'}
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant={deactivating ? 'destructive' : 'default'}
            onClick={() => { void confirm(); }} disabled={busy || !reasonOk}>
            {busy ? 'Working…' : deactivating ? 'Deactivate' : 'Activate'}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-3.5">
        {refusal !== null && <Notice tone="error">{refusal}</Notice>}
        <TextArea label="Reason" value={reason} onChange={setReason} required
          placeholder={deactivating ? 'e.g. Contract ended by the owner' : 'e.g. Owner renewed the contract'}
          hint="Kept on the record with your name. At least 3 characters." />
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- country --- */

interface CountryPreview {
  readonly from: { country: string; currency: string; timezone: string };
  readonly to: { country: string; currency: string; timezone: string };
  readonly rate: string | null;
  readonly converted: Readonly<Record<string, number>>;
  readonly samples: readonly { name: string; priceMinor: string; newPriceMinor: string }[];
  readonly taxClasses: readonly { key: string; name: string; rateBps: number }[];
  readonly itemsRetaxed: number;
  readonly taxAccount: string;
}

const CONVERTED_LABELS: Readonly<Record<string, string>> = {
  menu_item: 'dish prices', branch_menu_price: 'branch prices', modifier_option: 'add-on prices',
  combo_choice_option: 'combo choice prices', branch: 'parcel charges', role: 'custom role discount caps',
  supplier_product: 'supplier prices',
};

/**
 * A restaurant's country and currency, before its first bill. Two steps on
 * purpose: the preview (the server's own answer, which writes nothing) shows
 * what will change -- the prices, the tax rates, how branches charge -- and
 * the change is sent only once the person has ticked that they read it. No
 * exchange rate is applied unless one is typed.
 */
export function CountryModal(props: {
  api: PlatformApi;
  tenant: TenantSummary | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactElement | null {
  const [settings, setSettings] = useState<CountrySettings | null>(null);
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [convert, setConvert] = useState(false);
  const [rate, setRate] = useState('');
  const [preview, setPreview] = useState<CountryPreview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setCountry(props.tenant?.country ?? 'IN');
    setCurrency(props.tenant?.defaultCurrency ?? '');
    setTimezone(props.tenant?.defaultTimezone ?? '');
    setConvert(false); setRate(''); setPreview(null); setPreviewProblem(null); setAgreed(false); setRefusal(null);
    if (props.tenant === null) return;
    let live = true;
    props.api.get<CountrySettings>('/countries').then((read) => { if (live) setSettings(read); }).catch(() => undefined);
    return () => { live = false; };
  }, [props.tenant, props.api]);

  const chooseCountry = (code: string): void => {
    setCountry(code);
    const found = settings?.countries.find((c) => c.code === code);
    if (found) { setCurrency(found.currency); setTimezone(found.timezone); }
  };

  const currencyChanges = props.tenant !== null && currency !== props.tenant.defaultCurrency;
  const rateText = convert && currencyChanges ? rate.trim() : '';
  const rateError = rateText !== '' && !/^\d{1,7}(\.\d{1,6})?$/.test(rateText) ? 'A number above zero, e.g. 0.044.' : null;
  const unchanged = props.tenant === null || (country === (props.tenant.country ?? 'IN')
    && currency === props.tenant.defaultCurrency && timezone === props.tenant.defaultTimezone);

  // The server's own preview, re-read whenever the request changes. It is also
  // where a refusal (billed, orders open, not allowed) is first heard.
  useEffect(() => {
    setPreview(null); setPreviewProblem(null); setAgreed(false);
    if (props.tenant === null || unchanged || rateError !== null || (convert && currencyChanges && rateText === '')) return;
    let live = true;
    const query = new URLSearchParams({ country, currency, timezone, ...(rateText === '' ? {} : { rate: rateText }) });
    const timer = window.setTimeout(() => {
      props.api.get<CountryPreview>(`/tenants/${props.tenant!.tenantId}/country-change?${query.toString()}`)
        .then((read) => { if (live) setPreview(read); })
        .catch((error: unknown) => { if (live) setPreviewProblem(refusalMessage(error, 'this change cannot be made')); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [props.tenant, props.api, country, currency, timezone, rateText, convert, unchanged, rateError, currencyChanges]);

  async function confirm(): Promise<void> {
    if (props.tenant === null || preview === null || !agreed) return;
    setBusy(true); setRefusal(null);
    try {
      await props.api.post(`/tenants/${props.tenant.tenantId}/country`, {
        country, currency, timezone, ...(rateText === '' ? {} : { rate: rateText }), confirm: true,
      });
      props.onChanged(`${props.tenant.name} is now in ${nameOf(country)}, billing in ${currency}.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was changed'));
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (code: string): string => settings?.countries.find((c) => c.code === code)?.name ?? code;
  const offered = (settings?.countries ?? []).filter((c) => c.offered || c.code === (props.tenant?.country ?? ''));
  const converted = preview === null ? [] : Object.entries(preview.converted).filter(([, n]) => n > 0);

  return (
    <Modal open={props.tenant !== null} onClose={props.onClose} busy={busy} wide
      title={`Country & currency of ${props.tenant?.name ?? ''}`}
      description="Only before the restaurant's first bill, and only with no order open. Bills already issued are never changed."
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => { void confirm(); }}
            disabled={busy || preview === null || !agreed}>
            {busy ? 'Changing…' : 'Change country'}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-3.5">
        {refusal !== null && <Notice tone="error">{refusal}</Notice>}
        {settings !== null && !settings.salesMayChangeCountry && (
          <p className="text-xs text-muted-foreground">
            Sales cannot change a restaurant&apos;s country right now; a Super Admin can, or can allow Sales to in Countries.
          </p>
        )}
        <div className="grid gap-3.5 sm:grid-cols-3">
          <SelectField label="Country" value={country} onChange={chooseCountry} required
            options={offered.map((c) => ({ value: c.code, label: c.name }))} />
          <SelectField label="Currency" value={currency} onChange={setCurrency} required
            options={(settings?.currencies ?? [currency]).map((c) => ({ value: c, label: c }))} />
          <TextField label="Timezone" value={timezone} onChange={setTimezone} mono required />
        </div>
        {currencyChanges && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={convert} onChange={(e) => setConvert(e.target.checked)} />
              Convert prices with an exchange rate
            </label>
            {convert ? (
              <TextField label={`1 ${props.tenant?.defaultCurrency ?? ''} = how many ${currency}?`} value={rate} onChange={setRate}
                mono error={rateError} hint="Every dish, add-on, branch price, parcel charge and custom discount cap is multiplied by it." />
            ) : (
              <p className="text-xs text-muted-foreground">
                No conversion: every price keeps its number in {currency} (100.00 stays 100.00). Re-price the menu afterwards.
              </p>
            )}
          </div>
        )}
        {previewProblem !== null && <Notice tone="error">{previewProblem}</Notice>}
        {preview !== null && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <span className="font-semibold">
              {nameOf(preview.from.country)} · {preview.from.currency} → {nameOf(preview.to.country)} · {preview.to.currency}
            </span>
            {preview.samples.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-xs">
                {preview.samples.map((s) => (
                  <li key={s.name}>
                    {s.name}: {formatMoney(Number(s.priceMinor), preview.from.currency)} → {formatMoney(Number(s.newPriceMinor), preview.to.currency)}
                  </li>
                ))}
              </ul>
            )}
            <span className="text-xs text-muted-foreground">
              {preview.rate === null
                ? 'Prices are not converted.'
                : `Converted at ${preview.rate}: ${converted.length === 0 ? 'nothing priced yet' : converted.map(([t, n]) => `${n} ${CONVERTED_LABELS[t] ?? t}`).join(', ')}.`}
              {preview.from.country !== preview.to.country && (
                ` ${preview.itemsRetaxed} dish(es) move to ${preview.taxClasses.map((c) => c.name).join(' / ')}; every branch charges ${preview.taxAccount.toUpperCase()} and its tax registration number is cleared.`
              )}
            </span>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              I have checked this. Change the country and currency{preview.rate === null ? ' without converting prices' : ' and convert the prices'}.
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ view --- */

function Row(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="shrink-0 text-xs text-subtle-foreground sm:w-36">{props.label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{props.children}</dd>
    </div>
  );
}

export function ExpiryText(props: { end: string | null }): ReactElement {
  const days = daysUntil(props.end);
  if (props.end === null || days === null) return <span className="text-subtle-foreground">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono text-xs">{formatDate(props.end)}</span>
      <span className={cn('ml-1.5 text-[11px]',
        days < 0 ? 'text-status-critical' : days <= 7 ? 'text-status-warn' : 'text-subtle-foreground')}>
        {days < 0 ? 'expired' : days === 0 ? 'today' : `in ${days}d`}
      </span>
    </span>
  );
}

export function RestaurantDetailModal(props: {
  api: PlatformApi;
  tenant: TenantSummary | null;
  canChangeSubscription: boolean;
  canIssueSetupLink: boolean;
  /** The restaurant's published plan version: what its links are derived from. Null until known. */
  planTerms?: PlanVersion | null;
  /** Add staff, set their PIN, switch them off (`platform.tenant.staff`). */
  canManageStaff?: boolean;
  onChangePlan: (t: TenantSummary) => void;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement | null {
  const tenant = props.tenant;
  return (
    <Modal open={tenant !== null} onClose={props.onClose} wide
      title={tenant?.name ?? ''}
      description={tenant === null ? undefined : `${tenant.slug} · created ${formatDate(tenant.createdAt)}`}
      footer={<Button type="button" variant="outline" onClick={props.onClose}>Close</Button>}>
      {tenant !== null && (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Account</span>
            <dl className="flex flex-col gap-2">
              <Row label="Status">
                <span className={cn('font-semibold', tenantStatusTone(tenant.status))}>
                  {tenantStatusWord(tenant.status)}
                </span>
                {tenant.deactivationReason !== null && (
                  <span className="ml-2 text-muted-foreground">— {tenant.deactivationReason}</span>
                )}
                {tenant.delinquentSince !== null && (
                  <span className="ml-2 text-status-warn">owing since {formatDate(tenant.delinquentSince)}</span>
                )}
              </Row>
              <Row label="Legal name">{tenant.legalName ?? <span className="text-subtle-foreground">not set</span>}</Row>
              <Row label="Address">{tenant.address ?? <span className="text-subtle-foreground">not set</span>}</Row>
              <Row label="Look">
                <span className="flex items-center gap-2">
                  {tenant.logoUrl !== null
                    ? <img src={tenant.logoUrl} alt="" className="size-6 rounded object-contain" />
                    : <span className="text-subtle-foreground">no logo</span>}
                  {tenant.themeColor !== null && (
                    <span className="inline-flex items-center gap-1 font-mono text-xs">
                      <span className="size-3.5 rounded-sm border border-border" style={{ background: tenant.themeColor }} />
                      {tenant.themeColor}
                    </span>
                  )}
                </span>
              </Row>
              <Row label="Restaurant Manager">
                {tenant.ownerName !== null && <span className="mr-2">{tenant.ownerName}</span>}
                <span className="text-muted-foreground">{tenant.ownerEmail ?? 'no invite on record'}</span>
                {tenant.ownerPhone !== null && <span className="ml-2 font-mono text-xs text-muted-foreground">{tenant.ownerPhone}</span>}
                {tenant.ownerInviteStatus !== null && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({tenant.ownerInviteStatus === 'accepted' ? 'signed up' : `invite ${tenant.ownerInviteStatus}`})
                  </span>
                )}
              </Row>
              <Row label="Region">{tenant.defaultCurrency} · {tenant.defaultTimezone}</Row>
              <Row label="Revenue collected">{formatMoney(tenant.revenueMinor, tenant.defaultCurrency)}</Row>
            </dl>
          </section>

          <section className="flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Sales person</span>
            {tenant.salesPersonName === null ? (
              <span className="text-sm text-muted-foreground">Not sold by a sales person (created by the platform).</span>
            ) : (
              <dl className="flex flex-col gap-2">
                <Row label="Name">{tenant.salesPersonName}</Row>
                <Row label="Email">{tenant.salesPersonEmail ?? '—'}</Row>
                <Row label="Phone"><span className="font-mono text-xs">{tenant.salesPersonPhone ?? '—'}</span></Row>
              </dl>
            )}
          </section>

          <RestaurantLogin api={props.api} tenant={tenant} canIssue={props.canIssueSetupLink}
            planTerms={props.planTerms ?? null} onChanged={props.onChanged} />

          {props.canManageStaff === true && <TenantStaff key={tenant.tenantId} api={props.api} tenantId={tenant.tenantId} />}

          <section className="flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Subscription</span>
            {tenant.subscriptionId === null ? (
              <span className="text-sm text-muted-foreground">No live subscription.</span>
            ) : (
              <dl className="flex flex-col gap-2">
                <Row label="Plan">{tenant.planName} <span className="text-subtle-foreground">v{tenant.planVersion}</span></Row>
                <Row label="Amount">
                  {formatMoney(tenant.priceMinor, tenant.priceCurrency)}
                  <span className="text-muted-foreground"> / {tenant.billingPeriod === 'yearly' ? 'year' : 'month'}</span>
                </Row>
                <Row label="Status">
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', HEALTH_TONES[subscriptionHealth(tenant)])}>
                    {HEALTH_WORDS[subscriptionHealth(tenant)]}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    billing: {subscriptionStatusWord(tenant.subscriptionStatus ?? '')}
                  </span>
                </Row>
                <Row label="Payment">
                  <span className={BILLING_TONES[tenant.billingStatus]}>{BILLING_WORDS[tenant.billingStatus]}</span>
                </Row>
                <Row label="Started"><span className="font-mono text-xs">{formatDate(tenant.currentPeriodStart)}</span></Row>
                <Row label="Renews / expires"><ExpiryText end={tenant.currentPeriodEnd} /></Row>
              </dl>
            )}
            {props.canChangeSubscription && tenant.subscriptionId !== null && (
              <>
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => props.onChangePlan(tenant)}>
                    Change plan
                  </Button>
                </div>
                <Renew api={props.api} tenant={tenant} onRenewed={props.onChanged} />
              </>
            )}
          </section>

        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- restaurant login --- */

/**
 * How the Restaurant Manager signs in -- the address, the restaurant code and
 * the email -- and, until they have, a setup link.
 *
 * The password itself is never shown here, because nobody has it but the
 * manager: they set it from the link, and only its hash is stored. A lost link
 * is answered with a new one, which revokes the old; once the manager has
 * signed up, no new link can be made, because a link that reset an active
 * owner would be a way into their restaurant.
 */
function RestaurantLogin(props: {
  api: PlatformApi; tenant: TenantSummary; canIssue: boolean; planTerms: PlanVersion | null; onChanged: () => void;
}): ReactElement {
  const [link, setLink] = useState<{ url: string; expiresAt: string; isReset: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Only after sign-up: a new link then RESETS the manager's password, so it
  // asks for a reason first (kept on record with who issued it).
  const [resetting, setResetting] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setLink(null); setRefusal(null); setResetting(false); setReason('');
  }, [props.tenant.tenantId]);

  const signedUp = props.tenant.ownerInviteStatus === 'accepted';

  async function issue(): Promise<void> {
    setBusy(true); setRefusal(null);
    try {
      const made = await props.api.post<{ inviteToken: string; expiresAt: string; isReset: boolean }>(
        `/tenants/${props.tenant.tenantId}/owner-invite`, signedUp ? { reason: reason.trim() } : {});
      setLink({ url: setupLink(made.inviteToken), expiresAt: made.expiresAt, isReset: made.isReset });
      setResetting(false); setReason('');
      props.onChanged();
    } catch (error) {
      setRefusal(refusalMessage(error, 'no link was made'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Restaurant login</span>
      <dl className="flex flex-col gap-2">
        <Row label="Restaurant URL">
          <a href={restaurantUrl(props.tenant.slug)} target="_blank" rel="noreferrer"
            className="font-mono text-xs text-primary underline-offset-2 hover:underline">
            {restaurantUrl(props.tenant.slug)}
          </a>
        </Row>
        <Row label="Plan links">
          {props.planTerms === null ? (
            <span className="text-subtle-foreground">shown once the plan is known</span>
          ) : (
            <span className="flex flex-col gap-1">
              {restaurantLinks(props.tenant.slug, entitlementsFromTerms(props.planTerms)).map((link) => (
                <a key={link.key} href={link.path} target="_blank" rel="noreferrer"
                  className="font-mono text-xs text-primary underline-offset-2 hover:underline">
                  {link.label} — {window.location.origin}{link.path}
                </a>
              ))}
            </span>
          )}
        </Row>
        <Row label="Slug"><span className="font-mono text-xs">{props.tenant.slug}</span></Row>
        <Row label="Login email">{props.tenant.ownerEmail ?? '—'}</Row>
        <Row label="Password">
          {signedUp
            ? <span className="text-status-good">Set by the manager</span>
            : <span className="text-status-warn">
                {props.tenant.ownerInviteStatus === 'expired' ? 'Setup link expired — not set yet' : 'Not set yet — waiting for the manager'}
              </span>}
        </Row>
      </dl>
      {refusal !== null && <Notice tone="error">{refusal}</Notice>}
      {link !== null && (
        <div className="flex flex-col gap-1.5">
          <CopyField label={link.isReset ? 'Password reset link (works once)' : 'New setup link (works once)'} value={link.url} />
          <span className="text-[11px] text-subtle-foreground">
            Valid until {formatDate(link.expiresAt)}. Shown only now; any earlier link no longer works.
            {link.isReset && ' The current password keeps working until this link is used.'}
          </span>
        </div>
      )}
      {props.canIssue && !signedUp && link === null && (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void issue(); }}>
            {busy ? 'Creating…' : 'New setup link'}
          </Button>
        </div>
      )}
      {props.canIssue && signedUp && link === null && !resetting && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setResetting(true)}>
            Reset password (new setup link)
          </Button>
        </div>
      )}
      {resetting && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-status-warn/40 bg-status-warn/5 p-3">
          <span className="text-sm text-foreground">
            The manager has already set a password. A new link lets whoever opens it set a
            new one, so a reason is required and kept on record with your name.
          </span>
          <TextArea label="Reason" value={reason} onChange={setReason} required
            placeholder="e.g. Manager forgot their password (called 14:20)" />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || reason.trim().length < 3}
              onClick={() => { void issue(); }}>
              {busy ? 'Creating…' : 'Create reset link'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy}
              onClick={() => { setResetting(false); setReason(''); }}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ renew --- */

const RENEW_OPTIONS = [1, 3, 6, 12] as const;

/**
 * Extends from the current end date by whole billing periods. A trial that is
 * renewed becomes active, because the paid period starts exactly where the
 * trial ends. The server computes the dates; this only says how many periods.
 */
function Renew(props: { api: PlatformApi; tenant: TenantSummary; onRenewed: () => void }): ReactElement {
  const [periods, setPeriods] = useState('1');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { setDone(null); setRefusal(null); }, [props.tenant.tenantId]);
  const unit = props.tenant.billingPeriod === 'yearly' ? 'year' : 'month';

  async function renew(): Promise<void> {
    setBusy(true); setRefusal(null); setDone(null);
    try {
      const result = await props.api.post<{ currentPeriodEnd: string; status: string }>(
        `/subscriptions/${props.tenant.subscriptionId}/renew`, { periods: Number(periods) });
      setDone(`Renewed. Now runs to ${formatDate(result.currentPeriodEnd)}.`);
      props.onRenewed();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was renewed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <SelectField label="Renew for" value={periods} onChange={setPeriods}
            options={RENEW_OPTIONS.map((n) => ({ value: String(n), label: `${n} ${unit}${n === 1 ? '' : 's'}` }))} />
        </div>
        <Button type="button" size="sm" className="h-10" disabled={busy} onClick={() => { void renew(); }}>
          {busy ? 'Renewing…' : 'Renew'}
        </Button>
      </div>
      <span className="text-[11px] text-subtle-foreground">
        Adds to the current expiry date, not to today, so no paid days are lost.
      </span>
      {refusal !== null && <Notice tone="error">{refusal}</Notice>}
      {done !== null && <Notice tone="success">{done}</Notice>}
    </div>
  );
}

/* ------------------------------------------------------------ change plan --- */

interface PendingChange {
  readonly id: string;
  readonly kind: string;
  readonly effectiveAt: string;
  readonly targetPlanVersionId: string | null;
}

type ChangeResult =
  | { readonly effect: 'immediate' }
  | { readonly effect: 'at_period_end'; readonly scheduled: { readonly effectiveAt: string } };

/**
 * Moving a restaurant between Basic and Pro.
 *
 * The server applies the product's existing rule and this dialog does not
 * second-guess it: an UPGRADE takes effect today (the customer gets more now
 * and is billed from now), a DOWNGRADE is scheduled for the end of the period
 * they have already paid for (nobody loses days they paid for). The preview
 * below says which to expect from the prices; the result says which happened,
 * in those words -- never just "saved". Every change is a new billing segment
 * or a scheduled change, and an audit row: the history is kept by construction.
 */
export function ChangePlanModal(props: {
  api: PlatformApi;
  tenant: TenantSummary | null;
  planOptions: readonly PlanOption[];
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactElement | null {
  const tenant = props.tenant;
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setTarget(''); setRefusal(null); setPending(null);
    if (tenant?.subscriptionId == null) return;
    let live = true;
    void (async () => {
      try {
        const read = await props.api.get<{ pending: PendingChange | null }>(
          `/subscriptions/${tenant.subscriptionId}/pending-change`);
        if (live) setPending(read.pending);
      } catch {
        if (live) setPending(null);
      }
    })();
    return () => { live = false; };
  }, [tenant?.subscriptionId, props.api]);

  const choices = props.planOptions.filter((o) => o.planVersionId !== tenant?.planVersionId);
  const chosen = props.planOptions.find((o) => o.planVersionId === target) ?? null;
  const upgrade = chosen !== null && tenant?.priceMinor != null && chosen.priceMinor > tenant.priceMinor;
  const per = (period: string | null): string => (period === 'yearly' ? 'year' : 'month');

  async function change(): Promise<void> {
    if (tenant?.subscriptionId == null || chosen === null) return;
    setBusy(true); setRefusal(null);
    try {
      const result = await props.api.post<ChangeResult>(
        `/subscriptions/${tenant.subscriptionId}/change`, { planVersionId: chosen.planVersionId });
      props.onChanged(result.effect === 'immediate'
        ? `${tenant.name} is on ${chosen.planName} from today, at ${formatMoney(chosen.priceMinor, chosen.currency)} / ${per(chosen.billingPeriod)}.`
        : `${tenant.name} moves to ${chosen.planName} on ${formatDate(result.scheduled.effectiveAt)}, the end of the period already paid for. It stays on ${tenant.planName} until then.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'the plan was not changed'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPending(): Promise<void> {
    if (tenant?.subscriptionId == null) return;
    setBusy(true); setRefusal(null);
    try {
      await props.api.del(`/subscriptions/${tenant.subscriptionId}/pending-change`);
      props.onChanged(`The scheduled change for ${tenant.name} was cancelled. It stays on ${tenant.planName}.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was cancelled'));
    } finally {
      setBusy(false);
    }
  }

  const pendingName = pending === null ? null
    : props.planOptions.find((o) => o.planVersionId === pending.targetPlanVersionId)?.planName ?? 'another plan';

  return (
    <Modal open={tenant !== null} onClose={props.onClose} busy={busy}
      title={`Change plan — ${tenant?.name ?? ''}`}
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void change(); }} disabled={busy || chosen === null}>
            {busy ? 'Changing…' : 'Change plan'}
          </Button>
        </>
      )}>
      {tenant !== null && (
        <div className="flex flex-col gap-4">
          {refusal !== null && <Notice tone="error">{refusal}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 p-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Current plan</span>
              <span className="text-base font-semibold text-foreground">{tenant.planName ?? '—'}</span>
              <span className="text-sm text-muted-foreground">
                {formatMoney(tenant.priceMinor, tenant.priceCurrency)} / {per(tenant.billingPeriod)}
              </span>
              <span className="text-xs text-subtle-foreground">Paid to {formatDate(tenant.currentPeriodEnd)}</span>
            </div>
            <div className={cn('flex flex-col gap-1 rounded-lg border p-3',
              chosen === null ? 'border-dashed border-border' : 'border-primary/50 bg-primary/5')}>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">New plan</span>
              {chosen === null ? <span className="text-sm text-subtle-foreground">Choose below</span> : (
                <>
                  <span className="text-base font-semibold text-foreground">{chosen.planName}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatMoney(chosen.priceMinor, chosen.currency)} / {per(chosen.billingPeriod)}
                  </span>
                  <span className="text-xs text-subtle-foreground">Billed {chosen.billingPeriod}</span>
                </>
              )}
            </div>
          </div>

          <SelectField label="Move to" value={target} onChange={setTarget} placeholder="Choose a plan"
            options={choices.map((o) => ({ value: o.planVersionId, label: o.label }))} />

          {chosen !== null && (
            <Notice tone="success">
              {upgrade
                ? 'Upgrade: takes effect immediately, and is billed at the new price from today.'
                : `Downgrade: takes effect on ${formatDate(tenant.currentPeriodEnd)}, when the period already paid for ends. Until then nothing changes.`}
            </Notice>
          )}

          {pending !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warn/50 bg-status-warn/10 px-3 py-2.5 text-sm">
              <span>Already scheduled: move to <strong>{pendingName}</strong> on {formatDate(pending.effectiveAt)}.</span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void cancelPending(); }}>
                Cancel scheduled change
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
