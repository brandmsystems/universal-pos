import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button.js';
import { PasswordInput } from '@/components/ui/password-input.js';
import { Label } from '@/components/ui/label.js';
import { RefusalBanner } from '../../../components/admin/banner.js';

/**
 * A Restaurant Manager choosing their own password from a setup link.
 *
 * The link is `admin.html#invite=<token>`. A fragment, not a query string, so
 * the token is never sent in a request line and never lands in an access log;
 * this screen reads it from the address bar and posts it in a body, once.
 *
 * Nobody else ever knows this password -- not the Super Admin, not the
 * salesperson who sold the restaurant. The server stores only its hash.
 */

const MIN_LENGTH = 10;

export function readInviteToken(): string | null {
  const match = /(?:^#|&)invite=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function AcceptInvite(props: {
  token: string;
  onDone: (signIn: { tenantSlug: string; email: string } | null) => void;
  /**
   * Signs in with the password just chosen. On success the manager is taken to
   * their restaurant's own page, `/{slug}`, already signed in -- replacing any
   * other restaurant's session this browser was holding, which would otherwise
   * open instead.
   */
  signIn: (input: { tenantSlug: string; email: string; password: string }) => Promise<unknown>;
}): ReactElement {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<{ tenantSlug: string; email: string } | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = !busy && password.length >= MIN_LENGTH && confirm === password;

  async function submit(): Promise<void> {
    setBusy(true); setRefusal(null);
    try {
      const response = await fetch('/api/auth/invite/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: props.token, password }),
      });
      if (response.ok) {
        const accepted = await response.json() as { tenantSlug: string; email: string };
        try {
          await props.signIn({ ...accepted, password });
          setSignedIn(true);
        } catch {
          // The password is saved either way; the restaurant's own sign-in page
          // is where they go next, and it says why if the restaurant is closed.
        }
        setDone(accepted);
        return;
      }
      const body = await response.json().catch(() => ({})) as { detail?: string };
      setRefusal(response.status === 400 && body.detail
        ? body.detail.charAt(0).toUpperCase() + body.detail.slice(1) + '.'
        // One sentence for every token problem, as the server gives one status:
        // it is not this screen's job to tell a guesser which part was wrong.
        : 'This setup link is not valid. It may have expired, been used already, or been '
          + 'replaced by a newer one. Ask whoever set up your restaurant for a new link.');
    } catch {
      setRefusal('No connection. Setting a password needs one.');
    } finally {
      setBusy(false);
    }
  }

  const openRestaurant = (): void => {
    if (done === null) return;
    // A full load, not a state change: the address decides which restaurant
    // this page is, and it is read once at start-up.
    window.location.assign(`/${done.tenantSlug}`);
  };

  const leave = (): void => {
    // Drop the token from the address bar, so a reload or a shared screenshot
    // does not carry it.
    window.history.replaceState(null, '', window.location.pathname);
    props.onDone(done);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 font-sans text-foreground">
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[4px] border border-border bg-card p-7">
        {done !== null ? (
          <>
            <span className="text-2xl font-bold tracking-tight">You're all set</span>
            <span className="text-sm leading-relaxed text-muted-foreground">
              Your password is saved{signedIn ? ' and you are signed in' : ''}. Your restaurant's address is{' '}
              <strong className="font-mono text-foreground">{window.location.origin}/{done.tenantSlug}</strong>{' '}
              and you sign in as <strong className="text-foreground">{done.email}</strong>. Add your restaurant
              admin, kitchen, waiter, cashier and chef accounts from the Staff screen.
            </span>
            <Button type="button" onClick={openRestaurant}
              className="h-[50px] bg-brand-gradient text-base font-bold text-primary-foreground hover:opacity-90">
              {signedIn ? 'Open my restaurant' : 'Go to my restaurant’s sign-in'}
            </Button>
          </>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (ready) void submit(); }}>
            <span className="text-2xl font-bold tracking-tight">Set your password</span>
            <span className="text-sm leading-relaxed text-muted-foreground">
              Choose the password you will sign in to your restaurant with. Only you will know it.
            </span>
            {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                New password
              </Label>
              <PasswordInput id="new-password" autoComplete="new-password" value={password}
                onChange={(event) => setPassword(event.target.value)} className="h-11 text-[15px]" />
              <span className={tooShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                At least {MIN_LENGTH} characters.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Confirm password
              </Label>
              <PasswordInput id="confirm-password" autoComplete="new-password" value={confirm}
                onChange={(event) => setConfirm(event.target.value)} className="h-11 text-[15px]" />
              {mismatch && <span className="text-xs text-destructive">The two passwords do not match.</span>}
            </div>
            <Button type="submit" disabled={!ready}
              className="h-[50px] bg-brand-gradient text-base font-bold text-primary-foreground hover:opacity-90 disabled:bg-[#DCDCDC] disabled:text-muted-foreground disabled:opacity-100">
              {busy ? 'Saving…' : 'Set password'}
            </Button>
            <button type="button" onClick={leave} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              I already have a password — sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
