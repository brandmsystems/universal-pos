import { useState } from 'react';
import type { ReactElement } from 'react';
import { PlatformApiError, type PlatformApi, type PlatformSession } from '../../../services/platformApi.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { PasswordInput } from '@/components/ui/password-input.js';
import { Label } from '@/components/ui/label.js';
import { Alert, AlertDescription } from '@/components/ui/alert.js';

/**
 * Control-plane sign-in.
 *
 * ###########################################################################
 * NO TENANT SLUG, AND ITS ABSENCE IS THE WHOLE DIFFERENCE FROM ADMIN.
 *
 * The admin sign-in asks for the restaurant's name in full, because the tenant
 * has to come from something verified or something a human typed, and a laptop
 * has neither. A platform user belongs to no tenant, so there is nothing to ask
 * for -- and a field here would be worse than redundant: it would suggest that a
 * control-plane session is scoped to one customer, which is exactly the thing
 * the impersonation routes exist to make a separate, audited act.
 * ###########################################################################
 *
 * The refusal is uniform. An unknown address and a wrong password get the same
 * sentence, because distinguishing them tells a prober which half they got
 * right -- and the address half is the list worth having before phishing a
 * member of staff who can enter any restaurant in the estate.
 */
export function SignIn(props: {
  api: PlatformApi;
  onSignedIn: (session: PlatformSession) => void;
}): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      props.onSignedIn(await props.api.signIn({ email: email.trim(), password }));
    } catch (error) {
      setRefusal(
        error instanceof PlatformApiError && error.failure.kind === 'offline'
          ? 'No connection. Signing in needs one.'
          : 'That sign-in was not accepted.',
      );
      // Cleared on refusal, kept on a network error: retyping a password because
      // the office wifi dropped is a punishment for the wrong mistake.
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const ready = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 font-sans">
      {/* A radial glow behind the card, not a texture: the one flourish this
          screen gets, and the only place in the console purely decorative. */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(124,108,255,0.12),transparent_60%)]" />
      <form
        onSubmit={(event) => { event.preventDefault(); if (ready) void submit(); }}
        className="relative z-10 flex w-full max-w-[400px] flex-col gap-5 rounded-xl border border-border bg-card p-8 shadow-2xl shadow-black/40"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xl font-bold tracking-tight text-foreground">
            UniversalPOS control plane
          </span>
          <span className="text-sm leading-relaxed text-muted-foreground">
            Staff sign-in. This is not a restaurant&rsquo;s admin — everything
            here is somebody else&rsquo;s data.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Email
          </Label>
          <Input id="email" type="email" value={email} autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            className="h-11" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Password
          </Label>
          <PasswordInput id="password" value={password} autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            className="h-11" />
        </div>

        {refusal !== null && (
          <Alert variant="destructive">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={!ready} className="h-11 text-[15px] font-bold">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
