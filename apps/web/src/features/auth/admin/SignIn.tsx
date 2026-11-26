import { useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api, type DeviceIdentity, type Session } from '../../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { PasswordInput } from '@/components/ui/password-input.js';
import { Label } from '@/components/ui/label.js';
import { RefusalBanner } from '../../../components/admin/banner.js';

/**
 * Username and password (set by the Sales person), and the restaurant's name typed in full.
 *
 * The slug is asked for rather than discovered, for the same reason the POS asks
 * for a composite enrolment code: there is nothing verified to take it from yet,
 * and the pre-auth tenant rule is that the tenant comes either from something
 * verified or from something a human typed in full. A laptop has no device
 * record and no enrolment, so it is the second.
 *
 * The refusal is uniform. `credential_invalid` covers an unknown email, a wrong
 * password and an unknown restaurant, because distinguishing them tells someone
 * probing which of the three they got right.
 */
export function SignIn(props: {
  api: Api;
  onSignedIn?: (session: Session) => void;
  /**
   * The POS's sign-in, at `/{slug}/pos`: the SAME form, signing in on this
   * computer's till (`api.setUpTill`, `POST /api/auth/:slug/till`) with the POS's
   * own api, for staff and the manager alike. A browser that is not a till yet
   * becomes one only for a manager.
   */
  pos?: {
    /** `session` is null for a manager: the till is set up, and staff sign in on it by PIN. */
    readonly onTill: (device: DeviceIdentity, session: Session | null) => void;
    /** On a till: back to the staff cards (Staff Login), in place of the link to the manager screens. */
    readonly onStaff?: () => void;
  };
  /** Filled after a setup link is redeemed, so the manager only types the password. */
  prefill?: { tenantSlug: string; email: string } | null | undefined;
  /**
   * Set when this is the restaurant's own page, `/{slug}`: the slug is fixed by
   * the address and not typed, and the page is titled with the restaurant's name.
   */
  restaurant?: { slug: string; name: string } | undefined;
}): ReactElement {
  const [slug, setSlug] = useState(props.restaurant?.slug ?? props.prefill?.tenantSlug ?? '');
  const [email, setEmail] = useState(props.prefill?.email ?? '');
  const [password, setPassword] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One form, two doors: the manager screens at `/{slug}`, the POS at `/{slug}/pos`.
  // Usernames and passwords are the Sales person's to set, for both.
  const look = LOOK;
  const pos = props.pos;

  async function submit(): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      const tenantSlug = slug.trim();
      if (pos !== undefined) {
        const till = await props.api.setUpTill({ tenantSlug, email: email.trim(), password, deviceName: 'Counter till' });
        pos.onTill(till.device, till.session);
        return;
      }
      // The server refuses anyone who is not a manager (`staff_use_pos`); the
      // refusal is the server's, so no client change can open the manager screens to staff.
      const signed = await props.api.signInWithPassword({
        tenantSlug, email: email.trim(), password, audience: 'manager',
      });
      props.onSignedIn?.(signed);
    } catch (error) {
      setRefusal(pos !== undefined
        ? posRefusal(error)
        : error instanceof ApiError && error.failure.kind === 'offline'
          ? 'No connection. Signing in needs one.'
          : error instanceof ApiError && error.failure.kind === 'refused'
              && (error.failure.code === 'staff_use_pos' || error.failure.code === 'not_a_manager')
            ? 'This is a staff account. Use Staff Login to open the POS.'
            : 'That username and password were not accepted.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const fields = [
    ...(props.restaurant === undefined
      ? [['slug', 'Restaurant', slug, setSlug, 'text', 'spicegarden'] as const] : []),
    // The username the Sales person set. An email still works for an account that has one.
    ['email', look.loginLabel, email, setEmail, 'text', look.placeholder] as const,
    ['password', 'Password', password, setPassword, 'password', ''] as const,
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 font-sans text-foreground sm:p-6">
      <div className="grid w-full max-w-[880px] overflow-hidden rounded-2xl border border-border bg-card shadow-xl md:grid-cols-[1fr_1.1fr]">
        {/* The role's side of the page: who this sign-in is for and what it opens. */}
        <aside className={`hidden flex-col justify-between gap-8 p-8 md:flex ${look.panel}`}>
          <div className="flex flex-col gap-3">
            <span className="w-fit rounded-full bg-white/20 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em]">
              {look.badge}
            </span>
            <span className="text-[28px] font-bold leading-tight tracking-tight">{look.headline}</span>
            <span className="text-sm leading-relaxed opacity-90">{look.blurb}</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">
            {look.points.map((point) => (
              <li key={point} className="flex items-center gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/25 text-[11px] font-bold">✓</span>
                {point}
              </li>
            ))}
          </ul>
        </aside>

        <form
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          className="flex flex-col gap-4 p-7 sm:p-9"
        >
          {props.restaurant === undefined ? (
            <span className="text-2xl font-bold tracking-tight">Sign in</span>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-2xl font-bold tracking-tight">{props.restaurant.name}</span>
                <span className="text-sm text-muted-foreground">
                  {pos !== undefined ? 'Manager: set up this computer as the till' : 'Sign in to run your restaurant'}
                </span>
              </div>
              {/* The other door, top right: the POS from here, the manager screens from the POS. */}
              {pos?.onStaff !== undefined ? (
                <button type="button" onClick={pos.onStaff} className={OTHER_DOOR}>Staff Login</button>
              ) : (
                <a href={pos !== undefined ? `/${props.restaurant.slug}` : `/${props.restaurant.slug}/pos`} className={OTHER_DOOR}>
                  {pos !== undefined ? 'Manager screens' : 'Staff Login'}
                </a>
              )}
            </div>
          )}

          {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}

          {fields.map(([id, labelText, value, set, type, placeholder]) => (
            <div key={id} className="flex flex-col gap-1.5">
              <Label htmlFor={id} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {labelText}
              </Label>
              {type === 'password' ? (
                <PasswordInput
                  id={id}
                  value={value}
                  autoComplete="current-password"
                  onChange={(event) => set(event.target.value)}
                  className="h-11 text-[15px]"
                />
              ) : (
                <Input
                  id={id}
                  type={type}
                  value={value}
                  placeholder={placeholder}
                  autoComplete="on"
                  onChange={(event) => set(event.target.value)}
                  className="h-11 text-[15px]"
                />
              )}
            </div>
          ))}

          <Button
            type="submit"
            disabled={busy || slug.trim() === '' || email.trim() === '' || password === ''}
            className={`h-[50px] text-base font-bold hover:opacity-90 disabled:bg-[#DCDCDC] disabled:text-muted-foreground disabled:opacity-100 ${look.button}`}
          >
            {busy ? 'Signing in…' : look.submit}
          </Button>
          <span className="text-center text-xs text-muted-foreground">{look.footnote}</span>
        </form>
      </div>
    </div>
  );
}

const OTHER_DOOR = 'flex h-9 shrink-0 items-center rounded-md border border-input bg-card px-3 text-sm font-semibold text-foreground '
  + 'transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** What the manager's page says and how it is coloured. Words and colours only. */
const LOOK = {
  badge: 'Restaurant',
  headline: 'Run your restaurant',
  blurb: 'Menu, setup and reports — everything behind the counter, in one place.',
  points: ['Menu items, prices and kitchens', 'The POS and its till', 'Open orders and sales reports'],
  loginLabel: 'Username',
  placeholder: 'Your username',
  submit: 'Sign in',
  footnote: 'Your username and password are set by your Sales person.',
  panel: 'bg-brand-gradient text-primary-foreground',
  button: 'bg-brand-gradient text-primary-foreground',
} as const;

/** Why this sign-in could not open the POS on this computer. */
function posRefusal(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The POS did not open. Try again.';
  if (error.failure.kind === 'offline') return 'No connection. Signing in needs one.';
  switch (error.failure.kind === 'refused' ? error.failure.code : '') {
    case 'upgrade_required':
      return 'Every till this plan allows is in use. The manager can take an old one out of use under Tablets.';
    case 'till_not_permitted':
      return 'This computer is not the restaurant\'s till yet. The Restaurant Manager signs in here once to set it up; then staff can sign in.';
    case 'till_branch_ambiguous':
      return 'This restaurant has more than one branch. Its tablets are set up with a setup code from the admin.';
    default:
      return 'That username and password were not accepted.';
  }
}
