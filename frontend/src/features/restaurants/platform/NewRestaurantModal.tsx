import { useEffect, useState } from 'react';
import {
  ADDRESS_MIN_LENGTH, BUSINESS_MODULE_KEYS, CORE_MODULE, businessTypeOf, defaultModulesFor, normaliseThemeColor,
  selectableBusinessTypes, slugProblem, slugify,
} from '@universalpos/shared';
import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { Button } from '@/components/ui/button.js';
import {
  CopyField, Modal, Notice, SelectField, TextField, refusalMessage, restaurantUrl,
  TextArea,
} from '../../../components/platform/kit.js';
import type { CountrySettings, PlanOption } from '../../../types/restaurant.js';
import {
  BrandPreview, LogoField, ThemeColorField, readLogo, type LogoChoice,
} from '../../../components/platform/branding.js';
import { cn } from 'cn';

/**
 * Provisioning a new restaurant, as a dialog.
 *
 * ###########################################################################
 * THE CONSOLE HAD A ROUTE AND NO SCREEN.
 *
 * `POST /tenants` has been served since phase 1 -- tenant, first branch, seeded
 * roles, owner invite, all in one transaction -- and for most of this
 * project's life nothing on this console called it.
 * ###########################################################################
 *
 * Who sold it is NOT a field. The server records the provisioning request
 * against the signed-in user from the verified token, so a Salesperson who
 * creates a restaurant is linked to it automatically and cannot attribute it
 * to anyone else -- the attribution the Sales Persons page counts comes from
 * the same row.
 *
 * The idempotency key belongs to the ATTEMPT, not the click. It is minted once
 * when the dialog opens and carried across retries of the same fields, so a
 * lost response and a resubmit land on the same key -- the server replays
 * rather than double-provisions. A fresh key is only minted after a request
 * actually succeeds, because the next attempt is a different restaurant.
 */

interface ProvisionResult {
  readonly tenantId: string;
  readonly firstBranchId: string;
  readonly created: boolean;
  readonly ownerUserId: string;
}

type SlugCheck =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'available' }
  | { readonly state: 'unavailable'; readonly problem: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function NewRestaurantModal(props: {
  api: PlatformApi;
  open: boolean;
  planOptions: readonly PlanOption[];
  onClose: () => void;
  onCreated: () => void;
}): ReactElement | null {
  const [slug, setSlug] = useState('');
  // The slug follows the name until the Sales Person edits it themselves.
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugCheck, setSlugCheck] = useState<SlugCheck>({ state: 'idle' });
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  // The manager's sign-in, set by the Sales person (DECIDED 2026-10-16).
  const [ownerUsername, setOwnerUsername] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [startMode, setStartMode] = useState<'trial' | 'paid'>('trial');
  // Chosen, never assumed: no type is preselected, as no country is.
  const [businessType, setBusinessTypeRaw] = useState('');
  // The wizard's modules step starts from the chosen type's own modules; changing the type resets them.
  const [modules, setModules] = useState<readonly string[]>([]);
  const [step, setStep] = useState(0);
  const setBusinessType = (key: string): void => {
    setBusinessTypeRaw(key);
    setModules(key === '' ? [] : [...defaultModulesFor(key)]);
  };
  const toggleModule = (key: string): void => {
    if (key === CORE_MODULE) return;
    setModules((held) => (held.includes(key) ? held.filter((k) => k !== key) : [...held, key]));
  };
  const [firstBranchName, setFirstBranchName] = useState('Main branch');
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [planVersionId, setPlanVersionId] = useState('');
  // The country is chosen, never assumed: the form starts on the platform's
  // default (a Super Admin setting), and choosing one fills in its currency and
  // clock, both still changeable. The server refuses a country or currency the
  // platform does not offer.
  const [countries, setCountries] = useState<CountrySettings | null>(null);
  const [taxJurisdiction, setTaxJurisdiction] = useState('');

  const chooseCountry = (code: string, from: CountrySettings | null = countries): void => {
    const found = from?.countries.find((c) => c.code === code);
    setTaxJurisdiction(code);
    if (found) { setCurrency(found.currency); setTimezone(found.timezone); }
  };

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    props.api.get<CountrySettings>('/countries').then((read) => {
      if (!live) return;
      setCountries(read);
      if (taxJurisdiction === '') chooseCountry(read.defaultCountry, read);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [props.open, props.api]); // eslint-disable-line react-hooks/exhaustive-deps

  const [touched, setTouched] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [result, setResult] = useState<{
    name: string; slug: string; created: boolean; username: string; signInProblem: string | null;
    logoProblem: string | null;
  } | null>(null);
  const [address, setAddress] = useState('');
  const [themeColor, setThemeColor] = useState('');
  const [themeColorSecondary, setThemeColorSecondary] = useState('');
  const [logo, setLogo] = useState<LogoChoice | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changeName = (value: string): void => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  // A live answer to "is this slug free?", debounced so typing does not fire a
  // request per key. Advisory: the server checks again at create, and the
  // unique index settles a race between two Sales Persons.
  useEffect(() => {
    if (slugProblem(slug) !== null) { setSlugCheck({ state: 'idle' }); return; }
    setSlugCheck({ state: 'checking' });
    let live = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const answer = await props.api.get<{ available: boolean; problem: string | null }>(
            `/tenants/slug-available?slug=${encodeURIComponent(slug)}`);
          if (!live) return;
          setSlugCheck(answer.available
            ? { state: 'available' }
            : { state: 'unavailable', problem: answer.problem ?? 'This slug cannot be used.' });
        } catch {
          if (live) setSlugCheck({ state: 'idle' });
        }
      })();
    }, 350);
    return () => { live = false; window.clearTimeout(timer); };
  }, [slug, props.api]);

  const slugFormat = slugProblem(slug);
  const errors = {
    slug: slugFormat ?? (slugCheck.state === 'unavailable' ? slugCheck.problem : null),
    name: name.trim().length < 2 ? 'Required.' : null,
    ownerName: ownerName.trim() === '' ? 'Required.' : null,
    ownerEmail: !EMAIL.test(ownerEmail.trim()) ? 'A valid email address is required.' : null,
    ownerUsername: !/^[A-Z0-9]{1,12}$/.test(ownerUsername) ? '1 to 12 letters or digits.' : null,
    ownerPassword: ownerPassword.length < 8 || ownerPassword.length > 200 ? 'At least 8 characters.' : null,
    ownerPhone: ownerPhone.trim() !== '' && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(ownerPhone.trim())
      ? 'Digits, spaces, dashes and an optional leading +.' : null,
    firstBranchName: firstBranchName.trim() === '' ? 'Required.' : null,
    businessType: businessType === '' ? 'Choose what kind of business this is.' : null,
    country: taxJurisdiction === '' ? 'Choose a country.' : null,
    currency: !/^[A-Z]{3}$/.test(currency) ? 'Choose a currency.' : null,
    timezone: timezone.trim() === '' ? 'Required.' : null,
    plan: planVersionId === '' ? 'Choose a plan.' : null,
    address: address.trim().length < ADDRESS_MIN_LENGTH ? `At least ${ADDRESS_MIN_LENGTH} characters.` : null,
    themeColor: themeColor.trim() !== '' && normaliseThemeColor(themeColor) === null ? 'A hex colour like #fa5c00.' : null,
    themeColorSecondary: themeColorSecondary.trim() !== '' && normaliseThemeColor(themeColorSecondary) === null ? 'A hex colour like #1b7f3a.' : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const stepErrors: ReadonlyArray<ReadonlyArray<string | null>> = [
    [errors.name, errors.slug, errors.firstBranchName, errors.address, errors.ownerName, errors.ownerEmail,
      errors.ownerUsername, errors.ownerPassword, errors.ownerPhone],
    [errors.businessType],
    [errors.country, errors.currency, errors.timezone],
    [errors.plan],
    [errors.themeColor, errors.themeColorSecondary],
  ];
  const stepOk = (index: number): boolean => stepErrors[index]!.every((e) => e === null);
  const firstBadStep = stepErrors.findIndex((_, index) => !stepOk(index));
  const last = STEPS.length - 1;
  function next(): void {
    setTouched(true);
    if (stepOk(step)) setStep((current) => Math.min(last, current + 1));
  }
  const show = (error: string | null): string | null => (touched ? error : null);

  function reset(): void {
    setSlug(''); setSlugEdited(false); setSlugCheck({ state: 'idle' }); setLegalName('');
    setName(''); setOwnerName(''); setOwnerEmail(''); setOwnerPhone(''); setStartMode('trial');
    setOwnerUsername(''); setOwnerPassword('');
    setFirstBranchName('Main branch');
    if (countries !== null) chooseCountry(countries.defaultCountry);
    setBusinessType(''); setStep(0); setPlanVersionId(''); setTouched(false); setRefusal(null); setResult(null);
    setAddress(''); setThemeColor(''); setLogo(null); setLogoError(null);
  }

  function close(): void {
    reset();
    props.onClose();
  }

  async function submit(): Promise<void> {
    setTouched(true);
    if (!valid) return;
    setBusy(true); setRefusal(null);
    try {
      const created = await props.api.post<ProvisionResult>('/tenants', {
        slug: slug.trim(), name: name.trim(), currency, timezone: timezone.trim(),
        ...(legalName.trim() === '' ? {} : { legalName: legalName.trim() }),
        ownerEmail: ownerEmail.trim(), ownerName: ownerName.trim(),
        ...(ownerPhone.trim() === '' ? {} : { ownerPhone: ownerPhone.trim() }),
        startMode,
        firstBranchName: firstBranchName.trim(), planVersionId, taxJurisdiction, businessType,
        modules: [...modules],
        address: address.trim(),
        ...(themeColor.trim() === '' ? {} : { themeColor: normaliseThemeColor(themeColor) }),
        ...(themeColorSecondary.trim() === '' ? {} : { themeColorSecondary: normaliseThemeColor(themeColorSecondary) }),
      }, { 'idempotency-key': idempotencyKey });
      // The logo is its own request: the restaurant exists now, and a logo the
      // server refuses must not undo it. A refusal is shown beside the result.
      let logoProblem: string | null = null;
      if (logo !== null && created.created) {
        try {
          await props.api.post(`/tenants/${created.tenantId}/logo`,
            { contentType: logo.contentType, dataBase64: logo.dataBase64 });
        } catch (error) {
          logoProblem = refusalMessage(error, 'the logo was not saved');
        }
      }
      // The manager's username and password, by the same route that changes them
      // later. Its own request: a refusal leaves the restaurant created, and the
      // sign-in is then set from the restaurant's Sign-ins.
      let signInProblem: string | null = null;
      if (created.created) {
        try {
          await props.api.post(`/tenants/${created.tenantId}/staff/${created.ownerUserId}/credentials`,
            { username: ownerUsername, password: ownerPassword });
        } catch (error) {
          signInProblem = refusalMessage(error, 'the manager\'s sign-in was not saved');
        }
      }
      setResult({
        name: name.trim(), slug: slug.trim(), created: created.created, username: ownerUsername,
        signInProblem, logoProblem,
      });
      setIdempotencyKey(crypto.randomUUID());
      props.onCreated();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was created'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.open} onClose={close} busy={busy} wide
      title={result === null ? 'Create restaurant' : 'Restaurant created'}
      description={result === null
        ? `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}. Creates the business, its first branch, its staff roles and the Manager with the username and password you set. It is linked to you as the salesperson.`
        : undefined}
      footer={result === null ? (
        <>
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          {step > 0 && <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={busy}>Back</Button>}
          {step < last
            ? <Button type="button" onClick={next} disabled={busy}>Next</Button>
            : <Button type="button" disabled={busy}
                onClick={() => { if (valid) void submit(); else { setTouched(true); setStep(Math.max(0, firstBadStep)); } }}>
                {busy ? 'Creating…' : 'Create restaurant'}
              </Button>}
        </>
      ) : (
        <Button type="button" onClick={close}>Done</Button>
      )}>
      {result !== null ? (
        <div className="flex flex-col gap-4">
          <Notice tone="success">
            {result.created ? (
              <>
                <strong>{result.name}</strong> was created. Give the Restaurant Manager their username and the
                password you chose, yourself. Staff sign-ins are added from the restaurant&apos;s Sign-ins.
              </>
            ) : 'This request had already gone through — nothing new was created. '
              + 'Set the manager\'s sign-in from the restaurant\'s Sign-ins.'}
          </Notice>
          {result.signInProblem !== null && (
            <Notice tone="error">
              {`The restaurant was created, but ${result.signInProblem} Set it from the restaurant's Sign-ins.`}
            </Notice>
          )}
          {result.logoProblem !== null && (
            <Notice tone="error">
              {`The restaurant was created, but ${result.logoProblem} Add it from Edit restaurant.`}
            </Notice>
          )}
          {result.created && result.signInProblem === null && (
            <div className="grid gap-3 sm:grid-cols-2">
              <CopyField label="Restaurant URL" value={restaurantUrl(result.slug)} />
              <CopyField label="Manager username" value={result.username} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {refusal !== null && <Notice tone="error">{refusal}</Notice>}

          <nav aria-label="Steps" className="flex flex-wrap gap-1.5">
            {STEPS.map((title, index) => (
              <button key={title} type="button" onClick={() => setStep(index)}
                aria-current={index === step ? 'step' : undefined}
                className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                  index === step ? 'border-primary bg-primary/10 font-semibold text-foreground'
                    : touched && !stepOk(index) ? 'border-destructive text-destructive'
                    : 'border-border text-muted-foreground hover:bg-secondary')}>
                {index + 1}. {title}
              </button>
            ))}
          </nav>

          {step === 0 && (
          <section className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Restaurant</span>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField label="Restaurant name" value={name} onChange={changeName}
                placeholder="ABC Restaurant" required error={show(errors.name)} />
              <TextField label="Slug" value={slug}
                onChange={(v) => { setSlugEdited(true); setSlug(v.toLowerCase().replace(/\s+/g, '-')); }}
                placeholder="abc-restaurant" mono required
                error={slug === '' ? show(errors.slug) : errors.slug}
                hint={slugCheck.state === 'checking' ? 'Checking…'
                  : slugCheck.state === 'available' ? `Available — ${restaurantUrl(slug)}`
                  : 'The restaurant’s address. Cannot be changed later.'} />
              <TextField label="Restaurant details" value={legalName} onChange={setLegalName}
                placeholder="ABC Foods Pvt Ltd" hint="Registered / legal name, if different. Optional." />
              <TextField label="First branch" value={firstBranchName} onChange={setFirstBranchName}
                required error={show(errors.firstBranchName)} />
              <div className="sm:col-span-2">
                <TextArea label="Address" value={address} onChange={setAddress} required
                  placeholder="12 MG Road, Bengaluru 560001"
                  hint={show(errors.address) ?? 'Where the restaurant is. Shown to the restaurant and on its records.'} />
              </div>
            </div>
          </section>
          )}

          {step === 4 && (
          <section className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Look</span>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <LogoField current={null} choice={logo} removed={false} error={logoError}
                onChoose={(file) => {
                  void readLogo(file).then((read) => {
                    if (typeof read === 'string') { setLogoError(read); return; }
                    setLogoError(null); setLogo(read);
                  });
                }}
                onRemove={() => setLogo(null)} onUndo={() => setLogo(null)} />
              <BrandPreview name={name} logoUrl={logo?.previewUrl ?? null} primary={themeColor} secondary={themeColorSecondary} />
              <ThemeColorField label="Primary colour" value={themeColor} onChange={setThemeColor}
                usage="Buttons, the PIN and highlights" />
              <ThemeColorField label="Secondary colour" value={themeColorSecondary} onChange={setThemeColorSecondary}
                usage="Bands, card accents and the background glow" />
            </div>
          </section>
          )}

          {step === 0 && (
          <section className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Restaurant Manager</span>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField label="Full name" value={ownerName} onChange={setOwnerName}
                placeholder="Meera Iyer" required error={show(errors.ownerName)} />
              <TextField label="Email" value={ownerEmail} onChange={setOwnerEmail} type="email"
                placeholder="manager@restaurant.com" required error={show(errors.ownerEmail)} />
              <TextField label="Username" value={ownerUsername} required mono placeholder="MEERA"
                onChange={(v) => setOwnerUsername(v.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase())}
                error={show(errors.ownerUsername)} hint="They sign in with this." />
              <TextField label="Password" value={ownerPassword} onChange={setOwnerPassword} type="password" required
                error={show(errors.ownerPassword)} hint="At least 8 characters. Give it to them yourself." />
              <TextField label="Phone" value={ownerPhone} onChange={setOwnerPhone} type="tel"
                placeholder="+91 98450 12345" error={show(errors.ownerPhone)} />
            </div>
          </section>
          )}

          {step === 3 && (
          <section className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Subscription plan</span>
            <SelectField label="Plan" value={planVersionId} onChange={setPlanVersionId} required
              placeholder="Choose a plan"
              options={props.planOptions.map((p) => ({ value: p.planVersionId, label: p.label }))}
              hint={show(errors.plan) ?? undefined} />
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How the subscription starts">
              {([['trial', '14-day free trial', 'Billing starts when the trial ends.'],
                 ['paid', 'Paid from today', 'Billing starts today, for one billing period.']] as const)
                .map(([value, title, hint]) => (
                  <button key={value} type="button" role="radio" aria-checked={startMode === value}
                    onClick={() => setStartMode(value)}
                    className={cn('flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      startMode === value ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary')}>
                    <span className="text-sm font-semibold text-foreground">{title}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </button>
                ))}
            </div>
            <SubscriptionPreview startMode={startMode}
              plan={props.planOptions.find((p) => p.planVersionId === planVersionId) ?? null} />
          </section>
          )}

          {step === 1 && (
            <section className="flex flex-col gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Kind of business and modules</span>
              <SelectField label="Kind of business" value={businessType} onChange={setBusinessType} required
                placeholder="Choose a kind of business" options={BUSINESS_TYPE_OPTIONS}
                hint={show(errors.businessType) ?? (businessType === '' ? 'Sets the screens, words, look and starting modules. Fixed once it has taken an order.' : businessTypeOf(businessType).description)} />
              {businessType !== '' && (
                <ModulePicker type={businessType} chosen={modules} onToggle={toggleModule} />
              )}
            </section>
          )}
          {step === 2 && (
          <section className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Region</span>
            <div className="grid gap-3.5 sm:grid-cols-3">
              <SelectField label="Country" value={taxJurisdiction} onChange={(code) => chooseCountry(code)} required
                placeholder={countries === null ? 'Loading…' : 'Choose a country'}
                hint={show(errors.country) ?? 'Decides the tax on every bill. Fixed once the restaurant has billed.'}
                options={(countries?.countries ?? []).filter((c) => c.offered)
                  .map((c) => ({ value: c.code, label: c.name }))} />
              <SelectField label="Currency" value={currency} onChange={setCurrency} required
                hint={show(errors.currency) ?? 'Prices, bills and reports are in this.'}
                options={(countries?.currencies ?? []).map((c) => ({ value: c, label: c }))} />
              <TextField label="Timezone" value={timezone} onChange={setTimezone}
                mono required error={show(errors.timezone)} />
            </div>
          </section>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * The dates the server will set, shown before the click. A preview only: the
 * server computes the real ones from its own clock, and these are from the
 * same rule -- 14 days for a trial, one billing period for a paid start.
 */
/** What a Super Admin may pick: every type not merely planned. A preview says so, so nobody promises a shop what it cannot yet do. */
const BUSINESS_TYPE_OPTIONS = selectableBusinessTypes().map((type) => ({
  value: type.key,
  label: type.status === 'preview' ? `${type.label} (preview)` : type.label,
}));

function SubscriptionPreview(props: { startMode: 'trial' | 'paid'; plan: PlanOption | null }): ReactElement {
  const start = new Date();
  const end = new Date(start);
  if (props.startMode === 'trial') end.setDate(end.getDate() + 14);
  else if (props.plan?.billingPeriod === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm sm:grid-cols-4">
      <div className="flex flex-col"><span className="text-xs text-subtle-foreground">Start date</span>
        <span className="font-mono text-foreground">{day(start)}</span></div>
      <div className="flex flex-col"><span className="text-xs text-subtle-foreground">Expiry date</span>
        <span className="font-mono text-foreground">{day(end)}</span></div>
      <div className="flex flex-col"><span className="text-xs text-subtle-foreground">Price</span>
        <span className="text-foreground">{props.plan === null ? '—' : props.plan.label.split(' — ')[1]}</span></div>
      <div className="flex flex-col"><span className="text-xs text-subtle-foreground">Status</span>
        <span className="text-foreground">{props.startMode === 'trial' ? 'Trial' : 'Active'}</span></div>
    </div>
  );
}

const STEPS = ['Business and owner', 'Kind of business and modules', 'Region and tax', 'Plan and subscription', 'Logo and branding'] as const;

const moduleLabel = (key: string): string => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The type's own modules, ticked; every other module offered unticked. The till is always on. */
function ModulePicker(props: {
  type: string; chosen: readonly string[]; onToggle: (key: string) => void;
}): ReactElement {
  const own = defaultModulesFor(props.type);
  const others = BUSINESS_MODULE_KEYS.filter((key) => !own.includes(key));
  const box = (key: string): ReactElement => (
    <label key={key} className="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" checked={props.chosen.includes(key)} disabled={key === CORE_MODULE}
        onChange={() => props.onToggle(key)} />
      {moduleLabel(key)}{key === CORE_MODULE ? ' (always on)' : ''}
    </label>
  );
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
        <legend className="px-1 text-xs text-subtle-foreground">Included with this kind of business</legend>
        <div className="grid gap-2 sm:grid-cols-2">{own.map(box)}</div>
      </fieldset>
      <details className="rounded-lg border border-border px-3 py-2.5">
        <summary className="cursor-pointer text-xs text-subtle-foreground">Other modules</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{others.map(box)}</div>
      </details>
    </div>
  );
}
